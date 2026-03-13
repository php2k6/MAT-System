"""
backtest_engine.py
──────────────────
Pure-Python backtest logic extracted from momentum_backtest_v1.py.
All config is passed as parameters — no global variables.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

# ── TRANSACTION COST CONSTANTS (NSE/Fyers CNC) ─────────────────────────────
# Fyers charges zero brokerage on equity delivery (CNC).
_BROKERAGE       = 0.0
_STT_SELL        = 0.001
_EXCHANGE_CHARGE = 0.0000325
_SEBI_CHARGE     = 0.000001
_GST_RATE        = 0.18
_STAMP_DUTY_BUY  = 0.00015
_TRADING_DAYS_PER_MONTH = 21
_CASH_BUFFER     = 0.005

UNIVERSE_MAP = {
    "nifty50":  ["nifty50"],
    "nifty100": ["nifty50", "nifty100"],
    "nifty150": ["nifty50", "nifty100", "nifty150"],
    "nifty250": ["nifty50", "nifty100", "nifty150", "nifty250"],
}


# ── COST HELPERS ─────────────────────────────────────────────────────────────

def _calc_cost(value: float, side: str) -> float:
    brokerage = min(value * _BROKERAGE, 20)
    exch      = value * _EXCHANGE_CHARGE
    sebi      = value * _SEBI_CHARGE
    gst       = (brokerage + exch) * _GST_RATE
    stt       = value * _STT_SELL       if side == "sell" else 0
    stamp     = value * _STAMP_DUTY_BUY if side == "buy"  else 0
    return brokerage + exch + sebi + gst + stt + stamp


def _max_buyable_shares(cash: float, price: float) -> int:
    cost_factor = 1 + _BROKERAGE + _EXCHANGE_CHARGE + _STAMP_DUTY_BUY + _SEBI_CHARGE + 0.001
    return int(cash / (price * cost_factor))


# ── REBALANCE DATE SCHEDULE ──────────────────────────────────────────────────

def _get_rebalance_dates(
    all_dates,
    start_date: str,
    rebalance_type: str,       # "monthly" | "weekly"
    rebalance_freq: int,       # N months or N weeks
) -> set:
    trading_days = pd.DatetimeIndex(sorted(all_dates))
    start = pd.Timestamp(start_date)
    end   = trading_days[-1]

    if rebalance_type == "weekly":
        schedule = pd.date_range(start=start, end=end, freq=f"{rebalance_freq * 7}D")
    else:
        schedule = pd.date_range(start=start, end=end, freq=pd.DateOffset(months=rebalance_freq))

    rebalance_dates = set()
    for d in schedule:
        idx = trading_days.searchsorted(d)
        if idx < len(trading_days):
            rebalance_dates.add(trading_days[idx])

    return rebalance_dates


# ── MOMENTUM SCORING ─────────────────────────────────────────────────────────

def _compute_momentum_scores(
    df: pd.DataFrame,
    lookback_1: int,
    lookback_2: int,
    weight_1: float = 0.5,
    weight_2: float = 0.5,
    skip_months: int = 0,
) -> pd.DataFrame:
    df        = df.copy()
    skip_days = skip_months * _TRADING_DAYS_PER_MONTH
    lb1_days  = lookback_1  * _TRADING_DAYS_PER_MONTH
    lb2_days  = lookback_2  * _TRADING_DAYS_PER_MONTH

    g = df.groupby("symbol")["close"]
    df["p_t"]   = g.shift(skip_days)
    df["p_lb1"] = g.shift(lb1_days)
    df["p_lb2"] = g.shift(lb2_days)

    df["ret_lb1"] = (df["p_t"] / df["p_lb1"]) - 1
    df["ret_lb2"] = (df["p_t"] / df["p_lb2"]) - 1

    df["score_1"]        = df["ret_lb1"] / df["volatility_1y"]
    df["score_2"]        = df["ret_lb2"] / df["volatility_1y"]
    df["momentum_score"] = weight_1 * df["score_1"] + weight_2 * df["score_2"]
    return df


# ── TARGET PORTFOLIO ─────────────────────────────────────────────────────────

def _get_target_portfolio(
    current_date,
    df: pd.DataFrame,
    deployable_capital: float,
    n_stocks: int,
    min_price: float,
    max_price: float,
) -> dict:
    day_df = df[df["date"] == current_date].copy()
    if day_df.empty:
        return {}

    eligible = day_df[
        day_df["momentum_score"].notna() &
        day_df["close"].between(min_price, max_price)
    ].copy()

    top = eligible.sort_values(
        ["momentum_score", "symbol"], ascending=[False, True]
    ).head(n_stocks)

    if top.empty:
        return {}

    deployable    = deployable_capital * (1 - _CASH_BUFFER)
    target_weight = 1.0 / len(top)

    return {
        row["symbol"]: {
            "qty":   int((deployable * target_weight) / row["close"]),
            "price": row["close"],
        }
        for _, row in top.iterrows()
        if int((deployable * target_weight) / row["close"]) > 0
    }


# ── BACKTEST ENGINE ──────────────────────────────────────────────────────────

def run_backtest(
    df: pd.DataFrame,
    *,
    universe: str,
    n_stocks: int,
    lookback_1: int,
    lookback_2: int,
    min_price: float,
    max_price: float,
    initial_capital: float,
    rebalance_type: str,
    rebalance_freq: int,
    starting_date: str,
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """
    Parameters
    ----------
    df                  : dataframe (date, symbol, close, volatility_1y, index_member)
    universe            : one of nifty50 / nifty100 / nifty150 / nifty250
    n_stocks            : number of top stocks to hold
    lookback_1/2        : momentum lookback periods in months
    min_price / max_price : price filter
    initial_capital     : starting capital in INR
    rebalance_type      : "monthly" | "weekly"
    rebalance_freq      : N months or N weeks between rebalances
    starting_date       : first rebalance anchor date (YYYY-MM-DD)

    Returns (result_df, rebal_df, trades_df)
    """
    # Filter universe
    allowed = UNIVERSE_MAP.get(universe.lower(), ["nifty50"])
    if "index_member" in df.columns:
        df = df[df["index_member"].str.lower().isin(allowed)].copy()

    # Score
    scored_df = _compute_momentum_scores(df, lookback_1, lookback_2)

    all_dates       = sorted(scored_df["date"].unique())
    rebalance_dates = _get_rebalance_dates(all_dates, starting_date, rebalance_type, rebalance_freq)
    price_pivot     = scored_df.pivot(index="date", columns="symbol", values="close").ffill()

    cash          = float(initial_capital)
    holdings: dict[str, int] = {}
    last_prices: dict[str, float] = {}
    daily_log     = []
    rebalance_log = []
    trade_log     = []

    for current_date in all_dates:
        today_prices = price_pivot.loc[current_date].dropna().to_dict()
        last_prices.update(today_prices)

        portfolio_value = cash + sum(
            qty * last_prices.get(sym, 0) for sym, qty in holdings.items()
        )

        if current_date in rebalance_dates:
            pv_before  = portfolio_value
            target_map = _get_target_portfolio(
                current_date, scored_df, portfolio_value,
                n_stocks, min_price, max_price,
            )
            new_selected = set(target_map.keys())

            # Sell full exits
            for sym in list(holdings.keys()):
                if sym not in new_selected:
                    qty   = holdings.pop(sym)
                    price = last_prices.get(sym, 0)
                    if price > 0 and qty > 0:
                        val  = qty * price
                        net  = val - _calc_cost(val, "sell")
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
                            net           = val - _calc_cost(val, "sell")
                            cash         += net
                            holdings[sym] = targ_q
                            trade_log.append({
                                "date": current_date, "symbol": sym, "action": "SELL_ADJ",
                                "shares": diff, "price": price,
                                "gross_value": val, "cost": val - net, "net": net,
                            })

            # Buy new entries and top-ups
            for sym, info in target_map.items():
                targ_q = info["qty"]
                curr_q = holdings.get(sym, 0)
                diff   = targ_q - curr_q

                if diff <= 0:
                    continue

                price      = last_prices.get(sym, info["price"])
                buy_value  = diff * price
                total_cost = buy_value + _calc_cost(buy_value, "buy")

                if cash < total_cost:
                    diff = _max_buyable_shares(cash, price)
                    if diff <= 0:
                        continue
                    buy_value  = diff * price
                    total_cost = buy_value + _calc_cost(buy_value, "buy")

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

    result   = pd.DataFrame(daily_log).set_index("date")
    result.index = pd.to_datetime(result.index)
    trades_df = pd.DataFrame(trade_log)
    rebal_df  = pd.DataFrame(rebalance_log)
    return result, rebal_df, trades_df


# ── STATS + SERIES BUILDERS ──────────────────────────────────────────────────

def build_stats(result: pd.DataFrame, universe: str, initial_capital: float) -> dict:
    pv   = result["portfolio_value"]
    rets = pv.pct_change().dropna()

    total_return = float((pv.iloc[-1] / pv.iloc[0]) - 1)
    years        = (pv.index[-1] - pv.index[0]).days / 365.25
    cagr         = float((1 + total_return) ** (1 / max(years, 0.1)) - 1)
    vol          = float(rets.std() * np.sqrt(252))
    sharpe       = float((rets.mean() * 252) / vol) if vol != 0 else 0.0
    dd           = (pv - pv.cummax()) / pv.cummax()
    max_dd       = float(dd.min())
    calmar       = float(cagr / abs(max_dd)) if max_dd != 0 else float("nan")
    win_rate     = float((rets > 0).sum() / len(rets))
    avg_cash_pct = float((result["cash"] / pv).mean())

    return {
        "universe":     universe.upper(),
        "initialCap":   initial_capital,
        "finalValue":   round(float(pv.iloc[-1]), 2),
        "totalReturn":  round(total_return, 4),
        "cagr":         round(cagr, 4),
        "vol":          round(vol, 4),
        "sharpe":       round(sharpe, 4),
        "maxDrawdown":  round(max_dd, 4),
        "calmar":       round(calmar, 4) if not np.isnan(calmar) else None,
        "winRate":      round(win_rate, 4),
        "bestDay":      round(float(rets.max()), 4),
        "worstDay":     round(float(rets.min()), 4),
        "avgCashDrag":  round(avg_cash_pct, 4),
    }


def build_series(result: pd.DataFrame) -> list[dict]:
    pv   = result["portfolio_value"]
    rets = pv.pct_change().dropna()
    dd   = (pv - pv.cummax()) / pv.cummax()

    rolling_sharpe = rets.rolling(252).apply(
        lambda r: float(r.mean() / r.std() * np.sqrt(252)) if r.std() > 0 else float("nan"),
        raw=True,
    )

    lakh = 1e5
    rows = []
    for date, row in result.iterrows():
        pv_val = row["portfolio_value"]
        rs_val = rolling_sharpe.get(date, float("nan"))
        dd_val = float(dd.get(date, 0.0))
        rows.append({
            "date":          date.strftime("%Y-%m-%d"),
            "pvL":           round(pv_val / lakh, 4),
            "cashL":         round(row["cash"] / lakh, 4),
            "investedL":     round(row["invested"] / lakh, 4),
            "drawdown":      round(dd_val, 4),
            "holdings":      int(row["n_holdings"]),
            "rollingSharpe": round(rs_val, 4) if not np.isnan(rs_val) else None,
        })
    return rows
