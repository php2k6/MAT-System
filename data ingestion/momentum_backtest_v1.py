import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
import matplotlib.ticker as mticker

# ── CONFIG ──────────────────────────────────────────────────────
CSV_PATH         = "nifty250_log_return_volatility.csv"
UNIVERSE         = "nifty250"
INITIAL_CAPITAL  = 100_000
START_YEAR       = 2016
REBALANCE_MONTHS = 1
LOOKBACK_1       = 3
LOOKBACK_2       = 12
SKIP_MONTHS      = 0
WEIGHT_1         = 0.5
WEIGHT_2         = 0.5
N_STOCKS         = 10
MIN_PRICE        = 1.0
MAX_PRICE        = 100_000
CASH_BUFFER      = 0.005

BROKERAGE        = 0.0003
STT_SELL         = 0.001
EXCHANGE_CHARGE  = 0.0000325
SEBI_CHARGE      = 0.000001
GST_RATE         = 0.18
STAMP_DUTY_BUY   = 0.00015
TRADING_DAYS_PER_MONTH = 21

UNIVERSE_MAP = {
    "nifty50":  ["nifty50"],
    "nifty100": ["nifty50", "nifty100"],
    "nifty150": ["nifty50", "nifty100", "nifty150"],
    "nifty250": ["nifty50", "nifty100", "nifty150", "nifty250"],
}

# ── UTILITIES ────────────────────────────────────────────────────

def calc_cost(value, side):
    brokerage = min(value * BROKERAGE, 20)
    exch      = value * EXCHANGE_CHARGE
    sebi      = value * SEBI_CHARGE
    gst       = (brokerage + exch) * GST_RATE
    stt       = value * STT_SELL       if side == "sell" else 0
    stamp     = value * STAMP_DUTY_BUY if side == "buy"  else 0
    return brokerage + exch + sebi + gst + stt + stamp


def _max_buyable_shares(cash: float, price: float) -> int:
    """Returns max integer shares purchasable with available cash after estimated costs."""
    cost_factor = 1 + BROKERAGE + EXCHANGE_CHARGE + STAMP_DUTY_BUY + SEBI_CHARGE + 0.001
    return int(cash / (price * cost_factor))


def get_rebalance_dates(all_dates):
    temp = pd.DataFrame({"date": pd.to_datetime(sorted(all_dates))})
    temp["bucket"] = (temp["date"].dt.year * 12 + temp["date"].dt.month - 1) // REBALANCE_MONTHS
    return set(temp.groupby("bucket")["date"].max())


def compute_momentum_scores(df):
    df        = df.copy()
    skip_days = SKIP_MONTHS * TRADING_DAYS_PER_MONTH
    lb1_days  = LOOKBACK_1  * TRADING_DAYS_PER_MONTH
    lb2_days  = LOOKBACK_2  * TRADING_DAYS_PER_MONTH

    g = df.groupby("symbol")["close"]
    df["p_t"]   = g.shift(skip_days)
    df["p_lb1"] = g.shift(lb1_days)
    df["p_lb2"] = g.shift(lb2_days)

    df["ret_lb1"] = (df["p_t"] / df["p_lb1"]) - 1
    df["ret_lb2"] = (df["p_t"] / df["p_lb2"]) - 1

    # Risk-adjusted momentum: return / volatility for each lookback, then blended
    df["score_1"]       = df["ret_lb1"] / df["volatility_1y"]
    df["score_2"]       = df["ret_lb2"] / df["volatility_1y"]
    df["momentum_score"] = WEIGHT_1 * df["score_1"] + WEIGHT_2 * df["score_2"]
    return df


# ── STRATEGY ─────────────────────────────────────────────────────

def get_target_portfolio(current_date, df, deployable_capital, n_stocks=N_STOCKS):
    """
    Selects top-N stocks by momentum score and returns equal-weight target quantities.
    deployable_capital must be the full portfolio value (cash + equity), not just cash.
    """
    day_df = df[df["date"] == current_date].copy()
    if day_df.empty:
        return {}

    eligible = day_df[
        day_df["momentum_score"].notna() &
        day_df["close"].between(MIN_PRICE, MAX_PRICE)
    ].copy()

    top = eligible.sort_values(
        ["momentum_score", "symbol"], ascending=[False, True]
    ).head(n_stocks)

    if top.empty:
        return {}

    deployable    = deployable_capital * (1 - CASH_BUFFER)
    target_weight = 1.0 / len(top)

    return {
        row["symbol"]: {
            "qty":   int((deployable * target_weight) / row["close"]),
            "price": row["close"],
        }
        for _, row in top.iterrows()
        if int((deployable * target_weight) / row["close"]) > 0
    }


# ── BACKTEST ENGINE ──────────────────────────────────────────────

def run_backtest(df):
    """
    Rebalance sequence per period:
      1. Compute target using full portfolio value (cash + equity)
      2. Sell full exits
      3. Trim over-weight positions
      4. Buy new entries and top-up under-weight positions
    """
    all_dates       = sorted(df["date"].unique())
    rebalance_dates = get_rebalance_dates(all_dates)
    price_pivot     = df.pivot(index="date", columns="symbol", values="close").ffill()

    cash        = float(INITIAL_CAPITAL)
    holdings    = {}
    last_prices = {}
    daily_log   = []
    rebalance_log = []
    trade_log   = []

    for current_date in all_dates:
        today_prices = price_pivot.loc[current_date].dropna().to_dict()
        last_prices.update(today_prices)

        portfolio_value = cash + sum(
            qty * last_prices.get(sym, 0) for sym, qty in holdings.items()
        )

        if current_date in rebalance_dates:
            pv_before  = portfolio_value
            target_map = get_target_portfolio(current_date, df, portfolio_value)
            new_selected = set(target_map.keys())

            # Sell full exits
            for sym in list(holdings.keys()):
                if sym not in new_selected:
                    qty   = holdings.pop(sym)
                    price = last_prices.get(sym, 0)
                    if price > 0 and qty > 0:
                        val  = qty * price
                        net  = val - calc_cost(val, "sell")
                        cash += net
                        trade_log.append({
                            "date": current_date, "symbol": sym, "action": "SELL",
                            "shares": qty, "price": price,
                            "gross_value": val, "cost": val - net, "net": net,
                        })

            # Trim over-weight positions
            for sym in list(holdings.keys()):
                if sym in target_map:
                    curr_q = holdings[sym]
                    targ_q = target_map[sym]["qty"]
                    if curr_q > targ_q:
                        diff  = curr_q - targ_q
                        price = last_prices.get(sym, 0)
                        if price > 0:
                            val           = diff * price
                            net           = val - calc_cost(val, "sell")
                            cash         += net
                            holdings[sym] = targ_q
                            trade_log.append({
                                "date": current_date, "symbol": sym, "action": "SELL_ADJ",
                                "shares": diff, "price": price,
                                "gross_value": val, "cost": val - net, "net": net,
                            })

            # Buy new entries and top-up under-weight positions
            for sym, info in target_map.items():
                targ_q = info["qty"]
                curr_q = holdings.get(sym, 0)
                diff   = targ_q - curr_q

                if diff <= 0:
                    continue

                price      = last_prices.get(sym, info["price"])
                buy_value  = diff * price
                total_cost = buy_value + calc_cost(buy_value, "buy")

                if cash < total_cost:
                    diff = _max_buyable_shares(cash, price)
                    if diff <= 0:
                        continue
                    buy_value  = diff * price
                    total_cost = buy_value + calc_cost(buy_value, "buy")

                if diff > 0 and cash >= total_cost:
                    cash            -= total_cost
                    holdings[sym]    = curr_q + diff
                    action = "BUY_NEW" if curr_q == 0 else "BUY_ADJ"
                    trade_log.append({
                        "date": current_date, "symbol": sym, "action": action,
                        "shares": diff, "price": price,
                        "gross_value": buy_value,
                        "cost": total_cost - buy_value,
                        "net": -total_cost,
                    })

            if cash < -1.0:
                raise RuntimeError(
                    f"[{current_date}] Cash went negative: ₹{cash:,.2f}. "
                    "Logic error in buy/sell sequencing!"
                )
            cash = max(cash, 0.0)

            pv_after = cash + sum(
                qty * last_prices.get(sym, 0) for sym, qty in holdings.items()
            )
            rebalance_log.append({
                "date":       current_date,
                "pv_before":  round(pv_before, 2),
                "pv_after":   round(pv_after, 2),
                "cash":       round(cash, 2),
                "n_holdings": len(holdings),
            })

        pv = cash + sum(
            qty * last_prices.get(sym, 0) for sym, qty in holdings.items()
        )
        daily_log.append({
            "date":            current_date,
            "portfolio_value": round(pv, 2),
            "cash":            round(cash, 2),
            "invested":        round(pv - cash, 2),
            "n_holdings":      len(holdings),
        })

    result            = pd.DataFrame(daily_log).set_index("date")
    result.index      = pd.to_datetime(result.index)
    trades_df         = pd.DataFrame(trade_log)
    rebal_df          = pd.DataFrame(rebalance_log)
    return result, rebal_df, trades_df


# ── PERFORMANCE REPORT ───────────────────────────────────────────

def print_performance_report(result, rebal_df, trades_df):
    pv   = result["portfolio_value"]
    rets = pv.pct_change().dropna()

    total_return = (pv.iloc[-1] / pv.iloc[0]) - 1
    years        = (pv.index[-1] - pv.index[0]).days / 365.25
    cagr         = (1 + total_return) ** (1 / max(years, 0.1)) - 1
    vol          = rets.std() * np.sqrt(252)
    sharpe       = (rets.mean() * 252) / vol if vol != 0 else 0
    dd           = (pv - pv.cummax()) / pv.cummax()
    max_dd       = dd.min()
    calmar       = cagr / abs(max_dd) if max_dd != 0 else float("nan")
    win_rate     = (rets > 0).sum() / len(rets)
    avg_cash_pct = (result["cash"] / result["portfolio_value"]).mean()

    print("\n" + "=" * 62)
    print(f"{'STRATEGY PERFORMANCE REPORT':^62}")
    print("=" * 62)
    print(f"  Period          : {pv.index[0].date()} → {pv.index[-1].date()}")
    print(f"  Universe        : {UNIVERSE.upper()}")
    print(f"  Initial Capital : ₹{INITIAL_CAPITAL:,.2f}")
    print(f"  Final Value     : ₹{pv.iloc[-1]:,.2f}")
    print("-" * 62)
    print(f"  Total Return    : {total_return:>10.2%}")
    print(f"  CAGR            : {cagr:>10.2%}")
    print(f"  Ann. Volatility : {vol:>10.2%}")
    print(f"  Sharpe Ratio    : {sharpe:>10.2f}")
    print(f"  Max Drawdown    : {max_dd:>10.2%}")
    print(f"  Calmar Ratio    : {calmar:>10.2f}")
    print("-" * 62)
    print(f"  Win Rate(Daily) : {win_rate:>10.2%}")
    print(f"  Best Day        : {rets.max():>10.2%}")
    print(f"  Worst Day       : {rets.min():>10.2%}")
    print(f"  Avg Cash Drag   : {avg_cash_pct:>10.2%}")
    print("=" * 62)

    if not rebal_df.empty:
        print(f"\n  Total rebalances : {len(rebal_df)}")
        print(f"  Avg stocks held  : {rebal_df['n_holdings'].mean():.1f}")

    if not trades_df.empty:
        total_cost = trades_df["cost"].sum()
        total_turn = trades_df["gross_value"].sum()
        print(f"  Total turnover   : ₹{total_turn:,.0f}")
        print(f"  Total costs paid : ₹{total_cost:,.0f}")
        print(f"  Cost % of capital: {total_cost / INITIAL_CAPITAL * 100:.2f}%")

    min_cash = result["cash"].min()
    print(f"\n  Min cash ever    : ₹{min_cash:,.2f}  "
          f"{'✓ OK' if min_cash >= 0 else '✗ PROBLEM'}")
    print()


# ── CHART ─────────────────────────────────────────────────────────

def plot_results(result, out_path="backtest_chart.png"):
    pv       = result["portfolio_value"]
    cash     = result["cash"]
    invested = result["invested"]
    rets     = pv.pct_change().dropna()
    drawdown = (pv - pv.cummax()) / pv.cummax()
    lakh     = 1e5

    fig, axes = plt.subplots(
        4, 1, figsize=(15, 13), sharex=True,
        gridspec_kw={"height_ratios": [3, 1.5, 1.5, 1]}
    )
    fig.suptitle(
        f"NSE Momentum Strategy  |  Universe: {UNIVERSE.upper()}  "
        f"|  Top-{N_STOCKS} Stocks  |  Monthly Rebalance\n"
        f"Lookback: {LOOKBACK_1}M + {LOOKBACK_2}M  "
        f"|  Capital ₹{INITIAL_CAPITAL:,.0f}  |  Realistic NSE costs",
        fontsize=12, fontweight="bold", y=1.01
    )

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

    ax = axes[1]
    ax.fill_between(drawdown.index, drawdown * 100, 0,
                    where=(drawdown < 0), color="#d62728", alpha=0.7, label="Drawdown")
    ax.set_ylabel("Drawdown (%)")
    ax.set_title("Drawdown from Peak")
    ax.legend(fontsize=9)
    ax.grid(True, alpha=0.3)

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

    ax = axes[3]
    ax.plot(result.index, result["n_holdings"], color="#9467bd", linewidth=1)
    ax.set_ylabel("# Stocks")
    ax.set_title("Number of Holdings")
    ax.set_ylim(0, N_STOCKS + 5)
    ax.grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig(out_path, dpi=150, bbox_inches="tight")
    print(f"  Chart saved → {out_path}")
    plt.show()


# ── MAIN ──────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("Loading data...")
    raw_df = pd.read_csv(CSV_PATH)
    raw_df["date"] = pd.to_datetime(raw_df["date"])

    if "index_member" in raw_df.columns:
        allowed = UNIVERSE_MAP[UNIVERSE.lower()]
        raw_df  = raw_df[raw_df["index_member"].str.lower().isin(allowed)].copy()

    scored_df = compute_momentum_scores(raw_df)
    scored_df = scored_df[scored_df["date"].dt.year >= START_YEAR].copy()

    print(f"Running backtest on {UNIVERSE.upper()}...")
    result, rebal_df, trades_df = run_backtest(scored_df)

    print_performance_report(result, rebal_df, trades_df)
    plot_results(result)