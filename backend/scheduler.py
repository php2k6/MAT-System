"""
scheduler.py
────────────
APScheduler jobs on IST:

    1) queue_rebalances()       pre-market
    2) drain_rebalance_queue()  mid-market
    3) refresh_live_prices()    interval fallback (only when websocket is not connected)
    4) broker_reconcile_snapshot()  broker cash/holdings reconciliation
    5) eod_mtm_from_yahoo_prices()  post-market valuation from stock_price DB
    6) yahoo_daily_sync_job()       optional post-market Yahoo-to-DB stock_price sync
"""

from __future__ import annotations

import json
import logging
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo
from dateutil.relativedelta import relativedelta

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger

from sqlalchemy import and_, func
from sqlalchemy.exc import OperationalError

from backend.config import settings
from backend.core.live_prices import get_live_price_store
from backend.core.market_feed import get_market_feed_manager
from backend.core.security import decrypt_token
from backend.core.fyers_funds import extract_available_cash
from backend.core.time_utils import now_ist
from backend.core.yahoo_daily_sync import run_yahoo_daily_sync
from backend.database import SessionLocal
from backend.models import BrokerSession, Holdings, Portfolio, Positions, RebalanceQueue, StockPrice, StockTicker, Strategy
from fyers_apiv3 import fyersModel
logger = logging.getLogger(__name__)

# ── Singleton scheduler instance ─────────────────────────────────────────────
_scheduler = BackgroundScheduler(timezone=settings.scheduler_timezone)
_IST = ZoneInfo(settings.scheduler_timezone)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _advance_date(current: date, is_monthly: bool, freq: int) -> date:
    """Return the next rebalance date by adding freq months or freq*7 days."""
    if is_monthly:
        return current + relativedelta(months=freq)
    return current + relativedelta(days=freq * 7)


def _is_market_hours() -> bool:
    now_ist = datetime.now(_IST)
    if now_ist.weekday() >= 5:  # Saturday, Sunday
        return False

    minutes = now_ist.hour * 60 + now_ist.minute
    market_open = int(settings.market_open_hour_ist) * 60 + int(settings.market_open_minute_ist)
    market_close = int(settings.market_close_hour_ist) * 60 + int(settings.market_close_minute_ist)
    return market_open <= minutes <= market_close


def _is_nse_cm_open(fyers: fyersModel.FyersModel) -> bool:
    """
    NSE Capital Market open check using Fyers market_status():
    exchange=10, segment=10, market_type=NORMAL only.
    """
    try:
        resp = fyers.market_status()
        if str(resp.get("s", "")).lower() != "ok":
            logger.warning(
                "_is_nse_cm_open: market_status not ok s=%s code=%s",
                resp.get("s"),
                resp.get("code"),
            )
            return False

        rows = resp.get("marketStatus", []) or []
        normal_row = None
        candidates = []

        for seg in rows:
            ex = int(seg.get("exchange", -1))
            sg = int(seg.get("segment", -1))
            mt = str(seg.get("market_type", "")).upper()
            st = str(seg.get("status", "")).upper()

            if ex == 10 and sg == 10:
                candidates.append(f"{mt}:{st}")
                if mt == "NORMAL":
                    normal_row = seg
                    break

        if normal_row:
            status = str(normal_row.get("status", "")).upper()
            logger.info("_is_nse_cm_open: NSE CM NORMAL status=%s", status)
            return status == "OPEN"

        logger.warning(
            "_is_nse_cm_open: NSE CM NORMAL row not found; candidates=%s",
            ",".join(candidates) if candidates else "none",
        )
        return False

    except Exception:
        logger.exception("_is_nse_cm_open: failed to check market status; assuming closed")
        return False


def _iter_chunks(items: list[str], size: int):
    for i in range(0, len(items), size):
        yield items[i : i + size]


def _get_any_active_fyers(db):
    session = (
        db.query(BrokerSession)
        .filter(BrokerSession.token_date == date.today())
        .order_by(BrokerSession.created_at.desc())
        .first()
    )
    if not session:
        return None

    token = decrypt_token(session.access_token_encrypted)
    Path(settings.log_dir).mkdir(parents=True, exist_ok=True)
    return fyersModel.FyersModel(
        client_id=settings.fyers_app_id,
        token=token,
        is_async=False,
        log_path=settings.log_dir,
    )


def _get_user_fyers(db, user_id):
    session = (
        db.query(BrokerSession)
        .filter(
            BrokerSession.user_id == user_id,
            BrokerSession.token_date == date.today(),
        )
        .order_by(BrokerSession.created_at.desc())
        .first()
    )
    if not session:
        return None

    token = decrypt_token(session.access_token_encrypted)
    Path(settings.log_dir).mkdir(parents=True, exist_ok=True)
    return fyersModel.FyersModel(
        client_id=settings.fyers_app_id,
        token=token,
        is_async=False,
        log_path=settings.log_dir,
    )


def _extract_positions(positions_resp: dict) -> dict[str, dict]:
    if positions_resp.get("s") != "ok":
        return {}

    rows = positions_resp.get("netPositions") or positions_resp.get("overall") or []
    if isinstance(rows, dict):
        rows = rows.get("netPositions") or rows.get("overall") or []
    if not isinstance(rows, list):
        return {}

    out: dict[str, dict] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue

        symbol = str(row.get("symbol", ""))
        ticker = _extract_ticker(symbol)
        if not ticker:
            continue

        qty = int(row.get("netQty", row.get("qty", 0)) or 0)
        if qty <= 0:
            continue

        avg = float(row.get("netAvg", row.get("avgPrice", row.get("buyAvg", 0))) or 0)
        ltp = float(row.get("ltp", 0) or 0)
        if ltp <= 0:
            ltp = float(row.get("netLtp", row.get("lastPrice", avg)) or avg)

        out[ticker] = {
            "qty": qty,
            "avg_price": avg,
            "last_price": ltp,
        }
    return out


def _extract_positions_detailed(positions_resp: dict) -> dict[str, dict]:
    if positions_resp.get("s") != "ok":
        return {}

    rows = positions_resp.get("netPositions") or positions_resp.get("overall") or []
    if isinstance(rows, dict):
        rows = rows.get("netPositions") or rows.get("overall") or []
    if not isinstance(rows, list):
        return {}

    out: dict[str, dict] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue

        symbol = str(row.get("symbol", ""))
        ticker = _extract_ticker(symbol)
        if not ticker:
            continue

        qty = int(row.get("netQty", row.get("qty", 0)) or 0)
        if qty <= 0:
            continue

        avg = float(row.get("netAvg", row.get("avgPrice", row.get("buyAvg", 0))) or 0)
        ltp = float(row.get("ltp", row.get("netLtp", row.get("lastPrice", 0))) or 0)
        if ltp <= 0:
            ltp = avg

        market_value = float(row.get("marketVal", row.get("market_value", 0)) or 0)
        if market_value <= 0 and ltp > 0:
            market_value = qty * ltp

        pnl = float(row.get("pl", row.get("pnl", 0)) or 0)
        if pnl == 0 and avg > 0 and market_value > 0:
            pnl = market_value - (qty * avg)

        invested = qty * avg if avg > 0 else 0.0
        pnl_pct = (pnl / invested * 100.0) if invested > 0 else 0.0

        out[ticker] = {
            "qty": qty,
            "avg_price": avg,
            "last_price": ltp,
            "market_value": market_value,
            "pnl": pnl,
            "pnl_pct": pnl_pct,
        }
    return out


def _extract_holdings(holdings_resp: dict) -> dict[str, dict]:
    if holdings_resp.get("s") != "ok":
        return {}

    rows = holdings_resp.get("holdings") or holdings_resp.get("overall") or []
    if isinstance(rows, dict):
        rows = rows.get("holdings") or rows.get("overall") or []
    if not isinstance(rows, list):
        return {}

    out: dict[str, dict] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue

        symbol = str(row.get("symbol") or row.get("nseSymbol") or row.get("tradingsymbol") or "")
        ticker = _extract_ticker(symbol)
        if not ticker:
            continue

        qty = int(row.get("quantity", row.get("qty", 0)) or 0)
        if qty <= 0:
            continue

        avg = float(row.get("costPrice", row.get("avgPrice", row.get("holdingPrice", 0))) or 0)
        ltp = float(row.get("ltp", row.get("lastTradedPrice", 0)) or 0)
        if ltp <= 0:
            market_val = float(row.get("marketVal", row.get("market_value", 0)) or 0)
            if market_val > 0 and qty > 0:
                ltp = market_val / qty
        if ltp <= 0:
            ltp = avg

        out[ticker] = {
            "qty": qty,
            "avg_price": avg,
            "last_price": ltp,
        }
    return out


def _raw_holdings_rows(holdings_resp: dict) -> list[dict]:
    rows = holdings_resp.get("holdings") or holdings_resp.get("overall") or []
    if isinstance(rows, dict):
        rows = rows.get("holdings") or rows.get("overall") or []
    if not isinstance(rows, list):
        return []
    return [r for r in rows if isinstance(r, dict)]


def _holdings_equity_value(rows: list[dict]) -> float:
    equity = 0.0
    for row in rows:
        qty = int(row.get("quantity", row.get("qty", 0)) or 0)
        if qty <= 0:
            continue

        market_val = float(row.get("marketVal", row.get("market_value", 0)) or 0)
        if market_val > 0:
            equity += market_val
            continue

        ltp = float(row.get("ltp", row.get("lastTradedPrice", 0)) or 0)
        if ltp > 0:
            equity += qty * ltp
    return equity


def _extract_ticker(symbol: str) -> str:
    # NSE:INFY-EQ -> INFY
    if ":" in symbol:
        symbol = symbol.split(":", 1)[1]
    return symbol.replace("-EQ", "")


def refresh_live_prices() -> dict:
    """
    Pull latest prices for tracked tickers and store them in Redis cache.
    Runs on interval during market hours.
    """
    if not _is_market_hours():
        logger.info("refresh_live_prices: skipped (outside market hours)")
        return {"status": "skipped", "reason": "outside_market_hours", "updated": 0}

    # Save Fyers quote API budget when websocket feed is already live.
    if get_market_feed_manager().is_connected():
        logger.info("refresh_live_prices: skipped (market websocket connected)")
        return {"status": "skipped", "reason": "websocket_connected", "updated": 0}

    db = SessionLocal()
    try:
        tickers = [r.ticker for r in db.query(StockTicker.ticker).all()]
        if not tickers:
            return {"status": "skipped", "reason": "no_tickers", "updated": 0}

        fyers = _get_any_active_fyers(db)
        if not fyers:
            logger.debug("refresh_live_prices: no active broker session for today")
            return {"status": "skipped", "reason": "no_active_broker_session", "updated": 0}

        prices: dict[str, float] = {}
        chunk_size = max(int(settings.fyers_quotes_chunk_size), 1)
        for chunk in _iter_chunks(tickers, chunk_size):
            symbols = ",".join(f"NSE:{t}-EQ" for t in chunk)
            resp = fyers.quotes({"symbols": symbols, "ohlcv_flag": 1})
            if resp.get("s") != "ok":
                logger.warning("refresh_live_prices: quotes failed for chunk: %s", resp)
                continue

            for item in resp.get("d", []):
                if item.get("s") != "ok":
                    continue
                ticker = _extract_ticker(item.get("n", ""))
                v = item.get("v", {})
                ltp = float(v.get("lp", v.get("ltp", 0)) or 0)
                if ticker and ltp > 0:
                    prices[ticker] = ltp

        if prices:
            get_live_price_store().set_prices(prices, source="fyers-pull")
            logger.info("refresh_live_prices: updated %d tickers", len(prices))
            return {"status": "updated", "reason": "pull_success", "updated": len(prices)}

        logger.info("refresh_live_prices: completed with no fresh prices")
        return {"status": "skipped", "reason": "no_prices", "updated": 0}
    except Exception:
        logger.exception("refresh_live_prices: unexpected error")
        return {"status": "error", "reason": "unexpected_error", "updated": 0}
    finally:
        db.close()


def broker_reconcile_snapshot() -> dict:
    """
    Broker reconciliation snapshot:
    - refresh strategy cash from broker funds
    - refresh Holdings table from broker holdings/positions payload
    """
    db = SessionLocal()
    today = now_ist().date()
    processed = 0
    holdings_updated = 0
    positions_updated = 0
    skipped = 0
    try:
        strategies = (
            db.query(Strategy)
            .filter(Strategy.status.in_(["active", "paused"]))
            .all()
        )
        if not strategies:
            return {
                "status": "skipped",
                "reason": "no_strategies",
                "processed": 0,
                "holdingsUpdated": 0,
                "positionsUpdated": 0,
                "skipped": 0,
            }

        for strat in strategies:
            processed += 1
            fyers = _get_user_fyers(db, strat.user_id)
            if not fyers:
                skipped += 1
                continue

            try:
                funds_resp = fyers.funds()
                holdings_resp = fyers.holdings()
                positions_resp = fyers.positions()

                cash = extract_available_cash(funds_resp)
                holdings_ok = str(holdings_resp.get("s", "")).lower() == "ok"
                positions_ok = str(positions_resp.get("s", "")).lower() == "ok"

                broker_holdings = _extract_holdings(holdings_resp)
                broker_positions = _extract_positions_detailed(positions_resp)

                raw_rows = _raw_holdings_rows(holdings_resp)
                raw_holdings_count = len(raw_rows)

                if holdings_ok and raw_holdings_count > 0 and not broker_holdings:
                    logger.error(
                        "broker_reconcile_snapshot: holdings parse mismatch strat=%s raw_count=%d parsed_count=%d",
                        strat.strat_id,
                        raw_holdings_count,
                        len(broker_holdings),
                    )

                if cash is not None:
                    strat.unused_capital = float(cash)

                can_replace_holdings = (
                    (raw_holdings_count == 0) or
                    (raw_holdings_count > 0 and bool(broker_holdings))
                )
                if holdings_ok and can_replace_holdings:
                    db.query(Holdings).filter(Holdings.strat_id == strat.strat_id).delete()
                    for ticker, p in broker_holdings.items():
                        db.add(Holdings(
                            strat_id=strat.strat_id,
                            ticker=ticker,
                            qty=int(p["qty"]),
                            avg_price=float(p["avg_price"]),
                            last_price=float(p["last_price"]),
                        ))
                    holdings_updated += 1
                else:
                    logger.warning(
                        "broker_reconcile_snapshot: skip holdings replace strat=%s cash_ok=%s holdings_ok=%s positions_ok=%s raw_holdings=%d parsed_holdings=%d",
                        strat.strat_id,
                        cash is not None,
                        holdings_ok,
                        positions_ok,
                        raw_holdings_count,
                        len(broker_holdings),
                    )

                if positions_ok:
                    db.query(Positions).filter(Positions.strat_id == strat.strat_id).delete()
                    for ticker, p in broker_positions.items():
                        db.add(Positions(
                            strat_id=strat.strat_id,
                            ticker=ticker,
                            qty=int(p["qty"]),
                            avg_price=float(p["avg_price"]),
                            last_price=float(p["last_price"]),
                        ))
                    positions_updated += 1
                else:
                    logger.warning(
                        "broker_reconcile_snapshot: skip positions replace strat=%s positions_ok=%s parsed_positions=%d",
                        strat.strat_id,
                        positions_ok,
                        len(broker_positions),
                    )

                if not (holdings_ok and can_replace_holdings) and not positions_ok:
                    skipped += 1
            except Exception:
                skipped += 1
                logger.exception(
                    "broker_reconcile_snapshot: reconciliation failed strat=%s",
                    strat.strat_id,
                )

        db.commit()
        logger.info(
            "broker_reconcile_snapshot: completed processed=%d updated=%d skipped=%d",
            processed,
            holdings_updated + positions_updated,
            skipped,
        )
        return {
            "status": "ok",
            "processed": processed,
            "holdingsUpdated": holdings_updated,
            "positionsUpdated": positions_updated,
            "skipped": skipped,
        }
    except Exception:
        db.rollback()
        logger.exception("broker_reconcile_snapshot: unexpected error")
        return {
            "status": "error",
            "processed": processed,
            "holdingsUpdated": holdings_updated,
            "positionsUpdated": positions_updated,
            "skipped": skipped,
        }
    finally:
        db.close()


def eod_mtm_from_yahoo_prices() -> dict:
    """
    End-of-day MTM valuation using latest close prices from stock_price
    (typically refreshed by Yahoo sync).
    """
    db = SessionLocal()
    today = now_ist().date()
    processed = 0
    updated = 0
    skipped = 0
    try:
        strategies = (
            db.query(Strategy)
            .filter(Strategy.status.in_(["active", "paused"]))
            .all()
        )
        if not strategies:
            return {"status": "skipped", "reason": "no_strategies", "processed": 0, "updated": 0, "skipped": 0}

        for strat in strategies:
            processed += 1
            holdings = (
                db.query(Holdings)
                .filter(Holdings.strat_id == strat.strat_id)
                .all()
            )
            tickers = [h.ticker for h in holdings if int(h.qty or 0) > 0]
            if not tickers:
                cash = float(strat.unused_capital or 0)
                strat.market_value = cash
                db.query(Portfolio).filter(
                    Portfolio.strat_id == strat.strat_id,
                    Portfolio.date == today,
                ).delete(synchronize_session=False)
                db.add(Portfolio(strat_id=strat.strat_id, date=today, value=cash))
                updated += 1
                continue

            latest_date_subq = (
                db.query(
                    StockPrice.ticker.label("ticker"),
                    func.max(StockPrice.date).label("max_date"),
                )
                .filter(
                    StockPrice.ticker.in_(tickers),
                    StockPrice.date <= today,
                    StockPrice.close.isnot(None),
                )
                .group_by(StockPrice.ticker)
                .subquery()
            )

            price_rows = (
                db.query(StockPrice.ticker, StockPrice.close, StockPrice.date)
                .join(
                    latest_date_subq,
                    and_(
                        StockPrice.ticker == latest_date_subq.c.ticker,
                        StockPrice.date == latest_date_subq.c.max_date,
                    ),
                )
                .all()
            )
            price_map = {r.ticker: float(r.close) for r in price_rows}

            equity = 0.0
            missing = 0
            for h in holdings:
                qty = int(h.qty or 0)
                if qty <= 0:
                    continue
                px = float(price_map.get(h.ticker, 0.0) or 0.0)
                if px <= 0:
                    missing += 1
                    px = float(h.last_price or 0.0)
                if px > 0:
                    h.last_price = px
                    equity += qty * px

            cash = float(strat.unused_capital or 0)
            total_value = equity + cash
            strat.market_value = total_value

            db.query(Portfolio).filter(
                Portfolio.strat_id == strat.strat_id,
                Portfolio.date == today,
            ).delete(synchronize_session=False)
            db.add(Portfolio(strat_id=strat.strat_id, date=today, value=total_value))

            updated += 1
            logger.info(
                "eod_mtm_from_yahoo_prices: strat=%s equity=%.2f cash=%.2f total=%.2f tickers=%d missing_prices=%d",
                strat.strat_id,
                equity,
                cash,
                total_value,
                len(tickers),
                missing,
            )

        db.commit()
        logger.info(
            "eod_mtm_from_yahoo_prices: completed processed=%d updated=%d skipped=%d",
            processed,
            updated,
            skipped,
        )
        return {
            "status": "ok",
            "processed": processed,
            "updated": updated,
            "skipped": skipped,
            "valuationSource": "stock_price_close",
        }
    except Exception:
        db.rollback()
        logger.exception("eod_mtm_from_yahoo_prices: unexpected error")
        return {
            "status": "error",
            "processed": processed,
            "updated": updated,
            "skipped": skipped,
            "valuationSource": "stock_price_close",
        }
    finally:
        db.close()


def eod_mark_to_market(*, reconcile_from_broker: bool = False) -> None:
    """Backward-compatible wrapper retained for old call sites."""
    if reconcile_from_broker:
        broker_reconcile_snapshot()
    eod_mtm_from_yahoo_prices()


def yahoo_daily_sync_job() -> None:
    db = SessionLocal()
    try:
        result = run_yahoo_daily_sync(db)
        mtm_result = eod_mtm_from_yahoo_prices()
        logger.info(
            "yahoo_daily_sync_job: status=%s processed=%s summary=%s mtm=%s",
            result.get("status"),
            result.get("symbolsProcessed"),
            result.get("summary"),
            mtm_result,
        )
    except Exception:
        db.rollback()
        logger.exception("yahoo_daily_sync_job: unexpected error")
    finally:
        db.close()


# ── Job 1 : Queue rebalances (09:00 IST) ─────────────────────────────────────

def queue_rebalances() -> None:
    """
    Pre-market sweep:
    - Find active strategies whose next_rebalance_date is today or overdue
    - Insert into rebalance_queue (skip if already queued / in_progress)
    - Advance next_rebalance_date
    """
    today = date.today()
    db    = SessionLocal()
    try:
        strategies = (
            db.query(Strategy)
            .filter(
                Strategy.status == "active",
                Strategy.next_rebalance_date <= today,
                Strategy.next_rebalance_date.isnot(None),
            )
            .all()
        )

        for strat in strategies:
            # Skip if already in queue (pending or in_progress)
            existing = (
                db.query(RebalanceQueue)
                .filter(
                    RebalanceQueue.strat_id == strat.strat_id,
                    RebalanceQueue.status.in_(["pending", "in_progress", "skipped"]),
                )
                .first()
            )
            if existing:
                logger.info(
                    "queue_rebalances: strat %s already in queue (status=%s), skipping",
                    strat.strat_id, existing.status,
                )
                continue

            # Also skip if a "done" row was already written today (idempotency guard)
            already_done_today = (
                db.query(RebalanceQueue)
                .filter(
                    RebalanceQueue.strat_id == strat.strat_id,
                    RebalanceQueue.status == "done",
                    func.date(RebalanceQueue.queued_at) == today,
                )
                .first()
            )
            if already_done_today:
                logger.info(
                    "queue_rebalances: strat %s already completed today, skipping",
                    strat.strat_id,
                )
                continue

            # Insert new queue entry
            entry = RebalanceQueue(
                strat_id=strat.strat_id,
                user_id=strat.user_id,
                status="pending",
                queued_at=now_ist(),
            )
            db.add(entry)

            # Advance next_rebalance_date
            strat.next_rebalance_date = _advance_date(
                strat.next_rebalance_date, strat.is_monthly, strat.rebalance_freq
            )

            logger.info(
                "queue_rebalances: queued strat %s, next_rebalance_date → %s",
                strat.strat_id, strat.next_rebalance_date,
            )

        db.commit()

    except Exception:
        db.rollback()
        logger.exception("queue_rebalances: unexpected error")
    finally:
        db.close()


# ── Job 2 : Drain queue (12:00 IST) ──────────────────────────────────────────

def drain_rebalance_queue() -> None:
    """
    Mid-market execution sweep (12:00 IST):
    - Pick up all "pending" rows
    - Run MATEngine for each
    - Mark done / skipped / failed based on result
    """
    from backend.mat_engine import MATEngine   # lazy import avoids circular

    db  = SessionLocal()
    now = now_ist()
    try:
        logger.info("drain_rebalance_queue: started at=%s", now.isoformat())
        try:
            pending = (
                db.query(RebalanceQueue)
                .filter(RebalanceQueue.status.in_(["pending", "skipped"]))
                .order_by(RebalanceQueue.queued_at.asc(), RebalanceQueue.attempted_at.asc())
                .all()
            )
        except OperationalError:
            logger.warning("drain_rebalance_queue: pending query failed due DB connection issue; retrying once")
            db.rollback()
            db.close()
            db = SessionLocal()
            pending = (
                db.query(RebalanceQueue)
                .filter(RebalanceQueue.status.in_(["pending", "skipped"]))
                .order_by(RebalanceQueue.queued_at.asc(), RebalanceQueue.attempted_at.asc())
                .all()
            )

        if pending:
            skipped_count = sum(1 for entry in pending if entry.status == "skipped")
            pending_count = len(pending) - skipped_count
            logger.info(
                "drain_rebalance_queue: %d pending, %d skipped entries queued. Triggering pre-rebalance reconciliation.",
                pending_count,
                skipped_count,
            )
            try:
                broker_reconcile_snapshot()
            except Exception:
                logger.exception("drain_rebalance_queue: pre-rebalance reconciliation failed (continuing anyway)")

        # ── Market-open check (once for all entries) ────────────────────────────
        # Prefer Fyers market_status() (handles NSE holidays correctly);
        # fall back to time check if no broker session exists today.
        mkt_fyers  = _get_any_active_fyers(db)
        if mkt_fyers:
            market_open = _is_nse_cm_open(mkt_fyers)
        else:
            market_open = _is_market_hours()
            logger.warning(
                "drain_rebalance_queue: no Fyers session today, using time-based market check"
            )

        if not market_open:
            logger.warning(
                "drain_rebalance_queue: market closed — skipping %d pending entries", len(pending)
            )
            for entry in pending:
                entry.status      = "skipped"
                entry.reason      = "MARKET_CLOSED"
                entry.retry_count = (entry.retry_count or 0) + 1
            db.commit()
            return

        for entry in pending:
            entry_id = entry.id   # save before any potential rollback
            logger.info(
                "drain_rebalance_queue: triggered entry=%s strat=%s user=%s",
                entry_id,
                entry.strat_id,
                entry.user_id,
            )
            if entry.status == "skipped":
                logger.info(
                    "drain_rebalance_queue: retrying skipped entry=%s reason=%s retry_count=%s",
                    entry_id,
                    entry.reason,
                    entry.retry_count,
                )

            # Mark in-progress and commit so other workers don't double-pick
            entry.status       = "in_progress"
            entry.attempted_at = now
            db.commit()

            try:
                result = MATEngine(entry, db).run_rebalance()

                if result.skipped:
                    entry.status      = "skipped"
                    entry.reason      = (
                        result.reason
                        + (" | " + json.dumps(result.details) if result.details else "")
                    )
                    entry.retry_count = (entry.retry_count or 0) + 1
                    logger.info(
                        "drain_rebalance_queue: skipped entry=%s reason=%s",
                        entry_id,
                        result.reason,
                    )
                elif result.success:
                    entry.status       = "done"
                    entry.reason       = result.reason or entry.reason
                    entry.completed_at = now_ist()
                    logger.info("drain_rebalance_queue: done entry=%s", entry_id)
                else:
                    entry.status = "failed"
                    entry.reason = result.reason
                    logger.warning(
                        "drain_rebalance_queue: failed entry=%s reason=%s",
                        entry_id,
                        result.reason,
                    )

                db.commit()

                # Immediately sync broker ground truth after a successful rebalance.
                # broker_reconcile_snapshot() opens its own session — runs cleanly
                # after mat_engine's session has committed above.
                if result.success:
                    try:
                        broker_reconcile_snapshot()
                        logger.info(
                            "drain_rebalance_queue: broker_reconcile done entry=%s", entry_id
                        )
                    except Exception:
                        logger.exception(
                            "drain_rebalance_queue: broker_reconcile failed entry=%s (non-fatal)",
                            entry_id,
                        )

            except Exception as exc:
                # Engine called db.rollback() before raising — re-fetch entry
                db.rollback()
                entry = (
                    db.query(RebalanceQueue)
                    .filter(RebalanceQueue.id == entry_id)
                    .first()
                )
                if entry:
                    entry.status = "failed"
                    entry.reason = str(exc)[:500]
                    db.commit()
                logger.exception(
                    "drain_rebalance_queue: MATEngine raised for entry %s — %s",
                    entry_id, exc,
                )

    except Exception:
        db.rollback()
        logger.exception("drain_rebalance_queue: unexpected outer error")
    finally:
        db.close()


# ── Scheduler lifecycle ───────────────────────────────────────────────────────

def start_scheduler() -> None:
    _scheduler.add_job(
        queue_rebalances,
        trigger=CronTrigger(
            hour=int(settings.queue_rebalance_hour_ist),
            minute=int(settings.queue_rebalance_minute_ist),
            timezone=settings.scheduler_timezone,
        ),
        id="queue_rebalances",
        replace_existing=True,
        misfire_grace_time=3600,    # run even if delayed up to 1 hour
    )
    _scheduler.add_job(
        drain_rebalance_queue,
        trigger=CronTrigger(
            hour=int(settings.drain_rebalance_hour_ist),
            minute=int(settings.drain_rebalance_minute_ist),
            timezone=settings.scheduler_timezone,
        ),
        id="drain_rebalance_queue",
        replace_existing=True,
        misfire_grace_time=3600,
    )
    _scheduler.add_job(
        refresh_live_prices,
        trigger="interval",
        seconds=max(5, int(settings.live_price_refresh_seconds)),
        id="refresh_live_prices",
        replace_existing=True,
        misfire_grace_time=60,
    )
    _scheduler.add_job(
        broker_reconcile_snapshot,
        trigger=CronTrigger(
            hour=int(settings.reconcile_open_hour_ist),
            minute=int(settings.reconcile_open_minute_ist),
            timezone=settings.scheduler_timezone,
            day_of_week="mon-fri",
        ),
        id="open_broker_reconcile",
        replace_existing=True,
        misfire_grace_time=3600,
    )
    _scheduler.add_job(
        eod_mtm_from_yahoo_prices,
        trigger=CronTrigger(
            hour=int(settings.eod_mtm_hour_ist),
            minute=int(settings.eod_mtm_minute_ist),
            timezone=settings.scheduler_timezone,
            day_of_week="mon-fri",
        ),
        id="eod_mtm_from_yahoo_prices",
        replace_existing=True,
        misfire_grace_time=3600,
    )
    if settings.enable_yahoo_daily_sync:
        _scheduler.add_job(
            yahoo_daily_sync_job,
            trigger=CronTrigger(
                hour=int(settings.yahoo_daily_sync_hour_ist),
                minute=int(settings.yahoo_daily_sync_minute_ist),
                timezone=settings.scheduler_timezone,
                day_of_week="mon-fri",
            ),
            id="yahoo_daily_sync",
            replace_existing=True,
            misfire_grace_time=3600,
        )
    _scheduler.start()
    logger.info(
        "Scheduler started — queue@%02d:%02d, drain@%02d:%02d, live_prices@%ss, broker_reconcile@%02d:%02d, eod_mtm(yahoo)@%02d:%02d, yahoo_sync=%s@%02d:%02d (%s)",
        int(settings.queue_rebalance_hour_ist),
        int(settings.queue_rebalance_minute_ist),
        int(settings.drain_rebalance_hour_ist),
        int(settings.drain_rebalance_minute_ist),
        int(settings.live_price_refresh_seconds),
        int(settings.reconcile_open_hour_ist),
        int(settings.reconcile_open_minute_ist),
        int(settings.eod_mtm_hour_ist),
        int(settings.eod_mtm_minute_ist),
        bool(settings.enable_yahoo_daily_sync),
        int(settings.yahoo_daily_sync_hour_ist),
        int(settings.yahoo_daily_sync_minute_ist),
        settings.scheduler_timezone,
    )


def stop_scheduler() -> None:
    if _scheduler.running:
        _scheduler.shutdown(wait=False)
        logger.info("Scheduler stopped")
