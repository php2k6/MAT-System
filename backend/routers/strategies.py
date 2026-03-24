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
from backend.mat_engine import CASH_BUFFER, MATEngine, _buy_cost, _sell_cost
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
        .order_by(Strategy.start_date.desc(), Strategy.next_rebalance_date.desc())
        .first()
    )


def _deployed_user_strategy(db: Session, user_id):
    return (
        db.query(Strategy)
        .filter(
            Strategy.user_id == user_id,
            Strategy.status.in_(["active", "paused"]),
        )
        .order_by(Strategy.start_date.desc(), Strategy.next_rebalance_date.desc())
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

    # Enforce one deployed strategy per user.
    existing_live = (
        db.query(Strategy)
        .filter(
            Strategy.user_id == user.user_id,
            Strategy.status.in_(["active", "paused"]),
        )
        .first()
    )
    if existing_live:
        logger.warning("strategy.deploy already_deployed user_id=%s strat_id=%s", user.user_id, existing_live.strat_id)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "success": False,
                "message": "A strategy is already deployed. Stop it before deploying a new one.",
            },
        )

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
    strategy = _deployed_user_strategy(db, user.user_id)
    if not strategy:
        logger.warning("strategy.action no_strategy user_id=%s", user.user_id)
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"success": False, "message": "No deployed strategy found"},
        )

    if req.action == "pause":
        strategy.status = "paused"
        # Ensure pause takes effect immediately by clearing unprocessed queue rows.
        db.query(RebalanceQueue).filter(
            RebalanceQueue.strat_id == strategy.strat_id,
            RebalanceQueue.status == "pending",
        ).delete(synchronize_session=False)
    elif req.action in {"resume", "restart"}:
        strategy.status = "active"
    elif req.action == "stop":
        # Hard delete strategy and children (holdings, portfolio, queue rows) via ORM cascades.
        db.delete(strategy)

    db.commit()
    if req.action == "stop":
        logger.info("strategy.action success user_id=%s action=stop strategy_deleted=true", user.user_id)
        return {"success": True, "status": "stopped", "strategyDeleted": True}

    db.refresh(strategy)
    logger.info("strategy.action success user_id=%s status=%s", user.user_id, strategy.status)

    return {"success": True, "status": strategy.status}


@router.get("/rebalance-history")
def rebalance_history(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    logger.info("strategy.rebalance_history start user_id=%s", user.user_id)
    strategy = _deployed_user_strategy(db, user.user_id)
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

    strategy = _deployed_user_strategy(db, user.user_id)
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


@router.post("/testing/mock-rebalance")
def mock_rebalance_preview(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Dry-run rebalance preview:
    - uses active/paused strategy configuration
    - pulls available cash from Fyers funds
    - computes momentum + target portfolio + simulated buy/sell orders
    - never places any order
    """
    _ensure_testing_enabled()
    logger.info("strategy.testing.mock_rebalance start user_id=%s", user.user_id)

    strategy = _deployed_user_strategy(db, user.user_id)
    if not strategy:
        logger.warning("strategy.testing.mock_rebalance no_strategy user_id=%s", user.user_id)
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"success": False, "message": "No strategy deployed"},
        )

    if strategy.status not in {"active", "paused"}:
        logger.warning(
            "strategy.testing.mock_rebalance invalid_status strat_id=%s status=%s",
            strategy.strat_id,
            strategy.status,
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"success": False, "message": "Strategy is not active/paused"},
        )

    pending = (
        db.query(RebalanceQueue)
        .filter(
            RebalanceQueue.strat_id == strategy.strat_id,
            RebalanceQueue.status.in_(["pending", "in_progress"]),
        )
        .first()
    )
    if pending:
        logger.warning(
            "strategy.testing.mock_rebalance queue_blocked strat_id=%s queue_id=%s status=%s",
            strategy.strat_id,
            pending.id,
            pending.status,
        )
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"success": False, "message": "Rebalance already in progress for this strategy"},
        )

    # Reuse MATEngine internals for faithful dry-run math and checks.
    shadow_entry = type("ShadowQueueEntry", (), {"strategy": strategy})()
    engine = MATEngine(shadow_entry, db)

    try:
        fyers = engine._get_fyers()
    except RuntimeError as exc:
        logger.warning("strategy.testing.mock_rebalance broker_auth_failed: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"success": False, "message": f"Broker auth failed: {exc}"},
        )

    try:
        cash = float(engine._get_cash(fyers))
    except RuntimeError as exc:
        logger.warning("strategy.testing.mock_rebalance funds_failed: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"success": False, "message": f"Unable to fetch funds from broker: {exc}"},
        )

    db_holdings = engine._load_db_holdings()
    held_tickers = list(db_holdings.keys())

    try:
        scores, prev_close = engine._compute_momentum(strategy)
    except Exception as exc:
        logger.exception("strategy.testing.mock_rebalance momentum_failed")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"success": False, "message": f"Momentum calculation failed: {exc}"},
        )

    if not scores:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"success": False, "message": "No momentum scores available"},
        )

    n_target = int(strategy.n_stocks)
    n_candidates = max(n_target, int(n_target * max(float(settings.mat_candidate_pool_multiplier), 1.0)))
    candidates = sorted(scores.items(), key=lambda x: x[1], reverse=True)[:n_candidates]
    candidate_tickers = [t for t, _ in candidates]

    quote_tickers = sorted(set(candidate_tickers) | set(held_tickers))
    try:
        quotes = engine._get_quotes(fyers, quote_tickers) if quote_tickers else {}
    except Exception as exc:
        logger.warning("strategy.testing.mock_rebalance quotes_failed: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"success": False, "message": f"Unable to fetch quotes: {exc}"},
        )

    equity_value = sum(
        int(db_holdings[t]["qty"] or 0) * float(quotes.get(t, {}).get("ltp", 0) or 0)
        for t in held_tickers
    )
    total_capital = cash + equity_value
    working_capital = total_capital * (1 - CASH_BUFFER)

    target_tickers = []
    uc_candidates = []
    for ticker, _score in candidates:
        if len(target_tickers) >= n_target:
            break
        if ticker not in prev_close or float(prev_close[ticker] or 0) <= 0:
            continue
        q = quotes.get(ticker)
        if q and engine._is_uc(q):
            uc_candidates.append(ticker)
            if len(uc_candidates) > n_target / 2:
                return {
                    "success": True,
                    "dryRun": True,
                    "strategyId": str(strategy.strat_id),
                    "status": "skipped",
                    "reason": "UC_GLOBAL_EVENT",
                    "checks": {
                        "ordersPunched": False,
                        "ucCandidates": uc_candidates,
                    },
                    "funds": {
                        "availableCashFromFyers": round(cash, 2),
                        "equityFromTrackedHoldings": round(equity_value, 2),
                        "totalCapital": round(total_capital, 2),
                        "workingCapital": round(working_capital, 2),
                    },
                    "targetPortfolio": [],
                    "simulatedOrders": {"sell": [], "buy": []},
                }
            continue
        target_tickers.append(ticker)

    if not target_tickers:
        return {
            "success": True,
            "dryRun": True,
            "strategyId": str(strategy.strat_id),
            "status": "failed",
            "reason": "NO_ELIGIBLE_STOCKS",
            "checks": {
                "ordersPunched": False,
                "ucCandidates": uc_candidates,
            },
            "funds": {
                "availableCashFromFyers": round(cash, 2),
                "equityFromTrackedHoldings": round(equity_value, 2),
                "totalCapital": round(total_capital, 2),
                "workingCapital": round(working_capital, 2),
            },
            "targetPortfolio": [],
            "simulatedOrders": {"sell": [], "buy": []},
        }

    alloc_pre = working_capital / len(target_tickers)
    target_set = set(target_tickers)

    sells_exit = {}
    sells_trim = {}
    for ticker, held in db_holdings.items():
        held_qty = int(held.get("qty") or 0)
        if held_qty <= 0:
            continue
        if ticker not in target_set:
            sells_exit[ticker] = held_qty
        else:
            pre_target_qty = int(alloc_pre / float(prev_close.get(ticker, 0) or 1))
            if held_qty > pre_target_qty:
                trim_qty = held_qty - pre_target_qty
                if trim_qty > 0:
                    sells_trim[ticker] = trim_qty

    lc_tickers = [
        t for t in (list(sells_exit) + list(sells_trim))
        if engine._is_lc(quotes.get(t, {}))
    ]
    if lc_tickers:
        return {
            "success": True,
            "dryRun": True,
            "strategyId": str(strategy.strat_id),
            "status": "skipped",
            "reason": "LC_DETECTED",
            "checks": {
                "ordersPunched": False,
                "lcTickers": lc_tickers,
                "ucCandidates": uc_candidates,
            },
            "funds": {
                "availableCashFromFyers": round(cash, 2),
                "equityFromTrackedHoldings": round(equity_value, 2),
                "totalCapital": round(total_capital, 2),
                "workingCapital": round(working_capital, 2),
            },
            "targetPortfolio": [],
            "simulatedOrders": {"sell": [], "buy": []},
        }

    sell_orders = []
    estimated_sell_net = 0.0
    for ticker in list(sells_exit) + list(sells_trim):
        qty = int(sells_exit.get(ticker) or sells_trim.get(ticker) or 0)
        ltp = float(quotes.get(ticker, {}).get("ltp", prev_close.get(ticker, 0)) or 0)
        gross = qty * ltp
        est_cost = _sell_cost(gross)
        est_net = max(0.0, gross - est_cost)
        estimated_sell_net += est_net
        sell_orders.append(
            {
                "symbol": ticker,
                "side": "SELL",
                "qty": qty,
                "ltp": round(ltp, 4),
                "grossValue": round(gross, 2),
                "estimatedCharges": round(est_cost, 2),
                "estimatedNet": round(est_net, 2),
                "reason": "EXIT" if ticker in sells_exit else "TRIM",
            }
        )

    current_qty = {t: int(v.get("qty") or 0) for t, v in db_holdings.items()}
    for ticker, qty in sells_exit.items():
        current_qty[ticker] = max(0, current_qty.get(ticker, 0) - int(qty))
    for ticker, qty in sells_trim.items():
        current_qty[ticker] = max(0, current_qty.get(ticker, 0) - int(qty))

    estimated_post_sell_cash = cash + estimated_sell_net
    buy_budget = estimated_post_sell_cash * (1 - CASH_BUFFER)
    alloc_post = buy_budget / len(target_tickers)

    base_qty = {}
    for ticker in target_tickers:
        close = float(prev_close.get(ticker, 0) or 0)
        base_qty[ticker] = int(alloc_post / close) if close > 0 else 0

    base_cost = sum(base_qty[t] * float(prev_close[t]) for t in target_tickers if float(prev_close.get(t, 0) or 0) > 0)
    residual = buy_budget - base_cost

    remainders = [
        (t, alloc_post - base_qty[t] * float(prev_close[t]))
        for t in target_tickers
        if float(prev_close.get(t, 0) or 0) > 0
    ]
    remainders.sort(key=lambda x: x[1], reverse=True)

    greedy_qty = dict(base_qty)
    for ticker, _ in remainders:
        close = float(prev_close[ticker])
        if residual >= close:
            greedy_qty[ticker] += 1
            residual -= close

    buy_orders = []
    uc_buy_skipped = []
    remaining_buy_cash = buy_budget
    for ticker in target_tickers:
        diff = int(greedy_qty.get(ticker, 0) - current_qty.get(ticker, 0))
        if diff <= 0:
            continue
        q = quotes.get(ticker)
        if q and engine._is_uc(q):
            uc_buy_skipped.append(ticker)
            continue

        est_price = max(
            float(quotes.get(ticker, {}).get("ltp", 0) or 0),
            float(prev_close.get(ticker, 0) or 0),
        )
        if est_price <= 0:
            continue

        # Cash-drag aware cap for market-buy simulation.
        factor = 1 + 0.0 + 0.0000325 + 0.00015 + 0.000001 + 0.001
        max_affordable = int(remaining_buy_cash / (est_price * factor))
        capped_qty = min(diff, max_affordable)
        if capped_qty <= 0:
            continue

        est_gross = capped_qty * est_price
        est_charges = _buy_cost(est_gross)
        est_outflow = est_gross + est_charges
        if est_outflow > remaining_buy_cash:
            continue

        remaining_buy_cash -= est_outflow

        buy_orders.append(
            {
                "symbol": ticker,
                "side": "BUY",
                "qty": capped_qty,
                "ltp": round(est_price, 4),
                "estimatedValue": round(est_gross, 2),
                "estimatedCharges": round(est_charges, 2),
                "estimatedOutflow": round(est_outflow, 2),
                "cappedByCash": capped_qty < diff,
                "reason": "NEW" if int(db_holdings.get(ticker, {}).get("qty") or 0) == 0 else "TOP_UP",
            }
        )

    target_portfolio = []
    for ticker in target_tickers:
        target_portfolio.append(
            {
                "symbol": ticker,
                "momentumScore": round(float(scores.get(ticker, 0.0)), 8),
                "prevClose": round(float(prev_close.get(ticker, 0.0)), 4),
                "ltp": round(float(quotes.get(ticker, {}).get("ltp", 0.0)), 4),
                "currentQty": int(db_holdings.get(ticker, {}).get("qty") or 0),
                "targetQty": int(greedy_qty.get(ticker, 0)),
                "deltaQty": int(greedy_qty.get(ticker, 0) - int(db_holdings.get(ticker, {}).get("qty") or 0)),
                "isUC": bool(engine._is_uc(quotes.get(ticker, {}))),
            }
        )

    logger.info(
        "strategy.testing.mock_rebalance done strat_id=%s target=%d sell=%d buy=%d",
        strategy.strat_id,
        len(target_portfolio),
        len(sell_orders),
        len(buy_orders),
    )

    return {
        "success": True,
        "dryRun": True,
        "ordersPunched": False,
        "strategyId": str(strategy.strat_id),
        "strategyStatus": strategy.status,
        "funds": {
            "availableCashFromFyers": round(cash, 2),
            "equityFromTrackedHoldings": round(equity_value, 2),
            "totalCapital": round(total_capital, 2),
            "workingCapital": round(working_capital, 2),
            "estimatedPostSellCash": round(estimated_post_sell_cash, 2),
            "estimatedBuyBudget": round(buy_budget, 2),
            "estimatedBuyBudgetRemaining": round(remaining_buy_cash, 2),
        },
        "checks": {
            "ucCandidatesSkipped": uc_candidates,
            "ucBuySkipped": uc_buy_skipped,
            "lcTickers": [],
        },
        "targetPortfolio": target_portfolio,
        "simulatedOrders": {
            "sell": sell_orders,
            "buy": buy_orders,
        },
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
    result = refresh_live_prices()
    return {
        "success": True,
        "message": "Triggered live price refresh",
        "result": result,
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


@router.post("/testing/yahoo-daily-sync")
def trigger_yahoo_daily_sync(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _ensure_testing_enabled()
    # user dependency keeps endpoint authenticated even though user object is unused.
    from backend.core.yahoo_daily_sync import run_yahoo_daily_sync

    _ = user
    logger.info("strategy.testing.yahoo_daily_sync trigger user_id=%s", user.user_id)
    result = run_yahoo_daily_sync(db)
    return {
        "success": True,
        "message": "Triggered Yahoo daily DB sync",
        "result": result,
    }
