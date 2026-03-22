from datetime import date, datetime, timedelta, timezone
import json
import logging
from pathlib import Path

import pandas as pd
from fastapi import APIRouter, Depends, HTTPException, status
from fyers_apiv3 import fyersModel
from sqlalchemy.orm import Session

from backend.backtest_engine import build_series, build_stats, run_backtest
from backend.core.deps import get_current_user
from backend.core.security import decrypt_token
from backend.config import settings
from backend.database import get_db
from backend.models import BrokerSession, RebalanceQueue, StockPrice, Strategy, User
from backend.schemas.strategy import BacktestRequest, DeployStrategyRequest, StrategyActionRequest

router = APIRouter(prefix="/api/strategy", tags=["strategy"])
logger = logging.getLogger(__name__)


UNIVERSE_TO_INT = {
    "nifty50": 50,
    "nifty100": 100,
    "nifty150": 150,
    "nifty250": 250,
}


def _get_available_balance(broker_session: BrokerSession) -> float:
    token = decrypt_token(broker_session.access_token_encrypted)
    Path(settings.log_dir).mkdir(parents=True, exist_ok=True)
    fyers = fyersModel.FyersModel(
        client_id=settings.fyers_app_id,
        token=token,
        is_async=False,
        log_path=settings.log_dir,
    )

    resp = fyers.funds()
    if resp.get("s") != "ok":
        raise RuntimeError(f"FUNDS_FAILED:{resp}")

    for item in resp.get("fund_limit", []):
        title = item.get("title", "")
        if "Available Balance" in title or "available_balance" in title.lower():
            return float(item.get("equityAmount", item.get("val", 0)))

    return sum(float(i.get("equityAmount", i.get("val", 0))) for i in resp.get("fund_limit", []))


def _latest_user_strategy(db: Session, user_id):
    return (
        db.query(Strategy)
        .filter(Strategy.user_id == user_id)
        .order_by(Strategy.start_date.desc())
        .first()
    )


def _ensure_testing_enabled() -> None:
    if not settings.enable_testing_endpoints:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"success": False, "message": "Testing endpoints are disabled"},
        )


@router.post("/backtest")
def run_backtest_api(req: BacktestRequest, db: Session = Depends(get_db)):
    logger.info("strategy.backtest start universe=%s capital=%s", req.universe, req.capital)
    # Pull required columns from stock_price; alias ticker → symbol
    rows = db.query(
        StockPrice.ticker,
        StockPrice.date,
        StockPrice.close,
        StockPrice.volatility_1y,
        StockPrice.index_member,
    ).all()

    if not rows:
        logger.warning("strategy.backtest no_stock_price_data")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"success": False, "message": "No stock price data in database"},
        )

    df = pd.DataFrame(rows, columns=["symbol", "date", "close", "volatility_1y", "index_member"])
    df["date"]          = pd.to_datetime(df["date"])
    df["close"]         = df["close"].astype(float)
    df["volatility_1y"] = df["volatility_1y"].astype(float)

    try:
        result, _, _ = run_backtest(
            df,
            universe=req.universe,
            n_stocks=req.numStocks,
            lookback_1=req.lookback1,
            lookback_2=req.lookback2,
            min_price=1.0,
            max_price=req.priceCap,
            initial_capital=req.capital,
            rebalance_type=req.rebalanceType,
            rebalance_freq=req.rebalanceFreq,
            starting_date=req.backtestStartDate,
        )
    except Exception as e:
        logger.exception("strategy.backtest failed")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"success": False, "message": str(e)},
        )

    # Trim output to startingDate — simulation runs from full history for
    # momentum warm-up, but series and stats are reported from startingDate onward
    result_trimmed = result[result.index >= pd.Timestamp(req.backtestStartDate)]

    return {
        "success": True,
        "stats":   build_stats(result_trimmed, req.universe, req.capital),
        "series":  build_series(result_trimmed),
    }


@router.post("/deploy")
def deploy_strategy(
    req: DeployStrategyRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    logger.info("strategy.deploy start user_id=%s", user.user_id)
    broker_session = (
        db.query(BrokerSession)
        .filter(
            BrokerSession.user_id == user.user_id,
            BrokerSession.token_date == date.today(),
        )
        .order_by(BrokerSession.created_at.desc())
        .first()
    )
    if not broker_session:
        logger.warning("strategy.deploy missing_broker_session user_id=%s", user.user_id)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"success": False, "message": "Connect broker before deploying strategy"},
        )

    try:
        available_balance = _get_available_balance(broker_session)
    except Exception:
        logger.exception("strategy.deploy funds_check_failed user_id=%s", user.user_id)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"success": False, "message": "Unable to verify broker funds at the moment"},
        )

    capital = float(req.capital)
    if round(available_balance, 2) != round(capital, 2):
        logger.warning(
            "strategy.deploy funds_mismatch user_id=%s available=%.2f requested=%.2f",
            user.user_id,
            available_balance,
            capital,
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "success": False,
                "message": f"Broker available balance must exactly match deploy capital. Available={available_balance:.2f}, Requested={capital:.2f}",
            },
        )

    # Ensure one live strategy per user. Keep history, but stop any existing live one.
    existing_live = (
        db.query(Strategy)
        .filter(Strategy.user_id == user.user_id)
        .all()
    )
    for existing in existing_live:
        if existing.status in {"active", "paused"}:
            existing.status = "stopped"

    strategy = Strategy(
        user_id=user.user_id,
        universe=UNIVERSE_TO_INT[req.universe],
        n_stocks=req.numStocks,
        lb_period_1=req.lookback1,
        lb_period_2=req.lookback2,
        price_cap=req.priceCap,
        capital=capital,
        unused_capital=capital,
        buffer_capital=capital * 0.005,
        rebalance_freq=req.rebalanceFreq,
        is_monthly=req.rebalanceType == "monthly",
        next_rebalance_date=req.startingDate,
        start_date=req.startingDate,
        market_value=capital,
        status="active",
    )
    db.add(strategy)

    db.commit()
    db.refresh(strategy)
    logger.info("strategy.deploy success user_id=%s strat_id=%s", user.user_id, strategy.strat_id)

    return {
        "success": True,
        "strategyId": str(strategy.strat_id),
        "status": strategy.status,
        "nextRebalance": strategy.next_rebalance_date.isoformat() if strategy.next_rebalance_date else None,
    }


@router.post("/action")
def strategy_action(
    req: StrategyActionRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    logger.info("strategy.action start user_id=%s action=%s", user.user_id, req.action)
    strategy = _latest_user_strategy(db, user.user_id)
    if not strategy:
        logger.warning("strategy.action no_strategy user_id=%s", user.user_id)
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"success": False, "message": "No strategy deployed"},
        )

    action_to_status = {
        "pause": "paused",
        "resume": "active",
        "stop": "stopped",
        "restart": "active",
    }
    strategy.status = action_to_status[req.action]
    db.commit()
    db.refresh(strategy)
    logger.info("strategy.action success user_id=%s status=%s", user.user_id, strategy.status)

    return {"success": True, "status": strategy.status}


@router.get("/rebalance-history")
def rebalance_history(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    logger.info("strategy.rebalance_history start user_id=%s", user.user_id)
    strategy = _latest_user_strategy(db, user.user_id)
    if not strategy:
        logger.info("strategy.rebalance_history no_strategy user_id=%s", user.user_id)
        return {
            "success": True,
            "strategyDeployed": False,
            "message": "No strategy deployed",
            "history": [],
        }

    rows = (
        db.query(RebalanceQueue)
        .filter(RebalanceQueue.strat_id == strategy.strat_id)
        .order_by(RebalanceQueue.queued_at.desc())
        .all()
    )
    logger.info("strategy.rebalance_history rows=%d strat_id=%s", len(rows), strategy.strat_id)

    history = [
        {
            "id": str(r.id),
            "status": r.status,
            "reason": r.reason,
            "retryCount": int(r.retry_count or 0),
            "queuedAt": r.queued_at.isoformat() if r.queued_at else None,
            "attemptedAt": r.attempted_at.isoformat() if r.attempted_at else None,
            "completedAt": r.completed_at.isoformat() if r.completed_at else None,
        }
        for r in rows
    ]

    return {
        "success": True,
        "strategyDeployed": True,
        "strategyId": str(strategy.strat_id),
        "history": history,
    }


@router.post("/testing/force-rebalance")
def force_rebalance_now(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Manual testing endpoint to execute rebalance immediately for the user's
    latest strategy, without waiting for scheduler time windows.
    """
    _ensure_testing_enabled()
    from backend.mat_engine import MATEngine

    logger.info("strategy.testing.force_rebalance start user_id=%s", user.user_id)

    strategy = _latest_user_strategy(db, user.user_id)
    if not strategy:
        logger.warning("strategy.testing.force_rebalance no_strategy user_id=%s", user.user_id)
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"success": False, "message": "No strategy deployed"},
        )

    if strategy.status not in {"active", "paused"}:
        logger.warning("strategy.testing.force_rebalance invalid_status strat_id=%s status=%s", strategy.strat_id, strategy.status)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"success": False, "message": "Strategy is not active/paused"},
        )

    existing = (
        db.query(RebalanceQueue)
        .filter(
            RebalanceQueue.strat_id == strategy.strat_id,
            RebalanceQueue.status.in_(["pending", "in_progress"]),
        )
        .first()
    )
    if existing:
        logger.warning("strategy.testing.force_rebalance already_running strat_id=%s", strategy.strat_id)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"success": False, "message": "Rebalance already in progress for this strategy"},
        )

    now = datetime.now(timezone.utc)
    entry = RebalanceQueue(
        strat_id=strategy.strat_id,
        user_id=user.user_id,
        status="in_progress",
        queued_at=now,
        attempted_at=now,
    )
    db.add(entry)
    db.commit()
    db.refresh(entry)

    try:
        result = MATEngine(entry, db).run_rebalance()
        if result.skipped:
            entry.status = "skipped"
            entry.reason = result.reason + (" | " + json.dumps(result.details) if result.details else "")
            entry.retry_count = (entry.retry_count or 0) + 1
        elif result.success:
            entry.status = "done"
            entry.completed_at = datetime.now(timezone.utc)
        else:
            entry.status = "failed"
            entry.reason = result.reason

        db.commit()
        db.refresh(entry)
        logger.info("strategy.testing.force_rebalance done queue_id=%s status=%s", entry.id, entry.status)
    except Exception as exc:
        db.rollback()
        entry = db.query(RebalanceQueue).filter(RebalanceQueue.id == entry.id).first()
        if entry:
            entry.status = "failed"
            entry.reason = str(exc)[:500]
            db.commit()
        logger.exception("strategy.testing.force_rebalance failed")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"success": False, "message": f"Force rebalance failed: {exc}"},
        )

    return {
        "success": True,
        "queueId": str(entry.id),
        "strategyId": str(strategy.strat_id),
        "status": entry.status,
        "reason": entry.reason,
    }


@router.post("/testing/refresh-live-prices")
def trigger_live_price_refresh(
    user: User = Depends(get_current_user),
):
    _ensure_testing_enabled()
    # user dependency keeps endpoint authenticated even though user object is unused.
    from backend.scheduler import refresh_live_prices

    _ = user
    logger.info("strategy.testing.refresh_live_prices trigger user_id=%s", user.user_id)
    refresh_live_prices()
    return {
        "success": True,
        "message": "Triggered live price refresh",
    }


@router.post("/testing/eod-mtm")
def trigger_eod_mtm(
    user: User = Depends(get_current_user),
):
    _ensure_testing_enabled()
    # user dependency keeps endpoint authenticated even though user object is unused.
    from backend.scheduler import eod_mark_to_market

    _ = user
    logger.info("strategy.testing.eod_mtm trigger user_id=%s", user.user_id)
    eod_mark_to_market()
    return {
        "success": True,
        "message": "Triggered EOD mark-to-market",
    }
