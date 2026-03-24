from datetime import date, timedelta
import logging

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func
from sqlalchemy.orm import Session

from backend.core.live_prices import get_live_price_store
from backend.core.deps import get_current_user
from backend.database import get_db
from backend.models import Holdings, Portfolio, RebalanceQueue, StockPrice, StockTicker, Strategy, User

router = APIRouter(prefix="/api/portfolio", tags=["portfolio"])
logger = logging.getLogger(__name__)


UNIVERSE_LABELS = {
    50: "Nifty 50",
    100: "Nifty 100",
    150: "Nifty 150",
    250: "Nifty 250",
}


def _num(v) -> float:
    return float(v or 0)


def _pick_user_strategy(db: Session, user_id):
    """Pick currently deployed strategy (active/paused), newest first."""
    deployed = (
        db.query(Strategy)
        .filter(
            Strategy.user_id == user_id,
            Strategy.status.in_(["active", "paused"]),
        )
        .order_by(Strategy.start_date.desc(), Strategy.next_rebalance_date.desc())
        .first()
    )
    return deployed


@router.get("")
def get_portfolio(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    logger.info("portfolio.get start user_id=%s", user.user_id)
    strategy = _pick_user_strategy(db, user.user_id)
    if not strategy:
        logger.info("portfolio.get no_strategy user_id=%s", user.user_id)
        return {
            "strategyDeployed": False,
            "user": {"name": user.name},
            "strategy": None,
            "summary": None,
            "holdings": [],
        }

    latest_price_date = db.query(func.max(StockPrice.date)).scalar()
    prices_by_ticker = {}
    names_by_ticker = {}

    if latest_price_date:
        price_rows = (
            db.query(StockPrice.ticker, StockPrice.close, StockPrice.daily_return)
            .filter(StockPrice.date == latest_price_date)
            .all()
        )
        prices_by_ticker = {
            r.ticker: {
                "ltp": _num(r.close),
                "daily_return": _num(r.daily_return),
            }
            for r in price_rows
        }

    ticker_names = db.query(StockTicker.ticker, StockTicker.name).all()
    names_by_ticker = {r.ticker: r.name for r in ticker_names}

    holding_rows = (
        db.query(Holdings)
        .filter(Holdings.strat_id == strategy.strat_id)
        .order_by(Holdings.ticker.asc())
        .all()
    )
    logger.info("portfolio.get strategy=%s holdings=%d", strategy.strat_id, len(holding_rows))

    holdings_payload = []
    invested_total = 0.0
    live_equity = 0.0
    used_live_price = False
    store = get_live_price_store()
    live_prices = store.get_prices([h.ticker for h in holding_rows]) if holding_rows else {}

    for h in holding_rows:
        qty = int(h.qty or 0)
        avg_price = _num(h.avg_price)
        live = live_prices.get(h.ticker)
        if live and not live.get("is_stale") and _num(live.get("ltp")) > 0:
            ltp = _num(live.get("ltp"))
            price_source = "live"
            price_ts = int(live.get("ts") or 0)
            used_live_price = True
        else:
            ltp = prices_by_ticker.get(h.ticker, {}).get("ltp", _num(h.last_price))
            price_source = "snapshot"
            price_ts = None

        value = qty * ltp
        cost = qty * avg_price
        pnl = value - cost
        pnl_pct = (pnl / cost * 100) if cost > 0 else 0.0
        live_equity += value

        day_ret = prices_by_ticker.get(h.ticker, {}).get("daily_return", 0.0)
        day_change = day_ret * 100 if abs(day_ret) <= 1 else day_ret

        invested_total += cost
        holdings_payload.append(
            {
                "symbol": h.ticker,
                "name": names_by_ticker.get(h.ticker, h.ticker),
                "qty": qty,
                "avgPrice": round(avg_price, 2),
                "ltp": round(ltp, 2),
                "value": round(value, 2),
                "pnl": round(pnl, 2),
                "pnlPct": round(pnl_pct, 2),
                "dayChange": round(day_change, 2),
                "priceSource": price_source,
                "priceTs": price_ts,
            }
        )

    cash = _num(strategy.unused_capital)
    current_value = round(live_equity + cash, 2) if used_live_price else _num(strategy.market_value)
    # Strategy-level PnL should be measured against deployed capital, not
    # current holdings cost, so closed positions are reflected correctly.
    baseline_capital = _num(strategy.capital)
    pnl = current_value - baseline_capital
    pnl_pct = (pnl / baseline_capital * 100) if baseline_capital > 0 else 0.0

    last_done = (
        db.query(RebalanceQueue)
        .filter(
            RebalanceQueue.strat_id == strategy.strat_id,
            RebalanceQueue.status == "done",
        )
        .order_by(RebalanceQueue.completed_at.desc())
        .first()
    )

    return {
        "strategyDeployed": True,
        "user": {"name": user.name},
        "strategy": {
            "status": strategy.status,
            "universe": UNIVERSE_LABELS.get(strategy.universe, str(strategy.universe)),
            "numStocks": int(strategy.n_stocks),
            "priceCap": _num(strategy.price_cap) if strategy.price_cap is not None else None,
            "lookback1": int(strategy.lb_period_1),
            "lookback2": int(strategy.lb_period_2),
            "capital": _num(strategy.capital),
            "rebalanceType": "monthly" if strategy.is_monthly else "weekly",
            "frequency": int(strategy.rebalance_freq),
            "startingDate": strategy.start_date.isoformat() if strategy.start_date else None,
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
            "currentValue": round(current_value, 2),
            "pnl": round(pnl, 2),
            "pnlPct": round(pnl_pct, 2),
            "cash": round(cash, 2),
            "priceSource": "live" if used_live_price else "snapshot",
        },
        "holdings": holdings_payload,
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

    latest_date = rows[-1].date
    selected_range = range.upper()
    days_map = {
        "1W": 7,
        "1M": 30,
        "3M": 90,
        "1Y": 365,
        "3Y": 365 * 3,
        "5Y": 365 * 5,
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
        filtered = [r for r in rows if r.date >= start_date]

    # Return "Jan 1" style labels expected by frontend.
    return [
        {
            "date": f"{r.date.strftime('%b')} {r.date.day}",
            "value": round(_num(r.value), 2),
        }
        for r in filtered
    ]
