"""
ingest_all.py
=============
Full historical bulk-load of both stock_tickers and stock_price
from nifty250_log_return_volatility.csv.

WHAT THIS DOES:
  1. Upserts unique tickers into stock_tickers
  2. Upserts price history into stock_price (chunked, ON CONFLICT DO NOTHING)

Usage (from mat-system/ root):
    python "data ingestion/ingest_all.py"
"""

import sys
import time
from decimal import Decimal, InvalidOperation
from pathlib import Path

import pandas as pd
from sqlalchemy.dialects.postgresql import insert as pg_insert

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.database import SessionLocal, init_db  # noqa: E402
from backend.models import StockPrice, StockTicker  # noqa: E402

CSV_PATH = Path(__file__).parent / "nifty250_log_return_volatility.csv"
CHUNK_SIZE = 5_000


def _safe_decimal(val):
    try:
        if pd.isna(val):
            return None
        return Decimal(str(val))
    except (InvalidOperation, TypeError):
        return None


def _normalize_symbol(value):
    if pd.isna(value):
        return None
    return str(value).strip().upper()


def ingest_tickers(df: pd.DataFrame, session) -> int:
    symbols = df["symbol"].map(_normalize_symbol)
    tickers = [symbol for symbol in symbols.dropna().unique().tolist() if symbol]

    if not tickers:
        print("  ⚠ No tickers found in CSV.")
        return 0

    stmt = (
        pg_insert(StockTicker)
        .values([{"ticker": ticker, "name": ticker} for ticker in tickers])
        .on_conflict_do_nothing(index_elements=["ticker"])
    )
    session.execute(stmt)
    session.commit()
    return len(tickers)


def ingest_prices(df: pd.DataFrame, session) -> int:
    total = len(df)
    if total == 0:
        return 0

    batches = (total + CHUNK_SIZE - 1) // CHUNK_SIZE
    processed = 0

    for i in range(batches):
        chunk = df.iloc[i * CHUNK_SIZE : (i + 1) * CHUNK_SIZE]

        rows = [
            {
                "ticker": _normalize_symbol(row["symbol"]),
                "date": row["date"],
                "open": _safe_decimal(row["open"]),
                "high": _safe_decimal(row["high"]),
                "low": _safe_decimal(row["low"]),
                "close": _safe_decimal(row["close"]),
                "volume": _safe_decimal(row["volume"]),
                "index_member": row["index_member"] if pd.notna(row["index_member"]) else None,
                "daily_return": _safe_decimal(row["daily_return"]),
                "log_return": _safe_decimal(row["log_return"]),
                "volatility_1y": _safe_decimal(row["volatility_1y"]),
            }
            for _, row in chunk.iterrows()
            if _normalize_symbol(row["symbol"])
        ]

        if not rows:
            continue

        stmt = (
            pg_insert(StockPrice)
            .values(rows)
            .on_conflict_do_nothing(index_elements=["ticker", "date"])
        )
        session.execute(stmt)
        session.commit()

        processed += len(rows)
        print(f"  ✓ Batch {i+1}/{batches} — {processed}/{total} rows committed")

    return processed


def main():
    print("=" * 60)
    print("  FULL INGEST — Tickers + Stock Price")
    print("=" * 60)
    print(f"Loading CSV: {CSV_PATH}")

    t0 = time.time()

    df = pd.read_csv(CSV_PATH, parse_dates=["date"])
    df.columns = df.columns.str.strip()
    print(f"  Rows read: {len(df):,}  |  Elapsed: {time.time() - t0:.1f}s")

    init_db()

    session = SessionLocal()
    try:
        print("\n[1/2] Ingesting tickers ...")
        ticker_count = ingest_tickers(df, session)
        print(f"  ✓ {ticker_count} tickers processed")

        print("\n[2/2] Ingesting stock prices ...")
        price_count = ingest_prices(df, session)
        print(f"\n  ✓ Done. {price_count} price rows processed")
    finally:
        session.close()

    print(f"Total time: {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
