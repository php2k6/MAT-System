from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect

from backend.config import settings
from backend.core.deps import get_current_user
from backend.core.live_prices import get_live_price_store
from backend.core.market_feed import get_market_feed_manager
from backend.core.security import decode_access_token
from backend.core.time_utils import now_ist
from backend.database import SessionLocal
from backend.models import Holdings, Positions, Strategy, User

router = APIRouter(prefix="/api/live", tags=["live"])
logger = logging.getLogger(__name__)
_IST = ZoneInfo(settings.scheduler_timezone)

# Both values are configurable via WS_PRICE_POLL_INTERVAL and
# WS_PORTFOLIO_REFRESH_INTERVAL environment variables (see config.py).
_PRICE_POLL_INTERVAL: float      = settings.ws_price_poll_interval
_HOLDINGS_REFRESH_INTERVAL: float = settings.ws_portfolio_refresh_interval


def _is_market_hours() -> bool:
    now = datetime.now(_IST)
    if now.weekday() >= 5:
        return False
    minutes      = now.hour * 60 + now.minute
    market_open  = int(settings.market_open_hour_ist)  * 60 + int(settings.market_open_minute_ist)
    market_close = int(settings.market_close_hour_ist) * 60 + int(settings.market_close_minute_ist)
    return market_open <= minutes <= market_close


def _ensure_testing_enabled() -> None:
    if not settings.enable_testing_endpoints:
        raise HTTPException(status_code=404, detail="Not found")


@router.get("/testing/feed-status")
def testing_feed_status(current_user: User = Depends(get_current_user)):
    _ensure_testing_enabled()

    manager = get_market_feed_manager()
    feed    = manager.get_debug_snapshot()
    sample_symbols = feed.get("subscribedSample") or []
    sample_prices  = get_live_price_store().get_prices(sample_symbols)

    logger.info(
        "live.testing.feed_status user_id=%s connected=%s subscribed=%s",
        current_user.user_id,
        feed.get("connected"),
        feed.get("subscribedCount"),
    )

    return {"success": True, "feed": feed, "samplePrices": sample_prices}


async def _resolve_user(websocket: WebSocket) -> User | None:
    token = websocket.cookies.get("access_token")
    if not token:
        return None
    user_id = decode_access_token(token)
    if not user_id:
        return None
    db = SessionLocal()
    try:
        return db.query(User).filter(User.user_id == user_id).first()
    finally:
        db.close()


def _pick_strategy_for_user(db, user_id):
    return (
        db.query(Strategy)
        .filter(
            Strategy.user_id == user_id,
            Strategy.status.in_(["active", "paused"]),
        )
        .order_by(Strategy.start_date.desc(), Strategy.next_rebalance_date.desc())
        .first()
    )


def _load_portfolio_from_db(db, strat_id: str) -> dict:
    """
    Load holdings + positions for a strategy into a lightweight cache dict.
    Returns:
      {
        "holdings":  {ticker: {"qty": int, "avg_price": float, "last_price": float}},
        "positions": {ticker: {"qty": int, "avg_price": float, "last_price": float}},
        "tickers":   sorted list of all tickers,
      }
    """
    holdings_rows  = db.query(Holdings).filter(Holdings.strat_id == strat_id).all()
    positions_rows = db.query(Positions).filter(Positions.strat_id == strat_id).all()

    holdings = {
        r.ticker: {"qty": int(r.qty or 0), "avg_price": float(r.avg_price or 0), "last_price": float(r.last_price or 0)}
        for r in holdings_rows if r.qty and r.qty > 0
    }
    positions = {
        r.ticker: {"qty": int(r.qty or 0), "avg_price": float(r.avg_price or 0), "last_price": float(r.last_price or 0)}
        for r in positions_rows if r.qty and r.qty > 0
    }
    tickers = sorted(set(holdings) | set(positions))
    return {"holdings": holdings, "positions": positions, "tickers": tickers}


@router.websocket("/ws")
async def live_ws(websocket: WebSocket):
    await websocket.accept()
    logger.info("live.ws accepted")

    user = await _resolve_user(websocket)
    if not user:
        logger.warning("live.ws unauthorized")
        await websocket.send_json({"type": "error", "message": "Unauthorized"})
        await websocket.close(code=4401)
        return

    logger.info("live.ws authenticated user_id=%s", user.user_id)

    store = get_live_price_store()

    # LTP change tracking (only send when price moves)
    last_sent: dict[str, float]           = {}
    last_positions_sent: dict[str, float] = {}

    # Holdings cache — loaded once, refreshed every _HOLDINGS_REFRESH_INTERVAL seconds
    portfolio: dict | None = None
    strat_id:  str | None  = None
    last_holdings_refresh: float = 0.0

    try:
        while True:
            now_mono = asyncio.get_event_loop().time()

            # ── Refresh holdings from DB (on connect + every 60s) ─────────────
            needs_refresh = (now_mono - last_holdings_refresh) >= _HOLDINGS_REFRESH_INTERVAL

            if portfolio is None or needs_refresh:
                db = SessionLocal()
                try:
                    strategy = _pick_strategy_for_user(db, user.user_id)
                    if not strategy:
                        logger.debug("live.ws no_strategy user_id=%s", user.user_id)
                        await websocket.send_json({"type": "status", "message": "NO_STRATEGY"})
                        portfolio = None
                        strat_id  = None
                        await asyncio.sleep(3)
                        continue

                    strat_id  = str(strategy.strat_id)
                    portfolio = _load_portfolio_from_db(db, strat_id)
                    last_holdings_refresh = now_mono

                    logger.debug(
                        "live.ws holdings_refreshed user_id=%s holdings=%d positions=%d",
                        user.user_id,
                        len(portfolio["holdings"]),
                        len(portfolio["positions"]),
                    )
                finally:
                    db.close()

            # ── LTP from Redis (market hours) or last_price (off hours) ───────
            use_live = _is_market_hours()
            live_map = store.get_prices(portfolio["tickers"]) if (use_live and portfolio["tickers"]) else {}

            def _resolve_ltp(ticker: str, last_price: float) -> tuple[float, int]:
                live = live_map.get(ticker)
                if use_live and live and not live.get("is_stale") and float(live.get("ltp", 0)) > 0:
                    return float(live["ltp"]), int(live.get("ts") or 0)
                return last_price, 0

            # ── Holdings LTP updates ───────────────────────────────────────────
            items = []
            for ticker, data in (portfolio["holdings"]).items():
                ltp, ts = _resolve_ltp(ticker, data["last_price"])
                if last_sent.get(ticker) != ltp:
                    last_sent[ticker] = ltp
                    items.append({"symbol": ticker, "ltp": round(ltp, 2), "ts": ts})

            if items:
                logger.debug("live.ws holdings_update user_id=%s count=%d", user.user_id, len(items))
                await websocket.send_json({
                    "type":      "holdings_update",
                    "timestamp": now_ist().isoformat(),
                    "items":     items,
                })

            # ── Positions LTP updates ──────────────────────────────────────────
            position_items = []
            for ticker, data in (portfolio["positions"]).items():
                ltp, ts = _resolve_ltp(ticker, data["last_price"])
                if last_positions_sent.get(ticker) != ltp:
                    last_positions_sent[ticker] = ltp
                    position_items.append({"symbol": ticker, "ltp": round(ltp, 2), "ts": ts})

            if position_items:
                logger.debug("live.ws positions_update user_id=%s count=%d", user.user_id, len(position_items))
                await websocket.send_json({
                    "type":      "positions_update",
                    "timestamp": now_ist().isoformat(),
                    "items":     position_items,
                })

            await asyncio.sleep(_PRICE_POLL_INTERVAL)

    except WebSocketDisconnect:
        logger.info("live.ws disconnected user_id=%s", user.user_id)
    except Exception:
        logger.exception("live.ws error user_id=%s", user.user_id)
        await websocket.close(code=1011)
