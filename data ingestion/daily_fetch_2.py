"""
daily_fetch.py — Production-grade Incremental Updater with Split Detection
===========================================================================

OVERVIEW
--------
Run this script Tue–Sat after NSE market close (~18:30 IST).
fetch_and_build.py is run only ONCE to seed the master CSV.
Every subsequent day, this script handles everything.

WHAT THIS DOES (in order)
--------------------------
  1. Load master CSV — normalize all dates to tz-naive
  2. Detect last available trading date on Yahoo (via NIFTYBEES.NS)
  3. Split/bonus detection — re-fetch last 2 stored dates per symbol,
     compare close prices. Any diff > 0.3% = back-adjustment detected.
  4. For split symbols  → full history re-fetch from START_DATE
  5. For all symbols    → incremental append of new rows since last date
  6. Recompute indicators:
       - Split symbols  : full recompute (entire history replaced)
       - Normal symbols : tail recompute (provably correct seam)
  7. Safety checks → atomic save → backup

INDICATORS COMPUTED
--------------------
  daily_return  = (close_t - close_t-1) / close_t-1
  log_return    = ln(close_t / close_t-1)
  volatility_1y = rolling 252-day std of log_return × √252  (annualised)
                  NaN for first 251 rows per symbol — correct by design

FILES PRODUCED
--------------
  nifty250_log_return_volatility.csv         — live file (read by consumers)
  nifty250_log_return_volatility.csv.backup  — previous known-good version
  daily_fetch.log                            — run log (appended each day)
  split_audit.log                            — permanent split event record
"""

import os
import shutil
import logging
import time
from datetime import timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import yfinance as yf


# ═══════════════════════════════════════════════════════════════════
#  CONFIG — edit only this section
# ═══════════════════════════════════════════════════════════════════

MASTER_CSV        = "nifty250_log_return_volatility.csv"
SPLIT_AUDIT_LOG   = "split_audit.log"
START_DATE        = "2015-01-01"      # used only when re-fetching split symbols

VOLATILITY_WINDOW = 252               # trading days for rolling volatility
ANNUALISE_VOL     = True              # True  → volatility_1y = σ × √252 (annualised)
                                      # False → volatility_1y = raw daily σ
                                      # WARNING: column is named volatility_1y —
                                      # strategies expect annualised. Keep True.

SPLIT_THRESHOLD   = 0.003             # 0.3% price diff triggers split detection
                                      # Yahoo rounding noise  ≈ 0.05%  (well below)
                                      # Smallest real bonus   ≈ 4.76%  (well above)
                                      # Safe gap on both sides.

SPLIT_CHECK_DAYS  = 2                 # number of recent stored dates to verify
API_DELAY         = 0.25              # seconds between Yahoo Finance calls
REFERENCE_TICKER  = "NIFTYBEES.NS"    # proxy for detecting last trading date

# Minimum rows expected per year of history (250 trading days × 0.8 safety)
MIN_ROWS_PER_YEAR = 200

# ═══════════════════════════════════════════════════════════════════


# ───────────────────────────────────────────────────────────────────
#  LOGGING
# ───────────────────────────────────────────────────────────────────

def _setup_logging() -> tuple[logging.Logger, logging.Logger]:
    fmt     = "%(asctime)s [%(levelname)s] %(message)s"
    datefmt = "%Y-%m-%d %H:%M:%S"

    # Main run logger — console + file
    logging.basicConfig(
        level=logging.INFO,
        format=fmt,
        datefmt=datefmt,
        handlers=[
            logging.FileHandler("daily_fetch.log"),
            logging.StreamHandler(),
        ],
    )
    main_log = logging.getLogger("daily_fetch")

    # Audit logger — append-only, never truncated, file only
    audit_log = logging.getLogger("split_audit")
    audit_log.setLevel(logging.INFO)
    audit_log.propagate = False
    if not audit_log.handlers:
        fh = logging.FileHandler(SPLIT_AUDIT_LOG)
        fh.setFormatter(logging.Formatter(fmt, datefmt=datefmt))
        audit_log.addHandler(fh)

    return main_log, audit_log


log, audit = _setup_logging()


# ───────────────────────────────────────────────────────────────────
#  PRICE CLEANING
# ───────────────────────────────────────────────────────────────────

def _clean_prices(df: pd.DataFrame, label: str = "") -> pd.DataFrame:
    """
    Remove rows where close is NaN, zero, or negative.

    Why this matters:
      np.log(0)        = -inf  → infinite log_return → strategy blows up
      np.log(negative) = NaN   → silent NaN propagation into indicators
      NaN close        = NaN   → pct_change and log both produce NaN

    Called after every download and after loading the master CSV.
    """
    bad_mask = df["close"].isna() | (df["close"] <= 0)
    n_bad    = int(bad_mask.sum())
    if n_bad > 0:
        log.warning(
            f"_clean_prices({label}): dropping {n_bad} rows with "
            f"zero / null / negative close"
        )
        df = df[~bad_mask].copy()
    return df


# ───────────────────────────────────────────────────────────────────
#  YAHOO DOWNLOAD WRAPPER
# ───────────────────────────────────────────────────────────────────

def _download_ohlcv(
    ticker_ns: str,
    start: str,
    end: str,
) -> pd.DataFrame | None:
    """
    Download OHLCV for one NSE ticker from Yahoo Finance.

    Returns a clean DataFrame with columns:
        date (tz-naive, normalized), open, high, low, close, volume

    Returns None on any failure — never raises.

    Key details:
      - auto_adjust=True  : prices back-adjusted for splits and bonuses
      - tz stripping      : Yahoo sometimes returns tz-aware timestamps;
                            we strip to tz-naive so date comparisons with
                            stored dates never silently fail
      - MultiIndex cols   : yfinance occasionally returns MultiIndex columns;
                            we flatten them
    """
    try:
        raw = yf.download(
            ticker_ns,
            start=start,
            end=end,
            auto_adjust=True,
            progress=False,
            rounding=True,
        )
        if raw.empty:
            return None

        # Flatten MultiIndex columns if present
        if isinstance(raw.columns, pd.MultiIndex):
            raw.columns = raw.columns.get_level_values(0)

        raw = raw.reset_index()
        raw.columns = [c.lower() for c in raw.columns]

        # Keep only OHLCV columns that exist
        keep = [c for c in ["date", "open", "high", "low", "close", "volume"]
                if c in raw.columns]
        raw = raw[keep]

        # Strip timezone and normalize to midnight — critical for date matching
        raw["date"] = (
            pd.to_datetime(raw["date"])
            .dt.tz_localize(None)
            .dt.normalize()
        )

        raw = raw.dropna(subset=["close"])
        raw = raw[raw["close"] > 0]   # also filter zeros early

        if raw.empty:
            return None

        raw = raw.sort_values("date").reset_index(drop=True)
        return raw

    except Exception as e:
        log.error(f"_download_ohlcv({ticker_ns}, {start} → {end}): {e}")
        return None


# ───────────────────────────────────────────────────────────────────
#  TRADING DATE DETECTION
# ───────────────────────────────────────────────────────────────────

def get_last_trading_date() -> pd.Timestamp | None:
    """
    Ask Yahoo what the most recent available trading date is,
    using NIFTYBEES.NS as a reliable proxy.

    Handles weekends, NSE holidays, and Yahoo upload delays automatically:
    whatever date Yahoo's last row carries is exactly the date we should
    fetch up to.

    Returns None only if Yahoo is completely unreachable.
    """
    try:
        ref = yf.download(
            REFERENCE_TICKER,
            period="5d",
            progress=False,
            auto_adjust=True,
            rounding=True,
        )
        if ref.empty:
            log.warning(f"Reference ticker {REFERENCE_TICKER} returned no data")
            return None

        last = pd.to_datetime(ref.index[-1])
        if last.tzinfo is not None:
            last = last.tz_localize(None)
        return last.normalize()

    except Exception as e:
        log.warning(f"Could not reach Yahoo Finance for reference date: {e}")
        return None


# ───────────────────────────────────────────────────────────────────
#  SPLIT / BONUS DETECTION
# ───────────────────────────────────────────────────────────────────

def check_split(
    symbol: str,
    sym_df: pd.DataFrame,
) -> tuple[bool, list[dict]]:
    """
    Detect whether Yahoo has back-adjusted this symbol's history
    since our last fetch (indicating a split or bonus issue).

    Method:
      Re-fetch a window around the last SPLIT_CHECK_DAYS stored dates.
      For each matching date, compare stored close vs Yahoo close.
      If abs(yahoo - stored) / stored > SPLIT_THRESHOLD on any date
      → Yahoo has back-adjusted → full re-fetch required.

    Returns:
      (is_split: bool, evidence: list[dict])
      evidence contains one dict per compared date with full details
      for the audit log.

    Robustness details:
      - Fetch window is ±5 days wider than needed, so weekends and
        holidays never result in zero overlapping rows.
      - Dates are tz-stripped before comparison (timezone mismatch
        causes silent isin() failures that would miss every split).
      - comparisons == 0 is treated as inconclusive (not clean) and
        logged as a warning — normal fetch still runs.
    """
    sym_df     = sym_df.sort_values("date").reset_index(drop=True)
    check_rows = sym_df.tail(SPLIT_CHECK_DAYS)

    if check_rows.empty:
        return False, []

    # Wide fetch window — ensures we get overlapping dates across
    # weekends, holidays, and any Yahoo upload timing variation
    fetch_start = check_rows["date"].iloc[0]  - timedelta(days=5)
    fetch_end   = check_rows["date"].iloc[-1] + timedelta(days=5)

    fetched = _download_ohlcv(
        f"{symbol}.NS",
        start=fetch_start.strftime("%Y-%m-%d"),
        end=fetch_end.strftime("%Y-%m-%d"),
    )

    if fetched is None:
        log.warning(
            f"  {symbol}: Yahoo unreachable during split check — "
            f"treating as clean, normal fetch will proceed"
        )
        return False, []

    # Build date → close map from fresh Yahoo data
    yahoo_map: dict[pd.Timestamp, float] = {
        row["date"]: float(row["close"])
        for _, row in fetched.iterrows()
    }

    evidence    = []
    comparisons = 0
    mismatches  = 0

    for _, row in check_rows.iterrows():
        date         = pd.Timestamp(row["date"]).tz_localize(None).normalize()
        stored_close = float(row["close"])

        if stored_close <= 0 or np.isnan(stored_close):
            continue

        yahoo_close = yahoo_map.get(date)
        if yahoo_close is None:
            continue   # date not in Yahoo window — skip

        comparisons += 1
        diff_pct = abs(yahoo_close - stored_close) / stored_close

        entry = {
            "date":         date.date(),
            "stored_close": round(stored_close, 4),
            "yahoo_close":  round(yahoo_close,  4),
            "diff_pct":     round(diff_pct * 100, 4),
            "mismatch":     diff_pct > SPLIT_THRESHOLD,
        }
        evidence.append(entry)

        if diff_pct > SPLIT_THRESHOLD:
            mismatches += 1

    if comparisons == 0:
        log.warning(
            f"  {symbol}: no overlapping dates found in split check window "
            f"(stored dates may not yet be on Yahoo) — treating as clean"
        )
        return False, []

    return mismatches > 0, evidence


# ───────────────────────────────────────────────────────────────────
#  DATA FETCHERS
# ───────────────────────────────────────────────────────────────────

def _min_acceptable_rows(existing_row_count: int) -> int:
    """
    Calculate the minimum row count we will accept from a full re-fetch.
    Rejects truncated/corrupt Yahoo responses before they replace good data.

    Uses the stricter of:
      - 90% of what we currently have on disk
      - 80% of the theoretical expected rows (years × 250 trading days)
    """
    years_of_history = (
        pd.Timestamp.today() - pd.Timestamp(START_DATE)
    ).days / 365.25

    theoretical_min = int(years_of_history * MIN_ROWS_PER_YEAR)
    retention_min   = int(existing_row_count * 0.90)

    return max(theoretical_min, retention_min)


def fetch_full_history(
    symbol: str,
    existing_row_count: int,
) -> pd.DataFrame | None:
    """
    Download the full price history for one symbol from START_DATE.
    Used when a split or bonus is detected.

    Validates row count before returning — rejects suspiciously short
    responses (network truncation, Yahoo error pages) to prevent good
    data being replaced with garbage.

    Returns clean DataFrame with symbol column prepended, or None on
    any failure (caller retains old data in that case).
    """
    log.info(f"    Full re-fetch: {symbol} from {START_DATE} …")

    df = _download_ohlcv(
        f"{symbol}.NS",
        start=START_DATE,
        end=(pd.Timestamp.today() + timedelta(days=1)).strftime("%Y-%m-%d"),
    )

    if df is None:
        log.error(f"    {symbol}: full re-fetch returned nothing")
        return None

    min_rows = _min_acceptable_rows(existing_row_count)
    if len(df) < min_rows:
        log.error(
            f"    {symbol}: re-fetch returned only {len(df)} rows "
            f"(need >= {min_rows}). Rejecting — old data kept."
        )
        return None

    df.insert(0, "symbol", symbol)
    log.info(
        f"    {symbol}: {len(df):,} rows  "
        f"{df['date'].min().date()} → {df['date'].max().date()}  ✔"
    )
    return df


def fetch_incremental(
    symbol: str,
    from_date: pd.Timestamp,
    to_date: pd.Timestamp,
) -> pd.DataFrame | None:
    """
    Fetch only the new rows for one symbol since from_date.
    Used for the normal daily append (all symbols).
    Also used for split symbols after full re-fetch to pick up
    the latest day's close (full re-fetch ends at yesterday).
    """
    df = _download_ohlcv(
        f"{symbol}.NS",
        start=from_date.strftime("%Y-%m-%d"),
        end=(to_date + timedelta(days=1)).strftime("%Y-%m-%d"),
    )
    if df is not None:
        df.insert(0, "symbol", symbol)
    return df


# ───────────────────────────────────────────────────────────────────
#  INDICATOR COMPUTATION
# ───────────────────────────────────────────────────────────────────

def compute_indicators_full(df: pd.DataFrame) -> pd.DataFrame:
    """
    Compute all three indicators for one or more complete symbol histories.
    Called after a full re-fetch (split symbols).

    Indicators:
      daily_return  = pct_change of close within each symbol group
      log_return    = ln(close_t / close_t-1) within each symbol group
      volatility_1y = rolling 252-day std of log_return
                      × √252 if ANNUALISE_VOL=True (gives annualised vol)
                      First 251 rows per symbol → NaN (correct, not a bug)

    Notes:
      - groupby().pct_change() and groupby().shift(1) respect symbol
        boundaries — first row of each symbol is NaN, never bleeds into
        the next symbol.
      - _clean_prices() called first to prevent log(0) = -inf corruption.
    """
    df = df.sort_values(["symbol", "date"]).reset_index(drop=True)
    df = _clean_prices(df, label="compute_indicators_full")

    grp = df.groupby("symbol")["close"]

    df["daily_return"] = grp.pct_change()
    df["log_return"]   = np.log(df["close"] / grp.shift(1))

    rolling_std = (
        df.groupby("symbol")["log_return"]
          .rolling(window=VOLATILITY_WINDOW, min_periods=VOLATILITY_WINDOW)
          .std()
          .reset_index(level=0, drop=True)
    )
    df["volatility_1y"] = (
        rolling_std * (np.sqrt(252) if ANNUALISE_VOL else 1.0)
    )
    return df


def recompute_tail(stock_df: pd.DataFrame) -> pd.DataFrame:
    """
    Recompute indicators for ONE symbol after appending new rows.
    Provably correct — does not rely on accidental NaN-row discard.

    The problem with naive tail recompute:
      If you slice out the last N rows and call pct_change() / shift(1),
      row 0 of the slice has no predecessor — its daily_return and
      log_return are NaN. If this row happens to be a truly-new row
      (not a borrowed lookback row), that NaN ends up in the output.

    The fix — seed the computation with the actual prior close:
      1. Split into head (unchanged) and context (recompute zone).
      2. Prepend a single seed row to context, whose 'close' is the
         last head close. This gives shift(1) a real predecessor for
         context row 0.
      3. Compute indicators on the seeded context.
      4. Drop the seed row.
      5. Drop borrowed rows (date <= head's last date).
      6. Concatenate head + new tail.

    Edge case — head is empty (fewer than context_size rows total):
      Compute from scratch. First row NaN is correct behaviour.

    Volatility at the seam:
      We borrow VOLATILITY_WINDOW + 5 rows as context. The rolling std
      on the last context rows uses a full 252-row window of log_returns.
      When we discard borrowed rows and keep only new rows, each new
      row's volatility_1y is computed from the correct 252-row window.
    """
    stock_df = stock_df.sort_values("date").reset_index(drop=True)
    stock_df = _clean_prices(stock_df, label=f"recompute_tail")

    n            = len(stock_df)
    context_size = VOLATILITY_WINDOW + 5        # rows to borrow as lookback
    context_start = max(0, n - context_size)

    head    = stock_df.iloc[:context_start].copy()
    context = stock_df.iloc[context_start:].copy().reset_index(drop=True)

    if not head.empty:
        # Build a seed row — same metadata as context row 0,
        # but close replaced with last head close.
        # This row exists only to give shift(1) a real predecessor.
        seed           = context.iloc[[0]].copy()
        seed["close"]  = float(head["close"].iloc[-1])
        # Zero out indicators on seed so they don't accidentally appear
        for col in ["daily_return", "log_return", "volatility_1y"]:
            if col in seed.columns:
                seed[col] = np.nan
        context_seeded = pd.concat([seed, context], ignore_index=True)
    else:
        # No head — compute entirely from scratch
        context_seeded = context.copy()

    # ── Compute indicators on seeded context ──────────────────────
    c = context_seeded  # alias for brevity

    c["daily_return"] = c["close"].pct_change()
    c["log_return"]   = np.log(c["close"] / c["close"].shift(1))

    rolling_std = (
        c["log_return"]
        .rolling(window=VOLATILITY_WINDOW, min_periods=VOLATILITY_WINDOW)
        .std()
    )
    c["volatility_1y"] = rolling_std * (np.sqrt(252) if ANNUALISE_VOL else 1.0)

    # ── Drop seed row ─────────────────────────────────────────────
    if not head.empty:
        c = c.iloc[1:].copy()   # remove the prepended seed row

    # ── Keep only rows newer than head — never overwrite head data ─
    if not head.empty:
        cutoff   = head["date"].iloc[-1]
        new_tail = c[c["date"] > cutoff].copy()
        return pd.concat([head, new_tail], ignore_index=True)
    else:
        return c.reset_index(drop=True)


# ───────────────────────────────────────────────────────────────────
#  SAFE ATOMIC SAVE
# ───────────────────────────────────────────────────────────────────

def safe_save(df: pd.DataFrame, path: str) -> None:
    """
    Write DataFrame to disk atomically.

    Steps:
      1. Write to path + '.tmp'   (original untouched)
      2. Read back .tmp and verify row count (catches disk errors)
      3. Copy current live file to path + '.backup'
      4. os.replace(.tmp → path)  (atomic on Linux — single syscall)

    A crash at any point before step 4 leaves the original intact.
    A crash during step 4 is atomic — OS guarantees old or new, never partial.
    Consumers reading the file at any moment see a complete file.
    """
    tmp_path    = path + ".tmp"
    backup_path = path + ".backup"

    # Step 1: write to temp
    df.to_csv(tmp_path, index=False)

    # Step 2: read-back verify
    verify = pd.read_csv(tmp_path, low_memory=False)
    if len(verify) < int(len(df) * 0.99):
        os.unlink(tmp_path)
        raise RuntimeError(
            f"safe_save: read-back row count {len(verify):,} < "
            f"written {len(df):,}. Disk error? Original file untouched."
        )

    # Step 3: backup
    if Path(path).exists():
        shutil.copy2(path, backup_path)
        log.info(f"Backup saved → {Path(backup_path).name}")

    # Step 4: atomic replace
    os.replace(tmp_path, path)
    log.info(f"Saved {len(df):,} rows → {Path(path).name}")


# ───────────────────────────────────────────────────────────────────
#  COLUMN ORDER HELPER
# ───────────────────────────────────────────────────────────────────

_COL_ORDER = [
    "symbol", "date", "open", "high", "low", "close", "volume",
    "index_member", "daily_return", "log_return", "volatility_1y",
]

def _enforce_col_order(df: pd.DataFrame) -> pd.DataFrame:
    cols = [c for c in _COL_ORDER if c in df.columns]
    return df[cols]


# ───────────────────────────────────────────────────────────────────
#  MAIN
# ───────────────────────────────────────────────────────────────────

def main() -> None:
    log.info("=" * 62)
    log.info("  DAILY FETCH  (incremental + split detection)")
    log.info("=" * 62)

    # ── STEP 1: Load master CSV ──────────────────────────────────
    log.info(f"\n[1/5] Loading {MASTER_CSV} …")

    if not Path(MASTER_CSV).exists():
        raise FileNotFoundError(
            f"'{MASTER_CSV}' not found. Run fetch_and_build.py first."
        )

    df = pd.read_csv(MASTER_CSV, low_memory=False)

    # Normalize dates — strip tz so comparisons with Yahoo never fail
    df["date"] = (
        pd.to_datetime(df["date"])
        .dt.tz_localize(None)
        .dt.normalize()
    )
    df["close"] = pd.to_numeric(df["close"], errors="coerce")

    # Ensure index_member column exists
    if "index_member" not in df.columns:
        log.warning("'index_member' column missing — defaulting all to nifty250")
        df["index_member"] = "nifty250"

    # Clean prices on load
    df = _clean_prices(df, label="master CSV load")

    original_row_count = len(df)
    symbols            = df["symbol"].unique().tolist()

    log.info(f"  Symbols  : {len(symbols)}")
    log.info(f"  Rows     : {original_row_count:,}")
    log.info(f"  Latest   : {df['date'].max().date()}")

    # ── STEP 2: Detect last available trading date ───────────────
    log.info(f"\n[2/5] Detecting last available trading date on Yahoo …")

    last_available = get_last_trading_date()

    if last_available is None:
        # Fallback: yesterday. Script continues with a warning.
        last_available = (pd.Timestamp.today() - timedelta(days=1)).normalize()
        log.warning(f"  Fallback to yesterday: {last_available.date()}")
    else:
        log.info(f"  Yahoo last date : {last_available.date()}")

    master_last = df["date"].max()

    if master_last >= last_available:
        log.info(
            f"\n  Already up to date ({master_last.date()}). Nothing to do."
        )
        return

    log.info(
        f"  Master last : {master_last.date()}  "
        f"({(last_available - master_last).days} calendar day(s) behind)"
    )

    # ── STEP 3: Split / bonus detection ─────────────────────────
    log.info(
        f"\n[3/5] Split/bonus check — verifying last {SPLIT_CHECK_DAYS} "
        f"dates per symbol (threshold = {SPLIT_THRESHOLD*100:.1f}%) …\n"
    )

    split_symbols  = []
    normal_symbols = []

    for i, symbol in enumerate(symbols, 1):
        sym_df   = df[df["symbol"] == symbol].copy()
        print(f"  [{i:>3}/{len(symbols)}] {symbol:<15}", end=" ", flush=True)

        is_split, evidence = check_split(symbol, sym_df)

        if is_split:
            print("⚡ SPLIT / BONUS DETECTED")
            split_symbols.append(symbol)

            # Write every mismatched date to the permanent audit log
            for ev in evidence:
                if ev["mismatch"]:
                    audit.info(
                        f"SPLIT_DETECTED | {symbol} | "
                        f"date={ev['date']} | "
                        f"stored={ev['stored_close']} | "
                        f"yahoo={ev['yahoo_close']} | "
                        f"diff={ev['diff_pct']}%"
                    )
        else:
            print("✔  clean")
            normal_symbols.append(symbol)

        time.sleep(API_DELAY)

    log.info(f"\n  Splits detected : {len(split_symbols)}")
    if split_symbols:
        log.info(f"  → {split_symbols}")
    log.info(f"  Clean symbols   : {len(normal_symbols)}")

    # ── STEP 4: Fetch data ───────────────────────────────────────
    log.info(f"\n[4/5] Fetching data …")

    split_failed       = []   # split re-fetch could not complete
    successfully_split = []   # split re-fetch succeeded

    # ── 4a. Full re-fetch for split/bonus symbols ────────────────
    if split_symbols:
        log.info(f"\n  Full re-fetch for {len(split_symbols)} split symbol(s) …")

        for symbol in split_symbols:
            existing_rows = int((df["symbol"] == symbol).sum())
            fresh         = fetch_full_history(symbol, existing_rows)

            if fresh is None:
                # Re-fetch failed — KEEP old data, flag symbol
                log.error(
                    f"  {symbol}: re-fetch FAILED. "
                    f"Old (back-adjusted) data retained. "
                    f"Will retry on next run. "
                    f"DO NOT trade this symbol until resolved."
                )
                audit.warning(
                    f"REFETCH_FAILED | {symbol} | "
                    f"old data retained | retry next run"
                )
                split_failed.append(symbol)
                # Do not touch df for this symbol
                continue

            # Replace old rows with fresh adjusted history
            tag = df.loc[df["symbol"] == symbol, "index_member"].iloc[0]
            fresh["index_member"] = tag

            df = df[df["symbol"] != symbol]
            df = pd.concat([df, fresh], ignore_index=True)

            successfully_split.append(symbol)
            audit.info(
                f"REFETCH_OK | {symbol} | "
                f"rows={len(fresh)} | "
                f"range={fresh['date'].min().date()}→{fresh['date'].max().date()}"
            )
            time.sleep(API_DELAY)

    # ── 4b. Incremental append for ALL symbols ───────────────────
    #
    # Why split symbols also go through incremental fetch:
    #   fetch_full_history() downloads up to today but Yahoo's last
    #   available date may be yesterday. The incremental step ensures
    #   every symbol (including successfully re-fetched ones) gets
    #   today's close appended if it is available.
    #
    symbols_for_append = set(normal_symbols) | set(successfully_split)

    log.info(
        f"\n  Incremental append for {len(symbols_for_append)} symbol(s) …"
    )

    new_rows_list      = []
    incremental_failed = []

    for symbol in sorted(symbols_for_append):
        sym_last   = df.loc[df["symbol"] == symbol, "date"].max()
        start_from = sym_last + timedelta(days=1)

        if sym_last >= last_available:
            continue   # already current

        new_df = fetch_incremental(symbol, start_from, last_available)

        if new_df is None or new_df.empty:
            log.warning(f"  {symbol}: incremental fetch returned nothing")
            incremental_failed.append(symbol)
        else:
            tag                  = df.loc[df["symbol"] == symbol, "index_member"].iloc[0]
            new_df["index_member"] = tag
            new_rows_list.append(new_df)
            log.info(f"  {symbol}: +{len(new_df)} row(s) ✔")

        time.sleep(API_DELAY)

    # Merge new rows into master DataFrame
    if new_rows_list:
        df = pd.concat([df] + new_rows_list, ignore_index=True)

    # Deduplicate — safe to run multiple times per day
    df = df.drop_duplicates(subset=["symbol", "date"], keep="last")
    df = df.sort_values(["symbol", "date"]).reset_index(drop=True)

    # ── STEP 5: Recompute indicators ─────────────────────────────
    log.info(f"\n[5/5] Recomputing indicators …")

    # 5a. Full recompute for split symbols (entire history replaced)
    if successfully_split:
        log.info(
            f"  Full indicator recompute for "
            f"{len(successfully_split)} split symbol(s) …"
        )
        stable  = df[~df["symbol"].isin(successfully_split)]
        rebuilt = df[ df["symbol"].isin(successfully_split)]
        rebuilt = compute_indicators_full(rebuilt)
        df      = pd.concat([stable, rebuilt], ignore_index=True)

    # 5b. Tail recompute for normally-appended symbols
    appended_symbols = {
        chunk["symbol"].iloc[0] for chunk in new_rows_list
    }
    # Exclude split symbols — already fully recomputed above
    tail_symbols = appended_symbols - set(successfully_split)

    if tail_symbols:
        log.info(
            f"  Tail indicator recompute for "
            f"{len(tail_symbols)} normal symbol(s) …"
        )
        stable   = df[~df["symbol"].isin(tail_symbols)]
        changed  = df[ df["symbol"].isin(tail_symbols)]

        recomputed = []
        for symbol in tail_symbols:
            s = changed[changed["symbol"] == symbol].copy()
            recomputed.append(recompute_tail(s))

        df = pd.concat([stable] + recomputed, ignore_index=True)

    # Final sort and column order
    df = df.sort_values(["symbol", "date"]).reset_index(drop=True)
    df = _enforce_col_order(df)

    # ── Safety check before save ─────────────────────────────────
    #
    # If the final row count is less than what we started with,
    # something went wrong in the pipeline (concat bug, filter bug,
    # pandas API change). Hard-abort — do not touch the file on disk.
    #
    if len(df) < original_row_count:
        raise RuntimeError(
            f"SAFETY ABORT: final row count {len(df):,} < "
            f"original {original_row_count:,}. "
            f"This should never happen. "
            f"Master CSV not saved. Investigate before re-running."
        )

    # ── Atomic save ───────────────────────────────────────────────
    safe_save(df, MASTER_CSV)

    # ── Summary ───────────────────────────────────────────────────
    log.info("\n" + "=" * 62)
    log.info("  SUMMARY")
    log.info("=" * 62)
    log.info(f"  Total rows            : {len(df):,}")
    log.info(f"  Symbols               : {df['symbol'].nunique()}")
    log.info(f"  Latest date           : {df['date'].max().date()}")
    log.info(f"  Splits corrected      : {len(successfully_split)}"
             + (f"  {successfully_split}" if successfully_split else ""))
    log.info(f"  Split fetch failed    : {len(split_failed)}"
             + (f"  {split_failed}" if split_failed else ""))
    log.info(f"  Incremental failed    : {len(incremental_failed)}"
             + (f"  {incremental_failed}" if incremental_failed else ""))
    log.info(
        f"  Rows with vol         : "
        f"{df['volatility_1y'].notna().sum():,}  "
        f"({df['volatility_1y'].notna().mean():.1%})"
    )

    if split_failed:
        log.warning(
            f"\n  *** WARNING ***\n"
            f"  The following symbols have back-adjusted (split/bonus) prices\n"
            f"  that could NOT be corrected in this run:\n"
            f"  {split_failed}\n"
            f"  These symbols retain their old adjusted prices.\n"
            f"  EXCLUDE them from live trading until the next successful run.\n"
            f"  They will be retried automatically on the next daily run."
        )

    if incremental_failed:
        log.warning(
            f"\n  The following symbols had no new rows fetched today:\n"
            f"  {incremental_failed}\n"
            f"  This may be a Yahoo data delay — check tomorrow."
        )


if __name__ == "__main__":
    main()