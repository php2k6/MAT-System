from __future__ import annotations

import logging
import threading
import time
from collections.abc import Iterable
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from fyers_apiv3.FyersWebsocket.data_ws import FyersDataSocket

from backend.config import settings
from backend.core.live_prices import get_live_price_store

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


def _norm_symbol(symbol: str | None) -> str | None:
    if not symbol:
        return None
    s = symbol.strip().upper()
    if ":" in s:
        s = s.split(":", 1)[1]
    if s.endswith("-EQ"):
        s = s[:-3]
    return s or None


def _to_fyers_symbol(ticker: str) -> str:
    return f"NSE:{ticker}-EQ"


def _extract_prices(payload: Any) -> dict[str, float]:
    """
    Best-effort parser for Fyers websocket messages.
    Supports nested dict/list shapes and picks symbol+ltp fields when present.
    """
    prices: dict[str, float] = {}

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            symbol = _norm_symbol(
                node.get("symbol")
                or node.get("n")
                or node.get("s")
                or node.get("ticker")
            )

            ltp = (
                node.get("ltp")
                or node.get("lp")
                or node.get("last_price")
                or node.get("lastPrice")
            )
            if symbol and ltp is not None:
                try:
                    val = float(ltp)
                    if val > 0:
                        prices[symbol] = val
                except Exception:
                    pass

            for child in node.values():
                if isinstance(child, (dict, list, tuple)):
                    walk(child)

        elif isinstance(node, (list, tuple)):
            for item in node:
                walk(item)

    walk(payload)
    return prices


class MarketFeedManager:
    """Singleton-style manager for backend market data websocket."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._socket: FyersDataSocket | None = None
        self._running = False
        self._subscribed: set[str] = set()
        self._last_message_ts_ms: int | None = None
        self._last_message_price_count: int = 0
        self._total_messages: int = 0
        self._total_price_updates: int = 0
        self._last_message_preview: str = ""
        self._last_error: str = ""
        self._last_close: str = ""
        self._last_connect_ts_ms: int | None = None

    @staticmethod
    def _now_ms() -> int:
        return int(time.time() * 1000)

    def _on_message(self, message: Any) -> None:
        try:
            prices = _extract_prices(message)
            with self._lock:
                self._total_messages += 1
                self._last_message_ts_ms = self._now_ms()
                self._last_message_price_count = len(prices)
                self._total_price_updates += len(prices)
                self._last_message_preview = str(message)[:500]
            if prices:
                get_live_price_store().set_prices(prices, source="fyers-ws")
        except Exception:
            logger.exception("MarketFeedManager: on_message error")

    def _on_error(self, message: Any) -> None:
        with self._lock:
            self._last_error = str(message)[:300]
        logger.warning("MarketFeedManager: socket error: %s", message)

    def _on_close(self, message: Any) -> None:
        logger.warning("MarketFeedManager: socket closed: %s", message)
        with self._lock:
            self._running = False
            self._last_close = str(message)[:300]

    def _on_connect(self) -> None:
        logger.info("MarketFeedManager: socket connected")
        with self._lock:
            self._last_connect_ts_ms = self._now_ms()
            symbols = sorted(self._subscribed)
            socket = self._socket

        if socket and symbols:
            try:
                socket.subscribe(symbols=[_to_fyers_symbol(t) for t in symbols], data_type="SymbolUpdate")
                socket.keep_running()
                logger.info("MarketFeedManager: subscribed %d symbols", len(symbols))
            except Exception:
                logger.exception("MarketFeedManager: subscribe failed on connect")

    def ensure_running(self, access_token: str, symbols: Iterable[str]) -> bool:
        """
        Ensure a single market feed is running.
        Returns True if started now, False if already running.
        """
        if not _is_market_hours():
            logger.info("MarketFeedManager: skipped startup outside market hours")
            return False

        normalized = {_norm_symbol(s) for s in symbols}
        normalized = {s for s in normalized if s}

        with self._lock:
            self._subscribed.update(normalized)

            if self._running and self._socket:
                try:
                    if bool(self._socket.is_connected()):
                        return False
                except Exception:
                    pass

            Path(settings.log_dir).mkdir(parents=True, exist_ok=True)
            self._socket = FyersDataSocket(
                access_token=access_token,
                log_path=settings.log_dir,
                litemode=True,
                reconnect=True,
                on_message=self._on_message,
                on_error=self._on_error,
                on_connect=self._on_connect,
                on_close=self._on_close,
            )
            self._running = True

        try:
            self._socket.connect()
            return True
        except Exception:
            with self._lock:
                self._running = False
            logger.exception("MarketFeedManager: failed to start socket")
            raise

    def is_connected(self) -> bool:
        with self._lock:
            socket = self._socket
            running = self._running

        if not running or not socket:
            return False

        try:
            return bool(socket.is_connected())
        except Exception:
            return False

    def get_debug_snapshot(self) -> dict[str, Any]:
        with self._lock:
            subscribed = sorted(self._subscribed)
            running = self._running
            last_message_ts_ms = self._last_message_ts_ms
            last_message_price_count = self._last_message_price_count
            total_messages = self._total_messages
            total_price_updates = self._total_price_updates
            last_message_preview = self._last_message_preview
            last_error = self._last_error
            last_close = self._last_close
            last_connect_ts_ms = self._last_connect_ts_ms

        return {
            "running": running,
            "connected": self.is_connected(),
            "subscribedCount": len(subscribed),
            "subscribedSample": subscribed[:25],
            "lastConnectTsMs": last_connect_ts_ms,
            "lastMessageTsMs": last_message_ts_ms,
            "lastMessagePriceCount": last_message_price_count,
            "totalMessages": total_messages,
            "totalPriceUpdates": total_price_updates,
            "lastMessagePreview": last_message_preview,
            "lastError": last_error,
            "lastClose": last_close,
        }

    def stop(self) -> None:
        with self._lock:
            socket = self._socket
            self._socket = None
            self._running = False

        if socket:
            try:
                socket.close_connection()
            except Exception:
                logger.exception("MarketFeedManager: failed to close socket")


_manager: MarketFeedManager | None = None


def get_market_feed_manager() -> MarketFeedManager:
    global _manager
    if _manager is None:
        _manager = MarketFeedManager()
    return _manager
