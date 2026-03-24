from __future__ import annotations

import asyncio
import logging
from datetime import date
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from fyers_apiv3 import fyersModel

from backend.config import settings
from backend.core.deps import get_current_user
from backend.core.live_prices import get_live_price_store
from backend.core.market_feed import get_market_feed_manager
from backend.core.security import decode_access_token, decrypt_token
from backend.database import SessionLocal
from backend.models import BrokerSession, Holdings, Strategy, User

router = APIRouter(prefix="/api/live", tags=["live"])
logger = logging.getLogger(__name__)


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


def _extract_available_cash(funds_resp: dict) -> float | None:
    if funds_resp.get("s") != "ok":
        return None
    limits = funds_resp.get("fund_limit", []) or []
    for item in limits:
        title = str(item.get("title", ""))
        if "Available Balance" in title or "available_balance" in title.lower():
            return float(item.get("equityAmount", item.get("val", 0)) or 0)
    if limits:
        return sum(float(i.get("equityAmount", i.get("val", 0)) or 0) for i in limits)
    return None


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

        funds = _extract_available_cash(fyers.funds())
        positions = _extract_positions_snapshot(fyers.positions())
        if funds is None or positions is None:
            return None
        invested, positions_value, pnl = positions
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
                tickers = [h.ticker for h in holdings if h.qty and h.qty > 0]
                live_map = store.get_prices(tickers)

                items = []
                equity = 0.0
                for row in holdings:
                    qty = int(row.qty or 0)
                    if qty <= 0:
                        continue
                    live = live_map.get(row.ticker)
                    if live and not live.get("is_stale") and float(live.get("ltp", 0)) > 0:
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
                            "timestamp": datetime.now(timezone.utc).isoformat(),
                            "items": items,
                        }
                    )

                fyers_summary = _fetch_fyers_summary_for_user(db, user.user_id)
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
                            "timestamp": datetime.now(timezone.utc).isoformat(),
                            "summary": {
                                "invested": round(invested, 2),
                                "currentValue": round(total_value, 2),
                                "cash": round(cash, 2),
                                "equity": round(equity_summary, 2),
                                "pnl": round(pnl, 2),
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
