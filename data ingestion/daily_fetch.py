"""
daily_fetch.py — Incremental Daily Updater (with Split/Bonus Detection)
========================================================================

WHAT THIS DOES:
  1. Checks the last available trading date on Yahoo Finance
     using a reference ticker (handles holidays automatically)
  2. For each symbol, checks for any stock splits/bonuses in a
     5-day lookback window (catches ex-dates that precede data landing)
  3. If a split/bonus is detected → fetches ALL data from BASE_DATE
     (1 Jan 2015) and hard-replaces that symbol's entire history
  4. Otherwise → fetches only the missing rows since last update,
     with a seed-row fix so daily_return is never NaN at the seam
  5. Recomputes indicators (daily_return, log_return, volatility_1y)
     for all affected symbols — full recompute for splits, tail-only
     for incremental
  6. Preserves index_member tags exactly as they were
  7. Saves the updated master CSV in-place

BUG FIXES vs previous version:
  [1] Split detection window widened to sym_last - 5 days so ex-dates
      that land before data is available are never missed.
  [2] recompute_tail now seeds context_df with the last close from
      head_df before calling pct_change(), so daily_return and
      log_return are never NaN at the seam row. Seed row is dropped
      before the final concat.
  [3] Full re-fetch path now hard-removes old symbol rows from the
      master before concat rather than relying solely on dedup logic,
      so no stale un-adjusted prices can survive a corporate action.

WHY FULL RE-FETCH ON SPLIT/BONUS:
  yfinance auto_adjust=True back-adjusts ALL historical prices when a
  split/bonus occurs. A partial append would leave old un-adjusted prices
  mixed with new adjusted prices — making daily_return, log_return, and
  volatility_1y wrong at the seam. The only correct fix is to replace
  the entire price history for that symbol.

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
VOLATILITY_WINDOW = 252          # must match fetch_and_build.py
ANNUALISE_VOL     = False        # must match fetch_and_build.py
API_DELAY         = 0.2          # seconds between Yahoo Finance calls
BASE_DATE         = "2015-01-01" # full re-fetch start date for splits

# Lookback buffer for split detection (days before last row date).
# Catches ex-dates that Yahoo records before data actually reflects them.
SPLIT_LOOKBACK_DAYS = 5

# Reference ticker to detect last available trading date on Yahoo.
# NIFTYBEES is the Nifty 50 BeES ETF — always liquid, reliable.
REFERENCE_TICKER  = "NIFTYBEES.NS"
# ─────────────────────────────────────────────────────────────────


def get_last_available_trading_date() -> pd.Timestamp | None:
    """
    Fetch the most recent date Yahoo Finance has data for, using a
    reference ticker. Correctly handles weekends, NSE holidays, and
    data upload lags.

    Returns None if the reference ticker itself fails (network issue).
    """
    try:
        ref = yf.download(
            REFERENCE_TICKER,
            period="5d",
            progress=False,
            auto_adjust=True,
            rounding=True
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


def detect_split_or_bonus(symbol: str,
                           sym_last: pd.Timestamp) -> bool:
    """
    Check if Yahoo Finance recorded any split/bonus for the symbol
    within a SPLIT_LOOKBACK_DAYS window before sym_last.

    BUG FIX [1]: We check from (sym_last - SPLIT_LOOKBACK_DAYS) rather
    than from (sym_last + 1 day). Yahoo records splits on the ex-date,
    which can precede the date the adjusted prices actually land. The
    5-day buffer ensures we never miss a recent corporate action.

    Returns True  → split/bonus detected, must do full re-fetch
    Returns False → no corporate action, normal incremental update
    """
    check_from = (sym_last - timedelta(days=SPLIT_LOOKBACK_DAYS)).normalize()
    try:
        ticker = yf.Ticker(f"{symbol}.NS")
        splits = ticker.splits  # pd.Series, date-indexed

        if splits is None or splits.empty:
            return False

        # Strip timezone so comparison with naive check_from works
        # regardless of whether Yahoo returns Asia/Kolkata, UTC, or naive
        splits.index = pd.to_datetime(splits.index).tz_localize(None).normalize()
        recent = splits[splits.index >= check_from]

        if not recent.empty:
            for dt, ratio in recent.items():
                print(f"    ⚡ SPLIT/BONUS detected: {symbol} "
                      f"on {dt.date()} (ratio={ratio:.4f}) → full re-fetch")
            return True

        return False

    except Exception as e:
        print(f"    ⚠  Could not fetch splits for {symbol}: {e}")
        return False


def fetch_full_history(symbol: str,
                       end_date: pd.Timestamp) -> pd.DataFrame | None:
    """
    Fetch the complete adjusted price history from BASE_DATE to end_date.
    Used when a split or bonus has been detected.

    auto_adjust=True ensures all historical prices are back-adjusted
    for the latest corporate actions — the full series is clean.
    """
    try:
        data = yf.download(
            f"{symbol}.NS",
            start=BASE_DATE,
            end=(end_date + timedelta(days=1)).strftime("%Y-%m-%d"),
            auto_adjust=True,
            progress=False,
        )
        if data.empty:
            return None

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
        print(f"    ❌ {symbol} (full fetch): {e}")
        return None


def fetch_new_rows(symbol: str,
                   start_date: pd.Timestamp,
                   end_date: pd.Timestamp) -> pd.DataFrame | None:
    """
    Download only the missing OHLCV rows for a symbol between
    start_date and end_date (incremental update path).
    """
    try:
        data = yf.download(
            f"{symbol}.NS",
            start=start_date.strftime("%Y-%m-%d"),
            end=(end_date + timedelta(days=1)).strftime("%Y-%m-%d"),
            auto_adjust=True,
            progress=False,
        )
        if data.empty:
            return None

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


def compute_indicators_full(stock_df: pd.DataFrame,
                             window: int,
                             annualise: bool) -> pd.DataFrame:
    """
    Compute daily_return, log_return, and volatility_1y for an entire
    symbol's history from scratch.

    Used for symbols that got a full re-fetch due to split/bonus.
    Guarantees no stale or misaligned values anywhere in the series.
    """
    df = stock_df.sort_values("date").reset_index(drop=True).copy()

    df["daily_return"] = df["close"].pct_change()
    df["log_return"]   = np.log(df["close"] / df["close"].shift(1))

    rolling_std = (
        df["log_return"]
        .rolling(window=window, min_periods=window)
        .std()
    )
    df["volatility_1y"] = rolling_std * (np.sqrt(252) if annualise else 1.0)

    return df


def recompute_tail(stock_df: pd.DataFrame,
                   window: int,
                   annualise: bool) -> pd.DataFrame:
    """
    Recompute indicators for recent rows only, with enough lookback context.
    Prevents overwriting older valid volatility values with rolling NaNs.
    """
    out = stock_df.sort_values("date").reset_index(drop=True).copy()
    n = len(out)
    if n == 0:
        return out

    for col in ["daily_return", "log_return", "volatility_1y"]:
        if col not in out.columns:
            out[col] = np.nan

    tail_rows = window + 5
    recompute_start = max(0, n - tail_rows)
    calc_start = max(0, recompute_start - window)

    calc_df = out.iloc[calc_start:].copy()

    if calc_start > 0:
        seed = out.iloc[[calc_start - 1]][["date", "close"]].copy()
        calc_df = pd.concat([seed, calc_df], ignore_index=True)

    calc_df["daily_return"] = calc_df["close"].pct_change()
    calc_df["log_return"] = np.log(calc_df["close"] / calc_df["close"].shift(1))
    rolling_std = calc_df["log_return"].rolling(window=window, min_periods=window).std()
    calc_df["volatility_1y"] = rolling_std * (np.sqrt(252) if annualise else 1.0)

    if calc_start > 0:
        calc_df = calc_df.iloc[1:].reset_index(drop=True)

    patch_offset = recompute_start - calc_start
    patch = calc_df.iloc[patch_offset:].reset_index(drop=True)

    out.loc[recompute_start:, ["daily_return", "log_return", "volatility_1y"]] = \
        patch[["daily_return", "log_return", "volatility_1y"]].to_numpy()

    return out


def main():
    print("=" * 62)
    print("  DAILY FETCH — Incremental Updater with Split Detection")
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
        last_available = (pd.Timestamp.today() - timedelta(days=1)).normalize()
        print(f"    ⚠  Fallback to yesterday: {last_available.date()}")

    master_last_date = df["date"].max()

    if master_last_date >= last_available:
        print(f"\n  ✅ Already up to date ({master_last_date.date()}). "
              f"Nothing to fetch.")
        return

    days_behind = (last_available - master_last_date).days
    print(f"    Master is {days_behind} calendar day(s) behind — fetching …")

    # ── 3. Fetch missing rows (with split/bonus detection) ───────
    print(f"\n[3/5] Fetching new data for {len(symbols)} symbols …\n")

    # symbol → merged/replaced DataFrame ready for indicator recompute
    updated_data:  dict[str, pd.DataFrame] = {}
    full_refetch:  set[str]                = set()  # needs full indicator recompute
    up_to_date                             = 0
    incremental_updated                    = 0
    full_refetch_count                     = 0
    failed:        list[str]               = []

    for i, symbol in enumerate(symbols, 1):
        sym_df   = df[df["symbol"] == symbol]
        sym_last = sym_df["date"].max()

        if sym_last >= last_available:
            up_to_date += 1
            continue

        start_date   = sym_last + timedelta(days=1)
        existing_tag = sym_df["index_member"].iloc[0]

        print(f"  [{i:>3}/{len(symbols)}] {symbol:<15} "
              f"last={sym_last.date()} → {last_available.date()} …")

        # ── Check for splits/bonuses (BUG FIX [1]: wide window) ─
        has_split = detect_split_or_bonus(symbol, sym_last)

        if has_split:
            # ── Full re-fetch path ───────────────────────────────
            print(f"    → Full re-fetch from {BASE_DATE} …", end=" ")
            full_df = fetch_full_history(symbol, last_available)

            if full_df is None or full_df.empty:
                print("❌ Full re-fetch returned no data")
                failed.append(symbol)
            else:
                full_df["index_member"] = existing_tag
                updated_data[symbol]    = full_df   # complete fresh history
                full_refetch.add(symbol)
                print(f"✔  {len(full_df)} rows (full history replaced)")
                full_refetch_count += 1

        else:
            # ── Incremental path ─────────────────────────────────
            print(f"    → Incremental {start_date.date()} → "
                  f"{last_available.date()} …", end=" ")
            new_df = fetch_new_rows(symbol, start_date, last_available)

            if new_df is None or new_df.empty:
                print("⚠  No new rows")
                failed.append(symbol)
            else:
                new_df["index_member"] = existing_tag
                # Append new rows to existing history for this symbol
                merged               = pd.concat(
                    [sym_df, new_df], ignore_index=True
                )
                updated_data[symbol] = merged
                print(f"✔  +{len(new_df)} row(s)")
                incremental_updated += 1

        time.sleep(API_DELAY)

    print(f"\n  {up_to_date} symbols already up to date.")
    print(f"  {incremental_updated} symbols updated incrementally.")
    print(f"  {full_refetch_count} symbols fully re-fetched (split/bonus).")
    print(f"  {len(failed)} symbols returned no data."
          + (f"  {failed}" if failed else ""))

    # ── 4. Rebuild master ────────────────────────────────────────
    if not updated_data:
        print(f"\n[4/5] No new rows — master CSV unchanged.")
        print(f"\n[5/5] Skipping indicator recompute.")
        print(f"\n  ✅ Master CSV is current as of {master_last_date.date()}.")
        return

    all_updated_symbols = set(updated_data.keys())
    total_new_rows      = sum(len(v) for v in updated_data.values())
    print(f"\n[4/5] Rebuilding master — {len(all_updated_symbols)} symbols "
          f"({total_new_rows:,} rows total) …")

    # BUG FIX [3]: Hard-remove ALL rows for updated symbols from the
    # master before concat. For split symbols this is critical — we must
    # not let any un-adjusted old rows survive via dedup ordering.
    stable_df      = df[~df["symbol"].isin(all_updated_symbols)].copy()
    updated_frames = list(updated_data.values())

    df_combined = pd.concat(
        [stable_df] + updated_frames, ignore_index=True
    )

    # Safety dedup — catches any edge-case overlap (e.g. Yahoo returning
    # a date that was already in the incremental new_df)
    df_combined = df_combined.drop_duplicates(
        subset=["symbol", "date"], keep="last"
    )
    df_combined = df_combined.sort_values(
        ["symbol", "date"]
    ).reset_index(drop=True)

    # ── 5. Recompute indicators ───────────────────────────────────
    print(f"\n[5/5] Recomputing indicators …")

    stable_indicators = df_combined[
        ~df_combined["symbol"].isin(all_updated_symbols)
    ]
    changed_df = df_combined[
        df_combined["symbol"].isin(all_updated_symbols)
    ]

    recomputed_frames = []

    for symbol in all_updated_symbols:
        stock_df = changed_df[changed_df["symbol"] == symbol].copy()

        if symbol in full_refetch:
            # Full recompute — entire back-adjusted series is fresh
            stock_df = compute_indicators_full(
                stock_df, VOLATILITY_WINDOW, ANNUALISE_VOL
            )
            print(f"    {symbol:<15} full recompute (split/bonus)")
        else:
            # Tail recompute with seam-fix seed row (BUG FIX [2])
            stock_df = recompute_tail(
                stock_df, VOLATILITY_WINDOW, ANNUALISE_VOL
            )

        recomputed_frames.append(stock_df)

    df_final = pd.concat(
        [stable_indicators] + recomputed_frames, ignore_index=True
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
    print(f"  📊 Total rows        : {len(df_final):,}")
    print(f"  📈 Symbols           : {df_final['symbol'].nunique()}")
    print(f"  📅 Latest date       : {df_final['date'].max().date()}")
    print(f"  🔢 Rows with vol     : "
          f"{df_final['volatility_1y'].notna().sum():,}")
    if full_refetch_count:
        print(f"  ⚡ Splits/bonuses    : {full_refetch_count} symbol(s) "
              f"fully re-fetched and recomputed")


if __name__ == "__main__":
    main()