from datetime import timedelta
import logging

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from backend.config import settings
from backend.core.portfolio_merge import invested_from_merged, merge_holdings_positions
from backend.core.deps import get_current_user
from backend.database import get_db
from backend.models import Holdings, Portfolio, Positions, RebalanceQueue, StockTicker, Strategy, User

router = APIRouter(prefix="/api/portfolio", tags=["portfolio"])
logger = logging.getLogger(__name__)


UNIVERSE_LABELS = {
    50:  "Nifty 50",
    100: "Nifty 100",
    150: "Nifty 150",
    250: "Nifty 250",
}


def _num(v) -> float:
    return float(v or 0)


def _pick_user_strategy(db: Session, user_id):
    """Pick currently deployed strategy (active/paused), newest first."""
    return (
        db.query(Strategy)
        .filter(
            Strategy.user_id == user_id,
            Strategy.status.in_(["active", "paused"]),
        )
        .order_by(Strategy.start_date.desc(), Strategy.next_rebalance_date.desc())
        .first()
    )


@router.get("")
def get_portfolio(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Returns the user's full portfolio state from DB only.
    - holdings/positions/cash are kept fresh by broker_reconcile_snapshot()
    - ltp per row = last_price set by broker reconcile
    - invested  = sum(avg_price * qty) for holdings rows only
    - cash      = strategy.unused_capital
    - WS /api/live/ws handles real-time LTP streaming on top of this snapshot
    """
    logger.info("portfolio.get start user_id=%s", user.user_id)

    strategy = _pick_user_strategy(db, user.user_id)
    if not strategy:
        logger.info("portfolio.get no_strategy user_id=%s", user.user_id)
        return {
            "strategyDeployed": False,
            "user":     {"name": user.name},
            "strategy": None,
            "summary":  None,
            "holdings": [],
            "positions": [],
        }

    # ── Ticker name lookup (StockTicker table) ────────────────────────────────
    names_by_ticker: dict[str, str] = {
        r.ticker: r.name
        for r in db.query(StockTicker.ticker, StockTicker.name).all()
    }

    # ── Raw Holdings / Positions ──────────────────────────────────────────────
    holding_rows = (
        db.query(Holdings)
        .filter(Holdings.strat_id == strategy.strat_id)
        .order_by(Holdings.ticker.asc())
        .all()
    )

    position_rows = (
        db.query(Positions)
        .filter(Positions.strat_id == strategy.strat_id)
        .order_by(Positions.ticker.asc())
        .all()
    )

    # Effective merge only for invested summary; payload rows remain separate.
    merged_portfolio, _sale_scripts_count = merge_holdings_positions(holding_rows, position_rows)

    holdings_payload = []
    invested_total = invested_from_merged(merged_portfolio, _sale_scripts_count)

    for h in holding_rows:
        qty       = int(h.qty or 0)
        avg_price = _num(h.avg_price)
        ltp       = _num(h.last_price)

        holdings_payload.append({
            "symbol":   h.ticker,
            "name":     names_by_ticker.get(h.ticker, h.ticker),
            "qty":      qty,
            "avgPrice": round(avg_price, 2),
            "ltp":      round(ltp, 2),
        })

    logger.info(
        "portfolio.get strategy=%s holdings=%d",
        strategy.strat_id, len(holding_rows),
    )

    # ── Raw positions payload (kept for transparency/debugging) ──────────────
    positions_payload = []
    for p in position_rows:
        qty       = int(p.qty or 0)
        avg_price = _num(p.avg_price)
        ltp       = _num(p.last_price)

        positions_payload.append({
            "symbol":   p.ticker,
            "name":     names_by_ticker.get(p.ticker, p.ticker),
            "qty":      qty,
            "avgPrice": round(avg_price, 2),
            "ltp":      round(ltp, 2),
        })

    # ── Summary ───────────────────────────────────────────────────────────────
    cash = _num(strategy.unused_capital)

    # ── Last rebalanced (most recent done queue entry) ────────────────────────
    last_done = (
        db.query(RebalanceQueue)
        .filter(
            RebalanceQueue.strat_id == strategy.strat_id,
            RebalanceQueue.status   == "done",
        )
        .order_by(RebalanceQueue.completed_at.desc())
        .first()
    )

    return {
        "strategyDeployed": True,
        "user": {"name": user.name},
        "strategy": {
            "status":        strategy.status,
            "capital":       _num(strategy.capital),
            "universe":      UNIVERSE_LABELS.get(strategy.universe, str(strategy.universe)),
            "numStocks":     int(strategy.n_stocks),
            "priceCap":      _num(strategy.price_cap) if strategy.price_cap is not None else None,
            "lookback1":     int(strategy.lb_period_1),
            "lookback2":     int(strategy.lb_period_2),
            "rebalanceType": "monthly" if strategy.is_monthly else "weekly",
            "frequency":     int(strategy.rebalance_freq),
            "startingDate":  strategy.start_date.isoformat() if strategy.start_date else None,
            "lastRebalanced": (
                last_done.completed_at.date().isoformat()
                if last_done and last_done.completed_at
                else None
            ),
            "nextRebalance": (
                strategy.next_rebalance_date.isoformat()
                if strategy.next_rebalance_date
                else None
            ),
        },
        "summary": {
            "invested": round(invested_total, 2),
            "cash":     round(cash, 2),
        },
        "holdings":  holdings_payload,
        "positions": positions_payload,
    }


@router.get("/chart")
def get_portfolio_chart(
    range: str = Query("1M"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    logger.info("portfolio.chart start user_id=%s range=%s", user.user_id, range)
    strategy = _pick_user_strategy(db, user.user_id)
    if not strategy:
        logger.info("portfolio.chart no_strategy user_id=%s", user.user_id)
        return []

    rows = (
        db.query(Portfolio.date, Portfolio.value)
        .filter(Portfolio.strat_id == strategy.strat_id)
        .order_by(Portfolio.date.asc())
        .all()
    )
    if not rows:
        logger.info("portfolio.chart no_rows strat_id=%s", strategy.strat_id)
        return []

    latest_date   = rows[-1].date
    selected_range = range.upper()
    days_map = {
        "1W":  7,
        "1M":  30,
        "3M":  90,
        "1Y":  365,
        "3Y":  365 * 3,
        "5Y":  365 * 5,
        "10Y": 365 * 10,
        "MAX": None,
    }

    if selected_range not in days_map:
        logger.warning("portfolio.chart invalid_range user_id=%s range=%s", user.user_id, selected_range)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "success": False,
                "message": "range must be one of: 1W, 1M, 3M, 1Y, 3Y, 5Y, 10Y, MAX",
            },
        )

    window = days_map[selected_range]
    if window is None:
        filtered = rows
    else:
        start_date = latest_date - timedelta(days=window)
        filtered   = [r for r in rows if r.date >= start_date]

    return [
        {
            "date":  f"{r.date.strftime('%b')} {r.date.day}",
            "value": round(_num(r.value), 2),
        }
        for r in filtered
    ]
