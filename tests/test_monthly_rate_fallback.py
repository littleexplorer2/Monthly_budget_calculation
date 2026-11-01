import datetime as dt
import unittest
from unittest import mock

import pandas as pd

from application.contracts import RateFetchError
from application.metadata import sort_currencies
from application.rates import service as rates_service


class MonthlyRateFallbackTests(unittest.TestCase):
    @staticmethod
    def series(values, start="2026-10-01"):
        return pd.Series(values, index=pd.date_range(start, periods=len(values)), dtype="float64")

    def test_current_month_day_one_uses_previous_month_average(self):
        previous = {
            "CNY": self.series([1.0, 1.0]),
            "USD": self.series([7.0, 9.0]),
        }
        with mock.patch.object(
            rates_service,
            "_fetch_rates_parallel",
            side_effect=[RateFetchError("本月没有行情"), previous],
        ) as fetch:
            rates, source = rates_service._fetch_budget_rates(
                ["CNY", "USD"], 2026, 11, today=dt.date(2026, 11, 1),
            )

        self.assertEqual(fetch.call_args_list, [
            mock.call(["CNY", "USD"], "2026-11-01", "2026-11-30"),
            mock.call(["CNY", "USD"], "2026-10-01", "2026-10-31"),
        ])
        self.assertEqual(len(rates["USD"]), 30)
        self.assertTrue((rates["USD"] == 8.0).all())
        self.assertTrue((rates["CNY"] == 1.0).all())
        self.assertEqual(source["kind"], "previous_month_average")
        self.assertEqual(source["source_month"], "2026-10")
        self.assertEqual(source["averages"], {"CNY": 1.0, "USD": 8.0})

    def test_existing_current_month_rates_never_use_fallback(self):
        current = {"USD": self.series([7.25], start="2026-11-01")}
        with mock.patch.object(
            rates_service, "_fetch_rates_parallel", return_value=current,
        ) as fetch:
            rates, source = rates_service._fetch_budget_rates(
                ["USD"], 2026, 11, today=dt.date(2026, 11, 1),
            )

        self.assertIs(rates, current)
        self.assertFalse(source["fallback"])
        fetch.assert_called_once_with(["USD"], "2026-11-01", "2026-11-30")

    def test_january_fallback_reads_previous_december(self):
        previous = {"USD": self.series([7.0], start="2026-12-31")}
        with mock.patch.object(
            rates_service.app_contracts, "validate_year_month",
        ), mock.patch.object(
            rates_service,
            "_fetch_rates_parallel",
            side_effect=[RateFetchError("本月没有行情"), previous],
        ) as fetch:
            rates, source = rates_service._fetch_budget_rates(
                ["USD"], 2027, 1, today=dt.date(2027, 1, 1),
            )

        self.assertEqual(fetch.call_args_list[1], mock.call(
            ["USD"], "2026-12-01", "2026-12-31",
        ))
        self.assertEqual(len(rates["USD"]), 31)
        self.assertEqual(source["source_month"], "2026-12")

    def test_other_days_and_other_months_keep_original_failure(self):
        for requested, today in (
            ((2026, 11), dt.date(2026, 11, 2)),
            ((2026, 10), dt.date(2026, 11, 1)),
        ):
            with self.subTest(requested=requested, today=today):
                original = RateFetchError("本月没有行情")
                with mock.patch.object(
                    rates_service, "_fetch_rates_parallel", side_effect=original,
                ) as fetch:
                    with self.assertRaisesRegex(RateFetchError, "本月没有行情"):
                        rates_service._fetch_budget_rates(
                            ["USD"], *requested, today=today,
                        )
                self.assertEqual(fetch.call_count, 1)

    def test_previous_month_failure_reports_both_attempts(self):
        with mock.patch.object(
            rates_service,
            "_fetch_rates_parallel",
            side_effect=[RateFetchError("本月没有行情"), RateFetchError("上月也不可用")],
        ):
            with self.assertRaisesRegex(
                RateFetchError,
                "本月没有行情.*2026-10 月平均汇率回退失败.*上月也不可用",
            ):
                rates_service._fetch_budget_rates(
                    ["USD"], 2026, 11, today=dt.date(2026, 11, 1),
                )


class CurrencyOrderTests(unittest.TestCase):
    def test_priority_currencies_precede_alphabetical_remainder(self):
        self.assertEqual(
            sort_currencies(["EUR", "usd", "CNY", "AUD", "HKD", "EUR"]),
            ["CNY", "HKD", "USD", "AUD", "EUR"],
        )


if __name__ == "__main__":
    unittest.main()
