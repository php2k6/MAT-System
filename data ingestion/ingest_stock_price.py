"""
ingest_stock_price.py
=====================
Full historical bulk-load of nifty250_log_return_volatility.csv
into the stock_price table.

PRE-REQUISITE:
  stock_tickers table must already be populated (FK constraint).
  Run ingest_tickers.py first if it hasn't been done yet.

Usage (from mat-system/ root):
    python "data ingestion/ingest_stock_price.py"
"""

import sys
import time
from pathlib import Path
from decimal import Decimal, InvalidOperation

import pandas as pd
from sqlalchemy.dialects.postgresql import insert as pg_insert

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.database import SessionLocal, init_db  # noqa: E402
from backend.models import StockPrice               # noqa: E402

CSV_PATH   = Path(__file__).parent / "nifty250_log_return_volatility.csv"
CHUNK_SIZE = 5_000


def _safe_decimal(val):
    try:
        if pd.isna(val):
            return None
        return Decimal(str(val))
    except (InvalidOperation, TypeError):
        return None


def ingest_prices(df: pd.DataFrame, session) -> None:
    total    = len(df)
    batches  = (total + CHUNK_SIZE - 1) // CHUNK_SIZE
    inserted = 0

    for i in range(batches):
        chunk = df.iloc[i * CHUNK_SIZE : (i + 1) * CHUNK_SIZE]

        rows = [
            {
                "ticker":        row["symbol"],
                "date":          row["date"],
                "open":          _safe_decimal(row["open"]),
                "high":          _safe_decimal(row["high"]),
                "low":           _safe_decimal(row["low"]),
                "close":         _safe_decimal(row["close"]),
                "volume":        _safe_decimal(row["volume"]),
                "index_member":  row["index_member"] if pd.notna(row["index_member"]) else None,
                "daily_return":  _safe_decimal(row["daily_return"]),
                "log_return":    _safe_decimal(row["log_return"]),
                "volatility_1y": _safe_decimal(row["volatility_1y"]),
            }
            for _, row in chunk.iterrows()
        ]

        stmt = (
            pg_insert(StockPrice)
            .values(rows)
            .on_conflict_do_nothing(index_elements=["ticker", "date"])
        )
        session.execute(stmt)
        session.commit()
        inserted += len(rows)
        print(f"  ✓  Batch {i+1}/{batches} — {inserted}/{total} rows committed")

    print(f"\n  Done. {inserted} rows processed.")


def main():
    print(f"Loading CSV: {CSV_PATH}")
    t0 = time.time()

    df = pd.read_csv(CSV_PATH, parse_dates=["date"])
    df.columns = df.columns.str.strip()
    print(f"  Rows read: {len(df):,}  |  Elapsed: {time.time()-t0:.1f}s")

    init_db()

    session = SessionLocal()
    try:
        ingest_prices(df, session)
    finally:
        session.close()

    print(f"\nTotal time: {time.time()-t0:.1f}s")


if __name__ == "__main__":
    main()
