"""
tests/test_validation_errors.py
───────────────────────────────
Validation error handler tests.

Run:
    .\venv\Scripts\python.exe -m unittest tests.test_validation_errors -v
"""

from __future__ import annotations

import asyncio
import os
import sys
from datetime import date
from unittest import TestCase

from fastapi.exceptions import RequestValidationError
from pydantic import ValidationError

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from backend.main import validation_error_handler
from backend.schemas.strategy import DeployStrategyRequest


class TestValidationErrors(TestCase):
    def test_invalid_starting_date_returns_field_specific_message(self):
        try:
            DeployStrategyRequest(
                universe="nifty50",
                numStocks=10,
                lookback1=6,
                lookback2=12,
                priceCap=None,
                capital=500000,
                rebalanceType="monthly",
                rebalanceFreq=1,
                startingDate=date.today(),
            )
            self.fail("Expected validation error")
        except ValidationError as exc:
            request_exc = RequestValidationError(exc.errors())

        response = asyncio.run(validation_error_handler(None, request_exc))
        payload = response.body.decode()

        self.assertEqual(response.status_code, 400)
        self.assertIn('"success":false', payload.replace(' ', '').lower())
        self.assertIn('startingDate must be at least tomorrow', payload)
        self.assertIn('startingDate', payload)
