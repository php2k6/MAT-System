"""
ingest_tickers.py
=================
One-time seed of stock_tickers from the master CSV.
Run this ONCE before ingest_stock_price.py (FK dependency).

Usage (from mat-system/ root):
    python "data ingestion/ingest_tickers.py"
"""

import sys
from pathlib import Path

import pandas as pd
from sqlalchemy.dialects.postgresql import insert as pg_insert

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.database import SessionLocal, init_db  # noqa: E402
from backend.models import StockTicker              # noqa: E402

CSV_PATH = Path(__file__).parent / "nifty250_log_return_volatility.csv"


def main():
    print(f"Reading symbols from: {CSV_PATH}")
    df = pd.read_csv(CSV_PATH, usecols=["symbol"])
    tickers = df["symbol"].dropna().unique().tolist()
    print(f"  Unique tickers found: {len(tickers)}")

    init_db()

    session = SessionLocal()
    try:
        stmt = (
            pg_insert(StockTicker)
            .values([{"ticker": t, "name": t} for t in tickers])
            .on_conflict_do_nothing(index_elements=["ticker"])
        )
        session.execute(stmt)
        session.commit()
        print(f"  ✓  {len(tickers)} tickers upserted into stock_tickers")
    finally:
        session.close()


if __name__ == "__main__":
    main()
