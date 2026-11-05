# -*- coding: utf-8 -*-
"""审计回归：月度行情边界、重复日期和零金额币种。"""

import unittest

import pandas as pd

from application.budget.inputs import required_currencies
from core.budget import calculate_travel_budget
from core.standards import normalize_defaults_payload


def _standards():
    return (
        {"Home": {"CNY": 10.0}},
        {"Mainland": {"USD": 0.0, "CNY": 0.0}, "Overseas": {"USD": 0.0}},
        {},
        {"Home": {"currency": "CNY"}},
        {"CNY": 0.0, "HKD": 0.0, "USD": 0.0},
    )


class MonthlyBudgetHardeningTests(unittest.TestCase):
    def test_duplicate_itinerary_dates_are_supported_and_internal_rates_do_not_leak(self):
        itinerary = [
            {"date": "2026-01-01", "location": "Home", "is_travel": False},
            {"date": "2026-01-01", "location": "Home", "is_travel": False},
        ]
        result = calculate_travel_budget(
            itinerary, "Mainland", 2026, 1,
            resolved_standards=_standards(),
            rates_dict={"CNY": pd.Series([1.0], index=pd.to_datetime(["2026-01-01"]))},
        )
        self.assertEqual(result["daily_details"][0]["day_count"], 2)
        self.assertEqual(result["summary"]["总预算(人民币)"], 20.0)
        self.assertNotIn("rates_dict", result)

    def test_rate_series_cannot_be_backfilled_before_its_first_observation(self):
        with self.assertRaisesRegex(ValueError, "汇率不覆盖行程日"):
            calculate_travel_budget(
                [{"date": "2026-01-01", "location": "Home", "is_travel": False}],
                "Mainland", 2026, 1,
                resolved_standards=_standards(),
                rates_dict={"CNY": pd.Series([1.0], index=pd.to_datetime(["2026-01-02"]))},
            )

    def test_itinerary_dates_outside_requested_month_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "计算月份以外"):
            calculate_travel_budget(
                [{"date": "2026-02-01", "location": "Home", "is_travel": False}],
                "Mainland", 2026, 1,
                resolved_standards=_standards(),
                rates_dict={"CNY": pd.Series([1.0], index=pd.to_datetime(["2026-02-01"]))},
            )

    def test_zero_fixed_currency_is_not_requested(self):
        currencies = required_currencies(
            [{"date": "2026-01-01", "location": "Home", "is_travel": False}],
            "Mainland", _standards(),
        )
        self.assertEqual(currencies, ["CNY"])

    def test_unknown_extra_currency_is_rejected_instead_of_silently_dropped(self):
        with self.assertRaisesRegex(ValueError, "额外预算包含未知币种：EUR"):
            normalize_defaults_payload({
                "variable": {"Home": {"CNY": 10}},
                "fixed": {"Mainland": {"CNY": 1}, "Overseas": {"USD": 1}},
                "extra": {"EUR": 5},
                "travel": {},
            }, default_extra={"CNY": 0, "HKD": 0, "USD": 0})


if __name__ == "__main__":
    unittest.main()
