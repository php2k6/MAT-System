from datetime import date, datetime, timedelta, timezone
import json
import logging
from pathlib import Path
from zoneinfo import ZoneInfo
from uuid import UUID

import pandas as pd
from fastapi import APIRouter, Depends, HTTPException, status
from fyers_apiv3 import fyersModel
from sqlalchemy.orm import Session

from backend.backtest_engine import build_series, build_stats, run_backtest
from backend.core.deps import get_current_user
from backend.core.fyers_funds import extract_available_cash
from backend.core.security import decrypt_token
from backend.core.time_utils import now_ist
from backend.config import settings
from backend.database import get_db
from backend.models import (
    BrokerSession,
    Holdings,
    RebalanceOrderLeg,
    RebalanceQueue,
    RebalancingHistory,
    StockPrice,
    Strategy,
    Positions,
    User,
)
from backend.mat_engine import CASH_BUFFER, MATEngine, _buy_cost, _sell_cost
from backend.schemas.strategy import (
    BacktestRequest,
    DeployStrategyRequest,
    RebalanceHistoryActionRequest,
    StrategyActionRequest,
)

router = APIRouter(prefix="/api/strategy", tags=["strategy"])
logger = logging.getLogger(__name__)


UNIVERSE_TO_INT = {
    "nifty50": 50,
    "nifty100": 100,
    "nifty150": 150,
    "nifty250": 250,
}

_HISTORY_ACTIONABLE_STATUSES = {"action_required", "failed"}
_HISTORY_CLOSED_STATUSES = {"completed", "completed_ignored", "skipped"}
_LEG_OPEN_STATUSES = {"planned", "placed", "partial", "failed"}


def _to_ist_iso(dt: datetime | None) -> str | None:
    if not dt:
        return None
    ist = ZoneInfo(settings.scheduler_timezone)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(ist).isoformat()


def _safe_json_load(payload: str | None):
    if not payload:
        return None
    try:
        return json.loads(payload)
    except Exception:
        return None


def _serialize_leg(leg: RebalanceOrderLeg) -> dict:
    return {
        "id": str(leg.id),
        "phase": leg.phase,
        "side": leg.side,
        "symbol": leg.symbol,
        "requestedQty": int(leg.requested_qty or 0),
        "filledQty": int(leg.filled_qty or 0),
        "remainingQty": int(leg.remaining_qty or 0),
        "status": leg.status,
        "brokerOrderId": leg.broker_order_id,
        "attemptNo": int(leg.attempt_no or 1),
        "errorCode": leg.error_code,
        "errorMessage": leg.error_message,
        "isRetryable": bool(leg.is_retryable),
        "createdAt": _to_ist_iso(leg.created_at),
        "updatedAt": _to_ist_iso(leg.updated_at),
    }


def _history_row_payload(row: RebalancingHistory, legs: list[RebalanceOrderLeg]) -> dict:
    unresolved = [leg for leg in legs if int(leg.remaining_qty or 0) > 0 and leg.status in _LEG_OPEN_STATUSES]
    retryable_unresolved = [leg for leg in unresolved if bool(leg.is_retryable)]
    return {
        "id": str(row.id),
        "strategyId": str(row.strat_id),
        "queueId": str(row.queue_id) if row.queue_id else None,
        "status": row.status,
        "reason": row.reason,
        "startedAt": _to_ist_iso(row.started_at),
        "completedAt": _to_ist_iso(row.completed_at),
        "summary": _safe_json_load(row.summary_json),
        "legs": [_serialize_leg(leg) for leg in legs],
        "legsMeta": {
            "total": len(legs),
            "unresolved": len(unresolved),
            "retryableUnresolved": len(retryable_unresolved),
            "nonRetryableUnresolved": len(unresolved) - len(retryable_unresolved),
            "canRepair": row.status in _HISTORY_ACTIONABLE_STATUSES and len(unresolved) > 0,
            "canArchive": row.status in _HISTORY_ACTIONABLE_STATUSES and len(unresolved) > 0,
        },
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
    cash = extract_available_cash(resp)
    if cash is None:
        raise RuntimeError(f"FUNDS_PARSE_FAILED:{resp}")
    return float(cash)


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
    rows = (
        db.query(RebalancingHistory)
        .filter(RebalancingHistory.user_id == user.user_id)
        .order_by(RebalancingHistory.started_at.desc())
        .limit(100)
        .all()
    )

    legs = (
        db.query(RebalanceOrderLeg)
        .filter(RebalanceOrderLeg.user_id == user.user_id)
        .order_by(RebalanceOrderLeg.created_at.desc())
        .all()
    )
    legs_by_history: dict[str, list[RebalanceOrderLeg]] = {}
    for leg in legs:
        hid = str(leg.history_id)
        if hid not in legs_by_history:
            legs_by_history[hid] = []
        legs_by_history[hid].append(leg)

    history = [_history_row_payload(row, legs_by_history.get(str(row.id), [])) for row in rows]
    deployed = _deployed_user_strategy(db, user.user_id)

    return {
        "success": True,
        "strategyDeployed": bool(deployed),
        "strategyId": str(deployed.strat_id) if deployed else None,
        "history": history,
    }


@router.get("/rebalance-history/{history_id}")
def rebalance_history_detail(
    history_id: UUID,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    row = (
        db.query(RebalancingHistory)
        .filter(
            RebalancingHistory.id == history_id,
            RebalancingHistory.user_id == user.user_id,
        )
        .first()
    )
    if not row:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"success": False, "message": "Rebalancing history not found"},
        )

    legs = (
        db.query(RebalanceOrderLeg)
        .filter(RebalanceOrderLeg.history_id == row.id)
        .order_by(RebalanceOrderLeg.phase.asc(), RebalanceOrderLeg.symbol.asc())
        .all()
    )
    return {
        "success": True,
        "history": _history_row_payload(row, legs),
    }


@router.post("/rebalance-history/{history_id}/archive")
def archive_rebalance_history(
    history_id: UUID,
    req: RebalanceHistoryActionRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    row = (
        db.query(RebalancingHistory)
        .filter(
            RebalancingHistory.id == history_id,
            RebalancingHistory.user_id == user.user_id,
        )
        .first()
    )
    if not row:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"success": False, "message": "Rebalancing history not found"},
        )

    if row.status in _HISTORY_CLOSED_STATUSES:
        return {
            "success": True,
            "message": "History already closed",
            "status": row.status,
        }

    unresolved = (
        db.query(RebalanceOrderLeg)
        .filter(
            RebalanceOrderLeg.history_id == row.id,
            RebalanceOrderLeg.remaining_qty > 0,
            RebalanceOrderLeg.status.in_(list(_LEG_OPEN_STATUSES)),
        )
        .all()
    )

    for leg in unresolved:
        leg.status = "ignored"
        leg.error_code = "ARCHIVED_BY_USER"
        leg.error_message = req.note or "User archived unresolved leg"
        leg.is_retryable = False
        leg.remaining_qty = 0

    summary = _safe_json_load(row.summary_json) or {}
    archives = summary.get("archives") or []
    archives.append({
        "at": now_ist().isoformat(),
        "note": req.note,
        "ignoredLegs": len(unresolved),
    })
    summary["archives"] = archives

    row.status = "completed_ignored"
    row.reason = "ARCHIVED_BY_USER"
    row.summary_json = json.dumps(summary, ensure_ascii=True)
    row.completed_at = now_ist()
    db.commit()

    try:
        from backend.scheduler import broker_reconcile_snapshot
        broker_reconcile_snapshot()
    except Exception:
        logger.exception("strategy.rebalance_history.archive broker_reconcile failed (non-fatal)")

    return {
        "success": True,
        "historyId": str(row.id),
        "status": row.status,
        "ignoredLegs": len(unresolved),
    }


@router.post("/rebalance-history/{history_id}/repair")
def repair_rebalance_history(
    history_id: UUID,
    req: RebalanceHistoryActionRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    row = (
        db.query(RebalancingHistory)
        .filter(
            RebalancingHistory.id == history_id,
            RebalancingHistory.user_id == user.user_id,
        )
        .first()
    )
    if not row:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"success": False, "message": "Rebalancing history not found"},
        )

    if row.status == "completed_ignored":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"success": False, "message": "Archived history cannot be repaired"},
        )

    strat = (
        db.query(Strategy)
        .filter(
            Strategy.strat_id == row.strat_id,
            Strategy.user_id == user.user_id,
        )
        .first()
    )
    if not strat:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"success": False, "message": "Strategy not found for this history"},
        )

    legs = (
        db.query(RebalanceOrderLeg)
        .filter(
            RebalanceOrderLeg.history_id == row.id,
            RebalanceOrderLeg.remaining_qty > 0,
            RebalanceOrderLeg.status.in_(list(_LEG_OPEN_STATUSES)),
        )
        .order_by(RebalanceOrderLeg.phase.asc(), RebalanceOrderLeg.created_at.asc())
        .all()
    )
    if not legs:
        row.status = "completed"
        row.completed_at = now_ist()
        db.commit()
        return {
            "success": True,
            "historyId": str(row.id),
            "status": row.status,
            "message": "No unresolved legs found",
        }

    shadow_entry = type("ShadowQueueEntry", (), {"strategy": strat})()
    engine = MATEngine(shadow_entry, db)
    try:
        fyers = engine._get_fyers()
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"success": False, "message": f"Broker auth failed: {exc}"},
        )

    symbols = sorted({leg.symbol for leg in legs})
    try:
        quotes = engine._get_quotes(fyers, symbols) if symbols else {}
    except Exception:
        quotes = {}

    repaired = 0
    phase_counts: dict[str, int] = {"sell": 0, "buy": 0}

    for phase in ("sell", "buy"):
        phase_legs = [leg for leg in legs if leg.phase == phase and int(leg.remaining_qty or 0) > 0]
        if not phase_legs:
            continue

        order_to_leg: dict[str, RebalanceOrderLeg] = {}
        for leg in phase_legs:
            qty = int(leg.remaining_qty or 0)
            if qty <= 0:
                continue

            q = quotes.get(leg.symbol, {})
            if phase == "sell" and engine._is_lc(q):
                leg.status = "failed"
                leg.error_code = "LC_BLOCK"
                leg.error_message = "Lower-circuit guard blocked sell leg"
                leg.is_retryable = True
                continue
            if phase == "buy" and engine._is_uc(q):
                leg.status = "failed"
                leg.error_code = "UC_BLOCK"
                leg.error_message = "Upper-circuit guard blocked buy leg"
                leg.is_retryable = True
                continue

            try:
                oid = engine._place_order(fyers, leg.symbol, side=-1 if phase == "sell" else 1, qty=qty)
                leg.broker_order_id = oid
                leg.status = "placed"
                leg.attempt_no = int(leg.attempt_no or 1) + 1
                leg.error_code = None
                leg.error_message = None
                order_to_leg[oid] = leg
                phase_counts[phase] += 1
            except Exception as exc:
                leg.status = "failed"
                leg.error_code = "ORDER_PLACE_FAILED"
                leg.error_message = str(exc)
                leg.is_retryable = True

        if not order_to_leg:
            continue

        fill_map = engine._wait_for_fills(fyers, list(order_to_leg.keys()))
        for oid, leg in order_to_leg.items():
            fill = fill_map.get(oid, {"filled_qty": 0, "status": "missing"})
            filled_now = int(fill.get("filled_qty", 0) or 0)
            leg.filled_qty = min(int(leg.requested_qty or 0), int(leg.filled_qty or 0) + filled_now)
            leg.remaining_qty = max(int(leg.requested_qty or 0) - int(leg.filled_qty or 0), 0)
            fstatus = str(fill.get("status", "unknown")).lower()

            if leg.remaining_qty <= 0:
                leg.status = "filled"
                leg.error_code = None
                leg.error_message = None
                leg.is_retryable = True
                repaired += 1
            elif filled_now > 0:
                leg.status = "partial"
                leg.error_code = "PARTIAL_FILL"
                leg.error_message = f"Partially filled {leg.filled_qty}/{leg.requested_qty}"
                leg.is_retryable = True
            else:
                leg.status = "failed"
                error_map = {
                    "rejected": "ORDER_REJECTED",
                    "cancelled": "ORDER_CANCELLED",
                    "timeout": "BROKER_TIMEOUT",
                    "missing": "ORDERBOOK_MISSING",
                }
                leg.error_code = error_map.get(fstatus, "ORDER_FAILED")
                leg.error_message = f"Order ended with status={fstatus}"
                leg.is_retryable = fstatus in {"timeout", "missing", "unknown"}

    unresolved_after = (
        db.query(RebalanceOrderLeg)
        .filter(
            RebalanceOrderLeg.history_id == row.id,
            RebalanceOrderLeg.remaining_qty > 0,
            RebalanceOrderLeg.status.in_(list(_LEG_OPEN_STATUSES)),
        )
        .count()
    )

    summary = _safe_json_load(row.summary_json) or {}
    repairs = summary.get("repairs") or []
    repairs.append({
        "at": now_ist().isoformat(),
        "note": req.note,
        "repairedLegs": repaired,
        "sellPlaced": phase_counts["sell"],
        "buyPlaced": phase_counts["buy"],
        "unresolvedAfter": int(unresolved_after),
    })
    summary["repairs"] = repairs

    row.status = "completed" if unresolved_after == 0 else "action_required"
    row.reason = "REPAIRED" if unresolved_after == 0 else "REPAIR_INCOMPLETE"
    row.summary_json = json.dumps(summary, ensure_ascii=True)
    row.completed_at = now_ist() if unresolved_after == 0 else row.completed_at

    db.commit()

    try:
        from backend.scheduler import broker_reconcile_snapshot
        broker_reconcile_snapshot()
    except Exception:
        logger.exception("strategy.rebalance_history.repair broker_reconcile failed (non-fatal)")

    return {
        "success": True,
        "historyId": str(row.id),
        "status": row.status,
        "repairedLegs": repaired,
        "unresolvedLegs": int(unresolved_after),
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

    now = now_ist()
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
        # Pre-rebalance snapshot (symmetry with scheduler.py)
        try:
            from backend.scheduler import broker_reconcile_snapshot
            broker_reconcile_snapshot()
        except Exception:
            logger.exception("strategy.testing.force_rebalance: pre-rebalance broker_reconcile failed (continuing anyway)")

        result = MATEngine(entry, db).run_rebalance()
        if result.skipped:
            entry.status = "skipped"
            entry.reason = result.reason + (" | " + json.dumps(result.details) if result.details else "")
            entry.retry_count = (entry.retry_count or 0) + 1
        elif result.success:
            entry.status = "done"
            entry.reason = result.reason or entry.reason
            entry.completed_at = now_ist()
        else:
            entry.status = "failed"
            entry.reason = result.reason

        db.commit()
        db.refresh(entry)

        # Sync broker ground truth (mat_engine no longer does analytical flush).
        if result.success:
            try:
                from backend.scheduler import broker_reconcile_snapshot
                broker_reconcile_snapshot()
            except Exception:
                logger.exception("strategy.testing.force_rebalance: broker_reconcile failed (non-fatal)")

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

    # Sync ground-truth from broker to DB so mock preview is perfectly accurate
    try:
        from backend.scheduler import broker_reconcile_snapshot
        broker_reconcile_snapshot()
    except Exception:
        logger.exception("strategy.testing.mock_rebalance: pre-rebalance broker_reconcile failed")

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

    # Build target quantities using LTP-first pricing to match the live engine.
    # Falls back to prev_close for any ticker with no live quote.
    alloc_target = working_capital / len(target_tickers)
    pricing = {}
    for t in target_tickers:
        ltp = float((quotes.get(t) or {}).get("ltp", 0) or 0)
        pricing[t] = ltp if ltp > 0 else float(prev_close.get(t, 0) or 0)

    target_qty = {}
    for ticker in target_tickers:
        price = pricing.get(ticker, 0)
        target_qty[ticker] = int(alloc_target / price) if price > 0 else 0

    target_base_cost = sum(
        target_qty[t] * pricing.get(t, 0)
        for t in target_tickers
        if pricing.get(t, 0) > 0
    )
    target_residual = working_capital - target_base_cost
    target_remainders = [
        (t, alloc_target - target_qty[t] * pricing.get(t, 0))
        for t in target_tickers
        if pricing.get(t, 0) > 0
    ]
    target_remainders.sort(key=lambda x: x[1], reverse=True)
    for ticker, _ in target_remainders:
        price = pricing.get(ticker, 0)
        if target_residual >= price:
            target_qty[ticker] += 1
            target_residual -= price

    current_qty = {t: int(v.get("qty") or 0) for t, v in db_holdings.items()}

    # Sells come directly from final target deltas (current > target).
    sell_plan = {}
    for ticker, held in current_qty.items():
        plan_target = int(target_qty.get(ticker, 0))
        if held > plan_target:
            sell_plan[ticker] = held - plan_target

    lc_tickers = [t for t in sell_plan if engine._is_lc(quotes.get(t, {}))]
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
    for ticker, qty_raw in sell_plan.items():
        qty = int(qty_raw or 0)
        if qty <= 0:
            continue
        ltp = float(quotes.get(ticker, {}).get("ltp", prev_close.get(ticker, 0)) or 0)
        gross = qty * ltp
        est_cost = _sell_cost(gross)
        est_net = max(0.0, gross - est_cost)
        estimated_sell_net += est_net
        plan_target = int(target_qty.get(ticker, 0))
        sell_orders.append(
            {
                "symbol": ticker,
                "side": "SELL",
                "qty": qty,
                "ltp": round(ltp, 4),
                "grossValue": round(gross, 2),
                "estimatedCharges": round(est_cost, 2),
                "estimatedNet": round(est_net, 2),
                "reason": "EXIT" if plan_target <= 0 else "TRIM",
            }
        )

    estimated_post_sell_cash = cash + estimated_sell_net
    buy_budget = total_capital * (1 - CASH_BUFFER)
    buy_orders = []
    uc_buy_skipped = []
    for ticker in target_tickers:
        diff = int(target_qty.get(ticker, 0) - current_qty.get(ticker, 0))
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

        est_gross = diff * est_price
        est_charges = _buy_cost(est_gross)
        est_outflow = est_gross + est_charges

        buy_orders.append(
            {
                "symbol": ticker,
                "side": "BUY",
                "qty": diff,
                "ltp": round(est_price, 4),
                "estimatedValue": round(est_gross, 2),
                "estimatedCharges": round(est_charges, 2),
                "estimatedOutflow": round(est_outflow, 2),
                "validity": "IOC",
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
                "targetQty": int(target_qty.get(ticker, 0)),
                "deltaQty": int(target_qty.get(ticker, 0) - int(db_holdings.get(ticker, {}).get("qty") or 0)),
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
            "singleShotPlan": True,
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
    from backend.scheduler import eod_mtm_from_yahoo_prices

    _ = user
    logger.info("strategy.testing.eod_mtm trigger user_id=%s", user.user_id)
    result = eod_mtm_from_yahoo_prices()
    return {
        "success": True,
        "message": "Triggered EOD MTM valuation from Yahoo-backed stock_price",
        "result": result,
    }


@router.post("/testing/broker-reconcile")
def trigger_broker_reconcile(
    user: User = Depends(get_current_user),
):
    _ensure_testing_enabled()
    from backend.scheduler import broker_reconcile_snapshot

    _ = user
    logger.info("strategy.testing.broker_reconcile trigger user_id=%s", user.user_id)
    result = broker_reconcile_snapshot()
    return {
        "success": True,
        "message": "Triggered broker reconciliation snapshot",
        "result": result,
    }


@router.get("/testing/reconcile-state")
def get_reconcile_state(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _ensure_testing_enabled()

    strategy = _deployed_user_strategy(db, user.user_id)
    if not strategy:
        return {
            "success": True,
            "strategyDeployed": False,
            "holdings": [],
            "positions": [],
            "totals": {"positionsPnl": 0.0},
        }

    holdings = (
        db.query(Holdings)
        .filter(Holdings.strat_id == strategy.strat_id)
        .order_by(Holdings.ticker.asc())
        .all()
    )
    positions = (
        db.query(Positions)
        .filter(Positions.strat_id == strategy.strat_id)
        .order_by(Positions.ticker.asc())
        .all()
    )

    holdings_payload = [
        {
            "symbol": h.ticker,
            "qty": int(h.qty or 0),
            "avgPrice": float(h.avg_price or 0),
            "lastPrice": float(h.last_price or 0),
            "updatedAt": h.updated_at.isoformat() if h.updated_at else None,
        }
        for h in holdings
    ]

    positions_payload = []
    total_pnl = 0.0
    for p in positions:
        qty = int(p.qty or 0)
        avg_price = float(p.avg_price or 0)
        ltp = float(p.last_price or 0)
        market_value = qty * ltp
        invested = qty * avg_price
        pnl = market_value - invested
        pnl_pct = (pnl / invested * 100.0) if invested > 0 else 0.0
        total_pnl += pnl

        positions_payload.append(
            {
                "symbol": p.ticker,
                "qty": qty,
                "avgPrice": avg_price,
                "lastPrice": ltp,
                "ltp": ltp,
                "marketValue": market_value,
                "pnl": pnl,
                "pnlPct": pnl_pct,
                "updatedAt": p.updated_at.isoformat() if p.updated_at else None,
            }
        )
    return {
        "success": True,
        "strategyDeployed": True,
        "strategyId": str(strategy.strat_id),
        "holdings": holdings_payload,
        "positions": positions_payload,
        "totals": {
            "positionsPnl": round(total_pnl, 2),
            "holdingsCount": len(holdings_payload),
            "positionsCount": len(positions_payload),
        },
    }


@router.post("/testing/yahoo-daily-sync")
def trigger_yahoo_daily_sync(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _ensure_testing_enabled()
    # user dependency keeps endpoint authenticated even though user object is unused.
    from backend.core.yahoo_daily_sync import run_yahoo_daily_sync
    from backend.scheduler import eod_mtm_from_yahoo_prices

    _ = user
    logger.info("strategy.testing.yahoo_daily_sync trigger user_id=%s", user.user_id)
    sync_result = run_yahoo_daily_sync(db)
    mtm_result = eod_mtm_from_yahoo_prices()
    return {
        "success": True,
        "message": "Triggered Yahoo daily DB sync + EOD MTM valuation",
        "result": {
            "yahooSync": sync_result,
            "eodMtm": mtm_result,
        },
    }


@router.get("/testing/rebalance-execution-config")
def rebalance_execution_config(
    user: User = Depends(get_current_user),
):
    _ensure_testing_enabled()
    _ = user

    order_socket_available = False
    try:
        from fyers_apiv3.FyersWebsocket.order_ws import FyersOrderSocket  # noqa: F401
        order_socket_available = True
    except Exception:
        order_socket_available = False

    return {
        "success": True,
        "execution": {
            "singleShotTargetSizing": True,
            "recalculateBuyQtyAfterSells": False,
            "orderValidity": "IOC",
            "cashBuffer": float(CASH_BUFFER),
            "fillTrackingMode": "socket_first_poll_fallback",
            "orderSocketAvailable": order_socket_available,
        },
    }
