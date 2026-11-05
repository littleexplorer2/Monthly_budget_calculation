from application import state as state_api
from application.api import service as api_service
from application.budget import service as budget_service
from application.contracts import service as contracts_service
from application.lifecycle import service as lifecycle_service
from application.rates import service as rates_service
from application.state import service as state_service
import core.budget.annual as core_budget_annual
import core.rates as core_rates
import core.rates.cache as core_rates_cache
import core.rates.normalization as core_rates_normalization
# -*- coding: utf-8 -*-
"""全年预算、状态规范化与汇率缓存的后端回归测试。

测试用例只使用内存数据和 TemporaryDirectory，绝不写入项目 data/**/*.json。
导入生产模块时会执行其既有的只读默认值加载，但断言不依赖真实默认值内容。
"""
import datetime as real_datetime
import json
import math
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import pandas as pd



class _FixedDate(real_datetime.date):
    @classmethod
    def today(cls):
        return cls(2026, 9, 28)


class AnnualRateAlgorithmTests(unittest.TestCase):
    def test_close_series_uses_only_actual_close_observations(self):
        frame = pd.DataFrame(
            {"Open": [100.0, 150.0, 200.0], "Close": [1.0, 1.0, 10.0]},
            index=pd.to_datetime(["2026-01-02", "2026-01-05", "2026-02-03"]),
        )

        rates = core_rates_normalization._normalize_close_rate_frame(
            frame, "2026-01-01", "2026-12-31",
        )

        self.assertEqual(
            list(rates.index),
            list(pd.to_datetime(["2026-01-02", "2026-01-05", "2026-02-03"])),
        )
        self.assertEqual(rates.tolist(), [1.0, 1.0, 10.0])
        # 直接平均三个实际交易日为 4；不能把一月均值 1 与二月均值 10 再平均成 5.5。
        self.assertEqual(float(rates.mean()), 4.0)

    def test_close_series_does_not_fall_back_to_adjusted_close(self):
        frame = pd.DataFrame(
            {"Adj Close": [7.0]},
            index=pd.to_datetime(["2026-01-02"]),
        )
        self.assertIsNone(
            core_rates_normalization._normalize_close_rate_frame(frame, "2026-01-01", "2026-01-31")
        )

    def test_close_series_honors_year_and_as_of_boundaries(self):
        frame = pd.DataFrame(
            {"Close": [9.0, 1.0, 8.0]},
            index=pd.to_datetime(["2025-12-31", "2026-01-02", "2026-09-29"]),
        )
        rates = core_rates_normalization._normalize_close_rate_frame(
            frame, "2026-01-01", "2026-09-28",
        )
        self.assertEqual(list(rates.index), [pd.Timestamp("2026-01-02")])
        self.assertEqual(rates.tolist(), [1.0])
        self.assertIsNone(core_rates_normalization._normalize_close_rate_frame(
            pd.DataFrame(), "2026-01-01", "2026-09-28",
        ))

    def test_single_row_monthly_frame_keeps_its_date_index(self):
        frame = pd.DataFrame(
            {"Open": [2.0], "Close": [4.0]},
            index=pd.to_datetime(["2026-01-02"]),
        )

        rates = core_rates_normalization._normalize_rate_frame(
            frame, "2026-01-02", "2026-01-02", as_of="2026-01-02",
        )

        self.assertEqual(list(rates.index), list(pd.to_datetime(["2026-01-02"])))
        self.assertEqual(rates.tolist(), [3.0])

    def test_single_row_multiindex_close_keeps_date_and_uses_close(self):
        frame = pd.DataFrame(
            [[2.0, 4.0]],
            columns=pd.MultiIndex.from_tuples([
                ("Open", "USDCNY=X"), ("Close", "USDCNY=X"),
            ]),
            index=pd.to_datetime(["2026-01-02"]),
        )
        rates = core_rates_normalization._normalize_close_rate_frame(
            frame, "2026-01-01", "2026-01-31",
        )
        self.assertEqual(list(rates.index), [pd.Timestamp("2026-01-02")])
        self.assertEqual(rates.tolist(), [4.0])

    def test_cny_identity_is_not_counted_as_calendar_day_closes(self):
        rates = core_rates.get_historical_close_rates(
            ["CNY"], "2026-01-01", "2026-09-28",
        )["CNY"]
        self.assertEqual(len(rates), 1)
        self.assertEqual(rates.index[0], pd.Timestamp("2026-09-28"))
        self.assertEqual(float(rates.iloc[0]), 1.0)

    def test_budget_uses_unrounded_daily_close_average(self):
        series = pd.Series(
            [1.0000004, 1.0000006],
            index=pd.to_datetime(["2026-01-02", "2026-01-05"]),
        )
        stats = core_rates_normalization.annual_rate_stats({"USD": series}, ["USD"])
        raw_average = stats["USD"]["average"]

        result = core_budget_annual.calculate_annual_budget(
            {"USD": 1_000_000.0}, {"USD": raw_average},
        )

        self.assertTrue(math.isclose(raw_average, 1.0000005, rel_tol=0, abs_tol=1e-12))
        self.assertTrue(math.isclose(
            result["details"][0]["average_rate"], raw_average,
            rel_tol=0, abs_tol=1e-12,
        ))
        self.assertEqual(result["summary"]["全年预算合计(人民币)"], 1_000_000.5)

    def test_observed_through_excludes_cny_and_is_conservative(self):
        stats = {
            "CNY": {"last_date": "2026-09-28"},
            "USD": {"last_date": "2026-09-25"},
            "HKD": {"last_date": "2026-09-24"},
        }
        self.assertEqual(rates_service._annual_observed_through(stats), "2026-09-24")

    def test_budget_rejects_currency_keys_that_collide_after_normalization(self):
        with self.assertRaisesRegex(ValueError, "币种重复：USD"):
            core_budget_annual.calculate_annual_budget(
                {"usd": 1.0, "USD": 2.0}, {"USD": 7.0},
            )

    def test_total_is_the_sum_of_displayed_per_currency_amounts(self):
        result = core_budget_annual.calculate_annual_budget(
            {"USD": 1.0, "HKD": 1.0}, {"USD": 0.014, "HKD": 0.014},
        )
        detail_total = sum(row["cny_amount"] for row in result["details"])
        self.assertEqual([row["cny_amount"] for row in result["details"]], [0.01, 0.01])
        self.assertEqual(result["summary"]["全年预算合计(人民币)"], 0.02)
        self.assertEqual(detail_total, result["summary"]["全年预算合计(人民币)"])

    def test_budget_rejects_finite_inputs_whose_product_overflows(self):
        with self.assertRaisesRegex(ValueError, "换算结果超出有限数范围"):
            core_budget_annual.calculate_annual_budget(
                {"USD": 1e308},
                {"USD": 7.0},
            )

    def test_annual_bounds_stop_at_last_completed_day_and_reject_future_years(self):
        with mock.patch.object(contracts_service.dt, "date", _FixedDate):
            self.assertEqual(
                contracts_service._annual_bounds(2026),
                ("2026-01-01", "2026-09-27"),
            )
            self.assertEqual(
                contracts_service._annual_bounds(2025),
                ("2025-01-01", "2025-12-31"),
            )
            with self.assertRaisesRegex(ValueError, "未来年份"):
                contracts_service._annual_bounds(2027)

    def test_trailing_year_bounds_cover_exactly_365_calendar_days(self):
        with mock.patch.object(contracts_service.dt, "date", _FixedDate):
            start, end = contracts_service._trailing_year_bounds()
        self.assertEqual((start, end), ("2025-09-28", "2026-09-27"))
        self.assertEqual(
            (real_datetime.date.fromisoformat(end) - real_datetime.date.fromisoformat(start)).days + 1,
            365,
        )

    def test_failed_force_refresh_preserves_last_valid_annual_close_cache(self):
        key = core_rates_cache._rates_cache_key(
            "ZZZ", "2026-01-01", "2026-09-28", "daily_close",
        )
        old = pd.Series([1.0], index=pd.to_datetime(["2026-01-02"]))
        with core_rates_cache._RATES_CACHE_LOCK:
            core_rates_cache._RATES_CACHE[key] = (real_datetime.datetime.now().timestamp(), old)
        try:
            with self.assertRaisesRegex(ValueError, "refresh failed"):
                core_rates_cache._get_historical_rates_cached(
                    ["ZZZ"], "2026-01-01", "2026-09-28",
                    fetcher=mock.Mock(side_effect=ValueError("refresh failed")),
                    rate_kind="daily_close", force=True,
                )
            with core_rates_cache._RATES_CACHE_LOCK:
                self.assertIs(core_rates_cache._RATES_CACHE[key][1], old)
                self.assertNotIn(key, core_rates_cache._RATES_CACHE_REFRESHING)

            fetch = mock.Mock()
            result = core_rates_cache._get_historical_rates_cached(
                ["ZZZ"], "2026-01-01", "2026-09-28",
                fetcher=fetch, rate_kind="daily_close",
            )
            fetch.assert_not_called()
            self.assertEqual(float(result["ZZZ"].iloc[0]), 1.0)
        finally:
            with core_rates_cache._RATES_CACHE_LOCK:
                core_rates_cache._RATES_CACHE.pop(key, None)
                core_rates_cache._RATES_CACHE_REFRESHING.pop(key, None)
                core_rates_cache._RATES_CACHE_KEY_LOCKS.pop(key, None)


class AnnualStateTests(unittest.TestCase):
    def test_annual_state_is_normalized_and_raw_series_are_removed(self):
        state = state_service._normalize_app_state({
            "annualBudgetsByYear": {
                "2026": {"usd": 12, "HKD": 3.5},
            },
            "annualResultsByYear": {
                "2026": {
                    "summary": {"全年预算合计(人民币)": 12.0},
                    "details": [{
                        "currency": "USD", "amount": 2.0,
                        "average_rate": 6.0, "cny_amount": 12.0,
                    }],
                    "errors": {},
                    "series": [1, 2, 3],
                },
            },
        })

        self.assertEqual(
            state["annualBudgetsByYear"],
            {"2026": {"USD": 12.0, "HKD": 3.5}},
        )
        self.assertEqual(
            state["annualResultsByYear"],
            {"2026": {
                "summary": {"全年预算合计(人民币)": 12.0},
                "details": [{
                    "currency": "USD", "amount": 2.0,
                    "average_rate": 6.0, "cny_amount": 12.0,
                }],
                "errors": {},
            }},
        )

    def test_invalid_annual_state_is_rejected_with_its_field_path(self):
        invalid_payloads = [
            ({"annualBudgetsByYear": {"1999": {"USD": 1}}}, "年份无效"),
            ({"annualBudgetsByYear": {"2026": {"BAD-KEY": 1}}}, "币种代码无效"),
            ({"annualBudgetsByYear": {"2026": {"EUR": True}}}, "2026.EUR"),
            ({"annualResultsByYear": {"9999": {"summary": {}}}}, "年份无效"),
            ({"annualResultsByYear": {"2026": {}}}, "不能是空结果"),
            ({"annualResultsByYear": {"2026": {
                "summary": {"全年预算合计(人民币)": 1}, "details": {},
            }}}, "details 必须是数组"),
            ({"annualResultsByYear": {"2026": {
                "summary": {"全年预算合计(人民币)": 1},
                "details": [{"currency": "USD", "amount": 1,
                             "average_rate": 1, "cny_amount": float("nan")}],
            }}}, "cny_amount"),
            ({"annualResultsByYear": {"2026": {
                "year": 2025,
                "summary": {"全年预算合计(人民币)": 1},
                "details": [{"currency": "USD", "amount": 1,
                             "average_rate": 1, "cny_amount": 1}],
            }}}, "year 必须与外层年份一致"),
            ({"annualResultsByYear": {"2026": {
                "summary": {"全年预算合计(人民币)": 2},
                "details": [{"currency": "USD", "amount": 1,
                             "average_rate": 1, "cny_amount": 1}],
            }}}, "与明细合计不一致"),
            ({"annualResultsByYear": {"2026": {
                "summary": {"全年预算合计(人民币)": 2},
                "details": [{"currency": "USD", "amount": 1,
                             "average_rate": 1, "cny_amount": 2}],
            }}}, "与金额乘年平均汇率不一致"),
            ({"annualResultsByYear": {"2026": {
                "summary": {"全年预算合计(人民币)": 1},
                "details": [{"currency": "USD", "amount": 1,
                             "average_rate": 1, "cny_amount": 1,
                             "observation_count": -1}],
            }}}, "observation_count"),
            ({"annualResultsByYear": {"2026": {
                "price_field": "Open",
                "summary": {"全年预算合计(人民币)": 1},
                "details": [{"currency": "USD", "amount": 1,
                             "average_rate": 1, "cny_amount": 1}],
            }}}, "price_field"),
        ]
        for payload, message in invalid_payloads:
            with self.subTest(payload=payload):
                with self.assertRaisesRegex(ValueError, message):
                    state_service._normalize_app_state(payload)

    def test_missing_annual_fields_are_backward_compatible(self):
        state = state_service._normalize_app_state({"version": 1})
        self.assertEqual(state["annualBudgetsByYear"], {})
        self.assertEqual(state["annualResultsByYear"], {})

    def test_non_object_app_state_is_rejected_but_missing_file_is_empty(self):
        self.assertEqual(state_service._normalize_app_state(None), state_service._empty_app_state())
        with self.assertRaisesRegex(ValueError, "根节点必须是对象"):
            state_service._normalize_app_state([])

    def test_corrupt_selection_and_map_fields_are_not_silently_discarded(self):
        invalid_payloads = [
            ({"year": True}, "app-state.year"),
            ({"year": 1999}, "app-state.year"),
            ({"month": 13}, "app-state.month"),
            ({"resultsByMonth": []}, "app-state.resultsByMonth"),
            ({"annualBudgetsByYear": []}, "app-state.annualBudgetsByYear"),
            ({"itineraryByMonth": {"2026-13": {}}}, "itineraryByMonth 月份无效"),
            ({"optionsByMonth": {"2026-00": {}}}, "optionsByMonth 月份无效"),
            ({"overridesByMonth": {"not-a-month": {}}}, "overridesByMonth 月份无效"),
            ({"resultsByMonth": {"2026-1": {}}}, "resultsByMonth 月份无效"),
            ({"optionsByMonth": {"2026-09": []}}, "optionsByMonth.2026-09 必须是对象"),
        ]
        for payload, message in invalid_payloads:
            with self.subTest(payload=payload):
                with self.assertRaisesRegex(ValueError, message):
                    state_service._normalize_app_state(payload)

    def test_unregister_forwards_v2_entity_bundle(self):
        tab_id = "tab-unregister-sequence"
        final_bundle = {
            "schemaVersion": 2,
            "months": [{"month": "2026-09", "base_revision": 3, "data": {}}],
        }
        body = contracts_service.TabRegisterIn(
            tab_id=tab_id,
            state=final_bundle,
        )
        with (
            mock.patch.object(lifecycle_service, "_open_tabs", {tab_id: 1.0}),
            mock.patch.object(lifecycle_service, "AUTO_SHUTDOWN_ENABLED", False),
            mock.patch.object(lifecycle_service, "_cancel_tab_expiry_timer_locked"),
            mock.patch.object(
                state_api, "save_final_bundle", return_value={"saved": ["2026-09"], "conflicts": []},
            ) as save_state,
        ):
            self.assertEqual(lifecycle_service.api_tabs_unregister(body), {"open_tabs": 0})
        save_state.assert_called_once_with(final_bundle, allow_partial_conflicts=True)

class MonthlyRateCacheTests(unittest.TestCase):
    def test_rate_month_listing_hides_invalid_and_future_cache_names(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for name in ("2026-09.json", "2026-10.json", "2026-13.json", "not-a-month.json"):
                (root / name).write_text("{}", encoding="utf-8")
            with (
                mock.patch.object(rates_service, "RATES_DATA_DIR", root),
                mock.patch.object(rates_service.dt, "date", _FixedDate),
            ):
                self.assertEqual(rates_service._list_rate_months(), ["2026-09"])

    def test_current_month_memory_cache_expires_at_calendar_day_rollover(self):
        fetched_at = real_datetime.datetime(2026, 9, 27, 23, 59).timestamp()
        cached = (fetched_at, pd.Series([7.0], index=pd.to_datetime(["2026-09-27"])))
        now = real_datetime.datetime(2026, 9, 28, 0, 5).timestamp()
        with mock.patch.object(core_rates_cache.datetime, "date", _FixedDate):
            self.assertFalse(core_rates_cache._cached_rate_is_fresh(
                cached, "2026-09-30", "monthly", ttl=3600, now=now,
            ))
            self.assertTrue(core_rates_cache._cached_rate_is_fresh(
                cached, "2026-08-31", "monthly", ttl=3600, now=now,
            ))

    def test_freshness_rejects_partial_historical_and_stale_current_cache(self):
        with mock.patch.object(contracts_service.dt, "date", _FixedDate):
            partial_history = {"USD": {"2026-08-01": 7.0, "2026-08-20": 7.1}}
            wrong_month_tail = {"USD": {"2026-08-01": 7.0, "2026-09-01": 7.1}}
            missing_month_start = {"USD": {"2026-08-02": 7.0, "2026-08-31": 7.1}}
            full_history = {"USD": {"2026-08-01": 7.0, "2026-08-31": 7.1}}
            schema_history = {
                "USD": {
                    day.strftime("%Y-%m-%d"): 7.0
                    for day in pd.date_range("2026-08-01", "2026-08-31")
                },
                "_meta": {
                    "schema": 1,
                    "rate_kind": "monthly_open_close_estimate",
                    "currency_refreshed_on": {"USD": "2026-08-31"},
                },
            }
            schema_history_missing_middle = json.loads(json.dumps(schema_history))
            del schema_history_missing_middle["USD"]["2026-08-14"]
            stale_current = {"USD": {"2026-09-01": 7.0, "2026-09-23": 7.1}}
            full_current_values = {
                day.strftime("%Y-%m-%d"): 7.0
                for day in pd.date_range("2026-09-01", "2026-09-28")
            }
            fresh_current = {
                "USD": full_current_values,
                "_meta": {
                    "schema": 1,
                    "rate_kind": "monthly_open_close_estimate",
                    "currency_refreshed_on": {"USD": "2026-09-28"},
                },
            }
            missing_middle = json.loads(json.dumps(fresh_current))
            del missing_middle["USD"]["2026-09-14"]
            wrong_kind = {
                "USD": {"2026-08-01": 7.0, "2026-08-31": 7.1},
                "_meta": {"schema": 1, "rate_kind": "daily_close"},
            }

            self.assertFalse(rates_service._disk_currency_cache_is_fresh(
                partial_history, "USD", 2026, 8,
            ))
            self.assertFalse(rates_service._disk_currency_cache_is_fresh(
                wrong_month_tail, "USD", 2026, 8,
            ))
            self.assertFalse(rates_service._disk_currency_cache_is_fresh(
                missing_month_start, "USD", 2026, 8,
            ))
            self.assertFalse(rates_service._disk_currency_cache_is_fresh(
                full_history, "USD", 2026, 8,
            ))
            self.assertTrue(rates_service._disk_currency_cache_is_fresh(
                schema_history, "USD", 2026, 8,
            ))
            self.assertFalse(rates_service._disk_currency_cache_is_fresh(
                schema_history_missing_middle, "USD", 2026, 8,
            ))
            self.assertFalse(rates_service._disk_currency_cache_is_fresh(
                stale_current, "USD", 2026, 9,
            ))
            self.assertTrue(rates_service._disk_currency_cache_is_fresh(
                fresh_current, "USD", 2026, 9,
            ))
            self.assertFalse(rates_service._disk_currency_cache_is_fresh(
                missing_middle, "USD", 2026, 9,
            ))
            self.assertFalse(rates_service._disk_currency_cache_is_fresh(
                wrong_kind, "USD", 2026, 8,
            ))

    def test_saving_refreshed_subset_preserves_other_cached_currencies(self):
        with tempfile.TemporaryDirectory() as temp:
            rates_dir = Path(temp) / "rates"
            rates_dir.mkdir()
            path = rates_dir / "2026-09.json"
            path.write_text(json.dumps({
                "HKD": {"2026-09-28": 0.86},
                "_meta": {"currency_refreshed_on": {"HKD": "2026-09-28"}},
            }), encoding="utf-8")
            usd = pd.Series(
                [7.0], index=pd.to_datetime(["2026-09-28"]),
            )

            with (
                mock.patch.object(rates_service, "RATES_DATA_DIR", rates_dir),
                mock.patch.object(contracts_service.dt, "date", _FixedDate),
            ):
                rates_service._save_rates_month_file(2026, 9, {"USD": usd})

            saved = json.loads(path.read_text(encoding="utf-8"))
            self.assertIn("HKD", saved)
            self.assertIn("USD", saved)
            self.assertEqual(
                saved["_meta"]["currency_refreshed_on"],
                {"HKD": "2026-09-28", "USD": "2026-09-28"},
            )

    def test_corrupt_currency_entry_is_refetched_instead_of_returning_bad_request(self):
        disk_data = {
            "USD": {
                "2026-09-01": "not-a-number",
                "2026-09-28": "still-not-a-number",
            },
            "_meta": {
                "schema": 1,
                "rate_kind": "monthly_open_close_estimate",
                "currency_refreshed_on": {"USD": "2026-09-28"},
            },
        }
        downloaded = pd.Series(
            7.0, index=pd.date_range("2026-09-01", "2026-09-30"),
        )
        with (
            mock.patch.object(contracts_service.dt, "date", _FixedDate),
            mock.patch.object(core_rates, "get_rates_from_cache", return_value={}),
            mock.patch.object(rates_service, "_load_rates_month_file", return_value=disk_data),
            mock.patch.object(core_rates, "get_historical_rates_cached", return_value={"USD": downloaded},
            ) as fetch,
            mock.patch.object(rates_service, "_save_rates_month_file"),
        ):
            result = rates_service._fetch_rates_parallel(
                ["USD"], "2026-09-01", "2026-09-30", max_workers=1,
            )

        fetch.assert_called_once()
        self.assertEqual(float(result["USD"].iloc[0]), 7.0)


class ItineraryValidationTests(unittest.TestCase):
    def test_two_locations_cannot_claim_the_same_day(self):
        entries = [
            contracts_service.ItineraryEntryIn(
                location="A",
                ranges=[contracts_service.RangeIn(start="2026-09-01", end="2026-09-01")],
            ),
            contracts_service.ItineraryEntryIn(
                location="B",
                ranges=[contracts_service.RangeIn(start="2026-09-01", end="2026-09-01")],
            ),
        ]
        registry = {
            "A": {"type": "variable", "currency": "CNY"},
            "B": {"type": "variable", "currency": "CNY"},
        }

        with self.assertRaisesRegex(ValueError, "同一天只能属于一个地点"):
            budget_service._expand_itinerary(entries, 2026, 9, registry)


class RouteRegistrationTests(unittest.TestCase):
    def test_annual_routes_are_registered_before_static_mount(self):
        routes = list(api_service.app.routes)
        annual_rates = next(i for i, route in enumerate(routes)
                            if getattr(route, "path", None) == "/api/annual-rates")
        annual_budget = next(i for i, route in enumerate(routes)
                             if getattr(route, "path", None) == "/api/annual-budget")
        static_mount = next(i for i, route in enumerate(routes)
                            if getattr(route, "name", None) == "web")
        self.assertLess(annual_rates, static_mount)
        self.assertLess(annual_budget, static_mount)


if __name__ == "__main__":
    unittest.main()
