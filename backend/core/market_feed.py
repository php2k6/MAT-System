from __future__ import annotations

import logging
import threading
from collections.abc import Iterable
from typing import Any

from fyers_apiv3.FyersWebsocket.data_ws import FyersDataSocket

from backend.core.live_prices import get_live_price_store

logger = logging.getLogger(__name__)


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

    def _on_message(self, message: Any) -> None:
        try:
            prices = _extract_prices(message)
            if prices:
                get_live_price_store().set_prices(prices, source="fyers-ws")
        except Exception:
            logger.exception("MarketFeedManager: on_message error")

    def _on_error(self, message: Any) -> None:
        logger.warning("MarketFeedManager: socket error: %s", message)

    def _on_close(self, message: Any) -> None:
        logger.warning("MarketFeedManager: socket closed: %s", message)
        with self._lock:
            self._running = False

    def _on_connect(self) -> None:
        logger.info("MarketFeedManager: socket connected")
        with self._lock:
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

            self._socket = FyersDataSocket(
                access_token=access_token,
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
