from __future__ import annotations

import asyncio
import logging
from datetime import date
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from fyers_apiv3 import fyersModel

from backend.config import settings
from backend.core.deps import get_current_user
from backend.core.fyers_funds import extract_available_cash
from backend.core.live_prices import get_live_price_store
from backend.core.market_feed import get_market_feed_manager
from backend.core.security import decode_access_token, decrypt_token
from backend.core.time_utils import now_ist
from backend.database import SessionLocal
from backend.models import BrokerSession, Holdings, Positions, Strategy, User

router = APIRouter(prefix="/api/live", tags=["live"])
logger = logging.getLogger(__name__)
_IST = ZoneInfo(settings.scheduler_timezone)


def _is_market_hours() -> bool:
    now_ist = datetime.now(_IST)
    if now_ist.weekday() >= 5:
        return False

    minutes = now_ist.hour * 60 + now_ist.minute
    market_open = int(settings.market_open_hour_ist) * 60 + int(settings.market_open_minute_ist)
    market_close = int(settings.market_close_hour_ist) * 60 + int(settings.market_close_minute_ist)
    return market_open <= minutes <= market_close


def _ensure_testing_enabled() -> None:
    if not settings.enable_testing_endpoints:
        raise HTTPException(status_code=404, detail="Not found")


@router.get("/testing/feed-status")
def testing_feed_status(current_user: User = Depends(get_current_user)):
    _ensure_testing_enabled()

    manager = get_market_feed_manager()
    feed = manager.get_debug_snapshot()
    sample_symbols = feed.get("subscribedSample") or []
    sample_prices = get_live_price_store().get_prices(sample_symbols)

    logger.info(
        "live.testing.feed_status user_id=%s connected=%s subscribed=%s",
        current_user.user_id,
        feed.get("connected"),
        feed.get("subscribedCount"),
    )

    return {
        "success": True,
        "feed": feed,
        "samplePrices": sample_prices,
    }


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


def _extract_positions_snapshot(positions_resp: dict) -> tuple[float, float, float] | None:
    if positions_resp.get("s") != "ok":
        return None
    rows = positions_resp.get("netPositions") or positions_resp.get("overall") or []

    invested = 0.0
    current_value = 0.0
    pnl = 0.0
    for row in rows:
        qty = abs(int(row.get("netQty", row.get("qty", 0)) or 0))
        if qty <= 0:
            continue
        avg = float(row.get("netAvg", row.get("avgPrice", row.get("buyAvg", 0))) or 0)
        ltp = float(row.get("ltp", 0) or 0)
        market_val = float(row.get("marketVal", 0) or 0)
        pl = float(row.get("pl", row.get("pnl", 0)) or 0)

        pos_invested = qty * avg if avg > 0 else 0.0
        pos_current = market_val if market_val > 0 else (qty * ltp if ltp > 0 else pos_invested)
        invested += pos_invested
        current_value += pos_current
        pnl += pl if pl != 0 else (pos_current - pos_invested)

    return invested, current_value, pnl


def _extract_holdings_snapshot(holdings_resp: dict) -> tuple[float, float, float] | None:
    if holdings_resp.get("s") != "ok":
        return None

    rows = holdings_resp.get("holdings") or holdings_resp.get("overall") or []
    if isinstance(rows, dict):
        rows = rows.get("holdings") or rows.get("overall") or []
    if not isinstance(rows, list):
        return None

    invested = 0.0
    current_value = 0.0
    pnl = 0.0

    for row in rows:
        if not isinstance(row, dict):
            continue
        qty = int(row.get("quantity", row.get("qty", 0)) or 0)
        if qty <= 0:
            continue

        avg = float(row.get("costPrice", row.get("avgPrice", row.get("holdingPrice", 0))) or 0)
        ltp = float(row.get("ltp", row.get("lastTradedPrice", 0)) or 0)
        market_val = float(row.get("marketVal", 0) or 0)

        pos_invested = qty * avg if avg > 0 else 0.0
        pos_current = market_val if market_val > 0 else (qty * ltp if ltp > 0 else pos_invested)
        invested += pos_invested
        current_value += pos_current
        pnl += pos_current - pos_invested

    return invested, current_value, pnl


def _fetch_fyers_summary_for_user(db, user_id):
    try:
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
        fyers = fyersModel.FyersModel(
            client_id=settings.fyers_app_id,
            token=token,
            is_async=False,
            log_path=settings.log_dir,
        )

        funds = extract_available_cash(fyers.funds())
        holdings = _extract_holdings_snapshot(fyers.holdings())
        positions = _extract_positions_snapshot(fyers.positions())
        snapshot = holdings if holdings is not None else positions
        if funds is None or snapshot is None:
            return None
        invested, positions_value, pnl = snapshot
        current_value = funds + positions_value
        pnl_pct = (pnl / invested * 100.0) if invested > 0 else 0.0

        return {
            "invested": invested,
            "cash": funds,
            "equity": positions_value,
            "currentValue": current_value,
            "pnl": pnl,
            "pnlPct": pnl_pct,
        }
    except Exception:
        logger.debug("live.ws fyers_summary_unavailable user_id=%s", user_id, exc_info=True)
        return None


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
    last_sent: dict[str, float] = {}
    last_positions_sent: dict[str, float] = {}
    last_summary_value: float | None = None

    try:
        while True:
            db = SessionLocal()
            try:
                strategy = _pick_strategy_for_user(db, user.user_id)
                if not strategy:
                    logger.debug("live.ws no_strategy user_id=%s", user.user_id)
                    await websocket.send_json({"type": "status", "message": "NO_STRATEGY"})
                    await asyncio.sleep(3)
                    continue

                holdings = (
                    db.query(Holdings)
                    .filter(Holdings.strat_id == strategy.strat_id)
                    .all()
                )
                positions = (
                    db.query(Positions)
                    .filter(Positions.strat_id == strategy.strat_id)
                    .all()
                )
                holding_tickers = [h.ticker for h in holdings if h.qty and h.qty > 0]
                position_tickers = [p.ticker for p in positions if p.qty and p.qty > 0]
                tickers = sorted(set(holding_tickers) | set(position_tickers))
                use_live_prices = _is_market_hours()
                live_map = store.get_prices(tickers) if use_live_prices else {}

                items = []
                equity = 0.0
                for row in holdings:
                    qty = int(row.qty or 0)
                    if qty <= 0:
                        continue
                    live = live_map.get(row.ticker)
                    if use_live_prices and live and not live.get("is_stale") and float(live.get("ltp", 0)) > 0:
                        ltp = float(live["ltp"])
                        ts = int(live.get("ts") or 0)
                    else:
                        ltp = float(row.last_price or 0)
                        ts = 0

                    equity += qty * ltp
                    if last_sent.get(row.ticker) != ltp:
                        last_sent[row.ticker] = ltp
                        items.append({"symbol": row.ticker, "ltp": round(ltp, 2), "ts": ts})

                if items:
                    logger.debug("live.ws holdings_update user_id=%s count=%d", user.user_id, len(items))
                    await websocket.send_json(
                        {
                            "type": "holdings_update",
                            "timestamp": now_ist().isoformat(),
                            "items": items,
                        }
                    )

                position_items = []
                positions_total_pnl = 0.0
                for p in positions:
                    qty = int(p.qty or 0)
                    if qty <= 0:
                        continue
                    avg = float(p.avg_price or 0)
                    live = live_map.get(p.ticker)
                    if use_live_prices and live and not live.get("is_stale") and float(live.get("ltp", 0)) > 0:
                        ltp = float(live["ltp"])
                        ts = int(live.get("ts") or 0)
                    else:
                        ltp = float(p.last_price or 0)
                        ts = 0

                    market_value = qty * ltp
                    invested = qty * avg
                    pnl = market_value - invested
                    pnl_pct = (pnl / invested * 100.0) if invested > 0 else 0.0
                    positions_total_pnl += pnl

                    prev_ltp = last_positions_sent.get(p.ticker)
                    if prev_ltp != ltp:
                        last_positions_sent[p.ticker] = ltp
                        position_items.append({"symbol": p.ticker, "ltp": round(ltp, 2), "ts": ts})

                if position_items:
                    logger.debug("live.ws positions_update user_id=%s count=%d", user.user_id, len(position_items))
                    await websocket.send_json(
                        {
                            "type": "positions_update",
                            "timestamp": now_ist().isoformat(),
                            "items": position_items,
                        }
                    )

                fyers_summary = _fetch_fyers_summary_for_user(db, user.user_id) if use_live_prices else None
                if fyers_summary:
                    invested = float(fyers_summary["invested"])
                    cash = float(fyers_summary["cash"])
                    equity_summary = float(fyers_summary["equity"])
                    total_value = float(fyers_summary["currentValue"])
                    pnl = float(fyers_summary["pnl"])
                    pnl_pct = float(fyers_summary["pnlPct"])
                else:
                    # Fallback when broker snapshot is unavailable.
                    cash = float(strategy.unused_capital or 0)
                    total_value = equity + cash
                    invested = float(strategy.capital or 0)
                    pnl = total_value - invested
                    pnl_pct = (pnl / invested * 100.0) if invested > 0 else 0.0
                    equity_summary = equity

                if last_summary_value is None or abs(total_value - last_summary_value) >= 0.01:
                    last_summary_value = total_value
                    logger.debug("live.ws summary_update user_id=%s value=%.2f", user.user_id, total_value)
                    await websocket.send_json(
                        {
                            "type": "summary_update",
                            "timestamp": now_ist().isoformat(),
                            "summary": {
                                "invested": round(invested, 2),
                                "currentValue": round(total_value, 2),
                                "cash": round(cash, 2),
                                "equity": round(equity_summary, 2),
                                "pnl": round(pnl, 2),
                                "totalPnl": round(positions_total_pnl if positions else pnl, 2),
                                "pnlPct": round(pnl_pct, 2),
                            },
                        }
                    )
            finally:
                db.close()

            await asyncio.sleep(2)

    except WebSocketDisconnect:
        logger.info("live.ws disconnected user_id=%s", user.user_id)
        return
    except Exception:
        logger.exception("live.ws error user_id=%s", user.user_id)
        await websocket.close(code=1011)
