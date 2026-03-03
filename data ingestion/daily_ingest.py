"""
daily_ingest.py
===============
Incremental DB ingestion — run AFTER daily_fetch.py has updated
the master CSV (Tue–Sat before market open).

WHAT THIS DOES:
  1. Finds the latest date already in stock_price for each ticker
  2. Reads only rows from the CSV that are newer than that date
  3. Bulk-inserts the new rows (ON CONFLICT DO NOTHING — safe to re-run)

SCHEDULE:
  Monday      → fetch_and_build.py  then  ingest_stock_price.py   (full rebuild)
  Tue–Sat     → daily_fetch.py      then  daily_ingest.py         (delta only)

Usage (from mat-system/ root):
    python "data ingestion/daily_ingest.py"
"""

import sys
import time
from pathlib import Path
from decimal import Decimal, InvalidOperation

import pandas as pd
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.database import SessionLocal, init_db  # noqa: E402
from backend.models import StockPrice               # noqa: E402

CSV_PATH   = Path(__file__).parent / "nifty250_log_return_volatility.csv"
CHUNK_SIZE = 2_000


def _safe_decimal(val):
    try:
        if pd.isna(val):
            return None
        return Decimal(str(val))
    except (InvalidOperation, TypeError):
        return None


def get_last_dates(session) -> dict:
    """
    Returns {ticker: last_date} for every ticker currently in stock_price.
    """
    rows = session.execute(
        select(StockPrice.ticker, func.max(StockPrice.date))
        .group_by(StockPrice.ticker)
    ).fetchall()
    return {ticker: last_date for ticker, last_date in rows}


def main():
    print("=" * 60)
    print("  DAILY INGEST — Incremental DB updater  (run Tue–Sat)")
    print("=" * 60)

    t0 = time.time()

    # ── 1. Load CSV ───────────────────────────────────────────────
    print(f"\n[1/3] Loading CSV: {CSV_PATH} …")
    df = pd.read_csv(CSV_PATH, parse_dates=["date"])
    df.columns = df.columns.str.strip()
    print(f"  Rows in CSV : {len(df):,}")
    print(f"  CSV max date: {df['date'].max().date()}")

    init_db()

    session = SessionLocal()
    try:
        # ── 2. Find rows newer than what's in the DB ──────────────
        print("\n[2/3] Checking latest dates in DB …")
        last_dates = get_last_dates(session)

        if not last_dates:
            print("  ⚠  stock_price table is empty.")
            print("     Run ingest_tickers.py then ingest_stock_price.py first.")
            return

        overall_last = max(last_dates.values())
        print(f"  DB max date : {overall_last}")

        # Filter: keep only rows strictly newer than each ticker's last DB date
        # Fast path — filter by global max first to avoid per-ticker loop overhead
        new_df = df[df["date"].dt.date > overall_last]

        if new_df.empty:
            print("\n  ✅ DB is already up to date. Nothing to insert.")
            return

        # Per-ticker filtering handles the (rare) case where tickers have
        # different last dates (e.g. new ticker added mid-history)
        filtered_rows = []
        for ticker, group in new_df.groupby("symbol"):
            ticker_last = last_dates.get(ticker, None)
            if ticker_last is None:
                filtered_rows.append(group)  # brand-new ticker, take all rows
            else:
                filtered_rows.append(group[group["date"].dt.date > ticker_last])

        insert_df = pd.concat(filtered_rows, ignore_index=True)
        print(f"  New rows to insert: {len(insert_df):,}")

        # ── 3. Bulk-insert ────────────────────────────────────────
        print("\n[3/3] Inserting new rows …")
        total    = len(insert_df)
        batches  = (total + CHUNK_SIZE - 1) // CHUNK_SIZE
        inserted = 0

        for i in range(batches):
            chunk = insert_df.iloc[i * CHUNK_SIZE : (i + 1) * CHUNK_SIZE]

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

    finally:
        session.close()

    print(f"\n  ✅ Done. {inserted} new rows inserted.")
    print(f"  Total time: {time.time()-t0:.1f}s")


if __name__ == "__main__":
    main()
