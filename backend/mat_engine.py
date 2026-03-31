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
    e. Socket-first fill confirmation (polling fallback)
10. BUY PHASE
    a. Build buy list from fixed initial target quantities (single-shot plan)
      b. Final UC recheck per stock; skip UC stocks
    c. Place market BUY IOC orders
    d. Socket-first fill confirmation (polling fallback)
11. DB UPDATE (atomic flush; committed by caller — scheduler)
      a. Rebuild Holdings from analytical tracking (no extra Fyers call needed)
      b. Update Strategy.market_value / unused_capital / buffer_capital
      c. Upsert Portfolio row for today
"""

from __future__ import annotations

import json
import logging
import threading
import time
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Any, Optional
from uuid import UUID

import pandas as pd
from fyers_apiv3 import fyersModel
from sqlalchemy.orm import Session

from backend.config import settings
from backend.core.fyers_funds import extract_available_cash
from backend.core.security import decrypt_token
from backend.core.time_utils import now_ist
from backend.models import (
    BrokerSession,
    RebalanceOrderLeg,
    RebalanceQueue,
    RebalancingHistory,
    StockPrice,
    Strategy,
)

# All MATEngine logging (debug, info, warning, error, exception) goes to
# rebalancing.log via the "backend.rebalance" logger (configured in logging_setup.py).
logger = logging.getLogger("backend.rebalance")
rebalance_logger = logger  # kept for call-site compatibility

# ── Transaction-cost constants (matching backtest / Fyers CNC) ───────────────
# Fyers charges zero brokerage on equity delivery (CNC).
# MAT_BROKERAGE_RATE is configured as percentage (e.g. 0.3 for 0.3%).
BROKERAGE       = max(float(settings.mat_brokerage_rate), 0.0) / 100.0
STT_SELL        = max(float(settings.mat_stt_sell_rate), 0.0)
EXCHANGE_CHARGE = max(float(settings.mat_exchange_charge_rate), 0.0)
SEBI_CHARGE     = max(float(settings.mat_sebi_charge_rate), 0.0)
GST_RATE        = max(float(settings.mat_gst_rate), 0.0)
STAMP_DUTY_BUY  = max(float(settings.mat_stamp_duty_buy_rate), 0.0)
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
        self._access_token: str | None = None
        self._order_socket = None
        self._order_socket_connected = False
        self._order_socket_last_msg_ts: float | None = None
        self._socket_order_updates: dict[str, dict] = {}
        self._socket_lock = threading.Lock()

    # ── Entry point ───────────────────────────────────────────────────────────

    def run_rebalance(self) -> RebalanceResult:
        strat = self.strategy
        sid   = strat.strat_id
        started_at_ist = now_ist()
        logger.info("MATEngine: START strat=%s", sid)
        rebalance_logger.info(
            "event=rebalance_start payload=%s",
            json.dumps({
                "stratId": str(sid),
                "queueId": str(self.entry.id) if self.entry and self.entry.id else None,
                "startedAt": started_at_ist.isoformat(),
            }, ensure_ascii=True),
        )

        order_events: list[dict] = []
        pre_cash: float | None = None
        pre_total: float | None = None
        pre_holdings_snapshot: dict[str, dict] = {}

        def _done(result: RebalanceResult, *, post_cash: float | None = None, post_total: float | None = None,
                  post_holdings: dict[str, dict] | None = None, summary: dict | None = None) -> RebalanceResult:
            if result.details.get("historyStatus"):
                status = str(result.details["historyStatus"])
            elif result.success:
                status = "action_required" if self._has_action_required(order_events) else "completed"
            elif result.skipped:
                status = "skipped"
            else:
                status = "action_required" if order_events else "failed"
            try:
                history_row = self._record_rebalancing_history(
                    status=status,
                    reason=result.reason,
                    started_at=started_at_ist,
                    completed_at=now_ist(),
                    pre_cash=pre_cash,
                    post_cash=post_cash,
                    pre_total=pre_total,
                    post_total=post_total,
                    pre_holdings=pre_holdings_snapshot,
                    post_holdings=post_holdings or {},
                    orders=order_events,
                    summary={
                        "details": result.details,
                        **(summary or {}),
                    },
                )
                self._record_order_legs(history_row.id, order_events)
            except Exception:
                logger.exception("MATEngine: failed to persist rebalancing history strat=%s", sid)

            rebalance_logger.info(
                "event=rebalance_done payload=%s",
                json.dumps({
                    "stratId": str(sid),
                    "queueId": str(self.entry.id) if self.entry and self.entry.id else None,
                    "status": status,
                    "reason": result.reason,
                    "preCash": pre_cash,
                    "postCash": post_cash,
                    "preTotal": pre_total,
                    "postTotal": post_total,
                    "orders": order_events,
                }, ensure_ascii=True),
            )
            self._close_order_socket()
            return result

        # ── 1. Broker auth ────────────────────────────────────────────────────
        try:
            fyers = self._get_fyers()
        except RuntimeError as e:
            return _done(RebalanceResult(skipped=True, reason=str(e)))

        socket_connected = self._ensure_order_socket_connected()
        logger.info("MATEngine: order socket connected=%s strat=%s", socket_connected, sid)

        # ── 2. Current DB holdings + LTP ─────────────────────────────────────
        # Read what we own from DB (our tracked state, strategy-scoped)
        db_holdings: dict[str, dict] = self._load_db_holdings()
        # {ticker: {qty, avg_price}}

        held_tickers = list(db_holdings.keys())

        # ── 3. Cash ───────────────────────────────────────────────────────────
        try:
            cash = self._get_cash(fyers)
        except RuntimeError as e:
            return _done(RebalanceResult(skipped=True, reason=str(e)))

        # ── 4. Total capital ──────────────────────────────────────────────────
        # Need LTP for held stocks to calculate portfolio value
        held_quotes: dict[str, dict] = {}
        if held_tickers:
            try:
                held_quotes = self._get_quotes(fyers, held_tickers)
            except Exception as e:
                return _done(RebalanceResult(skipped=True, reason=f"HELD_QUOTES_FAILED:{e}"))

        pre_holdings_snapshot = {
            t: {
                "qty": int(v["qty"]),
                "avg_price": float(v.get("avg_price") or 0),
                "last_price": float(held_quotes.get(t, {}).get("ltp", 0) or 0),
            }
            for t, v in db_holdings.items()
        }

        equity_value   = sum(
            db_holdings[t]["qty"] * held_quotes.get(t, {}).get("ltp", 0)
            for t in held_tickers
        )
        total_capital  = cash + equity_value
        working_capital = total_capital * (1 - CASH_BUFFER)
        pre_cash = float(cash)
        pre_total = float(total_capital)

        logger.info(
            "MATEngine: strat=%s cash=%.2f equity=%.2f total=%.2f working=%.2f",
            sid, cash, equity_value, total_capital, working_capital,
        )

        # ── 5. Momentum scores from DB (prev-day close) ───────────────────────
        try:
            scores, prev_close = self._compute_momentum(strat)
        except Exception as e:
            return _done(RebalanceResult(success=False, reason=f"MOMENTUM_ERROR:{e}"))

        if not scores:
            return _done(RebalanceResult(success=False, reason="NO_MOMENTUM_SCORES"))

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
            return _done(RebalanceResult(skipped=True, reason=f"QUOTES_FAILED:{e}"))

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
                    return _done(RebalanceResult(
                        skipped=True,
                        reason="UC_GLOBAL_EVENT",
                        details={"uc_tickers": uc_skipped},
                    ))
                continue
            target_tickers.append(ticker)

        if not target_tickers:
            return _done(RebalanceResult(success=False, reason="NO_ELIGIBLE_STOCKS"))

        target_set = set(target_tickers)

        # ── 9. Build fixed target qty plan once (single transaction model) ───
        # Use LTP from step-7 quotes for sizing (more accurate at 12pm execution);
        # fall back to prev_close for any ticker missing a live quote.
        pricing: dict[str, float] = {}
        for t in target_tickers:
            ltp = float((all_quotes.get(t) or {}).get("ltp", 0) or 0)
            pricing[t] = ltp if ltp > 0 else float(prev_close.get(t, 0) or 0)

        ltp_used  = [t for t in target_tickers if float((all_quotes.get(t) or {}).get("ltp", 0) or 0) > 0]
        pc_used   = [t for t in target_tickers if t not in ltp_used]
        logger.info(
            "MATEngine: pricing source ltp=%d prev_close_fallback=%d",
            len(ltp_used), len(pc_used),
        )
        if pc_used:
            logger.warning("MATEngine: prev_close fallback tickers=%s", pc_used)

        alloc_plan = working_capital / len(target_tickers)
        target_qty_plan: dict[str, int] = {}
        for t in target_tickers:
            price = pricing.get(t, 0)
            target_qty_plan[t] = int(alloc_plan / price) if price > 0 else 0

        base_cost = sum(
            target_qty_plan[t] * pricing.get(t, 0)
            for t in target_tickers
            if pricing.get(t, 0) > 0
        )
        residual = working_capital - base_cost

        remainders = [
            (t, alloc_plan - target_qty_plan[t] * pricing.get(t, 0))
            for t in target_tickers
            if pricing.get(t, 0) > 0
        ]
        remainders.sort(key=lambda x: x[1], reverse=True)
        for t, _ in remainders:
            price = pricing.get(t, 0)
            if price > 0 and residual >= price:
                target_qty_plan[t] += 1
                residual -= price

        logger.info(
            "MATEngine: fixed plan built tickers=%d planned_notional=%.2f residual=%.2f",
            len(target_qty_plan),
            float(base_cost),
            float(residual),
        )

        # ── 10. SELL PHASE ────────────────────────────────────────────────────

        sells_exit: dict[str, int] = {}   # ticker → full-exit qty
        sells_trim: dict[str, int] = {}   # ticker → trim qty

        for ticker, held in db_holdings.items():
            if held["qty"] <= 0:
                continue
            if ticker not in target_set:
                sells_exit[ticker] = held["qty"]
            else:
                pre_target_qty = int(target_qty_plan.get(ticker, 0))
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
            for t in lc_tickers:
                qty = int((sells_exit.get(t) or sells_trim.get(t) or 0))
                order_events.append({
                    "phase": "sell",
                    "ticker": t,
                    "requestedQty": qty,
                    "status": "skipped_lc",
                    "errorCode": "LC_BLOCK",
                    "error": "Lower-circuit guard blocked sell leg",
                    "isRetryable": True,
                })
            return _done(RebalanceResult(
                skipped=True,
                reason="LC_DETECTED",
                details={"lc_tickers": lc_tickers},
            ))

        # Place ALL sell orders (exits first, then trims), rate-limited
        sell_order_map: dict[str, str] = {}   # ticker → order_id
        for ticker in list(sells_exit) + list(sells_trim):
            qty = sells_exit.get(ticker) or sells_trim[ticker]
            try:
                oid = self._place_order(fyers, ticker, side=-1, qty=qty)
                sell_order_map[ticker] = oid
                order_events.append({
                    "phase": "sell",
                    "ticker": ticker,
                    "requestedQty": int(qty),
                    "orderId": oid,
                    "status": "placed",
                })
                logger.info("MATEngine: SELL placed %s qty=%d oid=%s", ticker, qty, oid)
            except Exception as e:
                order_events.append({
                    "phase": "sell",
                    "ticker": ticker,
                    "requestedQty": int(qty),
                    "status": "placement_failed",
                    "error": str(e),
                })
                logger.error("MATEngine: sell placement failed for %s: %s", ticker, e)
                return _done(RebalanceResult(success=False, reason=f"SELL_PLACE_FAILED:{ticker}:{e}"))

        # Wait for ALL sell fills simultaneously
        sell_fills: dict[str, dict] = {}
        if sell_order_map:
            all_sell_results = self._wait_for_fills(fyers, list(sell_order_map.values()))
            sell_fills = {
                ticker: all_sell_results.get(oid, {"filled_qty": 0, "traded_price": 0, "status": "missing"})
                for ticker, oid in sell_order_map.items()
            }
            for ticker, fill in sell_fills.items():
                order_events.append({
                    "phase": "sell",
                    "ticker": ticker,
                    "filledQty": int(fill.get("filled_qty", 0) or 0),
                    "tradedPrice": float(fill.get("traded_price", 0) or 0),
                    "status": str(fill.get("status", "unknown")),
                })
                logger.info(
                    "MATEngine: SELL fill %s qty=%d price=%.2f status=%s",
                    ticker, fill["filled_qty"], fill["traded_price"], fill.get("status", "?"),
                )

        # ── 11. Post-sell cash refresh (for logging/reconciliation only) ─────
        try:
            actual_cash = self._get_cash(fyers)
        except RuntimeError as e:
            return _done(RebalanceResult(success=False, reason=f"POST_SELL_FUNDS_FAILED:{e}"))

        logger.info("MATEngine: post-sell actual_cash=%.2f", actual_cash)

        # ── 12. BUY PHASE — fixed qty from initial plan (no re-sizing) ───────
        # Analytical post-sell current quantities (strategy-scoped)
        current_qty: dict[str, int] = {t: v["qty"] for t, v in db_holdings.items()}
        for ticker, fill in sell_fills.items():
            current_qty[ticker] = max(0, current_qty.get(ticker, 0) - fill["filled_qty"])

        # Build buy list directly from fixed target plan (positive diff only)
        buy_order_map: dict[str, str] = {}    # ticker → order_id
        buy_order_qty: dict[str, int] = {}    # ticker → qty attempted

        for t in target_tickers:
            diff = int(target_qty_plan.get(t, 0)) - current_qty.get(t, 0)
            if diff <= 0:
                continue
            # Final UC safety check at buy time
            q = all_quotes.get(t)
            if q and self._is_uc(q):
                logger.info("MATEngine: BUY skipped — %s still UC at buy time", t)
                order_events.append({
                    "phase": "buy",
                    "ticker": t,
                    "requestedQty": int(diff),
                    "status": "skipped_uc",
                    "errorCode": "UC_BLOCK",
                    "error": "Stock is at upper circuit",
                    "isRetryable": True,
                })
                continue

            buy_order_qty[t] = int(diff)
            try:
                oid = self._place_order(fyers, t, side=1, qty=int(diff))
                buy_order_map[t] = oid
                order_events.append({
                    "phase": "buy",
                    "ticker": t,
                    "requestedQty": int(diff),
                    "orderId": oid,
                    "status": "placed",
                })
                logger.info("MATEngine: BUY placed %s qty=%d oid=%s", t, int(diff), oid)
            except Exception as e:
                # Non-fatal: log and skip; continue with remaining buys
                order_events.append({
                    "phase": "buy",
                    "ticker": t,
                    "requestedQty": int(diff),
                    "status": "placement_failed",
                    "error": str(e),
                })
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
                order_events.append({
                    "phase": "buy",
                    "ticker": ticker,
                    "filledQty": int(fill.get("filled_qty", 0) or 0),
                    "tradedPrice": float(fill.get("traded_price", 0) or 0),
                    "status": str(fill.get("status", "unknown")),
                })
                logger.info(
                    "MATEngine: BUY fill %s qty=%d price=%.2f status=%s",
                    ticker, fill["filled_qty"], fill["traded_price"], fill.get("status", "?"),
                )

        # ── Refresh broker cash after fills ───────────────────────────────────
        # Holdings/positions/cash DB state is handled by broker_reconcile_snapshot()
        # called in the scheduler immediately after this run completes.
        try:
            final_cash = self._get_cash(fyers)
        except RuntimeError as e:
            return _done(RebalanceResult(success=False, reason=f"POST_BUY_FUNDS_FAILED:{e}"))

        logger.info(
            "MATEngine: DONE strat=%s post_cash=%.2f",
            sid, final_cash,
        )
        has_action_required = self._has_action_required(order_events)
        return _done(
            RebalanceResult(
                success=True,
                reason="ACTION_REQUIRED" if has_action_required else "",
                details={
                    "historyStatus": "action_required" if has_action_required else "completed",
                },
            ),
            post_cash=float(final_cash),
            post_total=None,
            post_holdings={},
            summary={
                "targetTickers": target_tickers,
                "sellExits": sells_exit,
                "sellTrims": sells_trim,
                "buyAttempted": buy_order_qty,
                "ucSkipped": uc_skipped,
                "actionRequired": has_action_required,
            },
        )

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
        self._access_token = token
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
        cash = extract_available_cash(resp)
        if cash is None:
            raise RuntimeError(f"FUNDS_PARSE_FAILED:{resp}")
        return float(cash)

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
            "validity":     "IOC",
            "offlineOrder": False,
            "stopPrice":    0,
            "limitPrice":   0,
            "disclosedQty": 0,
        })
        if resp.get("s") != "ok":
            raise RuntimeError(f"ORDER_FAILED:{resp}")
        self._last_order_time = time.time()
        return resp["id"]

    def _ensure_order_socket_connected(self) -> bool:
        if self._order_socket is not None and self._order_socket_connected:
            return True
        if not self._access_token:
            logger.warning("MATEngine: order socket skipped (missing access token)")
            return False

        try:
            from fyers_apiv3.FyersWebsocket.order_ws import FyersOrderSocket
        except Exception as exc:
            logger.warning("MATEngine: order socket import failed, using polling fallback: %s", exc)
            return False

        self._socket_order_updates = {}
        self._order_socket_last_msg_ts = None
        self._order_socket_connected = False

        def _on_connect():
            self._order_socket_connected = True
            logger.info("MATEngine: order socket connected")
            rebalance_logger.info(
                "event=order_socket_connect payload=%s",
                json.dumps({
                    "stratId": str(self.strategy.strat_id),
                    "queueId": str(self.entry.id) if getattr(self.entry, "id", None) else None,
                }, ensure_ascii=True),
            )
            try:
                if self._order_socket:
                    self._order_socket.subscribe(data_type="OnOrders,OnTrades")
                    self._order_socket.keep_running()
                    logger.info("MATEngine: order socket subscribed data_type=OnOrders,OnTrades")
            except Exception as exc:
                logger.warning("MATEngine: order socket subscribe failed: %s", exc)

        def _on_close(msg):
            self._order_socket_connected = False
            logger.warning("MATEngine: order socket closed: %s", msg)

        def _on_error(msg):
            logger.warning("MATEngine: order socket error: %s", msg)

        def _on_orders(message):
            self._ingest_order_socket_message(message, source="orders")

        def _on_trades(message):
            self._ingest_order_socket_message(message, source="trades")

        try:
            self._order_socket = FyersOrderSocket(
                access_token=self._access_token,
                log_path=settings.log_dir,
                on_orders=_on_orders,
                on_trades=_on_trades,
                on_error=_on_error,
                on_connect=_on_connect,
                on_close=_on_close,
                reconnect=True,
            )
            self._order_socket.connect()

            wait_deadline = time.time() + 3.0
            while time.time() < wait_deadline:
                if self._order_socket_connected:
                    break
                try:
                    if self._order_socket and bool(self._order_socket.is_connected()):
                        self._order_socket_connected = True
                        break
                except Exception:
                    pass
                time.sleep(0.1)
        except Exception as exc:
            logger.warning("MATEngine: order socket connect failed, using polling fallback: %s", exc)
            self._order_socket_connected = False
            self._order_socket = None

        return bool(self._order_socket_connected)

    def _close_order_socket(self) -> None:
        socket = self._order_socket
        self._order_socket = None
        self._order_socket_connected = False
        if socket:
            try:
                socket.close_connection()
                logger.info("MATEngine: order socket closed")
            except Exception as exc:
                logger.warning("MATEngine: order socket close failed: %s", exc)

    def _ingest_order_socket_message(self, message: Any, source: str) -> None:
        updates = self._extract_order_updates(message)
        now_ts = time.time()
        self._order_socket_last_msg_ts = now_ts

        with self._socket_lock:
            for oid, upd in updates.items():
                prev = self._socket_order_updates.get(oid) or {}
                merged = {**prev, **upd}
                merged["updated_at"] = now_ts
                self._socket_order_updates[oid] = merged

        logger.info(
            "MATEngine: order socket message source=%s updates=%d preview=%s",
            source,
            len(updates),
            str(message)[:500],
        )
        if updates:
            rebalance_logger.info(
                "event=order_socket_update payload=%s",
                json.dumps({
                    "stratId": str(self.strategy.strat_id),
                    "queueId": str(self.entry.id) if getattr(self.entry, "id", None) else None,
                    "source": source,
                    "updates": updates,
                }, ensure_ascii=True),
            )

    def _extract_order_updates(self, payload: Any) -> dict[str, dict]:
        updates: dict[str, dict] = {}

        def _walk(node: Any) -> None:
            if isinstance(node, dict):
                oid = node.get("id") or node.get("order_id") or node.get("orderId")
                status = node.get("status")
                filled_qty = node.get("filledQty", node.get("filled_qty", node.get("filled_quantity", 0)))
                traded_price = node.get("tradedPrice", node.get("traded_price", node.get("avgPrice", 0)))
                message = node.get("message") or node.get("reason")

                if oid:
                    st = self._normalize_order_status(status)
                    updates[str(oid)] = {
                        "status": st,
                        "filled_qty": int(filled_qty or 0),
                        "traded_price": float(traded_price or 0),
                        "message": str(message or ""),
                    }

                for child in node.values():
                    if isinstance(child, (dict, list, tuple)):
                        _walk(child)
            elif isinstance(node, (list, tuple)):
                for child in node:
                    _walk(child)

        _walk(payload)
        return updates

    def _normalize_order_status(self, status: Any) -> str:
        if status is None:
            return "unknown"
        if isinstance(status, int):
            if status == _STATUS_TRADED:
                return "filled"
            if status == _STATUS_REJECTED:
                return "rejected"
            if status == _STATUS_CANCELLED:
                return "cancelled"
            return "unknown"

        s = str(status).strip().lower()
        if s in {"2", "traded", "filled", "complete", "completed"}:
            return "filled"
        if s in {"5", "rejected", "reject"}:
            return "rejected"
        if s in {"1", "cancelled", "canceled", "cancel"}:
            return "cancelled"
        if s in {"partial", "partially_filled", "partially filled"}:
            return "partial"
        if s in {"open", "trigger pending", "pending", "placed"}:
            return "placed"
        return "unknown"

    def _wait_for_fills(
        self,
        fyers: fyersModel.FyersModel,
        order_ids: list[str],
    ) -> dict[str, dict]:
        """
        Socket-first fill tracking; falls back to polling orderbook when socket
        is unavailable or stale.
        Returns {order_id: {filled_qty, traded_price, status}}.
        """
        pending = set(order_ids)
        fills:  dict[str, dict] = {}
        deadline = time.time() + ORDER_WAIT_SECS
        last_poll_ts = 0.0
        socket_connected = self._ensure_order_socket_connected()

        logger.info(
            "MATEngine: wait_for_fills start orders=%d socket_connected=%s",
            len(order_ids),
            socket_connected,
        )
        rebalance_logger.info(
            "event=order_wait_start payload=%s",
            json.dumps({
                "stratId": str(self.strategy.strat_id),
                "queueId": str(self.entry.id) if getattr(self.entry, "id", None) else None,
                "orderIds": list(order_ids),
                "socketConnected": socket_connected,
            }, ensure_ascii=True),
        )

        while pending and time.time() < deadline:
            resolved_via_socket = 0
            with self._socket_lock:
                for oid in list(pending):
                    upd = self._socket_order_updates.get(oid)
                    if not upd:
                        continue
                    st = str(upd.get("status", "unknown")).lower()
                    if st in {"filled", "rejected", "cancelled"}:
                        fills[oid] = {
                            "filled_qty": int(upd.get("filled_qty", 0) or 0),
                            "traded_price": float(upd.get("traded_price", 0) or 0),
                            "status": st,
                        }
                        pending.discard(oid)
                        resolved_via_socket += 1

            if resolved_via_socket:
                logger.info(
                    "MATEngine: order socket resolved=%d pending=%d",
                    resolved_via_socket,
                    len(pending),
                )

            if not pending:
                break

            now_ts = time.time()
            socket_stale = (
                socket_connected
                and (self._order_socket_last_msg_ts is None or (now_ts - self._order_socket_last_msg_ts) > (ORDER_POLL_INTERVAL * 2))
            )
            should_poll = (not socket_connected) or socket_stale
            should_poll = should_poll and (now_ts - last_poll_ts) >= ORDER_POLL_INTERVAL

            if should_poll:
                fallback_reason = "socket_disconnected" if not socket_connected else "socket_stale"
                logger.info(
                    "MATEngine: polling fallback reason=%s pending=%d",
                    fallback_reason,
                    len(pending),
                )
                rebalance_logger.info(
                    "event=order_poll_fallback payload=%s",
                    json.dumps({
                        "stratId": str(self.strategy.strat_id),
                        "queueId": str(self.entry.id) if getattr(self.entry, "id", None) else None,
                        "reason": fallback_reason,
                        "pendingCount": len(pending),
                    }, ensure_ascii=True),
                )
                last_poll_ts = now_ts

                resp = fyers.orderbook()
                if resp.get("s") == "ok":
                    for order in resp.get("orderBook", []):
                        oid = order.get("id")
                        if oid not in pending:
                            continue
                        status = order.get("status")
                        if status == _STATUS_TRADED:
                            fills[oid] = {
                                "filled_qty":   int(order.get("filledQty", 0)),
                                "traded_price": float(order.get("tradedPrice", 0)),
                                "status": "filled",
                            }
                            pending.discard(oid)
                        elif status in (_STATUS_REJECTED, _STATUS_CANCELLED):
                            fills[oid] = {
                                "filled_qty": int(order.get("filledQty", 0) or 0),
                                "traded_price": float(order.get("tradedPrice", 0) or 0),
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
                time.sleep(0.2)

        for oid in pending:
            upd = self._socket_order_updates.get(oid, {})
            filled_qty = int(upd.get("filled_qty", 0) or 0)
            traded_price = float(upd.get("traded_price", 0) or 0)
            if filled_qty > 0:
                fills[oid] = {
                    "filled_qty": filled_qty,
                    "traded_price": traded_price,
                    "status": "partial",
                }
                logger.warning(
                    "MATEngine: order %s timed out with partial socket fill qty=%d",
                    oid,
                    filled_qty,
                )
            else:
                fills[oid] = {"filled_qty": 0, "traded_price": 0, "status": "timeout"}
                logger.warning("MATEngine: order %s timed out", oid)

        rebalance_logger.info(
            "event=order_wait_done payload=%s",
            json.dumps({
                "stratId": str(self.strategy.strat_id),
                "queueId": str(self.entry.id) if getattr(self.entry, "id", None) else None,
                "fills": fills,
                "timedOut": [oid for oid, val in fills.items() if str(val.get("status")) == "timeout"],
            }, ensure_ascii=True),
        )

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

    def _record_rebalancing_history(
        self,
        *,
        status: str,
        reason: str,
        started_at,
        completed_at,
        pre_cash: float | None,
        post_cash: float | None,
        pre_total: float | None,
        post_total: float | None,
        pre_holdings: dict,
        post_holdings: dict,
        orders: list[dict],
        summary: dict,
    ) -> RebalancingHistory:
        row = RebalancingHistory(
            strat_id=self.strategy.strat_id,
            queue_id=getattr(self.entry, "id", None),
            user_id=self.strategy.user_id,
            status=status,
            reason=reason,
            started_at=started_at,
            completed_at=completed_at,
            pre_cash=pre_cash,
            post_cash=post_cash,
            pre_total=pre_total,
            post_total=post_total,
            pre_holdings_json=json.dumps(pre_holdings or {}, ensure_ascii=True),
            post_holdings_json=json.dumps(post_holdings or {}, ensure_ascii=True),
            orders_json=json.dumps(orders or [], ensure_ascii=True),
            summary_json=json.dumps(summary or {}, ensure_ascii=True),
        )
        self.db.add(row)
        self.db.flush()
        return row

    def _has_action_required(self, order_events: list[dict]) -> bool:
        action_statuses = {
            "placement_failed",
            "rejected",
            "cancelled",
            "timeout",
            "missing",
            "skipped_uc",
            "skipped_lc",
            "skipped_price",
            "skipped_funds",
        }
        for ev in order_events:
            status = str(ev.get("status", "")).lower()
            if status in action_statuses:
                return True
        return False

    def _record_order_legs(self, history_id, order_events: list[dict]) -> None:
        legs_by_key: dict[tuple[str, str], dict] = {}

        def _get_leg(phase: str, ticker: str) -> dict:
            key = (phase.lower(), ticker)
            if key not in legs_by_key:
                side = "SELL" if phase.lower() == "sell" else "BUY"
                legs_by_key[key] = {
                    "phase": phase.lower(),
                    "side": side,
                    "symbol": ticker,
                    "requested_qty": 0,
                    "filled_qty": 0,
                    "remaining_qty": 0,
                    "status": "planned",
                    "broker_order_id": None,
                    "attempt_no": 1,
                    "error_code": None,
                    "error_message": None,
                    "is_retryable": True,
                }
            return legs_by_key[key]

        for ev in order_events:
            phase = str(ev.get("phase", "")).lower()
            ticker = str(ev.get("ticker", "")).upper()
            if phase not in {"sell", "buy"} or not ticker:
                continue

            leg = _get_leg(phase, ticker)
            requested = int(ev.get("requestedQty", leg["requested_qty"]) or 0)
            if requested > 0:
                leg["requested_qty"] = max(int(leg["requested_qty"]), requested)

            status = str(ev.get("status", "")).lower()
            if status == "placed":
                leg["status"] = "placed"
                leg["broker_order_id"] = ev.get("orderId")
                continue

            if status == "placement_failed":
                leg["status"] = "failed"
                leg["error_code"] = str(ev.get("errorCode") or "ORDER_PLACE_FAILED")
                leg["error_message"] = str(ev.get("error") or "Order placement failed")
                leg["is_retryable"] = bool(ev.get("isRetryable", True))
                continue

            if status in {"skipped_uc", "skipped_lc", "skipped_price", "skipped_funds"}:
                leg["status"] = "failed"
                leg["error_code"] = str(ev.get("errorCode") or "ORDER_SKIPPED")
                leg["error_message"] = str(ev.get("error") or "Order leg skipped")
                leg["is_retryable"] = bool(ev.get("isRetryable", status != "skipped_funds"))
                continue

            if status in {"filled", "partial", "rejected", "cancelled", "timeout", "missing", "unknown"}:
                filled_qty = int(ev.get("filledQty", 0) or 0)
                leg["filled_qty"] = max(int(leg["filled_qty"]), filled_qty)
                req = max(int(leg["requested_qty"]), int(leg["filled_qty"]))
                leg["requested_qty"] = req

                if status == "filled" and filled_qty >= req:
                    leg["status"] = "filled"
                    leg["error_code"] = None
                    leg["error_message"] = None
                    leg["is_retryable"] = True
                elif status == "partial" or filled_qty > 0:
                    leg["status"] = "partial"
                    leg["error_code"] = "PARTIAL_FILL"
                    leg["error_message"] = f"Partially filled {filled_qty}/{req}"
                    leg["is_retryable"] = True
                else:
                    leg["status"] = "failed"
                    error_map = {
                        "rejected": "ORDER_REJECTED",
                        "cancelled": "ORDER_CANCELLED",
                        "timeout": "BROKER_TIMEOUT",
                        "missing": "ORDERBOOK_MISSING",
                    }
                    leg["error_code"] = error_map.get(status, "ORDER_FAILED")
                    leg["error_message"] = f"Order ended with status={status}"
                    leg["is_retryable"] = status in {"timeout", "missing", "unknown"}

        for leg in legs_by_key.values():
            req = int(leg.get("requested_qty", 0) or 0)
            filled = int(leg.get("filled_qty", 0) or 0)
            leg["remaining_qty"] = max(req - filled, 0)
            if leg["status"] in {"planned", "placed"} and req > 0:
                leg["status"] = "failed"
                leg["error_code"] = leg["error_code"] or "NO_TERMINAL_STATUS"
                leg["error_message"] = leg["error_message"] or "No terminal broker status received"
                leg["is_retryable"] = True

            row = RebalanceOrderLeg(
                history_id=history_id,
                strat_id=self.strategy.strat_id,
                user_id=self.strategy.user_id,
                phase=leg["phase"],
                side=leg["side"],
                symbol=leg["symbol"],
                requested_qty=leg["requested_qty"],
                filled_qty=leg["filled_qty"],
                remaining_qty=leg["remaining_qty"],
                status=leg["status"],
                broker_order_id=leg["broker_order_id"],
                attempt_no=leg["attempt_no"],
                error_code=leg["error_code"],
                error_message=leg["error_message"],
                is_retryable=leg["is_retryable"],
            )
            self.db.add(row)
        self.db.flush()
