from __future__ import annotations

import logging
import time
from threading import Lock
from typing import Any

from backend.config import settings

logger = logging.getLogger(__name__)

try:
    import redis  # type: ignore
except Exception:  # pragma: no cover - optional dependency fallback
    redis = None


class LivePriceStore:
    """Redis-backed latest-price cache with in-memory fallback."""

    def __init__(self, redis_url: str, ttl_seconds: int, stale_after_seconds: int) -> None:
        self.ttl_seconds = max(30, int(ttl_seconds))
        self.stale_after_seconds = max(5, int(stale_after_seconds))
        self._lock = Lock()
        self._memory: dict[str, dict[str, Any]] = {}
        self._redis = None

        if redis and redis_url:
            try:
                self._redis = redis.Redis.from_url(redis_url, decode_responses=True)
                self._redis.ping()
                logger.info("LivePriceStore: connected to Redis")
            except Exception as exc:
                self._redis = None
                logger.warning("LivePriceStore: Redis unavailable, falling back to memory cache: %s", exc)
        else:
            logger.info("LivePriceStore: Redis disabled, using memory cache")

    @staticmethod
    def _key(ticker: str) -> str:
        return f"ltp:{ticker.upper()}"

    @staticmethod
    def _now_ms() -> int:
        return int(time.time() * 1000)

    def is_stale(self, ts_ms: int | None) -> bool:
        if not ts_ms:
            return True
        return (self._now_ms() - int(ts_ms)) > (self.stale_after_seconds * 1000)

    def set_prices(self, prices: dict[str, float], *, source: str = "fyers", ts_ms: int | None = None) -> None:
        if not prices:
            return

        ts_ms = ts_ms or self._now_ms()
        clean_prices = {
            t.upper(): float(v)
            for t, v in prices.items()
            if t and v is not None and float(v) > 0
        }
        if not clean_prices:
            return

        if self._redis:
            try:
                pipe = self._redis.pipeline()
                for ticker, ltp in clean_prices.items():
                    key = self._key(ticker)
                    pipe.hset(key, mapping={"ltp": ltp, "ts": ts_ms, "source": source})
                    pipe.expire(key, self.ttl_seconds)
                pipe.execute()
                return
            except Exception as exc:
                logger.warning("LivePriceStore.set_prices Redis write failed, using memory fallback: %s", exc)

        with self._lock:
            for ticker, ltp in clean_prices.items():
                self._memory[ticker] = {"ltp": ltp, "ts": ts_ms, "source": source}

    def get_prices(self, tickers: list[str]) -> dict[str, dict[str, Any]]:
        symbols = [t.upper() for t in tickers if t]
        if not symbols:
            return {}

        if self._redis:
            try:
                pipe = self._redis.pipeline()
                for ticker in symbols:
                    pipe.hgetall(self._key(ticker))
                rows = pipe.execute()

                result: dict[str, dict[str, Any]] = {}
                for ticker, row in zip(symbols, rows):
                    if not row:
                        continue
                    ltp = float(row.get("ltp", 0) or 0)
                    ts = int(float(row.get("ts", 0) or 0))
                    if ltp <= 0:
                        continue
                    result[ticker] = {
                        "ltp": ltp,
                        "ts": ts,
                        "source": row.get("source") or "fyers",
                        "is_stale": self.is_stale(ts),
                    }
                return result
            except Exception as exc:
                logger.warning("LivePriceStore.get_prices Redis read failed, using memory fallback: %s", exc)

        with self._lock:
            result = {}
            for ticker in symbols:
                row = self._memory.get(ticker)
                if not row:
                    continue
                result[ticker] = {
                    "ltp": float(row.get("ltp", 0) or 0),
                    "ts": int(row.get("ts", 0) or 0),
                    "source": row.get("source") or "fyers",
                    "is_stale": self.is_stale(int(row.get("ts", 0) or 0)),
                }
            return result

    def status(self) -> dict[str, Any]:
        return {
            "redisEnabled": bool(self._redis),
            "ttlSeconds": self.ttl_seconds,
            "staleAfterSeconds": self.stale_after_seconds,
        }


_store: LivePriceStore | None = None


def get_live_price_store() -> LivePriceStore:
    global _store
    if _store is None:
        _store = LivePriceStore(
            redis_url=settings.redis_url,
            ttl_seconds=settings.redis_price_ttl_seconds,
            stale_after_seconds=settings.live_price_stale_after_seconds,
        )
    return _store
