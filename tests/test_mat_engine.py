"""
tests/test_mat_engine.py
─────────────────────────
Unit tests for MATEngine.

Run from the project root (venv active):
    python -m unittest tests.test_mat_engine -v

No external services required — all Fyers API calls and DB access are
replaced with unittest.mock doubles.  Only the app's Python env must be
set up (same requirements.txt as the backend).
"""

import sys
import os
import time
import unittest
from unittest.mock import MagicMock, patch, call
from uuid import uuid4

# ── Make sure the workspace root is on sys.path ───────────────────────────────
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from backend.mat_engine import (
    MATEngine,
    RebalanceResult,
    _to_fyers,
    _from_fyers,
    _sell_cost,
    _buy_cost,
    _ORDER_MIN_INTERVAL,
    CASH_BUFFER,
)


# ── Shared test fixtures ──────────────────────────────────────────────────────

# Three test tickers + prev-day close prices
TICKERS = ["AA", "BB", "CC"]
PRICES  = {"AA": 100.0, "BB": 200.0, "CC": 300.0}

# Candidate pool: 5 tickers (engine picks top N×1.5 = 4, then filters to N=3)
# Scores: AA > BB > CC > DD > EE  → target = [AA, BB, CC]
SCORES  = {"AA": 2.0, "BB": 1.8, "CC": 1.5, "DD": 1.2, "EE": 0.9}
ALL_PRICES = {**PRICES, "DD": 150.0, "EE": 250.0}

def _flat_quotes(tickers=ALL_PRICES, ltp_mult=1.05):
    """Build a neutral quotes dict — no circuits, decent bid/ask."""
    return {
        t: {
            "ltp":         round(p * ltp_mult, 2),
            "lower_limit": round(p * 0.9, 2),
            "upper_limit": round(p * 1.1, 2),
            "bid_qty":     100,
            "ask_qty":     100,
        }
        for t, p in tickers.items()
    }


def _make_engine(n_stocks=3, capital=100_000, held=None):
    """
    Build a MATEngine backed entirely by MagicMocks.
    ``held`` — dict of {ticker: {qty, avg_price}} to seed _load_db_holdings.
    All heavy helpers are replaced so tests only exercise the logic they target.
    """
    entry = MagicMock()
    s = entry.strategy
    s.strat_id    = uuid4()
    s.user_id     = uuid4()
    s.n_stocks    = n_stocks
    s.universe    = 50
    s.lb_period_1 = 6
    s.lb_period_2 = 12
    s.price_cap   = None
    s.capital     = capital

    db = MagicMock()
    engine = MATEngine(entry, db)

    # Default mock implementations (can be overridden per test)
    engine._get_fyers       = MagicMock(return_value=MagicMock())
    engine._load_db_holdings = MagicMock(return_value=held or {})
    engine._get_cash        = MagicMock(return_value=float(capital))
    engine._get_quotes      = MagicMock(return_value=_flat_quotes())
    engine._compute_momentum = MagicMock(return_value=(SCORES, ALL_PRICES))
    engine._flush_holdings  = MagicMock()
    engine._flush_strategy  = MagicMock()
    engine._flush_portfolio  = MagicMock()

    # Default _wait_for_fills: every order "filled" at prev_close price
    def auto_fills(fyers, order_ids):
        return {
            oid: {"filled_qty": 1, "traded_price": 100.0, "status": "filled"}
            for oid in order_ids
        }
    engine._wait_for_fills = MagicMock(side_effect=auto_fills)

    # Default _place_order: returns unique order IDs
    _counter = {"n": 0}
    def place_and_count(fyers, ticker, side, qty):
        _counter["n"] += 1
        return f"ORD{_counter['n']:03d}"
    engine._place_order = MagicMock(side_effect=place_and_count)

    return engine


# ═══════════════════════════════════════════════════════════════════════════════
# 1.  Pure helper function tests
# ═══════════════════════════════════════════════════════════════════════════════

class TestSymbolHelpers(unittest.TestCase):

    def test_to_fyers(self):
        self.assertEqual(_to_fyers("INFY"), "NSE:INFY-EQ")

    def test_from_fyers(self):
        self.assertEqual(_from_fyers("NSE:INFY-EQ"), "INFY")

    def test_roundtrip(self):
        for t in ["RELIANCE", "HDFCBANK", "TCS"]:
            self.assertEqual(_from_fyers(_to_fyers(t)), t)


class TestCostFunctions(unittest.TestCase):

    def test_sell_cost_positive(self):
        self.assertGreater(_sell_cost(100_000), 0)

    def test_buy_cost_positive(self):
        self.assertGreater(_buy_cost(100_000), 0)

    def test_sell_cost_reasonable(self):
        # Total sell friction should be roughly 0.1–0.3% of trade value
        ratio = _sell_cost(100_000) / 100_000
        self.assertGreater(ratio, 0.001)
        self.assertLess(ratio, 0.003)

    def test_buy_cost_reasonable(self):
        ratio = _buy_cost(100_000) / 100_000
        self.assertGreater(ratio, 0.0001)
        self.assertLess(ratio, 0.002)


# ═══════════════════════════════════════════════════════════════════════════════
# 2.  Circuit detection (instance methods but no DB/Fyers needed)
# ═══════════════════════════════════════════════════════════════════════════════

class TestCircuitDetection(unittest.TestCase):

    def setUp(self):
        self.engine = _make_engine()

    # ── Lower circuit ──────────────────────────────────────────────────────────

    def test_lc_bid_qty_zero(self):
        q = {"ltp": 90.0, "lower_limit": 90.0, "upper_limit": 110.0, "bid_qty": 0, "ask_qty": 50}
        self.assertTrue(self.engine._is_lc(q))

    def test_lc_price_proximity(self):
        # LTP within 0.05% of lower_limit even with bid_qty unknown (-1)
        q = {"ltp": 90.0, "lower_limit": 90.0, "upper_limit": 110.0, "bid_qty": -1, "ask_qty": 50}
        self.assertTrue(self.engine._is_lc(q))

    def test_not_lc_normal(self):
        q = {"ltp": 95.0, "lower_limit": 90.0, "upper_limit": 110.0, "bid_qty": 100, "ask_qty": 100}
        self.assertFalse(self.engine._is_lc(q))

    def test_lc_no_limit_set(self):
        # lower_limit == 0 means no circuit info; should not flag as LC
        q = {"ltp": 90.0, "lower_limit": 0, "upper_limit": 0, "bid_qty": 0, "ask_qty": 0}
        self.assertFalse(self.engine._is_lc(q))

    # ── Upper circuit ──────────────────────────────────────────────────────────

    def test_uc_ask_qty_zero(self):
        q = {"ltp": 110.0, "lower_limit": 90.0, "upper_limit": 110.0, "bid_qty": 50, "ask_qty": 0}
        self.assertTrue(self.engine._is_uc(q))

    def test_uc_price_proximity(self):
        q = {"ltp": 110.0, "lower_limit": 90.0, "upper_limit": 110.0, "bid_qty": 50, "ask_qty": -1}
        self.assertTrue(self.engine._is_uc(q))

    def test_not_uc_normal(self):
        q = {"ltp": 105.0, "lower_limit": 90.0, "upper_limit": 110.0, "bid_qty": 100, "ask_qty": 100}
        self.assertFalse(self.engine._is_uc(q))


# ═══════════════════════════════════════════════════════════════════════════════
# 3.  Rate-limit throttle on _place_order
# ═══════════════════════════════════════════════════════════════════════════════

class TestRateLimit(unittest.TestCase):

    def test_throttle_enforced_behaviorally(self):
        """
        Two _place_order calls back-to-back should take ≥ 110 ms total
        (the real implementation sleeps; we test without mocking time so
        the sleep actually happens — ~110 ms overhead per test run is acceptable).
        """
        mock_fyers = MagicMock()
        mock_fyers.place_order.return_value = {"s": "ok", "id": "x"}

        engine = _make_engine()
        # Use the real _place_order (not the MagicMock from _make_engine)
        # Restore original method:
        engine._place_order = MATEngine._place_order.__get__(engine)

        t0 = time.perf_counter()
        engine._place_order(mock_fyers, "INFY", 1, 10)
        engine._place_order(mock_fyers, "TCS",  1, 5)
        elapsed = time.perf_counter() - t0

        self.assertGreaterEqual(elapsed, _ORDER_MIN_INTERVAL * 0.9,
                                 f"Two orders completed in {elapsed:.3f}s — throttle may be broken")

    def test_no_throttle_when_enough_time_passed(self):
        """After ≥ 110 ms gap, _place_order should not sleep."""
        mock_fyers = MagicMock()
        mock_fyers.place_order.return_value = {"s": "ok", "id": "x"}

        engine = _make_engine()
        engine._place_order = MATEngine._place_order.__get__(engine)
        engine._last_order_time = 0.0  # epoch → huge gap since last order

        with patch("backend.mat_engine.time.sleep") as mock_sleep:
            engine._place_order(mock_fyers, "INFY", 1, 10)
            mock_sleep.assert_not_called()


# ═══════════════════════════════════════════════════════════════════════════════
# 4.  run_rebalance — abort paths
# ═══════════════════════════════════════════════════════════════════════════════

class TestAbortPaths(unittest.TestCase):

    def test_no_broker_session(self):
        engine = _make_engine()
        engine._get_fyers = MagicMock(side_effect=RuntimeError("NO_BROKER_SESSION"))
        result = engine.run_rebalance()
        self.assertTrue(result.skipped)
        self.assertEqual(result.reason, "NO_BROKER_SESSION")

    def test_no_momentum_scores(self):
        engine = _make_engine()
        engine._compute_momentum = MagicMock(return_value=({}, {}))
        result = engine.run_rebalance()
        self.assertFalse(result.success)
        self.assertEqual(result.reason, "NO_MOMENTUM_SCORES")

    def test_uc_global_event(self):
        """If > N/2 candidates are at upper circuit, engine aborts."""
        # With n_stocks=2, any 2 UC stocks triggers the >N/2 guard
        engine = _make_engine(n_stocks=2)
        uc_quotes = _flat_quotes()
        # Put AA and BB at upper circuit
        for t in ["AA", "BB"]:
            uc_quotes[t]["ltp"]      = uc_quotes[t]["upper_limit"]
            uc_quotes[t]["ask_qty"]  = 0
        engine._get_quotes = MagicMock(return_value=uc_quotes)

        result = engine.run_rebalance()
        self.assertTrue(result.skipped)
        self.assertEqual(result.reason, "UC_GLOBAL_EVENT")

    def test_lc_detected_aborts_before_any_sell(self):
        """If any sell candidate is at lower circuit, engine skips entirely."""
        engine = _make_engine(
            held={"AA": {"qty": 50, "avg_price": 98.0}}  # AA is in target → trim candidate or exit
        )
        # AA not in target_tickers (SCORES puts AA first but let's make DD, EE, BB the target)
        # Easier: n_stocks=2 so target=[AA,BB], held has CC (not in target → exit)
        engine = _make_engine(
            n_stocks=2,
            held={"CC": {"qty": 10, "avg_price": 295.0}},  # CC will be an exit
        )
        lc_quotes = _flat_quotes()
        lc_quotes["CC"]["ltp"]     = lc_quotes["CC"]["lower_limit"]
        lc_quotes["CC"]["bid_qty"] = 0
        engine._get_quotes = MagicMock(return_value=lc_quotes)

        result = engine.run_rebalance()
        self.assertTrue(result.skipped)
        self.assertEqual(result.reason, "LC_DETECTED")
        self.assertIn("CC", result.details.get("lc_tickers", []))
        engine._place_order.assert_not_called()  # no orders placed

    def test_post_sell_funds_failure_aborts(self):
        """If fyers.funds() fails after sells, run aborts with error."""
        engine = _make_engine()
        # First _get_cash call succeeds, second fails
        engine._get_cash = MagicMock(
            side_effect=[100_000.0, RuntimeError("FUNDS_FAILED")]
        )
        result = engine.run_rebalance()
        self.assertFalse(result.success)
        self.assertIn("POST_SELL_FUNDS_FAILED", result.reason)


# ═══════════════════════════════════════════════════════════════════════════════
# 5.  run_rebalance — happy path: all buys (no existing holdings)
# ═══════════════════════════════════════════════════════════════════════════════

class TestAllBuysGreedy(unittest.TestCase):
    """
    No existing holdings → no sells → greedy buy allocation.

    cash = 100_000, CASH_BUFFER = 0.5%
    buy_budget = 99_500
    n_target   = 3 (AA, BB, CC)
    alloc      = 99_500 / 3 = 33_166.666...

    prev_close: AA=100, BB=200, CC=300

    base_qty: AA=331, BB=165, CC=110
    base_cost = 33_100 + 33_000 + 33_000 = 99_100
    residual  = 99_500 - 99_100 = 400

    remainders (alloc - base*close):
        AA: 33_166.67 - 33_100 =  66.67
        BB: 33_166.67 - 33_000 = 166.67
        CC: 33_166.67 - 33_000 = 166.67
    sorted desc: BB(166.67), CC(166.67), AA(66.67)
        BB: 400 >= 200 → BB=166, residual=200
        CC: 200 >= 300 → no
        AA: 200 >= 100 → AA=332, residual=100

    Expected orders: AA=332, BB=166, CC=110
    """

    EXPECTED_QTYS = {"AA": 332, "BB": 166, "CC": 110}

    def setUp(self):
        self.engine = _make_engine(n_stocks=3, capital=100_000, held={})
        # Both cash calls return 100_000
        self.engine._get_cash = MagicMock(return_value=100_000.0)
        # Use only TICKERS (AA, BB, CC) in both scores and quotes
        self.engine._compute_momentum = MagicMock(
            return_value=(
                {"AA": 2.0, "BB": 1.8, "CC": 1.5, "DD": 1.2},  # DD is 4th candidate, filtered out
                ALL_PRICES,
            )
        )
        self.engine._get_quotes = MagicMock(return_value=_flat_quotes())

        # Make _wait_for_fills return a fill that maps each order_id to filled
        def fill_buys(fyers, order_ids):
            return {oid: {"filled_qty": 1, "traded_price": 100.0, "status": "filled"} for oid in order_ids}
        self.engine._wait_for_fills = MagicMock(side_effect=fill_buys)

        # Capture _place_order calls (keep our counter side_effect)
        _n = {"i": 0}
        placed = {}
        def capture_place(fyers, ticker, side, qty):
            _n["i"] += 1
            oid = f"ORD{_n['i']:03d}"
            placed[ticker] = {"side": side, "qty": qty, "oid": oid}
            return oid
        self.engine._place_order = MagicMock(side_effect=capture_place)
        self._placed = placed

    def test_result_is_success(self):
        result = self.engine.run_rebalance()
        self.assertTrue(result.success, f"Expected success, got reason={result.reason}")

    def test_no_sell_orders_placed(self):
        self.engine.run_rebalance()
        sell_calls = [c for c in self.engine._place_order.call_args_list if c.kwargs.get("side") == -1]
        self.assertEqual(len(sell_calls), 0)

    def test_greedy_quantities(self):
        self.engine.run_rebalance()
        for ticker, expected_qty in self.EXPECTED_QTYS.items():
            actual = self._placed.get(ticker, {}).get("qty")
            self.assertEqual(
                actual, expected_qty,
                f"{ticker}: expected {expected_qty} shares, got {actual}",
            )

    def test_buy_budget_not_exceeded(self):
        self.engine.run_rebalance()
        total_cost = sum(
            self._placed[t]["qty"] * ALL_PRICES[t]
            for t in self._placed
        )
        buy_budget = 100_000 * (1 - CASH_BUFFER)
        self.assertLessEqual(total_cost, buy_budget + 1.0)  # +1 for float rounding

    def test_post_sell_cash_refresh_called(self):
        """_get_cash must be called twice: once at start, once after sells."""
        self.engine.run_rebalance()
        self.assertEqual(self.engine._get_cash.call_count, 2)

    def test_db_flush_called(self):
        self.engine.run_rebalance()
        self.engine._flush_holdings.assert_called_once()
        self.engine._flush_strategy.assert_called_once()
        self.engine._flush_portfolio.assert_called_once()


# ═══════════════════════════════════════════════════════════════════════════════
# 6.  run_rebalance — sells: exits + trims
# ═══════════════════════════════════════════════════════════════════════════════

class TestSellPhase(unittest.TestCase):
    """
    Existing holdings:
      - DD: 10 shares @ 149  (not in target [AA,BB,CC] → full exit)
      - AA: 500 shares @ 98  (in target, but way over pre-sell target qty → trim)

    We use capital=10_000 so that the working-capital sums to ~64k and the
    pre-sell target alloc per stock is ~21k, giving target_qty_AA = 212.
    This guarantees trim_qty = 500 - 212 = 288.

    Sell orders expected: DD(10 shares exit), AA(288 shares trim) — exits first.
    """
    TRIM_QTY = 288   # 500 - floor(working_capital/3 / 100), see class docstring

    def setUp(self):
        self.engine = _make_engine(
            n_stocks=3,
            capital=10_000,
            held={
                "DD": {"qty": 10,  "avg_price": 149.0},
                "AA": {"qty": 500, "avg_price": 98.0},
            },
        )
        self.engine._get_cash = MagicMock(side_effect=[10_000.0, 10_000.0])
        self.engine._compute_momentum = MagicMock(
            return_value=({"AA": 2.0, "BB": 1.8, "CC": 1.5, "DD": 1.2, "EE": 0.9}, ALL_PRICES)
        )
        self.engine._get_quotes = MagicMock(return_value=_flat_quotes())

        _n = {"i": 0}
        self._sell_calls = []
        self._buy_calls = []

        def capture(fyers, ticker, side, qty):
            _n["i"] += 1
            oid = f"ORD{_n['i']:03d}"
            if side == -1:
                self._sell_calls.append({"ticker": ticker, "qty": qty, "oid": oid})
            else:
                self._buy_calls.append({"ticker": ticker, "qty": qty, "oid": oid})
            return oid

        self.engine._place_order = MagicMock(side_effect=capture)

        def fills(fyers, order_ids):
            return {oid: {"filled_qty": 1, "traded_price": 100.0, "status": "filled"} for oid in order_ids}
        self.engine._wait_for_fills = MagicMock(side_effect=fills)

    def test_exit_order_placed_for_dd(self):
        self.engine.run_rebalance()
        sell_tickers = [c["ticker"] for c in self._sell_calls]
        self.assertIn("DD", sell_tickers)

    def test_trim_order_placed_for_aa(self):
        self.engine.run_rebalance()
        sell_tickers = [c["ticker"] for c in self._sell_calls]
        self.assertIn("AA", sell_tickers)

    def test_exit_placed_before_trim(self):
        """Exits (DD) must be placed before trims (AA)."""
        self.engine.run_rebalance()
        tickers_in_order = [c["ticker"] for c in self._sell_calls]
        # DD is the full exit
        dd_idx = tickers_in_order.index("DD") if "DD" in tickers_in_order else -1
        aa_idx = tickers_in_order.index("AA") if "AA" in tickers_in_order else -1
        self.assertGreater(aa_idx, dd_idx)

    def test_trim_quantity_correct(self):
        self.engine.run_rebalance()
        aa_sell = next((c for c in self._sell_calls if c["ticker"] == "AA"), None)
        self.assertIsNotNone(aa_sell, "Expected a trim sell for AA")
        self.assertEqual(aa_sell["qty"], self.TRIM_QTY)

    def test_sells_batched_then_waits(self):
        """All sell order IDs must be passed in a SINGLE _wait_for_fills call (not per-order)."""
        self.engine.run_rebalance()
        # First _wait_for_fills call is for sells; second (if any) is for buys.
        first_wait = self.engine._wait_for_fills.call_args_list[0]
        sell_ids_passed = first_wait.args[1]  # positional arg: (fyers, order_ids)
        # Both the exit (DD) and the trim (AA) should be in the same batch
        self.assertEqual(len(sell_ids_passed), 2,
                         f"Expected both sell orders in one batch, got IDs: {sell_ids_passed}")


# ═══════════════════════════════════════════════════════════════════════════════
# 7.  run_rebalance — UC at buy time is skipped gracefully
# ═══════════════════════════════════════════════════════════════════════════════

class TestUCAtBuyTime(unittest.TestCase):

    def test_uc_stock_skipped_from_buy(self):
        """A target stock that turns UC between analysis and buy should be skipped."""
        engine = _make_engine(n_stocks=3, held={})
        uc_quotes = _flat_quotes()
        # Make CC at upper circuit by buy time
        uc_quotes["CC"]["ltp"]     = uc_quotes["CC"]["upper_limit"]
        uc_quotes["CC"]["ask_qty"] = 0
        engine._get_quotes = MagicMock(return_value=uc_quotes)
        engine._get_cash = MagicMock(return_value=100_000.0)

        placed = []
        engine._place_order = MagicMock(side_effect=lambda f, t, side, qty: placed.append(t) or "OID")
        engine._wait_for_fills = MagicMock(return_value={})

        result = engine.run_rebalance()

        # Should still succeed (non-fatal; just skips CC)
        self.assertTrue(result.success)
        self.assertNotIn("CC", placed)


# ═══════════════════════════════════════════════════════════════════════════════
#  Entry point
# ═══════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    unittest.main(verbosity=2)
