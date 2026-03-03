"""
fetch_and_build.py — Full Historical Rebuild
=============================================
Run every MONDAY morning before market open.

SCHEDULE:
  Monday      → run this script  (full 11yr rebuild, split/bonus adjusted)
  Tue–Sat     → run daily_fetch.py  (append previous day's close only)
  Sunday      → nothing

WHY MONDAY:
  - Yahoo Finance back-adjusts ALL historical prices when a split/bonus occurs
  - daily_fetch.py only appends new rows — it never fixes old prices
  - A weekly full rebuild ensures your entire history is always clean
    and correctly adjusted for any corporate actions that happened last week

WHAT THIS DOES:
  1. Reads symbol lists from 4 index CSVs → assigns index_member tag
  2. Downloads 11 years of OHLCV (auto-adjusted for splits and bonuses)
  3. Computes daily_return, log_return, volatility_1y in the same pass
  4. Saves the master CSV ready for the backtester

INPUT FILES (must be in index_data/ folder, each needs a 'Symbol' column):
  - ind_nifty50list.csv               → Nifty 50
  - ind_nifty100list.csv              → Nifty 50 + Next 50 (100 total)
  - ind_nifty150list.csv              → Nifty Midcap 150 (no overlap with above)
  - ind_niftylargemidcap250list.csv   → All 250 (used as fallback tag only)

OUTPUT:
  - nifty250_log_return_volatility.csv
    Columns: symbol, date, open, high, low, close, volume,
             index_member, daily_return, log_return, volatility_1y

index_member values assigned:
  nifty50   → top 50 large cap
  nifty100  → next 50 large cap  (in nifty100 file but not nifty50)
  nifty150  → midcap 150         (in nifty150 file, no overlap)
  nifty250  → any remaining      (in 250 file only — rare/none with your files)
"""

import pandas as pd
import numpy as np
import yfinance as yf
import time
from pathlib import Path

# ─────────────────────────────────────────────────────────────────
#  CONFIG — edit paths here if needed
# ─────────────────────────────────────────────────────────────────
OUTPUT_CSV        = "nifty250_log_return_volatility.csv"
YEARS             = 11
VOLATILITY_WINDOW = 252       # trading days for rolling volatility
ANNUALISE_VOL     = False     # True → multiply std by √252
API_DELAY         = 0.3       # seconds between Yahoo Finance calls

INDEX_FILES = {
    "nifty50":  "index_data/ind_nifty50list.csv",
    "nifty100": "index_data/ind_nifty100list.csv",
    "nifty150": "index_data/ind_nifty150list.csv",
    "nifty250": "index_data/ind_niftylargemidcap250list.csv",
}
# ─────────────────────────────────────────────────────────────────


def load_universe() -> pd.DataFrame:
    """
    Load index CSVs and tag each symbol with its smallest index label.

    Processing order: nifty250 → nifty150 → nifty100 → nifty50
    Each pass overwrites the tag so the smallest index always wins.

    Example result with your files:
      RELIANCE   → nifty50   (present in all files, nifty50 overwrites last)
      BAJAJFINSV → nifty100  (in nifty100 + nifty250, not in nifty50)
      LODHA      → nifty150  (midcap, only in nifty150 + nifty250)
    """
    symbol_map = {}

    for index_name in ["nifty250", "nifty150", "nifty100", "nifty50"]:
        filepath = INDEX_FILES.get(index_name)
        if not filepath or not Path(filepath).exists():
            print(f"  ⚠  {index_name}: file not found ({filepath}) — skipping")
            continue
        try:
            df = pd.read_csv(filepath)
        except Exception as e:
            print(f"  ❌ Could not read {filepath}: {e}")
            continue
        if "Symbol" not in df.columns:
            print(f"  ❌ 'Symbol' column missing in {filepath} — skipping")
            continue
        symbols = df["Symbol"].dropna().astype(str).str.strip().unique()
        for sym in symbols:
            symbol_map[sym] = index_name   # smaller index overwrites larger
        print(f"  ✔  {index_name:<12}: {len(symbols)} symbols from {filepath}")

    if not symbol_map:
        raise RuntimeError(
            "No symbols loaded. Check index_data/ folder and CSV files."
        )

    universe_df = pd.DataFrame(
        symbol_map.items(), columns=["symbol", "index_member"]
    )
    print(f"\n  Total unique symbols : {len(universe_df)}")
    print(f"  Index breakdown:")
    print(universe_df["index_member"].value_counts().to_string())
    return universe_df


def fetch_ohlcv(symbol: str) -> pd.DataFrame | None:
    """
    Fetch YEARS of OHLCV for one NSE symbol from Yahoo Finance.
    auto_adjust=True ensures all historical prices are back-adjusted
    for splits, bonuses, and dividends automatically.
    """
    try:
        df = yf.download(
            f"{symbol}.NS",
            period=f"{YEARS}y",
            progress=False,
            auto_adjust=True,    # back-adjusts ALL history for splits/bonuses
        )
        if df.empty:
            return None

        # Flatten MultiIndex columns (yfinance sometimes returns these)
        if isinstance(df.columns, pd.MultiIndex):
            df.columns = df.columns.get_level_values(0)

        df = df.reset_index()
        df.columns = [c.lower() for c in df.columns]

        # With auto_adjust=True, 'close' already contains adjusted prices
        # There is no separate 'adj close' column
        keep = [c for c in ["date", "open", "high", "low", "close", "volume"]
                if c in df.columns]
        df = df[keep].dropna(subset=["close"])

        if df.empty:
            return None

        df.insert(0, "symbol", symbol)
        df["date"] = pd.to_datetime(df["date"])
        return df

    except Exception as e:
        print(f"    ❌ {symbol}: {e}")
        return None


def compute_indicators(df: pd.DataFrame) -> pd.DataFrame:
    """
    Compute per-symbol indicators:
      daily_return  — simple % change in close
      log_return    — ln(close_t / close_t-1)
      volatility_1y — rolling 252-day std of log_return
    """
    df = df.sort_values(["symbol", "date"]).copy()
    grp = df.groupby("symbol")["close"]

    df["daily_return"] = grp.pct_change()
    df["log_return"]   = np.log(df["close"] / grp.shift(1))

    rolling_std = (
        df.groupby("symbol")["log_return"]
          .rolling(window=VOLATILITY_WINDOW, min_periods=VOLATILITY_WINDOW)
          .std()
          .reset_index(level=0, drop=True)
    )
    df["volatility_1y"] = rolling_std * (np.sqrt(252) if ANNUALISE_VOL else 1.0)
    return df


def main():
    print("=" * 62)
    print("  FETCH & BUILD — Full Rebuild  (run every Monday)")
    print("=" * 62)

    # ── 1. Universe ──────────────────────────────────────────────
    print("\n[1/3] Loading symbol universe …")
    universe_df = load_universe()
    symbols     = universe_df["symbol"].tolist()

    # ── 2. Fetch OHLCV ───────────────────────────────────────────
    print(f"\n[2/3] Fetching {YEARS}y OHLCV for {len(symbols)} symbols "
          f"(auto-adjusted for splits & bonuses) …\n")
    all_data = []
    failed   = []

    for i, symbol in enumerate(symbols, 1):
        print(f"  [{i:>3}/{len(symbols)}] {symbol:<15}", end=" ")
        df = fetch_ohlcv(symbol)
        if df is None:
            print("⚠  No data")
            failed.append(symbol)
        else:
            print(f"✔  {df['date'].min().date()} → {df['date'].max().date()} "
                  f"({len(df):,} rows)")
            all_data.append(df)
        time.sleep(API_DELAY)

    if not all_data:
        print("\n❌ No data collected. Check internet or symbol list.")
        return

    # ── 3. Merge, compute indicators, save ───────────────────────
    print(f"\n[3/3] Computing indicators and saving …")
    final_df = pd.concat(all_data, ignore_index=True)

    # Attach index_member tag
    final_df = final_df.merge(universe_df, on="symbol", how="left")
    final_df["index_member"] = final_df["index_member"].fillna("nifty250")

    # Compute indicators
    final_df = compute_indicators(final_df)

    # Enforce clean column order
    col_order = [
        "symbol", "date", "open", "high", "low", "close", "volume",
        "index_member", "daily_return", "log_return", "volatility_1y"
    ]
    final_df = final_df[[c for c in col_order if c in final_df.columns]]

    final_df.to_csv(OUTPUT_CSV, index=False)

    # ── Summary ──────────────────────────────────────────────────
    vol_pct = final_df["volatility_1y"].notna().mean()
    print(f"\n  ✅ Saved → {OUTPUT_CSV}")
    print(f"  📊 Total rows      : {len(final_df):,}")
    print(f"  📈 Symbols OK      : {final_df['symbol'].nunique()}")
    print(f"  ❌ Symbols failed  : {len(failed)}"
          + (f"  {failed}" if failed else ""))
    print(f"  📅 Date range      : {final_df['date'].min().date()} → "
          f"{final_df['date'].max().date()}")
    print(f"  📉 Rows with vol   : {vol_pct:.1%}  "
          f"(first {VOLATILITY_WINDOW} rows per symbol are NaN by design)")
    print(f"\n➡  Run daily_fetch.py Tue–Sat to append each day's close.")


if __name__ == "__main__":
    main()
