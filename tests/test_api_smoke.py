"""
tests/test_api_smoke.py
──────────────────────
Contract-level tests for frontend APIs without TestClient/httpx.

Run:
    .\\venv\\Scripts\\python.exe -m unittest tests.test_api_smoke -v
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
import os
import sys
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch
from uuid import uuid4

from fastapi import HTTPException

# Ensure project root is importable whether tests run from repo root or tests/.
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from backend.routers import portfolio as portfolio_router
from backend.routers.strategies import (
    DeployStrategyRequest,
    StrategyActionRequest,
    deploy_strategy,
    force_rebalance_now,
    rebalance_history,
    trigger_eod_mtm,
    trigger_live_price_refresh,
    strategy_action,
)
import unittest


class _FakeQuery:
    def __init__(self, *, all_result=None, first_result=None, scalar_result=None):
        self._all = all_result
        self._first = first_result
        self._scalar = scalar_result

    def filter(self, *args, **kwargs):
        return self

    def order_by(self, *args, **kwargs):
        return self

    def all(self):
        return self._all

    def first(self):
        return self._first

    def scalar(self):
        return self._scalar


class _FakeSession:
    def __init__(self, query_results):
        self._query_results = list(query_results)
        self.commit_called = False
        self.refresh_called = False
        self.flush_called = False
        self.added = []

    def query(self, *args, **kwargs):
        if not self._query_results:
            raise AssertionError("Unexpected db.query() call in test")
        return self._query_results.pop(0)

    def commit(self):
        self.commit_called = True

    def refresh(self, _obj):
        self.refresh_called = True

    def add(self, obj):
        self.added.append(obj)

    def flush(self):
        self.flush_called = True

    def rollback(self):
        self.rollback_called = True


class TestApiContract(TestCase):
    def setUp(self):
        self.user = SimpleNamespace(user_id=uuid4(), name="Your Name")

    def test_get_portfolio_contract(self):
        strategy = SimpleNamespace(
            strat_id=uuid4(),
            status="active",
            universe=50,
            n_stocks=10,
            price_cap=None,
            lb_period_1=6,
            lb_period_2=12,
            capital=500000,
            is_monthly=True,
            rebalance_freq=1,
            start_date=date(2024, 1, 15),
            next_rebalance_date=date(2025, 3, 1),
            market_value=531240,
            unused_capital=68500,
        )

        latest_price_date = date(2025, 2, 1)
        price_rows = [SimpleNamespace(ticker="RELIANCE", close=2587, daily_return=0.0112)]
        ticker_name_rows = [SimpleNamespace(ticker="RELIANCE", name="Reliance Industries")]
        holding_rows = [SimpleNamespace(ticker="RELIANCE", qty=120, avg_price=2410, last_price=2587)]
        last_done = SimpleNamespace(completed_at=datetime(2025, 2, 1, 12, 0, 0))

        fake_db = _FakeSession(
            [
                _FakeQuery(scalar_result=latest_price_date),
                _FakeQuery(all_result=price_rows),
                _FakeQuery(all_result=ticker_name_rows),
                _FakeQuery(all_result=holding_rows),
                _FakeQuery(first_result=last_done),
            ]
        )

        with patch("backend.routers.portfolio._pick_user_strategy", return_value=strategy):
            data = portfolio_router.get_portfolio(db=fake_db, user=self.user)

        self.assertTrue(data["strategyDeployed"])
        self.assertEqual(data["user"]["name"], "Your Name")
        self.assertEqual(data["strategy"]["status"], "active")
        self.assertEqual(data["strategy"]["universe"], "Nifty 50")
        self.assertEqual(data["strategy"]["numStocks"], 10)
        self.assertEqual(data["strategy"]["lookback1"], 6)
        self.assertEqual(data["strategy"]["lookback2"], 12)
        self.assertEqual(data["strategy"]["capital"], 500000.0)
        self.assertEqual(data["strategy"]["rebalanceType"], "monthly")
        self.assertEqual(data["strategy"]["frequency"], 1)
        self.assertEqual(data["strategy"]["startingDate"], "2024-01-15")
        self.assertEqual(data["strategy"]["lastRebalanced"], "2025-02-01")
        self.assertEqual(data["strategy"]["nextRebalance"], "2025-03-01")

        self.assertEqual(data["summary"]["currentValue"], 531240.0)
        self.assertEqual(data["summary"]["cash"], 68500.0)

        self.assertEqual(len(data["holdings"]), 1)
        h = data["holdings"][0]
        self.assertEqual(h["symbol"], "RELIANCE")
        self.assertEqual(h["name"], "Reliance Industries")
        self.assertEqual(h["qty"], 120)
        self.assertEqual(h["avgPrice"], 2410.0)
        self.assertEqual(h["ltp"], 2587.0)

    def test_chart_supports_extended_ranges(self):
        strategy = SimpleNamespace(strat_id=uuid4())
        chart_rows = [
            SimpleNamespace(date=date(2016, 1, 1), value=100000),
            SimpleNamespace(date=date(2023, 1, 1), value=250000),
            SimpleNamespace(date=date(2025, 1, 1), value=480000),
            SimpleNamespace(date=date(2026, 1, 1), value=510000),
        ]

        with patch("backend.routers.portfolio._pick_user_strategy", return_value=strategy):
            data_3y = portfolio_router.get_portfolio_chart(
                range="3Y",
                db=_FakeSession([_FakeQuery(all_result=chart_rows)]),
                user=self.user,
            )
            data_5y = portfolio_router.get_portfolio_chart(
                range="5Y",
                db=_FakeSession([_FakeQuery(all_result=chart_rows)]),
                user=self.user,
            )
            data_10y = portfolio_router.get_portfolio_chart(
                range="10Y",
                db=_FakeSession([_FakeQuery(all_result=chart_rows)]),
                user=self.user,
            )
            data_max = portfolio_router.get_portfolio_chart(
                range="max",
                db=_FakeSession([_FakeQuery(all_result=chart_rows)]),
                user=self.user,
            )

        self.assertEqual(len(data_max), 4)
        self.assertLessEqual(len(data_3y), len(data_5y))
        self.assertLessEqual(len(data_5y), len(data_10y))

    def test_strategy_action_pause(self):
        strategy = SimpleNamespace(status="active")
        fake_db = _FakeSession([_FakeQuery(first_result=strategy)])

        body = strategy_action(
            req=StrategyActionRequest(action="pause"),
            db=fake_db,
            user=self.user,
        )

        self.assertTrue(body["success"])
        self.assertEqual(body["status"], "paused")
        self.assertEqual(strategy.status, "paused")
        self.assertTrue(fake_db.commit_called)
        self.assertTrue(fake_db.refresh_called)

    def test_deploy_strategy_maps_parameters_and_prechecks_funds(self):
        broker_session = SimpleNamespace(id=uuid4())
        existing_strategy = SimpleNamespace(status="active")

        fake_db = _FakeSession([
            _FakeQuery(first_result=broker_session),
            _FakeQuery(all_result=[existing_strategy]),
        ])

        req = DeployStrategyRequest(
            universe="nifty50",
            numStocks=10,
            lookback1=6,
            lookback2=12,
            priceCap=None,
            capital=500000,
            rebalanceType="monthly",
            rebalanceFreq=1,
            startingDate=date.today() + timedelta(days=1),
        )

        with patch("backend.routers.strategies._get_available_balance", return_value=500000.0):
            body = deploy_strategy(req=req, db=fake_db, user=self.user)

        self.assertTrue(body["success"])
        self.assertEqual(body["status"], "active")
        self.assertEqual(existing_strategy.status, "stopped")
        self.assertTrue(fake_db.commit_called)
        self.assertTrue(fake_db.refresh_called)
        self.assertEqual(len(fake_db.added), 1)

        new_strategy = fake_db.added[0]

        self.assertEqual(new_strategy.universe, 50)
        self.assertEqual(new_strategy.n_stocks, 10)
        self.assertEqual(new_strategy.lb_period_1, 6)
        self.assertEqual(new_strategy.lb_period_2, 12)
        self.assertEqual(float(new_strategy.capital), 500000.0)
        self.assertEqual(float(new_strategy.unused_capital), 500000.0)
        self.assertEqual(new_strategy.is_monthly, True)
        self.assertEqual(new_strategy.rebalance_freq, 1)
        self.assertEqual(new_strategy.status, "active")
        self.assertEqual(new_strategy.start_date, date.today() + timedelta(days=1))
        self.assertEqual(new_strategy.next_rebalance_date, date.today() + timedelta(days=1))

    def test_deploy_strategy_rejects_balance_mismatch(self):
        broker_session = SimpleNamespace(id=uuid4())
        fake_db = _FakeSession([
            _FakeQuery(first_result=broker_session),
        ])

        req = DeployStrategyRequest(
            universe="nifty50",
            numStocks=10,
            lookback1=6,
            lookback2=12,
            priceCap=None,
            capital=500000,
            rebalanceType="monthly",
            rebalanceFreq=1,
            startingDate=date.today() + timedelta(days=1),
        )

        with patch("backend.routers.strategies._get_available_balance", return_value=499999.0):
            with self.assertRaises(HTTPException) as ctx:
                deploy_strategy(req=req, db=fake_db, user=self.user)

        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("exactly match deploy capital", ctx.exception.detail["message"])

    def test_rebalance_history_no_strategy(self):
        fake_db = _FakeSession([
            _FakeQuery(first_result=None),
        ])

        body = rebalance_history(db=fake_db, user=self.user)

        self.assertTrue(body["success"])
        self.assertFalse(body["strategyDeployed"])
        self.assertEqual(body["history"], [])

    def test_rebalance_history_returns_rows(self):
        strat_id = uuid4()
        strategy = SimpleNamespace(strat_id=strat_id)
        rows = [
            SimpleNamespace(
                id=uuid4(),
                status="done",
                reason=None,
                retry_count=0,
                queued_at=datetime(2026, 3, 20, 9, 0, 0),
                attempted_at=datetime(2026, 3, 20, 12, 0, 0),
                completed_at=datetime(2026, 3, 20, 12, 1, 0),
            ),
            SimpleNamespace(
                id=uuid4(),
                status="skipped",
                reason="LC_DETECTED",
                retry_count=1,
                queued_at=datetime(2026, 3, 13, 9, 0, 0),
                attempted_at=datetime(2026, 3, 13, 12, 0, 0),
                completed_at=None,
            ),
        ]
        fake_db = _FakeSession([
            _FakeQuery(first_result=strategy),
            _FakeQuery(all_result=rows),
        ])

        body = rebalance_history(db=fake_db, user=self.user)

        self.assertTrue(body["success"])
        self.assertTrue(body["strategyDeployed"])
        self.assertEqual(body["strategyId"], str(strat_id))
        self.assertEqual(len(body["history"]), 2)
        self.assertEqual(body["history"][0]["status"], "done")
        self.assertEqual(body["history"][1]["reason"], "LC_DETECTED")

    def test_force_rebalance_returns_done_status(self):
        strategy = SimpleNamespace(strat_id=uuid4(), status="active")
        in_progress = None
        queue_entry = SimpleNamespace(
            id=uuid4(),
            status="in_progress",
            reason=None,
            retry_count=0,
            completed_at=None,
        )

        fake_db = _FakeSession([
            _FakeQuery(first_result=strategy),
            _FakeQuery(first_result=in_progress),
        ])

        fake_result = SimpleNamespace(success=True, skipped=False, reason="", details={})
        fake_engine = SimpleNamespace(run_rebalance=lambda: fake_result)

        # refresh(entry) should keep the same object reference in fake flow
        def _refresh(obj):
            fake_db.refresh_called = True

        fake_db.refresh = _refresh

        with patch("backend.routers.strategies.settings.enable_testing_endpoints", True), patch(
            "backend.routers.strategies.RebalanceQueue", return_value=queue_entry
        ), patch(
            "backend.mat_engine.MATEngine", return_value=fake_engine
        ):
            body = force_rebalance_now(db=fake_db, user=self.user)

        self.assertTrue(body["success"])
        self.assertEqual(body["status"], "done")

    def test_testing_triggers_return_success(self):
        with patch("backend.routers.strategies.settings.enable_testing_endpoints", True), patch(
            "backend.scheduler.refresh_live_prices", return_value=None
        ):
            a = trigger_live_price_refresh(user=self.user)
        with patch("backend.routers.strategies.settings.enable_testing_endpoints", True), patch(
            "backend.scheduler.eod_mark_to_market", return_value=None
        ):
            b = trigger_eod_mtm(user=self.user)

        self.assertTrue(a["success"])
        self.assertTrue(b["success"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
