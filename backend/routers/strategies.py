from datetime import date, timedelta

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


UNIVERSE_TO_INT = {
    "nifty50": 50,
    "nifty100": 100,
    "nifty150": 150,
    "nifty250": 250,
}


def _get_available_balance(broker_session: BrokerSession) -> float:
    token = decrypt_token(broker_session.access_token_encrypted)
    fyers = fyersModel.FyersModel(
        client_id=settings.fyers_app_id,
        token=token,
        is_async=False,
        log_path="",
    )

    resp = fyers.funds()
    if resp.get("s") != "ok":
        raise RuntimeError(f"FUNDS_FAILED:{resp}")

    for item in resp.get("fund_limit", []):
        title = item.get("title", "")
        if "Available Balance" in title or "available_balance" in title.lower():
            return float(item.get("equityAmount", item.get("val", 0)))

    return sum(float(i.get("equityAmount", i.get("val", 0))) for i in resp.get("fund_limit", []))


@router.post("/backtest")
def run_backtest_api(req: BacktestRequest, db: Session = Depends(get_db)):
    # Pull required columns from stock_price; alias ticker → symbol
    rows = db.query(
        StockPrice.ticker,
        StockPrice.date,
        StockPrice.close,
        StockPrice.volatility_1y,
        StockPrice.index_member,
    ).all()

    if not rows:
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
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"success": False, "message": "Connect broker before deploying strategy"},
        )

    try:
        available_balance = _get_available_balance(broker_session)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"success": False, "message": "Unable to verify broker funds at the moment"},
        )

    capital = float(req.capital)
    if round(available_balance, 2) != round(capital, 2):
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
    strategy = (
        db.query(Strategy)
        .filter(Strategy.user_id == user.user_id)
        .order_by(Strategy.start_date.desc())
        .first()
    )
    if not strategy:
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

    return {"success": True, "status": strategy.status}


@router.get("/rebalance-history")
def rebalance_history(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    strategy = (
        db.query(Strategy)
        .filter(Strategy.user_id == user.user_id)
        .order_by(Strategy.start_date.desc())
        .first()
    )
    if not strategy:
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
