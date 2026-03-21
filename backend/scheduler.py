"""
scheduler.py
────────────
Two APScheduler jobs that run daily on IST:

  Job 1 — queue_rebalances()      09:00 IST (pre-market)
    • Checks every active strategy for next_rebalance_date == today
    • Inserts a "pending" row into rebalance_queue
    • Advances next_rebalance_date by rebalance_freq months or weeks

  Job 2 — drain_rebalance_queue() 12:00 IST (mid-market)
    • Picks up all "pending" rows from rebalance_queue
    • Calls MATEngine.run_rebalance() for each
    • Updates status/reason on success, skip, or failure
"""

from __future__ import annotations

import json
import logging
from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo
from dateutil.relativedelta import relativedelta

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger

from sqlalchemy import func

from backend.config import settings
from backend.core.live_prices import get_live_price_store
from backend.core.security import decrypt_token
from backend.database import SessionLocal
from backend.models import BrokerSession, Holdings, Portfolio, RebalanceQueue, StockTicker, Strategy
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
    return fyersModel.FyersModel(
        client_id=settings.fyers_app_id,
        token=token,
        is_async=False,
        log_path="",
    )


def _extract_ticker(symbol: str) -> str:
    # NSE:INFY-EQ -> INFY
    if ":" in symbol:
        symbol = symbol.split(":", 1)[1]
    return symbol.replace("-EQ", "")


def refresh_live_prices() -> None:
    """
    Pull latest prices for tracked tickers and store them in Redis cache.
    Runs on interval during market hours.
    """
    if not _is_market_hours():
        return

    db = SessionLocal()
    try:
        tickers = [r.ticker for r in db.query(StockTicker.ticker).all()]
        if not tickers:
            return

        fyers = _get_any_active_fyers(db)
        if not fyers:
            logger.debug("refresh_live_prices: no active broker session for today")
            return

        prices: dict[str, float] = {}
        for chunk in _iter_chunks(tickers, 50):
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
            get_live_price_store().set_prices(prices, source="fyers")
            logger.info("refresh_live_prices: updated %d tickers", len(prices))
    except Exception:
        logger.exception("refresh_live_prices: unexpected error")
    finally:
        db.close()


def eod_mark_to_market() -> None:
    """
    End-of-day valuation snapshot:
    - refresh holdings.last_price from latest live cache (fallback existing)
    - update strategy.market_value
    - upsert portfolio value for today
    """
    db = SessionLocal()
    today = date.today()
    try:
        strategies = (
            db.query(Strategy)
            .filter(Strategy.status.in_(["active", "paused"]))
            .all()
        )
        if not strategies:
            return

        for strat in strategies:
            holdings = (
                db.query(Holdings)
                .filter(Holdings.strat_id == strat.strat_id)
                .all()
            )
            tickers = [h.ticker for h in holdings if (h.qty or 0) > 0]
            live_map = get_live_price_store().get_prices(tickers)

            equity = 0.0
            for h in holdings:
                qty = int(h.qty or 0)
                if qty <= 0:
                    continue

                live = live_map.get(h.ticker)
                if live and not live.get("is_stale") and float(live.get("ltp", 0)) > 0:
                    ltp = float(live["ltp"])
                else:
                    ltp = float(h.last_price or 0)

                if ltp > 0:
                    h.last_price = ltp
                equity += qty * ltp

            cash = float(strat.unused_capital or 0)
            total_value = equity + cash
            strat.market_value = total_value

            row = (
                db.query(Portfolio)
                .filter(Portfolio.strat_id == strat.strat_id, Portfolio.date == today)
                .first()
            )
            if row:
                row.value = total_value
            else:
                db.add(Portfolio(strat_id=strat.strat_id, date=today, value=total_value))

        db.commit()
        logger.info("eod_mark_to_market: completed for %d strategies", len(strategies))
    except Exception:
        db.rollback()
        logger.exception("eod_mark_to_market: unexpected error")
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
                    RebalanceQueue.status.in_(["pending", "in_progress"]),
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
                queued_at=datetime.now(timezone.utc),
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
    now = datetime.now(timezone.utc)
    try:
        pending = (
            db.query(RebalanceQueue)
            .filter(RebalanceQueue.status == "pending")
            .all()
        )

        for entry in pending:
            entry_id = entry.id   # save before any potential rollback

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
                elif result.success:
                    entry.status       = "done"
                    entry.completed_at = datetime.now(timezone.utc)
                else:
                    entry.status = "failed"
                    entry.reason = result.reason

                db.commit()

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
        eod_mark_to_market,
        trigger=CronTrigger(
            hour=int(settings.eod_mtm_hour_ist),
            minute=int(settings.eod_mtm_minute_ist),
            timezone=settings.scheduler_timezone,
            day_of_week="mon-fri",
        ),
        id="eod_mark_to_market",
        replace_existing=True,
        misfire_grace_time=3600,
    )
    _scheduler.start()
    logger.info(
        "Scheduler started — queue@%02d:%02d, drain@%02d:%02d, live_prices@%ss, eod_mtm@%02d:%02d (%s)",
        int(settings.queue_rebalance_hour_ist),
        int(settings.queue_rebalance_minute_ist),
        int(settings.drain_rebalance_hour_ist),
        int(settings.drain_rebalance_minute_ist),
        int(settings.live_price_refresh_seconds),
        int(settings.eod_mtm_hour_ist),
        int(settings.eod_mtm_minute_ist),
        settings.scheduler_timezone,
    )


def stop_scheduler() -> None:
    if _scheduler.running:
        _scheduler.shutdown(wait=False)
        logger.info("Scheduler stopped")
