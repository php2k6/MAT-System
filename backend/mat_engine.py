"""
mat_engine.py
─────────────
Live rebalance execution engine. Called by scheduler.drain_rebalance_queue()
for every RebalanceQueue row with status="in_progress".

Full execution flow
───────────────────
1.  Authenticate — get Fyers client (token_date must == today)
2.  Get current DB holdings + their LTPs from Fyers quotes
3.  Get available cash from Fyers funds
4.  Total capital  = cash + equity_at_LTP  (no deduction yet)
    Working capital = total × (1 − 0.5 % buffer)
5.  Compute momentum scores from DB (prev-day close, NOT LTP)
6.  Candidate list = top N × 1.5 by risk-adjusted momentum score
7.  Fetch LTP + circuit limits for candidates (+ held stocks) from Fyers
8.  Build target portfolio (top-N equal-weight, sized on prev-day close)
    — walk candidates; skip UC stocks (max N/2 skippable → else GLOBAL EVENT)
9.  SELL PHASE
      a. exits  = held stocks not in target
      b. trims  = held stocks where current_qty > target_qty
      c. LC check: if ANY sell candidate is in LC → SKIP entire rebalance
      d. Place market SELL orders (exits first, then trims)
      e. Poll fill confirmation (up to ORDER_WAIT_SECS)
      f. Recompute cash from actual fill prices
10. BUY PHASE
      a. Build buy list (new entries + top-ups) after applying actual sells
      b. Final UC recheck per stock; skip UC stocks
      c. Size quantities with prev-day close; cap to available cash
      d. Place market BUY orders
      e. Poll fill confirmation
11. DB UPDATE (atomic flush; committed by caller — scheduler)
      a. Rebuild Holdings from analytical tracking (no extra Fyers call needed)
      b. Update Strategy.market_value / unused_capital / buffer_capital
      c. Upsert Portfolio row for today
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Optional
from uuid import UUID

import pandas as pd
from fyers_apiv3 import fyersModel
from sqlalchemy.orm import Session

from backend.config import settings
from backend.core.security import decrypt_token
from backend.models import BrokerSession, Holdings, Portfolio, RebalanceQueue, StockPrice, Strategy

logger = logging.getLogger(__name__)

# ── Transaction-cost constants (matching backtest / Fyers CNC) ───────────────
# Fyers charges zero brokerage on equity delivery (CNC).
BROKERAGE       = 0.0
STT_SELL        = 0.001
EXCHANGE_CHARGE = 0.0000325
SEBI_CHARGE     = 0.000001
GST_RATE        = 0.18
STAMP_DUTY_BUY  = 0.00015
CASH_BUFFER     = min(max(float(settings.mat_cash_buffer), 0.0), 0.5)

# ── Momentum constants (matching backtest) ────────────────────────────────────
TRADING_DAYS_PER_MONTH = 21
WEIGHT_1               = 0.5
WEIGHT_2               = 0.5

# ── Execution constants ───────────────────────────────────────────────────────
ORDER_WAIT_SECS     = max(int(settings.mat_order_wait_seconds), 1)
ORDER_POLL_INTERVAL = max(int(settings.mat_order_poll_interval_seconds), 1)
_ORDER_MIN_INTERVAL = max(float(settings.mat_order_min_interval_seconds), 0.0)
CANDIDATE_POOL_MULTIPLIER = max(float(settings.mat_candidate_pool_multiplier), 1.0)
FYERS_QUOTES_CHUNK_SIZE = max(int(settings.fyers_quotes_chunk_size), 1)

# Fyers order status codes
_STATUS_TRADED    = 2
_STATUS_REJECTED  = 5
_STATUS_CANCELLED = 1

# universe integer → index_member tags used in stock_price.index_member
UNIVERSE_MAP: dict[int, list[str]] = {
    50:  ["nifty50"],
    100: ["nifty50", "nifty100"],
    150: ["nifty50", "nifty100", "nifty150"],
    250: ["nifty50", "nifty100", "nifty150", "nifty250"],
}


# ── Tiny helpers ──────────────────────────────────────────────────────────────

def _to_fyers(ticker: str) -> str:
    """'INFY' → 'NSE:INFY-EQ'"""
    return f"NSE:{ticker}-EQ"


def _from_fyers(symbol: str) -> str:
    """'NSE:INFY-EQ' → 'INFY'"""
    return symbol.split(":")[1].replace("-EQ", "")


def _sell_cost(value: float) -> float:
    brokerage = min(value * BROKERAGE, 20)
    exch      = value * EXCHANGE_CHARGE
    sebi      = value * SEBI_CHARGE
    gst       = (brokerage + exch) * GST_RATE
    stt       = value * STT_SELL
    return brokerage + exch + sebi + gst + stt


def _buy_cost(value: float) -> float:
    brokerage = min(value * BROKERAGE, 20)
    exch      = value * EXCHANGE_CHARGE
    sebi      = value * SEBI_CHARGE
    gst       = (brokerage + exch) * GST_RATE
    stamp     = value * STAMP_DUTY_BUY
    return brokerage + exch + sebi + gst + stamp


def _max_shares(cash: float, price: float) -> int:
    """Max integer shares buyable from cash after estimated costs."""
    factor = 1 + BROKERAGE + EXCHANGE_CHARGE + STAMP_DUTY_BUY + SEBI_CHARGE + 0.001
    return int(cash / (price * factor))


# ── Result object ─────────────────────────────────────────────────────────────

@dataclass
class RebalanceResult:
    success: bool = False
    skipped: bool = False
    reason:  str  = ""
    details: dict = field(default_factory=dict)


# ── MATEngine ─────────────────────────────────────────────────────────────────

class MATEngine:
    """
    Instantiate with (queue_entry, db_session).
    Call run_rebalance() → RebalanceResult.

    DB flush operations are batched to the END of a successful run.
    The caller (scheduler) is responsible for db.commit().
    On failure the engine calls db.rollback() before raising so that the
    scheduler's session remains clean.
    """

    def __init__(self, queue_entry: RebalanceQueue, db: Session) -> None:
        self.entry    = queue_entry
        self.strategy: Strategy = queue_entry.strategy
        self.db       = db
        self._last_order_time: float = 0.0   # tracks last order placement for rate-limit

    # ── Entry point ───────────────────────────────────────────────────────────

    def run_rebalance(self) -> RebalanceResult:
        strat = self.strategy
        sid   = strat.strat_id
        logger.info("MATEngine: START strat=%s", sid)

        # ── 1. Broker auth ────────────────────────────────────────────────────
        try:
            fyers = self._get_fyers()
        except RuntimeError as e:
            return RebalanceResult(skipped=True, reason=str(e))

        # ── 2. Current DB holdings + LTP ─────────────────────────────────────
        # Read what we own from DB (our tracked state, strategy-scoped)
        db_holdings: dict[str, dict] = self._load_db_holdings()
        # {ticker: {qty, avg_price}}

        held_tickers = list(db_holdings.keys())

        # ── 3. Cash ───────────────────────────────────────────────────────────
        try:
            cash = self._get_cash(fyers)
        except RuntimeError as e:
            return RebalanceResult(skipped=True, reason=str(e))

        # ── 4. Total capital ──────────────────────────────────────────────────
        # Need LTP for held stocks to calculate portfolio value
        held_quotes: dict[str, dict] = {}
        if held_tickers:
            try:
                held_quotes = self._get_quotes(fyers, held_tickers)
            except Exception as e:
                return RebalanceResult(skipped=True, reason=f"HELD_QUOTES_FAILED:{e}")

        equity_value   = sum(
            db_holdings[t]["qty"] * held_quotes.get(t, {}).get("ltp", 0)
            for t in held_tickers
        )
        total_capital  = cash + equity_value
        working_capital = total_capital * (1 - CASH_BUFFER)

        logger.info(
            "MATEngine: strat=%s cash=%.2f equity=%.2f total=%.2f working=%.2f",
            sid, cash, equity_value, total_capital, working_capital,
        )

        # ── 5. Momentum scores from DB (prev-day close) ───────────────────────
        try:
            scores, prev_close = self._compute_momentum(strat)
        except Exception as e:
            return RebalanceResult(success=False, reason=f"MOMENTUM_ERROR:{e}")

        if not scores:
            return RebalanceResult(success=False, reason="NO_MOMENTUM_SCORES")

        # ── 6. Candidate list: top N × 1.5 ────────────────────────────────────
        n_target      = strat.n_stocks
        n_candidates  = max(n_target, int(n_target * CANDIDATE_POOL_MULTIPLIER))
        candidates    = sorted(scores.items(), key=lambda x: x[1], reverse=True)[:n_candidates]
        cand_tickers  = [t for t, _ in candidates]

        # ── 7. LTP + circuit limits for candidates + held stocks ──────────────
        quote_tickers = list(set(cand_tickers) | set(held_tickers))
        try:
            all_quotes = self._get_quotes(fyers, quote_tickers)
            # Merge held_quotes (already fetched) in case any ticker is missing
            all_quotes = {**held_quotes, **all_quotes}
        except Exception as e:
            return RebalanceResult(skipped=True, reason=f"QUOTES_FAILED:{e}")

        # ── 8. Build target portfolio ─────────────────────────────────────────
        # Walk candidates; skip UC stocks; max N/2 UC skips allowed
        target_tickers: list[str] = []
        uc_skipped: list[str]     = []

        for ticker, _score in candidates:
            if len(target_tickers) >= n_target:
                break
            if ticker not in prev_close or prev_close[ticker] <= 0:
                continue
            q = all_quotes.get(ticker)
            if q and self._is_uc(q):
                uc_skipped.append(ticker)
                logger.info("MATEngine: %s is UC — skipped from buy list", ticker)
                if len(uc_skipped) > n_target / 2:
                    return RebalanceResult(
                        skipped=True,
                        reason="UC_GLOBAL_EVENT",
                        details={"uc_tickers": uc_skipped},
                    )
                continue
            target_tickers.append(ticker)

        if not target_tickers:
            return RebalanceResult(success=False, reason="NO_ELIGIBLE_STOCKS")

        target_set = set(target_tickers)

        # ── 9. SELL PHASE ─────────────────────────────────────────────────────
        #
        # Pre-sell target qty is computed here purely to determine which
        # held positions need trimming.  Actual post-sell sizing is done in
        # the buy phase using fresh post-sell cash (see step 11).
        #
        alloc_pre = working_capital / len(target_tickers)

        sells_exit: dict[str, int] = {}   # ticker → full-exit qty
        sells_trim: dict[str, int] = {}   # ticker → trim qty

        for ticker, held in db_holdings.items():
            if held["qty"] <= 0:
                continue
            if ticker not in target_set:
                sells_exit[ticker] = held["qty"]
            else:
                pre_target_qty = int(alloc_pre / prev_close[ticker])
                if held["qty"] > pre_target_qty:
                    trim_qty = held["qty"] - pre_target_qty
                    if trim_qty > 0:
                        sells_trim[ticker] = trim_qty

        # LC guard — check ALL sell candidates before placing any order
        lc_tickers = [
            t for t in (list(sells_exit) + list(sells_trim))
            if self._is_lc(all_quotes.get(t, {}))
        ]
        if lc_tickers:
            return RebalanceResult(
                skipped=True,
                reason="LC_DETECTED",
                details={"lc_tickers": lc_tickers},
            )

        # Place ALL sell orders (exits first, then trims), rate-limited
        sell_order_map: dict[str, str] = {}   # ticker → order_id
        for ticker in list(sells_exit) + list(sells_trim):
            qty = sells_exit.get(ticker) or sells_trim[ticker]
            try:
                oid = self._place_order(fyers, ticker, side=-1, qty=qty)
                sell_order_map[ticker] = oid
                logger.info("MATEngine: SELL placed %s qty=%d oid=%s", ticker, qty, oid)
            except Exception as e:
                logger.error("MATEngine: sell placement failed for %s: %s", ticker, e)
                return RebalanceResult(success=False, reason=f"SELL_PLACE_FAILED:{ticker}:{e}")

        # Wait for ALL sell fills simultaneously
        sell_fills: dict[str, dict] = {}
        if sell_order_map:
            all_sell_results = self._wait_for_fills(fyers, list(sell_order_map.values()))
            sell_fills = {
                ticker: all_sell_results.get(oid, {"filled_qty": 0, "traded_price": 0, "status": "missing"})
                for ticker, oid in sell_order_map.items()
            }
            for ticker, fill in sell_fills.items():
                logger.info(
                    "MATEngine: SELL fill %s qty=%d price=%.2f status=%s",
                    ticker, fill["filled_qty"], fill["traded_price"], fill.get("status", "?"),
                )

        # ── 10. Post-sell cash refresh ────────────────────────────────────────
        try:
            actual_cash = self._get_cash(fyers)
        except RuntimeError as e:
            return RebalanceResult(success=False, reason=f"POST_SELL_FUNDS_FAILED:{e}")

        logger.info("MATEngine: post-sell actual_cash=%.2f", actual_cash)

        # ── 11. BUY PHASE — greedy allocation on actual cash ──────────────────
        #
        # Analytical post-sell current quantities (strategy-scoped)
        current_qty: dict[str, int] = {t: v["qty"] for t, v in db_holdings.items()}
        for ticker, fill in sell_fills.items():
            current_qty[ticker] = max(0, current_qty.get(ticker, 0) - fill["filled_qty"])

        # Greedy equal-weight sizing from actual post-sell cash
        n_final    = len(target_tickers)
        buy_budget = actual_cash * (1 - CASH_BUFFER)
        alloc_post = buy_budget / n_final

        # Base quantities: floor(alloc / prev_close)
        base_qty: dict[str, int] = {}
        for t in target_tickers:
            close = prev_close.get(t, 0)
            base_qty[t] = int(alloc_post / close) if close > 0 else 0

        # Fractional-remainder second pass:
        # Sort by (alloc mod prev_close) descending → award +1 share while residual allows
        base_cost = sum(base_qty[t] * prev_close[t] for t in target_tickers if prev_close.get(t, 0) > 0)
        residual  = buy_budget - base_cost

        remainders = [
            (t, alloc_post - base_qty[t] * prev_close[t])
            for t in target_tickers
            if prev_close.get(t, 0) > 0
        ]
        remainders.sort(key=lambda x: x[1], reverse=True)

        greedy_qty = dict(base_qty)
        for t, _rem in remainders:
            close = prev_close[t]
            if residual >= close:
                greedy_qty[t] += 1
                residual -= close

        # Build buy list: greedy_qty[t] - current_qty[t] (positive diff only)
        buy_order_map: dict[str, str] = {}    # ticker → order_id
        buy_order_qty: dict[str, int] = {}    # ticker → qty attempted
        remaining_buy_cash = buy_budget

        for t in target_tickers:
            diff = greedy_qty.get(t, 0) - current_qty.get(t, 0)
            if diff <= 0:
                continue
            # Final UC safety check at buy time
            q = all_quotes.get(t)
            if q and self._is_uc(q):
                logger.info("MATEngine: BUY skipped — %s still UC at buy time", t)
                continue

            # Cash-drag aware sizing for market orders:
            # cap desired qty by estimated gross + buy-side charges.
            est_price = max(
                float(all_quotes.get(t, {}).get("ltp", 0) or 0),
                float(prev_close.get(t, 0) or 0),
            )
            if est_price <= 0:
                logger.info("MATEngine: BUY skipped — %s has no usable price", t)
                continue

            max_affordable = _max_shares(remaining_buy_cash, est_price)
            if max_affordable <= 0:
                logger.info("MATEngine: BUY skipped — insufficient cash for %s", t)
                continue

            capped_qty = min(diff, max_affordable)
            if capped_qty <= 0:
                continue

            est_gross = capped_qty * est_price
            est_outflow = est_gross + _buy_cost(est_gross)
            if est_outflow > remaining_buy_cash:
                logger.info("MATEngine: BUY skipped — outflow exceeds remaining cash for %s", t)
                continue

            remaining_buy_cash -= est_outflow
            buy_order_qty[t] = capped_qty
            try:
                oid = self._place_order(fyers, t, side=1, qty=capped_qty)
                buy_order_map[t] = oid
                logger.info("MATEngine: BUY placed %s qty=%d oid=%s", t, capped_qty, oid)
            except Exception as e:
                # Non-fatal: log and skip; continue with remaining buys
                logger.error("MATEngine: buy placement failed for %s: %s", t, e)

        # Wait for ALL buy fills simultaneously
        buy_fills: dict[str, dict] = {}
        if buy_order_map:
            all_buy_results = self._wait_for_fills(fyers, list(buy_order_map.values()))
            buy_fills = {
                ticker: all_buy_results.get(oid, {"filled_qty": 0, "traded_price": 0, "status": "missing"})
                for ticker, oid in buy_order_map.items()
            }
            for ticker, fill in buy_fills.items():
                logger.info(
                    "MATEngine: BUY fill %s qty=%d price=%.2f status=%s",
                    ticker, fill["filled_qty"], fill["traded_price"], fill.get("status", "?"),
                )

        # ── 12. Rebuild holdings state (analytical) ───────────────────────────
        # Apply sell fills to db_holdings
        new_holdings: dict[str, dict] = {
            t: {"qty": v["qty"], "avg_price": v["avg_price"]}
            for t, v in db_holdings.items()
        }

        for ticker, fill in sell_fills.items():
            if fill["filled_qty"] > 0:
                remaining = new_holdings.get(ticker, {}).get("qty", 0) - fill["filled_qty"]
                if remaining <= 0:
                    new_holdings.pop(ticker, None)
                else:
                    new_holdings[ticker]["qty"] = remaining

        for ticker, fill in buy_fills.items():
            if fill["filled_qty"] > 0:
                buy_price = fill["traded_price"]
                if ticker in new_holdings:
                    old_qty   = new_holdings[ticker]["qty"]
                    old_avg   = new_holdings[ticker]["avg_price"] or buy_price
                    new_qty   = old_qty + fill["filled_qty"]
                    new_avg   = (old_qty * old_avg + fill["filled_qty"] * buy_price) / new_qty
                    new_holdings[ticker] = {"qty": new_qty, "avg_price": new_avg, "last_price": buy_price}
                else:
                    new_holdings[ticker] = {
                        "qty": fill["filled_qty"],
                        "avg_price": buy_price,
                        "last_price": buy_price,
                    }

        # Refresh broker cash after buy placements/fills so strategy cash is
        # not over-reported (prevents equity+cash double counting).
        try:
            final_cash = self._get_cash(fyers)
        except RuntimeError as e:
            return RebalanceResult(success=False, reason=f"POST_BUY_FUNDS_FAILED:{e}")

        # Compute final portfolio value (use LTP from quotes or prev_close)
        def _ltp(ticker: str) -> float:
            q = all_quotes.get(ticker)
            return q["ltp"] if q else prev_close.get(ticker, 0)

        final_equity = sum(v["qty"] * _ltp(t) for t, v in new_holdings.items())
        final_total  = final_cash + final_equity

        # ── Flush DB changes (committed by scheduler) ─────────────────────────
        try:
            self._flush_holdings(new_holdings, all_quotes)
            self._flush_strategy(final_total, final_cash)
            self._flush_portfolio(final_total)
        except Exception:
            self.db.rollback()
            raise

        logger.info(
            "MATEngine: DONE strat=%s final_value=%.2f cash=%.2f n_holdings=%d",
            sid, final_total, final_cash, len(new_holdings),
        )
        return RebalanceResult(success=True)

    # ── Fyers helpers ─────────────────────────────────────────────────────────

    def _get_fyers(self) -> fyersModel.FyersModel:
        session = (
            self.db.query(BrokerSession)
            .filter(
                BrokerSession.user_id   == self.strategy.user_id,
                BrokerSession.token_date == date.today(),
            )
            .order_by(BrokerSession.created_at.desc())
            .first()
        )
        if not session:
            raise RuntimeError("NO_BROKER_SESSION")
        token = decrypt_token(session.access_token_encrypted)
        Path(settings.log_dir).mkdir(parents=True, exist_ok=True)
        return fyersModel.FyersModel(
            client_id=settings.fyers_app_id,
            token=token,
            is_async=False,
            log_path=settings.log_dir,
        )

    def _get_cash(self, fyers: fyersModel.FyersModel) -> float:
        resp = fyers.funds()
        if resp.get("s") != "ok":
            raise RuntimeError(f"FUNDS_FAILED:{resp}")
        for item in resp.get("fund_limit", []):
            title = item.get("title", "")
            if "Available Balance" in title or "available_balance" in title.lower():
                return float(item.get("equityAmount", item.get("val", 0)))
        # Fallback: sum all equity amounts
        return sum(float(i.get("equityAmount", i.get("val", 0))) for i in resp.get("fund_limit", []))

    def _get_quotes(
        self, fyers: fyersModel.FyersModel, tickers: list[str]
    ) -> dict[str, dict]:
        """
        Returns {ticker: {ltp, lower_limit, upper_limit, bid_qty, ask_qty}}.
        Fyers quotes endpoint accepts up to ~50 symbols per call; we chunk if needed.
        """
        result: dict[str, dict] = {}
        chunk_size = FYERS_QUOTES_CHUNK_SIZE

        for i in range(0, len(tickers), chunk_size):
            chunk   = tickers[i : i + chunk_size]
            symbols = ",".join(_to_fyers(t) for t in chunk)
            resp    = fyers.quotes({"symbols": symbols, "ohlcv_flag": 1})
            if resp.get("s") != "ok":
                raise RuntimeError(f"QUOTES_FAILED:{resp}")
            for item in resp.get("d", []):
                if item.get("s") != "ok":
                    continue
                v      = item.get("v", {})
                ticker = _from_fyers(item.get("n", ""))
                result[ticker] = {
                    "ltp":         float(v.get("lp",           v.get("ltp", 0))),
                    "lower_limit": float(v.get("lower_limit",  v.get("lowerLimit", 0))),
                    "upper_limit": float(v.get("upper_limit",  v.get("upperLimit", 0))),
                    "bid_qty":     int(  v.get("bid_qty",      v.get("bidQty",    -1))),
                    "ask_qty":     int(  v.get("ask_qty",      v.get("askQty",    -1))),
                }
        return result

    def _is_lc(self, q: dict) -> bool:
        """
        Lower Circuit: price at lower limit AND no buyers waiting.
        bid_qty == 0 is the definitive signal.  Falls back to price proximity
        when bid_qty is unavailable (-1 means not returned by API).
        """
        if not q:
            return False
        lc = q.get("lower_limit", 0)
        if lc <= 0:
            return False
        ltp     = q.get("ltp", 0)
        bid_qty = q.get("bid_qty", -1)
        if bid_qty == 0:
            return True
        # Fallback: within 0.05% of lower limit
        return ltp > 0 and abs(ltp - lc) / lc < 0.0005

    def _is_uc(self, q: dict) -> bool:
        """Upper Circuit: price at upper limit AND no sellers."""
        if not q:
            return False
        uc = q.get("upper_limit", 0)
        if uc <= 0:
            return False
        ltp     = q.get("ltp", 0)
        ask_qty = q.get("ask_qty", -1)
        if ask_qty == 0:
            return True
        return ltp > 0 and abs(ltp - uc) / uc < 0.0005

    def _place_order(
        self, fyers: fyersModel.FyersModel, ticker: str, side: int, qty: int
    ) -> str:
        """
        Place a CNC market order, rate-limited to ≤10 orders/second.
        side: 1 = buy,  -1 = sell
        Returns Fyers order ID.
        """
        # Rate limit: enforce ≥ 110 ms between consecutive placements
        elapsed = time.time() - self._last_order_time
        if elapsed < _ORDER_MIN_INTERVAL:
            time.sleep(_ORDER_MIN_INTERVAL - elapsed)

        resp = fyers.place_order(data={
            "symbol":       _to_fyers(ticker),
            "qty":          qty,
            "type":         2,           # market order
            "side":         side,
            "productType":  "CNC",
            "validity":     "DAY",
            "offlineOrder": False,
            "stopPrice":    0,
            "limitPrice":   0,
            "disclosedQty": 0,
        })
        if resp.get("s") != "ok":
            raise RuntimeError(f"ORDER_FAILED:{resp}")
        self._last_order_time = time.time()
        return resp["id"]

    def _wait_for_fills(
        self,
        fyers: fyersModel.FyersModel,
        order_ids: list[str],
    ) -> dict[str, dict]:
        """
        Polls the orderbook until every order_id reaches a terminal state.
        Returns {order_id: {filled_qty, traded_price, status}}.
        """
        pending = set(order_ids)
        fills:  dict[str, dict] = {}
        deadline = time.time() + ORDER_WAIT_SECS

        while pending and time.time() < deadline:
            resp = fyers.orderbook()
            if resp.get("s") == "ok":
                for order in resp.get("orderBook", []):
                    oid = order.get("id")
                    if oid not in pending:
                        continue
                    status = order.get("status")
                    if status == _STATUS_TRADED:
                        fills[oid] = {
                            "filled_qty":   int(  order.get("filledQty",   0)),
                            "traded_price": float(order.get("tradedPrice", 0)),
                            "status": "filled",
                        }
                        pending.discard(oid)
                    elif status in (_STATUS_REJECTED, _STATUS_CANCELLED):
                        fills[oid] = {
                            "filled_qty":   0,
                            "traded_price": 0,
                            "status": "rejected" if status == _STATUS_REJECTED else "cancelled",
                        }
                        pending.discard(oid)
                        logger.warning(
                            "MATEngine: order %s terminal state=%s msg=%s",
                            oid, status, order.get("message", ""),
                        )
            else:
                logger.warning("MATEngine: orderbook fetch failed: %s", resp)

            if pending:
                time.sleep(ORDER_POLL_INTERVAL)

        for oid in pending:
            fills[oid] = {"filled_qty": 0, "traded_price": 0, "status": "timeout"}
            logger.warning("MATEngine: order %s timed out", oid)

        return fills

    # ── Momentum ──────────────────────────────────────────────────────────────

    def _load_db_holdings(self) -> dict[str, dict]:
        """Load strategy's current tracked holdings from our DB."""
        rows = (
            self.db.query(Holdings)
            .filter(Holdings.strat_id == self.strategy.strat_id)
            .all()
        )
        return {
            row.ticker: {
                "qty":       row.qty,
                "avg_price": float(row.avg_price or 0),
            }
            for row in rows
            if row.qty > 0
        }

    def _compute_momentum(
        self, strat: Strategy
    ) -> tuple[dict[str, float], dict[str, float]]:
        """
        Queries stock_price for the last (lb2_days + 30) trading dates and
        computes risk-adjusted momentum using the strategy's lookback periods.

        Returns:
            scores     — {ticker: momentum_score}  (sorted best → ...)
            prev_close — {ticker: latest_close}     (for order sizing)
        """
        universe_tags = UNIVERSE_MAP.get(strat.universe, ["nifty50"])
        lb1_days = strat.lb_period_1 * TRADING_DAYS_PER_MONTH
        lb2_days = strat.lb_period_2 * TRADING_DAYS_PER_MONTH
        n_rows   = lb2_days + 30   # enough history for the longest lookback

        # Get the n_rows most-recent distinct trading dates
        date_subq = (
            self.db.query(StockPrice.date)
            .distinct()
            .order_by(StockPrice.date.desc())
            .limit(n_rows)
            .subquery()
        )

        rows = (
            self.db.query(
                StockPrice.ticker,
                StockPrice.date,
                StockPrice.close,
                StockPrice.volatility_1y,
            )
            .filter(
                StockPrice.date.in_(date_subq),
                StockPrice.index_member.in_(universe_tags),
                StockPrice.close.isnot(None),
                StockPrice.volatility_1y.isnot(None),
            )
            .order_by(StockPrice.ticker, StockPrice.date)
            .all()
        )

        if not rows:
            return {}, {}

        df = pd.DataFrame(rows, columns=["symbol", "date", "close", "volatility_1y"])
        df["close"]        = df["close"].astype(float)
        df["volatility_1y"] = df["volatility_1y"].astype(float)

        # Apply price cap
        max_price = float(strat.price_cap) if strat.price_cap else 1_000_000_000.0
        df = df[df["close"].between(1.0, max_price)]

        # Momentum score via shift on sorted (symbol, date) df
        df = df.sort_values(["symbol", "date"]).reset_index(drop=True)
        g  = df.groupby("symbol")["close"]

        df["p_lb1"] = g.shift(lb1_days)
        df["p_lb2"] = g.shift(lb2_days)

        df["ret_lb1"] = (df["close"] / df["p_lb1"]) - 1
        df["ret_lb2"] = (df["close"] / df["p_lb2"]) - 1

        df["score_1"]        = df["ret_lb1"] / df["volatility_1y"]
        df["score_2"]        = df["ret_lb2"] / df["volatility_1y"]
        df["momentum_score"] = WEIGHT_1 * df["score_1"] + WEIGHT_2 * df["score_2"]

        # Keep only the latest row per symbol (most recent close = prev day)
        latest = (
            df.sort_values("date")
            .groupby("symbol")
            .last()
            .reset_index()
        )
        latest = latest[latest["momentum_score"].notna()]

        scores     = dict(zip(latest["symbol"], latest["momentum_score"]))
        prev_close = dict(zip(latest["symbol"], latest["close"]))
        return scores, prev_close

    # ── DB flush helpers ──────────────────────────────────────────────────────

    def _flush_holdings(
        self,
        new_holdings: dict[str, dict],
        quotes: dict[str, dict],
    ) -> None:
        """Replace Holdings rows for this strategy with the post-rebalance state."""
        strat_id = self.strategy.strat_id
        self.db.query(Holdings).filter(Holdings.strat_id == strat_id).delete()
        for ticker, data in new_holdings.items():
            if data["qty"] <= 0:
                continue
            ltp = quotes.get(ticker, {}).get("ltp") or data.get("last_price")
            self.db.add(Holdings(
                strat_id   = strat_id,
                ticker     = ticker,
                qty        = data["qty"],
                avg_price  = data.get("avg_price"),
                last_price = ltp,
            ))
        self.db.flush()

    def _flush_strategy(self, total_value: float, cash: float) -> None:
        strat                = self.strategy
        strat.market_value   = total_value
        strat.unused_capital = cash
        strat.buffer_capital = total_value * CASH_BUFFER
        self.db.flush()

    def _flush_portfolio(self, total_value: float) -> None:
        today    = date.today()
        existing = (
            self.db.query(Portfolio)
            .filter(
                Portfolio.strat_id == self.strategy.strat_id,
                Portfolio.date     == today,
            )
            .first()
        )
        if existing:
            existing.value = total_value
        else:
            self.db.add(Portfolio(
                strat_id=self.strategy.strat_id,
                date=today,
                value=total_value,
            ))
        self.db.flush()
