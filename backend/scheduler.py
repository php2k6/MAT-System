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

import logging
from datetime import date, datetime, timezone
from dateutil.relativedelta import relativedelta

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger

from sqlalchemy import func

from backend.database import SessionLocal
from backend.models import RebalanceQueue, Strategy

logger = logging.getLogger(__name__)

# ── Singleton scheduler instance ─────────────────────────────────────────────
_scheduler = BackgroundScheduler(timezone="Asia/Kolkata")


# ── Helpers ───────────────────────────────────────────────────────────────────

def _advance_date(current: date, is_monthly: bool, freq: int) -> date:
    """Return the next rebalance date by adding freq months or freq*7 days."""
    if is_monthly:
        return current + relativedelta(months=freq)
    return current + relativedelta(days=freq * 7)


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
    Mid-market execution sweep:
    - Pick up all "pending" rows
    - Call MATEngine.run_rebalance() for each
    - Mark done / skipped / failed based on result

    MATEngine is imported here (lazy) to avoid circular imports at startup.
    """
    # Lazy import — MATEngine will be implemented later
    # from backend.mat_engine import MATEngine

    db  = SessionLocal()
    now = datetime.now(timezone.utc)
    try:
        pending = (
            db.query(RebalanceQueue)
            .filter(RebalanceQueue.status == "pending")
            .all()
        )

        for entry in pending:
            entry.status       = "in_progress"
            entry.attempted_at = now
            db.commit()

            try:
                # ── Placeholder until MATEngine is built ──────────────────
                # result = MATEngine(entry.strat_id, db).run_rebalance()
                # if result.skipped:
                #     entry.status = "skipped"
                #     entry.reason = result.reason
                # else:
                #     entry.status = "done"
                #     entry.completed_at = datetime.now(timezone.utc)
                #     (row kept in table as history — no delete)
                # ─────────────────────────────────────────────────────────
                logger.info(
                    "drain_rebalance_queue: strat %s — MATEngine not yet implemented, marking skipped",
                    entry.strat_id,
                )
                entry.status = "skipped"
                entry.reason = "MAT_ENGINE_NOT_IMPLEMENTED"

            except Exception as exc:
                entry.status = "failed"
                entry.reason = str(exc)[:500]
                logger.exception(
                    "drain_rebalance_queue: strat %s failed — %s",
                    entry.strat_id, exc,
                )

            db.commit()

    except Exception:
        db.rollback()
        logger.exception("drain_rebalance_queue: unexpected error")
    finally:
        db.close()


# ── Scheduler lifecycle ───────────────────────────────────────────────────────

def start_scheduler() -> None:
    _scheduler.add_job(
        queue_rebalances,
        trigger=CronTrigger(hour=9, minute=0, timezone="Asia/Kolkata"),
        id="queue_rebalances",
        replace_existing=True,
        misfire_grace_time=3600,    # run even if delayed up to 1 hour
    )
    _scheduler.add_job(
        drain_rebalance_queue,
        trigger=CronTrigger(hour=12, minute=0, timezone="Asia/Kolkata"),
        id="drain_rebalance_queue",
        replace_existing=True,
        misfire_grace_time=3600,
    )
    _scheduler.start()
    logger.info("Scheduler started — queue_rebalances@09:00 IST, drain_queue@12:00 IST")


def stop_scheduler() -> None:
    if _scheduler.running:
        _scheduler.shutdown(wait=False)
        logger.info("Scheduler stopped")
