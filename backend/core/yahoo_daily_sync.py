from __future__ import annotations

import logging
import math
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any

import numpy as np
import pandas as pd
import yfinance as yf
from sqlalchemy import func
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from backend.config import settings
from backend.models import StockPrice, StockTicker

logger = logging.getLogger(__name__)


@dataclass
class SymbolSyncResult:
    symbol: str
    mode: str  # up_to_date | incremental | full_refetch | failed | no_data
    inserted_or_upserted: int = 0
    deleted: int = 0
    reason: str = ""


def _to_ts(value: date | datetime | pd.Timestamp) -> pd.Timestamp:
    return pd.to_datetime(value).normalize()


def _clean_ohlcv(df: pd.DataFrame, symbol: str) -> pd.DataFrame:
    if df.empty:
        return df

    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)

    out = df.reset_index().copy()
    out.columns = [str(c).lower() for c in out.columns]
    keep = [c for c in ["date", "open", "high", "low", "close", "volume"] if c in out.columns]
    out = out[keep].dropna(subset=["close"])
    if out.empty:
        return out

    out.insert(0, "symbol", symbol)
    out["date"] = pd.to_datetime(out["date"]).dt.normalize()
    return out


def _compute_indicators_full(stock_df: pd.DataFrame, window: int, annualise: bool) -> pd.DataFrame:
    df = stock_df.sort_values("date").reset_index(drop=True).copy()

    df["daily_return"] = df["close"].pct_change()
    df["log_return"] = np.log(df["close"] / df["close"].shift(1))
    rolling_std = df["log_return"].rolling(window=window, min_periods=window).std()
    df["volatility_1y"] = rolling_std * (math.sqrt(252) if annualise else 1.0)
    return df


def _recompute_tail(stock_df: pd.DataFrame, window: int, annualise: bool) -> tuple[pd.DataFrame, pd.Timestamp]:
    stock_df = stock_df.sort_values("date").reset_index(drop=True)
    n = len(stock_df)

    recompute_len = window + 5
    context_start = max(0, n - recompute_len - window)

    head_df = stock_df.iloc[:context_start].copy()
    context_df = stock_df.iloc[context_start:].copy()

    if not head_df.empty:
        seed = head_df.iloc[[-1]][["date", "close"]].copy()
        context_df = pd.concat([seed, context_df], ignore_index=True)

    context_df["daily_return"] = context_df["close"].pct_change()
    context_df["log_return"] = np.log(context_df["close"] / context_df["close"].shift(1))
    rolling_std = context_df["log_return"].rolling(window=window, min_periods=window).std()
    context_df["volatility_1y"] = rolling_std * (math.sqrt(252) if annualise else 1.0)

    if not head_df.empty:
        changed_from = _to_ts(head_df["date"].iloc[-1])
        context_df = context_df[context_df["date"] > changed_from]
        return pd.concat([head_df, context_df], ignore_index=True), changed_from

    changed_from = _to_ts(stock_df["date"].iloc[0])
    return context_df, changed_from


def _detect_split_or_bonus(symbol: str, sym_last: pd.Timestamp, lookback_days: int) -> bool:
    check_from = (sym_last - timedelta(days=lookback_days)).normalize()
    try:
        ticker = yf.Ticker(f"{symbol}.NS")
        splits = ticker.splits
        if splits is None or splits.empty:
            return False

        splits.index = pd.to_datetime(splits.index).tz_localize(None).normalize()
        recent = splits[splits.index >= check_from]
        if recent.empty:
            return False

        for dt, ratio in recent.items():
            logger.warning(
                "yahoo_sync split_detected symbol=%s date=%s ratio=%s",
                symbol,
                dt.date(),
                float(ratio),
            )
        return True
    except Exception as exc:
        logger.warning("yahoo_sync split_check_failed symbol=%s err=%s", symbol, exc)
        return False


def _fetch_reference_last_date(reference_ticker: str) -> pd.Timestamp | None:
    try:
        ref = yf.download(
            reference_ticker,
            period="5d",
            progress=False,
            auto_adjust=True,
            rounding=True,
        )
        if ref.empty:
            return None
        return _to_ts(ref.index[-1])
    except Exception as exc:
        logger.warning("yahoo_sync reference_fetch_failed ticker=%s err=%s", reference_ticker, exc)
        return None


def _fetch_full(symbol: str, start_date: str, end_date: pd.Timestamp) -> pd.DataFrame | None:
    try:
        data = yf.download(
            f"{symbol}.NS",
            start=start_date,
            end=(end_date + timedelta(days=1)).strftime("%Y-%m-%d"),
            auto_adjust=True,
            progress=False,
        )
        clean = _clean_ohlcv(data, symbol)
        return clean if not clean.empty else None
    except Exception as exc:
        logger.warning("yahoo_sync full_fetch_failed symbol=%s err=%s", symbol, exc)
        return None


def _fetch_incremental(symbol: str, start_date: pd.Timestamp, end_date: pd.Timestamp) -> pd.DataFrame | None:
    try:
        data = yf.download(
            f"{symbol}.NS",
            start=start_date.strftime("%Y-%m-%d"),
            end=(end_date + timedelta(days=1)).strftime("%Y-%m-%d"),
            auto_adjust=True,
            progress=False,
        )
        clean = _clean_ohlcv(data, symbol)
        return clean if not clean.empty else None
    except Exception as exc:
        logger.warning("yahoo_sync incremental_fetch_failed symbol=%s err=%s", symbol, exc)
        return None


def _load_symbol_prices(db: Session, symbol: str) -> pd.DataFrame:
    rows = (
        db.query(
            StockPrice.ticker,
            StockPrice.date,
            StockPrice.open,
            StockPrice.high,
            StockPrice.low,
            StockPrice.close,
            StockPrice.volume,
            StockPrice.index_member,
            StockPrice.daily_return,
            StockPrice.log_return,
            StockPrice.volatility_1y,
        )
        .filter(StockPrice.ticker == symbol)
        .order_by(StockPrice.date.asc())
        .all()
    )

    if not rows:
        return pd.DataFrame(
            columns=[
                "symbol",
                "date",
                "open",
                "high",
                "low",
                "close",
                "volume",
                "index_member",
                "daily_return",
                "log_return",
                "volatility_1y",
            ]
        )

    df = pd.DataFrame(
        [
            {
                "symbol": r.ticker,
                "date": pd.to_datetime(r.date),
                "open": float(r.open) if r.open is not None else np.nan,
                "high": float(r.high) if r.high is not None else np.nan,
                "low": float(r.low) if r.low is not None else np.nan,
                "close": float(r.close) if r.close is not None else np.nan,
                "volume": float(r.volume) if r.volume is not None else np.nan,
                "index_member": r.index_member,
                "daily_return": float(r.daily_return) if r.daily_return is not None else np.nan,
                "log_return": float(r.log_return) if r.log_return is not None else np.nan,
                "volatility_1y": float(r.volatility_1y) if r.volatility_1y is not None else np.nan,
            }
            for r in rows
        ]
    )
    df["date"] = pd.to_datetime(df["date"]).dt.normalize()
    return df


def _nan_to_none(v: Any) -> Any:
    if v is None:
        return None
    if isinstance(v, float) and np.isnan(v):
        return None
    return v


def _to_db_records(df: pd.DataFrame) -> list[dict[str, Any]]:
    if df.empty:
        return []

    records: list[dict[str, Any]] = []
    for _, row in df.iterrows():
        records.append(
            {
                "ticker": str(row["symbol"]),
                "date": pd.to_datetime(row["date"]).date(),
                "open": _nan_to_none(float(row["open"]) if pd.notna(row["open"]) else None),
                "high": _nan_to_none(float(row["high"]) if pd.notna(row["high"]) else None),
                "low": _nan_to_none(float(row["low"]) if pd.notna(row["low"]) else None),
                "close": _nan_to_none(float(row["close"]) if pd.notna(row["close"]) else None),
                "volume": _nan_to_none(float(row["volume"]) if pd.notna(row["volume"]) else None),
                "index_member": _nan_to_none(row.get("index_member")),
                "daily_return": _nan_to_none(float(row["daily_return"]) if pd.notna(row.get("daily_return")) else None),
                "log_return": _nan_to_none(float(row["log_return"]) if pd.notna(row.get("log_return")) else None),
                "volatility_1y": _nan_to_none(float(row["volatility_1y"]) if pd.notna(row.get("volatility_1y")) else None),
            }
        )
    return records


def _upsert_rows(db: Session, records: list[dict[str, Any]]) -> int:
    if not records:
        return 0

    stmt = insert(StockPrice).values(records)
    stmt = stmt.on_conflict_do_update(
        index_elements=[StockPrice.ticker, StockPrice.date],
        set_={
            "open": stmt.excluded.open,
            "high": stmt.excluded.high,
            "low": stmt.excluded.low,
            "close": stmt.excluded.close,
            "volume": stmt.excluded.volume,
            "index_member": stmt.excluded.index_member,
            "daily_return": stmt.excluded.daily_return,
            "log_return": stmt.excluded.log_return,
            "volatility_1y": stmt.excluded.volatility_1y,
        },
    )
    db.execute(stmt)
    return len(records)


def _sync_symbol(db: Session, symbol: str, last_available: pd.Timestamp) -> SymbolSyncResult:
    existing = _load_symbol_prices(db, symbol)
    existing_tag = None if existing.empty else existing["index_member"].dropna().iloc[-1] if not existing["index_member"].dropna().empty else None

    if existing.empty:
        full = _fetch_full(symbol, settings.yahoo_base_date, last_available)
        if full is None or full.empty:
            return SymbolSyncResult(symbol=symbol, mode="no_data", reason="no_data_full_fetch")

        full["index_member"] = existing_tag
        full = _compute_indicators_full(full, settings.yahoo_volatility_window, settings.yahoo_annualise_vol)
        records = _to_db_records(full)
        up = _upsert_rows(db, records)
        return SymbolSyncResult(symbol=symbol, mode="full_refetch", inserted_or_upserted=up)

    sym_last = _to_ts(existing["date"].max())
    if sym_last >= last_available:
        return SymbolSyncResult(symbol=symbol, mode="up_to_date")

    has_split = _detect_split_or_bonus(symbol, sym_last, settings.yahoo_split_lookback_days)

    if has_split:
        full = _fetch_full(symbol, settings.yahoo_base_date, last_available)
        if full is None or full.empty:
            return SymbolSyncResult(symbol=symbol, mode="failed", reason="split_full_fetch_failed")

        full["index_member"] = existing_tag
        full = _compute_indicators_full(full, settings.yahoo_volatility_window, settings.yahoo_annualise_vol)

        deleted = db.query(StockPrice).filter(StockPrice.ticker == symbol).delete(synchronize_session=False)
        up = _upsert_rows(db, _to_db_records(full))
        return SymbolSyncResult(symbol=symbol, mode="full_refetch", inserted_or_upserted=up, deleted=deleted)

    start_date = sym_last + timedelta(days=1)
    inc = _fetch_incremental(symbol, start_date, last_available)
    if inc is None or inc.empty:
        return SymbolSyncResult(symbol=symbol, mode="no_data", reason="no_incremental_rows")

    inc["index_member"] = existing_tag
    merged = pd.concat([existing, inc], ignore_index=True)
    merged = merged.drop_duplicates(subset=["symbol", "date"], keep="last").sort_values(["symbol", "date"]).reset_index(drop=True)

    recomputed, changed_from = _recompute_tail(merged, settings.yahoo_volatility_window, settings.yahoo_annualise_vol)
    changed = recomputed[recomputed["date"] >= changed_from].copy()
    up = _upsert_rows(db, _to_db_records(changed))
    return SymbolSyncResult(symbol=symbol, mode="incremental", inserted_or_upserted=up)


def run_yahoo_daily_sync(db: Session) -> dict[str, Any]:
    """
    Incremental DB sync for stock_price using Yahoo Finance.
    - Full symbol re-fetch when split/bonus is detected in lookback window
    - Incremental append with tail indicator recompute otherwise
    """
    started = datetime.now()
    ref_last = _fetch_reference_last_date(settings.yahoo_reference_ticker)
    if ref_last is None:
        ref_last = _to_ts(pd.Timestamp.today() - timedelta(days=1))

    db_last = db.query(func.max(StockPrice.date)).scalar()
    if db_last is not None and _to_ts(db_last) >= ref_last:
        return {
            "success": True,
            "status": "up_to_date",
            "lastAvailableDate": ref_last.date().isoformat(),
            "dbLastDate": _to_ts(db_last).date().isoformat(),
            "symbolsTotal": 0,
            "symbolsProcessed": 0,
            "summary": {"up_to_date": 0, "incremental": 0, "full_refetch": 0, "no_data": 0, "failed": 0},
            "durationSeconds": round((datetime.now() - started).total_seconds(), 2),
        }

    symbols = [row.ticker for row in db.query(StockTicker.ticker).order_by(StockTicker.ticker.asc()).all()]
    if not symbols:
        return {
            "success": True,
            "status": "skipped",
            "reason": "no_symbols",
            "symbolsTotal": 0,
            "symbolsProcessed": 0,
            "summary": {"up_to_date": 0, "incremental": 0, "full_refetch": 0, "no_data": 0, "failed": 0},
            "durationSeconds": round((datetime.now() - started).total_seconds(), 2),
        }

    summary = {"up_to_date": 0, "incremental": 0, "full_refetch": 0, "no_data": 0, "failed": 0}
    details: list[dict[str, Any]] = []

    logger.info("yahoo_sync starting symbol_count=%d target_date=%s", len(symbols), ref_last.date().isoformat())

    for idx, symbol in enumerate(symbols, start=1):
        try:
            result = _sync_symbol(db, symbol, ref_last)
            summary[result.mode] = summary.get(result.mode, 0) + 1
            details.append(
                {
                    "symbol": result.symbol,
                    "mode": result.mode,
                    "rows": result.inserted_or_upserted,
                    "deleted": result.deleted,
                    "reason": result.reason,
                }
            )
            db.commit()
        except Exception as exc:
            db.rollback()
            summary["failed"] += 1
            details.append({"symbol": symbol, "mode": "failed", "rows": 0, "deleted": 0, "reason": str(exc)[:300]})
            logger.exception("yahoo_sync symbol_failed symbol=%s", symbol)

        time.sleep(max(0.0, float(settings.yahoo_api_delay_seconds)))

        # Log progress every 25 symbols
        if idx % 25 == 0:
            logger.info("yahoo_sync progress processed=%d/%d up_to_date=%d incremental=%d full_refetch=%d no_data=%d failed=%d",
                       idx, len(symbols), summary["up_to_date"], summary["incremental"], 
                       summary["full_refetch"], summary["no_data"], summary["failed"])

    out = {
        "success": True,
        "status": "completed",
        "lastAvailableDate": ref_last.date().isoformat(),
        "dbLastDate": _to_ts(db.query(func.max(StockPrice.date)).scalar() or ref_last).date().isoformat(),
        "symbolsTotal": len(symbols),
        "symbolsProcessed": len(details),
        "summary": summary,
        "durationSeconds": round((datetime.now() - started).total_seconds(), 2),
        "details": details,
    }
    logger.info("yahoo_sync completed summary=%s", summary)
    return out
