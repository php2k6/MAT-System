"""
NSE Momentum Strategy — Production-Grade Backtester
=====================================================
All system parameters are configurable in the CONFIG block below.

UNIVERSE OPTIONS:
    "nifty50"   → Top  50 large-cap stocks
    "nifty100"  → Top 100 large-cap stocks
    "nifty150"  → Top 150 mid-cap stocks
    "nifty250"  → Top 250 large + mid-cap stocks

    Your CSV must contain a column named 'index_member' with values like
    "nifty50", "nifty100", etc. OR a column 'market_cap_rank' (integer rank).
    If neither exists, set UNIVERSE_FILTER = None to use all symbols in the CSV.

REBALANCE FREQUENCY:
    rebalance_months = 1   → monthly
    rebalance_months = 3   → quarterly
    rebalance_months = 6   → semi-annual
    rebalance_months = 12  → yearly

REALISTIC SIMULATION RULES:
  1.  Cash never goes negative — never deploy more than available cash
  2.  On rebalance: SELLS first (free up cash), then BUYS
  3.  Transaction costs on every trade, deducted from cash
  4.  Fractional shares NOT allowed — integer shares only
  5.  Stocks with zero/missing price on rebalance day are skipped
  6.  If a held stock has no price on a day, last known price is carried forward
  7.  Momentum score requires full lookback history — partial-history stocks skipped
  8.  Portfolio value = cash + Σ(integer_shares × current_price)
  9.  Target weights applied on AVAILABLE portfolio value, not theoretical
 10.  Excess cash after integer-share rounding stays as cash
 11.  STT on SELL side: 0.1% of sell value
 12.  Exchange transaction charge: 0.00325% of turnover
 13.  GST: 18% on (brokerage + exchange charges)
 14.  SEBI charges: 0.0001% of turnover
 15.  Stamp duty: 0.015% on BUY side only
 16.  Suspended/circuit-hit stocks held at last price, not traded

REQUIRED CSV COLUMNS:
    date           — trading date (any parseable format)
    symbol         — stock ticker
    close          — adjusted closing price (INR)
    volatility_1y  — annualised volatility (rolling 1-year)

OPTIONAL CSV COLUMNS (needed for universe filtering):
    index_member   — e.g. "nifty50" / "nifty100" / "nifty150" / "nifty250"
                     (assign the SMALLEST index the stock belongs to)
"""

import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
import matplotlib.ticker as mticker
from pathlib import Path


# ═══════════════════════════════════════════════════════════════════
#  EDIT ONLY THIS BLOCK
# ═══════════════════════════════════════════════════════════════════

CONFIG = dict(

    # ── File path ─────────────────────────────────────────────────
    csv_path        = r"nifty250_log_return_volatility.csv",

    # ── Universe ──────────────────────────────────────────────────
    # Options: "nifty50" | "nifty100" | "nifty150" | "nifty250" | None
    # "nifty50"  → only stocks where index_member == "nifty50"
    # "nifty100" → stocks where index_member IN ["nifty50","nifty100"]
    # "nifty150" → stocks where index_member IN ["nifty50","nifty100","nifty150"]
    # "nifty250" → all stocks (or index_member IN all four)
    # None       → use all symbols in the CSV (no universe filter)

    universe        = "None",       # ← CHANGE THIS

    # ── Portfolio Parameters ──────────────────────────────────────
    n_stocks        = 30,               # ← No. of stocks to hold
    max_price       = 5_000,            # ← INR price cap (set 999_999 for no cap)
    min_price       = 1.0,              # ← minimum price filter (keep 1.0)

    # ── Capital & Start Year ──────────────────────────────────────
    initial_capital = 1_000_000,        # ← Starting capital in INR
    start_year      = 2020,             # ← Backtest start year

    # ── Rebalance Frequency ───────────────────────────────────────
    # Number of calendar months between rebalances
    # 1 = monthly | 3 = quarterly | 6 = semi-annual | 12 = yearly
    rebalance_months = 1,               # ← CHANGE THIS

    # ── Momentum Lookback Periods (calendar months) ───────────────
    # These are converted to approximate trading days internally
    lookback_period_1_months = 6,       # ← Lookback Period 1 (months)
    lookback_period_2_months = 12,      # ← Lookback Period 2 (months)
    skip_months              = 1,       # skip most-recent N months (reversal filter)

    # ── Score Weights (must sum to 1.0) ───────────────────────────
    weight_period_1 = 0.4,              # weight for lookback period 1
    weight_period_2 = 0.6,              # weight for lookback period 2

    # ── Safety Cash Buffer ────────────────────────────────────────
    cash_buffer_pct = 0.005,            # 0.5% — prevents float rounding negatives

    # ── NSE Transaction Costs (fractions) ────────────────────────
    # Only change these if your broker/tax rules differ
    brokerage_pct       = 0.0003,       # 0.03% (Zerodha-style, capped ₹20/order)
    stt_sell_pct        = 0.001,        # 0.1% STT on sell side only
    exchange_charge_pct = 0.0000325,    # NSE exchange transaction charge
    sebi_charge_pct     = 0.000001,     # SEBI turnover charge
    gst_rate            = 0.18,         # 18% GST on brokerage + exchange charge
    stamp_duty_buy_pct  = 0.00015,      # 0.015% stamp duty on buy side only
)

# ═══════════════════════════════════════════════════════════════════
#  END OF CONFIG — do not edit below unless you know what you're doing
# ═══════════════════════════════════════════════════════════════════


# ── Universe membership map ──────────────────────────────────────
_UNIVERSE_HIERARCHY = {
    "nifty50":  ["nifty50"],
    "nifty100": ["nifty50", "nifty100"],
    "nifty150": ["nifty50", "nifty100", "nifty150"],
    "nifty250": ["nifty50", "nifty100", "nifty150", "nifty250"],
}

# ── Convert months → approximate trading days ────────────────────
_TRADING_DAYS_PER_MONTH = 21

def _months_to_tdays(months: int) -> int:
    return int(months * _TRADING_DAYS_PER_MONTH)


# ═══════════════════════════════════════════════════════════════════
#  COST CALCULATOR
# ═══════════════════════════════════════════════════════════════════

def compute_trade_cost(value: float, side: str, cfg: dict) -> float:
    """
    Compute total realistic NSE transaction cost for a single trade.
    side: "buy" or "sell" — Returns total cost in INR (always positive).
    """
    value      = abs(value)
    brokerage  = min(value * cfg["brokerage_pct"], 20.0)   # ₹20 cap per order
    exchange   = value * cfg["exchange_charge_pct"]
    sebi       = value * cfg["sebi_charge_pct"]
    gst        = (brokerage + exchange) * cfg["gst_rate"]
    stt        = value * cfg["stt_sell_pct"]        if side == "sell" else 0.0
    stamp      = value * cfg["stamp_duty_buy_pct"]  if side == "buy"  else 0.0
    return brokerage + exchange + sebi + gst + stt + stamp


# ═══════════════════════════════════════════════════════════════════
#  REBALANCE DATE BUILDER  (supports arbitrary N-month frequency)
# ═══════════════════════════════════════════════════════════════════

def get_rebalance_dates(dates: pd.Series, rebalance_months: int) -> set:
    """
    Return set of LAST trading dates for each N-month period.
    rebalance_months=1 → end of every month
    rebalance_months=3 → end of every quarter
    etc.
    """
    all_dates = pd.to_datetime(sorted(dates.unique()))
    tmp = pd.DataFrame({"date": all_dates})
    tmp["year"]  = tmp["date"].dt.year
    tmp["month"] = tmp["date"].dt.month

    # Assign each row to a period bucket: (year * 12 + month) // rebalance_months
    tmp["bucket"] = (tmp["year"] * 12 + tmp["month"] - 1) // rebalance_months
    return set(tmp.groupby("bucket")["date"].max())


# ═══════════════════════════════════════════════════════════════════
#  MOMENTUM SCORE COMPUTATION
# ═══════════════════════════════════════════════════════════════════

def add_momentum_scores(df: pd.DataFrame, cfg: dict) -> pd.DataFrame:
    """Add risk-adjusted momentum scores using the configured lookback periods."""
    skip  = _months_to_tdays(cfg["skip_months"])
    lb1   = _months_to_tdays(cfg["lookback_period_1_months"])
    lb2   = _months_to_tdays(cfg["lookback_period_2_months"])
    w1    = cfg["weight_period_1"]
    w2    = cfg["weight_period_2"]

    g = df.groupby("symbol")["close"]

    df["p_t"]  = g.shift(skip)   # price N months ago (skip recent)
    df["p_lb1"] = g.shift(lb1)   # price at lookback period 1
    df["p_lb2"] = g.shift(lb2)   # price at lookback period 2

    df["ret_lb1"] = (df["p_t"] / df["p_lb1"]) - 1
    df["ret_lb2"] = (df["p_t"] / df["p_lb2"]) - 1

    # Risk-Adjusted Momentum (return / annualised volatility)
    df["ram_1"] = df["ret_lb1"] / df["volatility_1y"]
    df["ram_2"] = df["ret_lb2"] / df["volatility_1y"]

    df["momentum_score"] = w1 * df["ram_1"] + w2 * df["ram_2"]
    return df


# ═══════════════════════════════════════════════════════════════════
#  UNIVERSE FILTER
# ═══════════════════════════════════════════════════════════════════

def filter_universe(df: pd.DataFrame, universe: str) -> pd.DataFrame:
    """
    Filter dataframe to the requested universe.
    Requires 'index_member' column in CSV. If absent, returns df unchanged
    with a warning.
    """
    if universe is None:
        return df

    if "index_member" not in df.columns:
        print(f"  ⚠  WARNING: 'index_member' column not found in CSV.")
        print(f"     Universe filter '{universe}' will NOT be applied.")
        print(f"     Add an 'index_member' column to your CSV to enable this filter.")
        return df

    allowed = _UNIVERSE_HIERARCHY.get(universe.lower())
    if allowed is None:
        raise ValueError(
            f"Unknown universe '{universe}'. "
            f"Choose from: {list(_UNIVERSE_HIERARCHY.keys())} or None."
        )

    filtered = df[df["index_member"].str.lower().isin(allowed)].copy()
    original_syms  = df["symbol"].nunique()
    filtered_syms  = filtered["symbol"].nunique()
    print(f"    Universe '{universe}': {filtered_syms} symbols "
          f"(from {original_syms} total in CSV)")
    return filtered


# ═══════════════════════════════════════════════════════════════════
#  MAIN BACKTEST ENGINE
# ═══════════════════════════════════════════════════════════════════

def run_backtest(cfg: dict):
    print("=" * 65)
    print("  NSE MOMENTUM BACKTESTER — REALISTIC SIMULATION")
    print("=" * 65)
    _print_config_summary(cfg)

    # ── Load data ────────────────────────────────────────────────
    print("\n[1/5] Loading data …")
    df = pd.read_csv(cfg["csv_path"])
    df["date"] = pd.to_datetime(df["date"])
    df = df.sort_values(["symbol", "date"]).reset_index(drop=True)

    required_cols = {"date", "symbol", "close", "volatility_1y"}
    missing = required_cols - set(df.columns)
    if missing:
        raise ValueError(f"CSV missing required columns: {missing}")

    print(f"    Loaded {len(df):,} rows | {df['symbol'].nunique()} symbols "
          f"| {df['date'].min().date()} → {df['date'].max().date()}")

    # ── Universe filter ──────────────────────────────────────────
    df = filter_universe(df, cfg.get("universe"))

    # ── Compute momentum scores ──────────────────────────────────
    print("[2/5] Computing momentum scores …")
    df = add_momentum_scores(df, cfg)

    # Filter to backtest window AFTER computing lookbacks
    df = df[df["date"].dt.year >= cfg["start_year"]].copy()
    df = df[df["close"] > 0].copy()

    # ── Build price matrix for fast lookup ───────────────────────
    print("[3/5] Building price matrix …")
    price_pivot = df.pivot_table(index="date", columns="symbol", values="close")
    price_pivot = price_pivot.ffill()   # carry forward on halts/suspensions

    all_dates       = sorted(df["date"].unique())
    rebalance_dates = get_rebalance_dates(
        pd.Series(all_dates), cfg["rebalance_months"]
    )

    freq_label = _freq_label(cfg["rebalance_months"])
    print(f"    Backtest dates : {len(all_dates)}")
    print(f"    Rebalance dates: {len(rebalance_dates)}  ({freq_label})")

    # ── Portfolio state ──────────────────────────────────────────
    cash        = float(cfg["initial_capital"])
    holdings    = {}     # {symbol: int_shares}
    last_prices = {}     # {symbol: last known price}

    portfolio_history = []
    rebalance_log     = []
    trade_log         = []
    buffer_pct        = cfg["cash_buffer_pct"]

    print("[4/5] Running simulation …")

    for current_date in all_dates:

        today_prices = price_pivot.loc[current_date].dropna().to_dict()
        last_prices.update(today_prices)

        # ── REBALANCE ────────────────────────────────────────────
        if current_date in rebalance_dates:

            pv_before = cash + sum(
                sh * last_prices.get(sym, 0.0) for sym, sh in holdings.items()
            )

            # Select new portfolio
            day_scores = df[df["date"] == current_date][
                ["symbol", "close", "momentum_score", "volatility_1y"]
            ].dropna(subset=["momentum_score", "volatility_1y"])

            eligible = day_scores[
                (day_scores["close"] >= cfg["min_price"]) &
                (day_scores["close"] <= cfg["max_price"]) &
                (day_scores["symbol"].isin(today_prices))
            ]

            new_selected = set(
                eligible.nlargest(cfg["n_stocks"], "momentum_score")["symbol"].tolist()
            )

            to_sell = {sym for sym in holdings if sym not in new_selected}
            to_buy  = new_selected - set(holdings.keys())
            to_hold = set(holdings.keys()) & new_selected

            # ── STEP 1: Sell exited positions → free cash ─────────
            for sym in to_sell:
                shares = holdings[sym]
                if shares <= 0:
                    continue
                price = today_prices.get(sym, last_prices.get(sym, 0.0))
                if price <= 0:
                    continue
                sell_value = shares * price
                cost       = compute_trade_cost(sell_value, "sell", cfg)
                cash      += sell_value - cost
                trade_log.append({
                    "date": current_date, "symbol": sym, "action": "SELL",
                    "shares": shares, "price": price,
                    "gross_value": sell_value, "cost": cost, "net": sell_value - cost,
                })
            for sym in list(to_sell):
                del holdings[sym]

            # ── STEP 2: Portfolio value post-sell ─────────────────
            pv_postsell = cash + sum(
                sh * today_prices.get(sym, last_prices.get(sym, 0.0))
                for sym, sh in holdings.items()
            )
            deployable    = pv_postsell * (1 - buffer_pct)
            target_weight = 1.0 / len(new_selected) if new_selected else 0.0

            # ── STEP 3: Adjust existing holdings ──────────────────
            for sym in to_hold:
                price = today_prices.get(sym, last_prices.get(sym, 0.0))
                if price <= 0:
                    continue
                target_shares  = int(deployable * target_weight / price)
                current_shares = holdings.get(sym, 0)
                delta          = target_shares - current_shares

                if delta > 0:
                    buy_value = delta * price
                    cost      = compute_trade_cost(buy_value, "buy", cfg)
                    if cash >= buy_value + cost:
                        cash -= buy_value + cost
                        holdings[sym] = target_shares
                        trade_log.append({
                            "date": current_date, "symbol": sym, "action": "BUY_ADJ",
                            "shares": delta, "price": price,
                            "gross_value": buy_value, "cost": cost,
                            "net": -(buy_value + cost),
                        })
                    else:
                        max_sh = _max_buyable_shares(cash, price, cfg)
                        if max_sh > 0:
                            buy_value = max_sh * price
                            cost      = compute_trade_cost(buy_value, "buy", cfg)
                            cash     -= buy_value + cost
                            holdings[sym] = current_shares + max_sh
                            trade_log.append({
                                "date": current_date, "symbol": sym,
                                "action": "BUY_ADJ_PARTIAL",
                                "shares": max_sh, "price": price,
                                "gross_value": buy_value, "cost": cost,
                                "net": -(buy_value + cost),
                            })
                elif delta < 0:
                    trim       = abs(delta)
                    sell_value = trim * price
                    cost       = compute_trade_cost(sell_value, "sell", cfg)
                    cash      += sell_value - cost
                    holdings[sym] = target_shares
                    trade_log.append({
                        "date": current_date, "symbol": sym, "action": "SELL_ADJ",
                        "shares": trim, "price": price,
                        "gross_value": sell_value, "cost": cost,
                        "net": sell_value - cost,
                    })

            # ── STEP 4: Buy new entries ────────────────────────────
            for sym in to_buy:
                price = today_prices.get(sym)
                if not price or price <= 0:
                    continue
                target_shares = int(deployable * target_weight / price)
                if target_shares <= 0:
                    continue
                buy_value    = target_shares * price
                cost         = compute_trade_cost(buy_value, "buy", cfg)
                total_needed = buy_value + cost

                if cash >= total_needed:
                    cash -= total_needed
                    holdings[sym] = target_shares
                    trade_log.append({
                        "date": current_date, "symbol": sym, "action": "BUY_NEW",
                        "shares": target_shares, "price": price,
                        "gross_value": buy_value, "cost": cost, "net": -total_needed,
                    })
                else:
                    max_sh = _max_buyable_shares(cash, price, cfg)
                    if max_sh > 0:
                        buy_value = max_sh * price
                        cost      = compute_trade_cost(buy_value, "buy", cfg)
                        if cash >= buy_value + cost:
                            cash -= buy_value + cost
                            holdings[sym] = max_sh
                            trade_log.append({
                                "date": current_date, "symbol": sym,
                                "action": "BUY_NEW_PARTIAL",
                                "shares": max_sh, "price": price,
                                "gross_value": buy_value, "cost": cost,
                                "net": -(buy_value + cost),
                            })

            # ── Safety check ──────────────────────────────────────
            if cash < -1.0:
                raise RuntimeError(
                    f"[{current_date}] CASH WENT NEGATIVE: ₹{cash:,.2f}. "
                    "Logic error in buy/sell sequencing!"
                )
            cash = max(cash, 0.0)

            pv_after = cash + sum(
                sh * today_prices.get(sym, last_prices.get(sym, 0.0))
                for sym, sh in holdings.items()
            )
            rebalance_log.append({
                "date":       current_date,
                "pv_before":  round(pv_before, 2),
                "pv_after":   round(pv_after, 2),
                "cash":       round(cash, 2),
                "n_holdings": len(holdings),
                "n_new_buys": len(to_buy),
                "n_sells":    len(to_sell),
                "n_adjusted": len(to_hold),
                "holdings":   dict(holdings),
            })

        # ── Daily mark-to-market ─────────────────────────────────
        pv = cash + sum(
            sh * today_prices.get(sym, last_prices.get(sym, 0.0))
            for sym, sh in holdings.items()
        )
        portfolio_history.append({
            "date":            current_date,
            "portfolio_value": round(pv, 2),
            "cash":            round(cash, 2),
            "invested":        round(pv - cash, 2),
            "n_holdings":      len(holdings),
        })

    print("[5/5] Simulation complete.\n")

    result   = pd.DataFrame(portfolio_history).set_index("date")
    result.index = pd.to_datetime(result.index)
    trades_df = pd.DataFrame(trade_log)
    rebal_df  = pd.DataFrame(rebalance_log)

    return result, rebal_df, trades_df


# ═══════════════════════════════════════════════════════════════════
#  HELPERS
# ═══════════════════════════════════════════════════════════════════

def _max_buyable_shares(cash: float, price: float, cfg: dict) -> int:
    """Estimate max integer shares purchasable with available cash."""
    cost_factor = (1 + cfg["brokerage_pct"] + cfg["exchange_charge_pct"]
                   + cfg["stamp_duty_buy_pct"] + cfg["sebi_charge_pct"] + 0.001)
    return int(cash / (price * cost_factor))


def _freq_label(months: int) -> str:
    labels = {1: "Monthly", 3: "Quarterly", 6: "Semi-Annual", 12: "Yearly"}
    return labels.get(months, f"Every {months} months")


def _print_config_summary(cfg: dict):
    print("\n  ── Strategy Configuration ──────────────────────────────")
    print(f"  Universe          : {cfg.get('universe', 'All').upper()}")
    print(f"  No. of Stocks     : {cfg['n_stocks']}")
    print(f"  Stock Price Cap   : {'No limit' if cfg['max_price'] >= 999_999 else f'₹{cfg[chr(109)+chr(97)+chr(120)+ chr(95)+chr(112)+chr(114)+chr(105)+chr(99)+chr(101)]:,}'}")
    print(f"  Lookback Period 1 : {cfg['lookback_period_1_months']} months  "
          f"(weight {cfg['weight_period_1']:.0%})")
    print(f"  Lookback Period 2 : {cfg['lookback_period_2_months']} months  "
          f"(weight {cfg['weight_period_2']:.0%})")
    print(f"  Rebalance Freq    : {_freq_label(cfg['rebalance_months'])}")
    print(f"  Initial Capital   : ₹{cfg['initial_capital']:,.0f}")
    print(f"  Start Year        : {cfg['start_year']}")
    print("  ────────────────────────────────────────────────────────\n")


# ═══════════════════════════════════════════════════════════════════
#  PERFORMANCE METRICS
# ═══════════════════════════════════════════════════════════════════

def compute_metrics(result: pd.DataFrame, cfg: dict) -> dict:
    pv   = result["portfolio_value"]
    rets = pv.pct_change().dropna()

    total_return = (pv.iloc[-1] / pv.iloc[0]) - 1
    n_years      = (pv.index[-1] - pv.index[0]).days / 365.25
    cagr         = (1 + total_return) ** (1 / max(n_years, 0.001)) - 1

    ann_vol  = rets.std() * np.sqrt(252)
    sharpe   = (rets.mean() * 252) / ann_vol if ann_vol > 0 else np.nan

    rolling_max = pv.cummax()
    drawdown    = (pv - rolling_max) / rolling_max
    max_dd      = drawdown.min()
    calmar      = cagr / abs(max_dd) if max_dd != 0 else np.nan

    win_rate     = (rets > 0).sum() / len(rets)
    avg_cash_pct = (result["cash"] / result["portfolio_value"]).mean()

    return dict(
        Period           = f"{pv.index[0].date()}  →  {pv.index[-1].date()}",
        Universe         = str(cfg.get("universe", "all")).upper(),
        Initial_Capital  = f"₹{cfg['initial_capital']:>12,.0f}",
        Final_Value      = f"₹{pv.iloc[-1]:>12,.0f}",
        Total_Return     = f"{total_return:>10.2%}",
        CAGR             = f"{cagr:>10.2%}",
        Ann_Volatility   = f"{ann_vol:>10.2%}",
        Sharpe_Ratio     = f"{sharpe:>10.2f}",
        Max_Drawdown     = f"{max_dd:>10.2%}",
        Calmar_Ratio     = f"{calmar:>10.2f}",
        Win_Rate_Daily   = f"{win_rate:>10.2%}",
        Best_Day         = f"{rets.max():>10.2%}",
        Worst_Day        = f"{rets.min():>10.2%}",
        Avg_Cash_Drag    = f"{avg_cash_pct:>10.2%}",
    )


# ═══════════════════════════════════════════════════════════════════
#  PLOTS
# ═══════════════════════════════════════════════════════════════════

def plot_results(result: pd.DataFrame, cfg: dict, out_path: str = None):
    freq_label = _freq_label(cfg["rebalance_months"])
    universe   = str(cfg.get("universe", "all")).upper()

    fig, axes = plt.subplots(
        4, 1, figsize=(15, 13), sharex=True,
        gridspec_kw={"height_ratios": [3, 1.5, 1.5, 1]}
    )
    fig.suptitle(
        f"NSE Momentum Strategy  |  Universe: {universe}  "
        f"|  Top-{cfg['n_stocks']} Stocks  |  {freq_label} Rebalance\n"
        f"Lookback: {cfg['lookback_period_1_months']}M + {cfg['lookback_period_2_months']}M  "
        f"|  Capital ₹{cfg['initial_capital']:,.0f}  "
        f"|  Realistic NSE costs",
        fontsize=12, fontweight="bold", y=1.01
    )

    pv          = result["portfolio_value"]
    cash        = result["cash"]
    invested    = result["invested"]
    rets        = pv.pct_change().dropna()
    drawdown    = (pv - pv.cummax()) / pv.cummax()
    lakh        = 1e5

    # 1. Equity Curve
    ax = axes[0]
    ax.stackplot(result.index, invested / lakh, cash / lakh,
                 labels=["Invested", "Cash"],
                 colors=["#4C72B0", "#C8D8E8"], alpha=0.85)
    ax.plot(result.index, pv / lakh, color="#1a1a2e", linewidth=1.2, label="Total NAV")
    ax.yaxis.set_major_formatter(mticker.FuncFormatter(lambda x, _: f"₹{x:.0f}L"))
    ax.set_ylabel("Portfolio Value (Lakhs)")
    ax.set_title("Equity Curve (Invested vs Cash)")
    ax.legend(loc="upper left", fontsize=9)
    ax.grid(True, alpha=0.3)

    # 2. Drawdown
    ax = axes[1]
    ax.fill_between(drawdown.index, drawdown * 100, 0,
                    where=(drawdown < 0), color="#d62728", alpha=0.7, label="Drawdown")
    ax.set_ylabel("Drawdown (%)")
    ax.set_title("Drawdown from Peak")
    ax.grid(True, alpha=0.3)
    ax.legend(fontsize=9)

    # 3. Rolling 1-Year Sharpe
    ax = axes[2]
    rolling_sharpe = rets.rolling(252).apply(
        lambda r: (r.mean() / r.std() * np.sqrt(252)) if r.std() > 0 else np.nan,
        raw=True
    )
    ax.plot(rolling_sharpe.index, rolling_sharpe, color="#2ca02c", linewidth=1.1)
    ax.axhline(0, color="black", linewidth=0.8, linestyle="--")
    ax.axhline(1, color="green",  linewidth=0.6, linestyle=":")
    ax.set_ylabel("Sharpe (1Y rolling)")
    ax.set_title("Rolling 1-Year Sharpe Ratio")
    ax.grid(True, alpha=0.3)

    # 4. Number of holdings
    ax = axes[3]
    ax.plot(result.index, result["n_holdings"], color="#9467bd", linewidth=1)
    ax.set_ylabel("# Stocks")
    ax.set_title("Number of Holdings")
    ax.set_ylim(0, cfg["n_stocks"] + 5)
    ax.grid(True, alpha=0.3)

    plt.tight_layout()
    if out_path:
        plt.savefig(out_path, dpi=150, bbox_inches="tight")
        print(f"Chart saved → {out_path}")
    plt.show()


# ═══════════════════════════════════════════════════════════════════
#  ENTRY POINT
# ═══════════════════════════════════════════════════════════════════

def main():
    result, rebal_df, trades_df = run_backtest(CONFIG)

    metrics = compute_metrics(result, CONFIG)
    print("=" * 58)
    print("  PERFORMANCE SUMMARY")
    print("=" * 58)
    for k, v in metrics.items():
        print(f"  {k:<22} {v}")
    print("=" * 58)

    print(f"\n  Total rebalances : {len(rebal_df)}")
    if not rebal_df.empty:
        print(f"  Avg stocks held  : {rebal_df['n_holdings'].mean():.1f}")
        print(f"  Avg new buys     : {rebal_df['n_new_buys'].mean():.1f}")
        print(f"  Avg sells        : {rebal_df['n_sells'].mean():.1f}")

    if not trades_df.empty:
        total_cost = trades_df["cost"].sum()
        total_turn = trades_df["gross_value"].sum()
        print(f"\n  Total turnover   : ₹{total_turn:,.0f}")
        print(f"  Total costs paid : ₹{total_cost:,.0f}")
        print(f"  Cost % of AUM    : {total_cost / CONFIG['initial_capital'] * 100:.2f}%")

    print("\nLast 5 days:")
    print(result[["portfolio_value", "cash", "invested", "n_holdings"]].tail(5).to_string())

    min_cash = result["cash"].min()
    print(f"\n  Min cash ever    : ₹{min_cash:,.2f}  "
          f"{'✓ OK' if min_cash >= 0 else '✗ PROBLEM'}")

    # Save outputs
    out_dir = Path(CONFIG["csv_path"]).parent
    result.to_csv(out_dir / "backtest_portfolio.csv")
    if not rebal_df.empty:
        rebal_df.drop(columns=["holdings"], errors="ignore").to_csv(
            out_dir / "backtest_rebalances.csv", index=False
        )
    if not trades_df.empty:
        trades_df.to_csv(out_dir / "backtest_trades.csv", index=False)

    print(f"\nOutputs saved → {out_dir}")

    chart_path = str(out_dir / "backtest_chart.png")
    plot_results(result, CONFIG, out_path=chart_path)

    return result, rebal_df, trades_df


if __name__ == "__main__":
    result, rebal_df, trades_df = main()