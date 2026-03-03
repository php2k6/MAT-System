"""
daily_fetch.py — Incremental Daily Updater
==========================================
Run Tue–Sat before market open (appends previous day's close).

SCHEDULE:
  Monday      → run fetch_and_build.py  (full rebuild)
  Tue–Sat     → run this script         (append yesterday's close only)
  Sunday      → nothing

WHAT THIS DOES:
  1. Checks the last available trading date on Yahoo Finance
     using a reference ticker (handles holidays automatically)
  2. For each symbol, fetches only the missing rows since last update
  3. Appends new OHLCV rows to the master CSV
  4. Recomputes indicators (daily_return, log_return, volatility_1y)
     only for the updated tail — stable history is untouched
  5. Preserves index_member tags exactly as they were
  6. Saves the updated master CSV in-place

HOLIDAY / WEEKEND HANDLING:
  - A reference ticker (NIFTYBEES.NS) is checked first to get the
    actual last available trading date from Yahoo Finance
  - If Yahoo has no new data (holiday, weekend, data delay) the
    script exits cleanly with "already up to date"
  - Safe to run multiple times — duplicates are automatically removed

INPUT / OUTPUT:
  - nifty250_log_return_volatility.csv  (read + overwrite in-place)
    Must be produced by fetch_and_build.py first.
"""

import pandas as pd
import numpy as np
import yfinance as yf
import time
from datetime import timedelta
from pathlib import Path

# ─────────────────────────────────────────────────────────────────
#  CONFIG — must match fetch_and_build.py settings
# ─────────────────────────────────────────────────────────────────
MASTER_CSV        = "nifty250_log_return_volatility.csv"
VOLATILITY_WINDOW = 252       # must match fetch_and_build.py
ANNUALISE_VOL     = False     # must match fetch_and_build.py
API_DELAY         = 0.2       # seconds between Yahoo Finance calls

# Reference ticker to detect last available trading date on Yahoo.
# NIFTYBEES is the Nifty 50 BeES ETF — always liquid, reliable.
REFERENCE_TICKER  = "NIFTYBEES.NS"
# ─────────────────────────────────────────────────────────────────


def get_last_available_trading_date() -> pd.Timestamp | None:
    """
    Fetch the most recent date Yahoo Finance has data for, using a
    reference ticker. This correctly handles all edge cases:

      Weekend          → returns Friday (last trading day)
      NSE holiday      → returns last trading day before holiday
      Data upload lag  → returns last date Yahoo has actually uploaded
      Post-Mon rebuild → Tuesday run correctly picks up Monday's close

    Returns None if the reference ticker itself fails (network issue).
    """
    try:
        ref = yf.download(
            REFERENCE_TICKER,
            period="5d",
            progress=False,
            auto_adjust=True,
        )
        if ref.empty:
            print(f"  ⚠  Reference ticker {REFERENCE_TICKER} returned no data.")
            return None
        last_date = pd.to_datetime(ref.index[-1]).normalize()
        print(f"    Last available trading date on Yahoo : {last_date.date()}")
        return last_date
    except Exception as e:
        print(f"  ⚠  Could not reach Yahoo Finance: {e}")
        return None


def fetch_new_rows(symbol: str,
                   start_date: pd.Timestamp,
                   end_date: pd.Timestamp) -> pd.DataFrame | None:
    """
    Download OHLCV rows for a symbol between start_date and end_date.
    Uses auto_adjust=True to match fetch_and_build.py price series.
    Yahoo Finance automatically skips weekends and holidays in the
    date range — no manual calendar filtering needed.
    """
    try:
        data = yf.download(
            f"{symbol}.NS",
            start=start_date.strftime("%Y-%m-%d"),
            end=(end_date + timedelta(days=1)).strftime("%Y-%m-%d"),
            auto_adjust=True,    # must match fetch_and_build.py
            progress=False,
        )
        if data.empty:
            return None

        # Flatten MultiIndex columns if present
        if isinstance(data.columns, pd.MultiIndex):
            data.columns = data.columns.get_level_values(0)

        data = data.reset_index()
        data.columns = [c.lower() for c in data.columns]

        keep = [c for c in ["date", "open", "high", "low", "close", "volume"]
                if c in data.columns]
        data = data[keep].dropna(subset=["close"])

        if data.empty:
            return None

        data.insert(0, "symbol", symbol)
        data["date"] = pd.to_datetime(data["date"])
        return data

    except Exception as e:
        print(f"    ❌ {symbol}: {e}")
        return None


def recompute_tail(stock_df: pd.DataFrame,
                   window: int,
                   annualise: bool) -> pd.DataFrame:
    """
    Recompute indicators only for the tail of one symbol's history.

    We borrow (window) rows before the new data as lookback context
    so the rolling std at the seam is always correct. The stable
    head (everything before the borrowed rows) is returned unchanged.
    """
    stock_df = stock_df.sort_values("date").reset_index(drop=True)
    n        = len(stock_df)

    # We need at least window rows of context before new rows
    # Recompute the last (window + 5) rows to be safe
    recompute_len = window + 5
    context_start = max(0, n - recompute_len - window)

    head_df    = stock_df.iloc[:context_start].copy()
    context_df = stock_df.iloc[context_start:].copy()

    # Compute indicators on the context window
    context_df["daily_return"] = context_df["close"].pct_change()
    context_df["log_return"]   = np.log(
        context_df["close"] / context_df["close"].shift(1)
    )
    rolling_std = (
        context_df["log_return"]
        .rolling(window=window, min_periods=window)
        .std()
    )
    context_df["volatility_1y"] = (
        rolling_std * (np.sqrt(252) if annualise else 1.0)
    )

    # Only keep the true new tail from context (not the borrowed lookback)
    if not head_df.empty:
        cutoff     = head_df["date"].iloc[-1]
        context_df = context_df[context_df["date"] > cutoff]
        return pd.concat([head_df, context_df], ignore_index=True)
    else:
        return context_df


def main():
    print("=" * 62)
    print("  DAILY FETCH — Incremental Updater  (run Tue–Sat)")
    print("=" * 62)

    # ── 1. Load master CSV ───────────────────────────────────────
    print(f"\n[1/5] Loading master CSV: {MASTER_CSV} …")
    if not Path(MASTER_CSV).exists():
        raise FileNotFoundError(
            f"'{MASTER_CSV}' not found. Run fetch_and_build.py first."
        )

    df = pd.read_csv(MASTER_CSV, low_memory=False)
    df["date"]  = pd.to_datetime(df["date"])
    df["close"] = pd.to_numeric(df["close"], errors="coerce")

    # Warn if index_member is missing — backtester universe filter needs it
    if "index_member" not in df.columns:
        print("  ⚠  'index_member' column missing.")
        print("     Universe filtering will not work.")
        print("     Re-run fetch_and_build.py to fix this properly.")
        df["index_member"] = "nifty250"

    symbols = df["symbol"].unique()
    print(f"    Symbols in master  : {len(symbols)}")
    print(f"    Rows in master     : {len(df):,}")
    print(f"    Master last date   : {df['date'].max().date()}")

    # ── 2. Get last available trading date ───────────────────────
    print(f"\n[2/5] Detecting last available trading date on Yahoo …")
    last_available = get_last_available_trading_date()

    if last_available is None:
        # Fallback: use yesterday — better than crashing
        last_available = (pd.Timestamp.today() - timedelta(days=1)).normalize()
        print(f"    ⚠  Fallback to yesterday: {last_available.date()}")

    master_last_date = df["date"].max()

    if master_last_date >= last_available:
        print(f"\n  ✅ Already up to date ({master_last_date.date()}). "
              f"Nothing to fetch.")
        return

    days_behind = (last_available - master_last_date).days
    print(f"    Master is {days_behind} calendar day(s) behind — fetching …")

    # ── 3. Fetch missing rows ────────────────────────────────────
    print(f"\n[3/5] Fetching new data for {len(symbols)} symbols …\n")
    new_rows_list = []
    up_to_date    = 0
    updated       = 0
    failed        = []

    for i, symbol in enumerate(symbols, 1):
        sym_last   = df.loc[df["symbol"] == symbol, "date"].max()
        start_date = sym_last + timedelta(days=1)

        # Already up to date for this symbol
        if sym_last >= last_available:
            up_to_date += 1
            continue

        print(f"  [{i:>3}/{len(symbols)}] {symbol:<15} "
              f"last={sym_last.date()} "
              f"fetching {start_date.date()} → {last_available.date()} …",
              end=" ")

        new_df = fetch_new_rows(symbol, start_date, last_available)

        if new_df is None or new_df.empty:
            print("⚠  No new rows")
            failed.append(symbol)
        else:
            # Carry forward the existing index_member tag for this symbol
            existing_tag         = df.loc[
                df["symbol"] == symbol, "index_member"
            ].iloc[0]
            new_df["index_member"] = existing_tag
            new_rows_list.append(new_df)
            print(f"✔  +{len(new_df)} row(s)")
            updated += 1

        time.sleep(API_DELAY)

    print(f"\n  {up_to_date} symbols already up to date.")
    print(f"  {updated} symbols updated successfully.")
    print(f"  {len(failed)} symbols returned no data."
          + (f"  {failed}" if failed else ""))

    # ── 4. Append new rows ───────────────────────────────────────
    if not new_rows_list:
        print(f"\n[4/5] No new rows — master CSV unchanged.")
        print(f"\n[5/5] Skipping indicator recompute.")
        print(f"\n  ✅ Master CSV is current as of {master_last_date.date()}.")
        return

    print(f"\n[4/5] Appending "
          f"{sum(len(d) for d in new_rows_list)} new rows …")

    df_new = pd.concat(new_rows_list, ignore_index=True)
    df     = pd.concat([df, df_new], ignore_index=True)

    # Remove any duplicates — keep last (new data wins)
    df = df.drop_duplicates(subset=["symbol", "date"], keep="last")
    df = df.sort_values(["symbol", "date"]).reset_index(drop=True)

    # ── 5. Recompute indicators for updated symbols only ─────────
    print(f"\n[5/5] Recomputing indicators for {updated} updated symbols …")

    updated_symbols = {d["symbol"].iloc[0] for d in new_rows_list}
    stable_df       = df[~df["symbol"].isin(updated_symbols)]
    changed_df      = df[ df["symbol"].isin(updated_symbols)]

    recomputed = []
    for symbol in updated_symbols:
        stock_df = changed_df[changed_df["symbol"] == symbol].copy()
        stock_df = recompute_tail(stock_df, VOLATILITY_WINDOW, ANNUALISE_VOL)
        recomputed.append(stock_df)

    df_final = pd.concat(
        [stable_df] + recomputed, ignore_index=True
    ).sort_values(["symbol", "date"]).reset_index(drop=True)

    # Enforce clean column order
    col_order = [
        "symbol", "date", "open", "high", "low", "close", "volume",
        "index_member", "daily_return", "log_return", "volatility_1y"
    ]
    df_final = df_final[[c for c in col_order if c in df_final.columns]]

    # ── Save ─────────────────────────────────────────────────────
    df_final.to_csv(MASTER_CSV, index=False)

    print(f"\n  ✅ Master CSV updated → {MASTER_CSV}")
    print(f"  📊 Total rows      : {len(df_final):,}")
    print(f"  📈 Symbols         : {df_final['symbol'].nunique()}")
    print(f"  📅 Latest date     : {df_final['date'].max().date()}")
    print(f"  🔢 Rows with vol   : "
          f"{df_final['volatility_1y'].notna().sum():,}")


if __name__ == "__main__":
    main()
