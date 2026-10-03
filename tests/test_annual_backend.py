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

import functions
import main_web


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

        rates = functions._normalize_close_rate_frame(
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
            functions._normalize_close_rate_frame(frame, "2026-01-01", "2026-01-31")
        )

    def test_close_series_honors_year_and_as_of_boundaries(self):
        frame = pd.DataFrame(
            {"Close": [9.0, 1.0, 8.0]},
            index=pd.to_datetime(["2025-12-31", "2026-01-02", "2026-09-29"]),
        )
        rates = functions._normalize_close_rate_frame(
            frame, "2026-01-01", "2026-09-28",
        )
        self.assertEqual(list(rates.index), [pd.Timestamp("2026-01-02")])
        self.assertEqual(rates.tolist(), [1.0])
        self.assertIsNone(functions._normalize_close_rate_frame(
            pd.DataFrame(), "2026-01-01", "2026-09-28",
        ))

    def test_single_row_monthly_frame_keeps_its_date_index(self):
        frame = pd.DataFrame(
            {"Open": [2.0], "Close": [4.0]},
            index=pd.to_datetime(["2026-01-02"]),
        )

        rates = functions._normalize_rate_frame(frame, "2026-01-02", "2026-01-02")

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
        rates = functions._normalize_close_rate_frame(
            frame, "2026-01-01", "2026-01-31",
        )
        self.assertEqual(list(rates.index), [pd.Timestamp("2026-01-02")])
        self.assertEqual(rates.tolist(), [4.0])

    def test_cny_identity_is_not_counted_as_calendar_day_closes(self):
        rates = functions.get_historical_close_rates(
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
        stats = functions.annual_rate_stats({"USD": series}, ["USD"])
        raw_average = stats["USD"]["average"]

        result = functions.calculate_annual_budget(
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
        self.assertEqual(main_web._annual_observed_through(stats), "2026-09-24")

    def test_budget_rejects_currency_keys_that_collide_after_normalization(self):
        with self.assertRaisesRegex(ValueError, "币种重复：USD"):
            functions.calculate_annual_budget(
                {"usd": 1.0, "USD": 2.0}, {"USD": 7.0},
            )

    def test_total_is_the_sum_of_displayed_per_currency_amounts(self):
        result = functions.calculate_annual_budget(
            {"USD": 1.0, "HKD": 1.0}, {"USD": 0.014, "HKD": 0.014},
        )
        detail_total = sum(row["cny_amount"] for row in result["details"])
        self.assertEqual([row["cny_amount"] for row in result["details"]], [0.01, 0.01])
        self.assertEqual(result["summary"]["全年预算合计(人民币)"], 0.02)
        self.assertEqual(detail_total, result["summary"]["全年预算合计(人民币)"])

    def test_budget_rejects_finite_inputs_whose_product_overflows(self):
        with self.assertRaisesRegex(ValueError, "换算结果超出有限数范围"):
            functions.calculate_annual_budget(
                {"USD": 1e308},
                {"USD": 7.0},
            )

    def test_annual_bounds_stop_at_today_and_reject_future_years(self):
        with mock.patch.object(main_web.dt, "date", _FixedDate):
            self.assertEqual(
                main_web._annual_bounds(2026),
                ("2026-01-01", "2026-09-28"),
            )
            self.assertEqual(
                main_web._annual_bounds(2025),
                ("2025-01-01", "2025-12-31"),
            )
            with self.assertRaisesRegex(ValueError, "未来年份"):
                main_web._annual_bounds(2027)

    def test_failed_force_refresh_evicts_old_annual_close_cache(self):
        key = functions._rates_cache_key(
            "ZZZ", "2026-01-01", "2026-09-28", "daily_close",
        )
        old = pd.Series([1.0], index=pd.to_datetime(["2026-01-02"]))
        fresh = pd.Series([2.0], index=pd.to_datetime(["2026-01-02"]))
        with functions._RATES_CACHE_LOCK:
            functions._RATES_CACHE[key] = (real_datetime.datetime.now().timestamp(), old)
        try:
            with self.assertRaisesRegex(ValueError, "refresh failed"):
                functions._get_historical_rates_cached(
                    ["ZZZ"], "2026-01-01", "2026-09-28",
                    fetcher=mock.Mock(side_effect=ValueError("refresh failed")),
                    rate_kind="daily_close", force=True,
                )
            with functions._RATES_CACHE_LOCK:
                self.assertNotIn(key, functions._RATES_CACHE)
                self.assertNotIn(key, functions._RATES_CACHE_REFRESHING)

            fetch = mock.Mock(return_value={"ZZZ": fresh})
            result = functions._get_historical_rates_cached(
                ["ZZZ"], "2026-01-01", "2026-09-28",
                fetcher=fetch, rate_kind="daily_close",
            )
            fetch.assert_called_once()
            self.assertEqual(float(result["ZZZ"].iloc[0]), 2.0)
        finally:
            with functions._RATES_CACHE_LOCK:
                functions._RATES_CACHE.pop(key, None)
                functions._RATES_CACHE_REFRESHING.pop(key, None)
                functions._RATES_CACHE_KEY_LOCKS.pop(key, None)


class AnnualStateTests(unittest.TestCase):
    def test_annual_state_is_normalized_and_raw_series_are_removed(self):
        state = main_web._normalize_app_state({
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
                    main_web._normalize_app_state(payload)

    def test_missing_annual_fields_are_backward_compatible(self):
        state = main_web._normalize_app_state({"version": 1})
        self.assertEqual(state["annualBudgetsByYear"], {})
        self.assertEqual(state["annualResultsByYear"], {})

    def test_non_object_app_state_is_rejected_but_missing_file_is_empty(self):
        self.assertEqual(main_web._normalize_app_state(None), main_web._empty_app_state())
        with self.assertRaisesRegex(ValueError, "根节点必须是对象"):
            main_web._normalize_app_state([])

    def test_corrupt_selection_and_map_fields_are_not_silently_discarded(self):
        invalid_payloads = [
            ({"year": True}, "app-state.year"),
            ({"year": 1999}, "app-state.year"),
            ({"month": 13}, "app-state.month"),
            ({"resultsByMonth": []}, "app-state.resultsByMonth"),
            ({"annualBudgetsByYear": []}, "app-state.annualBudgetsByYear"),
        ]
        for payload, message in invalid_payloads:
            with self.subTest(payload=payload):
                with self.assertRaisesRegex(ValueError, message):
                    main_web._normalize_app_state(payload)

    def test_existing_but_corrupt_app_state_is_not_silently_treated_as_empty(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "app-state.json"
            path.write_text("{not-json", encoding="utf-8")
            with mock.patch.object(main_web, "APP_STATE_FILE", path):
                with self.assertRaisesRegex(ValueError, "JSON 文件无法读取或已损坏"):
                    main_web._read_app_state_file()

    def test_annual_empty_object_is_a_merge_tombstone(self):
        annual_result = {
            "summary": {"全年预算合计(人民币)": 7.0},
            "details": [{
                "currency": "USD", "amount": 1.0,
                "average_rate": 7.0, "cny_amount": 7.0,
            }],
        }
        disk = {
            "annualBudgetsByYear": {"2026": {"USD": 1.0}, "2025": {"USD": 2.0}},
            "annualResultsByYear": {"2026": annual_result, "2025": annual_result},
        }
        merged = main_web._merge_app_state(disk, {
            "annualBudgetsByYear": {"2026": {}},
            "annualResultsByYear": {"2026": {}},
        })
        self.assertNotIn("2026", merged["annualBudgetsByYear"])
        self.assertNotIn("2026", merged["annualResultsByYear"])
        self.assertIn("2025", merged["annualBudgetsByYear"])
        self.assertIn("2025", merged["annualResultsByYear"])

        replaced = main_web._merge_app_state(disk, {
            "annualBudgetsByYear": {"2026": {}},
            "annualResultsByYear": {"2026": {}},
        }, replace=True)
        self.assertEqual(replaced["annualBudgetsByYear"], {})
        self.assertEqual(replaced["annualResultsByYear"], {})

    def test_state_patch_rejects_stale_same_key_but_allows_other_month(self):
        disk = main_web._normalize_app_state({
            "itineraryByMonth": {
                "2026-01": {"A": [{"start": "2026-01-01", "end": "2026-01-01"}]},
                "2026-02": {"B": [{"start": "2026-02-01", "end": "2026-02-01"}]},
            },
        })
        stale_january = {
            "itineraryByMonth": {
                "2026-01": {
                    "exists": True,
                    "value": {"A": [{"start": "2026-01-02", "end": "2026-01-02"}]},
                },
            },
        }
        with self.assertRaisesRegex(main_web.StateConflictError, "2026-01"):
            main_web._assert_state_patch_base(disk, stale_january)

        current_february = {
            "itineraryByMonth": {
                "2026-02": {
                    "exists": True,
                    "value": disk["itineraryByMonth"]["2026-02"],
                },
            },
        }
        main_web._assert_state_patch_base(disk, current_february)

    def test_state_year_and_month_must_be_updated_as_a_pair(self):
        with self.assertRaisesRegex(ValueError, "必须成对提交"):
            main_web._merge_app_state({}, {"year": 2026})
        with self.assertRaisesRegex(ValueError, "必须成对提交"):
            main_web._merge_app_state({}, {"month": 9})

    def test_state_patch_requires_base_marker_for_every_written_key(self):
        disk = main_web._normalize_app_state({
            "year": 2026,
            "month": 9,
            "resultsByMonth": {"2026-09": {"summary": {"total": 1}}},
        })
        year_marker = {"exists": True, "value": 2026}
        month_marker = {"exists": True, "value": 9}

        with self.assertRaisesRegex(ValueError, "baseValues.year.*month.*成对提交"):
            main_web._assert_state_patch_base(
                disk,
                {"year": year_marker},
                {"year": 2026, "month": 10},
            )
        with self.assertRaisesRegex(ValueError, "baseValues.*resultsByMonth.*2026-09"):
            main_web._assert_state_patch_base(
                disk,
                {},
                {"resultsByMonth": {"2026-09": {"summary": {"total": 2}}}},
            )

        # 完整 marker 可通过；完全不提供 baseValues 的旧客户端仍保持兼容。
        main_web._assert_state_patch_base(
            disk,
            {"year": year_marker, "month": month_marker},
            {"year": 2026, "month": 10},
        )
        main_web._assert_state_patch_base(
            disk,
            None,
            {"resultsByMonth": {"2026-09": {"summary": {"total": 2}}}},
        )

    def test_late_older_sequence_cannot_overwrite_final_same_tab_state(self):
        month = "2026-09"
        tab_id = "tab-reverse-arrival"
        old_result = {"summary": {"total": 1}}
        stale_result = {"summary": {"total": 2}}
        base_values = {
            "resultsByMonth": {
                month: {"exists": True, "value": old_result},
            },
        }
        disk = main_web._normalize_app_state({
            "year": 2026,
            "month": 9,
            "resultsByMonth": {month: old_result},
        })

        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "app-state.json"
            path.write_text(json.dumps(disk, ensure_ascii=False), encoding="utf-8")
            try:
                with mock.patch.object(main_web, "APP_STATE_FILE", path):
                    # 最终请求（序号 2）先到。它显式确认最终值仍为基线 1；
                    # 若没有同 tab 序号保护，随后到达的旧请求仍会通过 value CAS。
                    final = main_web._save_app_state(
                        {"resultsByMonth": {month: old_result}},
                        base_values=base_values,
                        tab_id=tab_id,
                        sequence=2,
                    )
                    self.assertEqual(
                        final["resultsByMonth"][month]["summary"]["total"], 1,
                    )

                    late = main_web._save_app_state(
                        {"resultsByMonth": {month: stale_result}},
                        base_values=base_values,
                        tab_id=tab_id,
                        sequence=1,
                    )
                    self.assertEqual(
                        late["resultsByMonth"][month]["summary"]["total"], 1,
                    )
                    persisted = main_web._normalize_app_state(
                        json.loads(path.read_text(encoding="utf-8"))
                    )
                    self.assertEqual(
                        persisted["resultsByMonth"][month]["summary"]["total"], 1,
                    )
            finally:
                main_web._state_write_sequences.pop(tab_id, None)

        with self.assertRaisesRegex(ValueError, "sequence"):
            main_web._validate_state_write_identity(tab_id, None)
        with self.assertRaisesRegex(ValueError, "tabId"):
            main_web._validate_state_write_identity(None, 1)

    def test_conflicting_group_makes_normal_put_atomic(self):
        tab_id = "tab-partial-safe"
        month = "2026-09"
        disk = main_web._normalize_app_state({
            "resultsByMonth": {month: {"summary": {"total": 2}}},
        })
        payload = {
            "resultsByMonth": {month: {"summary": {"total": 3}}},
            "annualBudgetsByYear": {"2026": {"USD": 100.0}},
        }
        base_values = {
            "resultsByMonth": {
                month: {"exists": True, "value": {"summary": {"total": 1}}},
            },
            "annualBudgetsByYear": {
                "2026": {"exists": False},
            },
        }

        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "app-state.json"
            path.write_text(json.dumps(disk, ensure_ascii=False), encoding="utf-8")
            try:
                with mock.patch.object(main_web, "APP_STATE_FILE", path):
                    with self.assertRaisesRegex(
                            main_web.StateConflictError, "本次请求未写入"):
                        main_web._save_app_state(
                            payload,
                            base_values=base_values,
                            tab_id=tab_id,
                            sequence=1,
                        )
                persisted = main_web._normalize_app_state(
                    json.loads(path.read_text(encoding="utf-8"))
                )
                self.assertEqual(
                    persisted["resultsByMonth"][month]["summary"]["total"], 2,
                )
                self.assertNotIn("2026", persisted["annualBudgetsByYear"])
            finally:
                main_web._state_write_sequences.pop(tab_id, None)

    def test_unregister_mode_salvages_only_nonconflicting_groups(self):
        tab_id = "tab-unregister-partial"
        month = "2026-09"
        disk = main_web._normalize_app_state({
            "resultsByMonth": {month: {"summary": {"total": 2}}},
        })
        payload = {
            "resultsByMonth": {month: {"summary": {"total": 3}}},
            "annualBudgetsByYear": {"2026": {"USD": 100.0}},
        }
        base_values = {
            "resultsByMonth": {
                month: {"exists": True, "value": {"summary": {"total": 1}}},
            },
            "annualBudgetsByYear": {"2026": {"exists": False}},
        }
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "app-state.json"
            path.write_text(json.dumps(disk, ensure_ascii=False), encoding="utf-8")
            try:
                with mock.patch.object(main_web, "APP_STATE_FILE", path):
                    with self.assertRaisesRegex(
                            main_web.StateConflictError, "其它无冲突月份/年度已保存"):
                        main_web._save_app_state(
                            payload,
                            base_values=base_values,
                            tab_id=tab_id,
                            sequence=1,
                            allow_partial_conflicts=True,
                        )
                persisted = main_web._normalize_app_state(
                    json.loads(path.read_text(encoding="utf-8"))
                )
                self.assertEqual(
                    persisted["resultsByMonth"][month]["summary"]["total"], 2,
                )
                self.assertEqual(
                    persisted["annualBudgetsByYear"]["2026"], {"USD": 100.0},
                )
            finally:
                main_web._state_write_sequences.pop(tab_id, None)

    def test_unregister_forwards_state_tab_identity_and_sequence(self):
        tab_id = "tab-unregister-sequence"
        body = main_web.TabRegisterIn(
            tab_id=tab_id,
            state={
                "version": 1,
                "tabId": tab_id,
                "sequence": 7,
                "baseValues": {},
            },
        )
        with (
            mock.patch.object(main_web, "_open_tabs", {tab_id: 1.0}),
            mock.patch.object(main_web, "AUTO_SHUTDOWN_ENABLED", False),
            mock.patch.object(main_web, "_cancel_tab_expiry_timer_locked"),
            mock.patch.object(main_web, "_save_app_state", return_value={}) as save_state,
        ):
            self.assertEqual(main_web.api_tabs_unregister(body), {"open_tabs": 0})
        save_state.assert_called_once_with(
            {"version": 1},
            replace=False,
            base_values={},
            tab_id=tab_id,
            sequence=7,
            allow_partial_conflicts=True,
        )

    def test_state_patch_accepts_idempotent_target_and_pending_write_alternative(self):
        disk = main_web._normalize_app_state({
            "resultsByMonth": {"2026-09": {"summary": {"total": 2}}},
        })
        old = {"summary": {"total": 1}}
        pending = {"summary": {"total": 2}}
        final = {"summary": {"total": 3}}

        # 上一请求已把目标 2 写入；相同旧基线的迟到重试是幂等的。
        main_web._assert_state_patch_base(
            disk,
            {"resultsByMonth": {"2026-09": {"exists": True, "value": old}}},
            {"resultsByMonth": {"2026-09": pending}},
        )
        # 最终 beacon 以旧基线 1 构造，但允许本标签页在途请求的目标 2。
        main_web._assert_state_patch_base(
            disk,
            {"resultsByMonth": {"2026-09": {
                "exists": True,
                "value": old,
                "alternatives": [{"exists": True, "value": pending}],
            }}},
            {"resultsByMonth": {"2026-09": final}},
        )
        with self.assertRaisesRegex(main_web.StateConflictError, "2026-09"):
            main_web._assert_state_patch_base(
                main_web._normalize_app_state({
                    "resultsByMonth": {"2026-09": {"summary": {"total": 99}}},
                }),
                {"resultsByMonth": {"2026-09": {
                    "exists": True,
                    "value": old,
                    "alternatives": [{"exists": True, "value": pending}],
                }}},
                {"resultsByMonth": {"2026-09": final}},
            )


class MonthlyRateCacheTests(unittest.TestCase):
    def test_current_month_memory_cache_expires_at_calendar_day_rollover(self):
        fetched_at = real_datetime.datetime(2026, 9, 27, 23, 59).timestamp()
        cached = (fetched_at, pd.Series([7.0], index=pd.to_datetime(["2026-09-27"])))
        now = real_datetime.datetime(2026, 9, 28, 0, 5).timestamp()
        with mock.patch.object(functions.datetime, "date", _FixedDate):
            self.assertFalse(functions._cached_rate_is_fresh(
                cached, "2026-09-30", "monthly", ttl=3600, now=now,
            ))
            self.assertTrue(functions._cached_rate_is_fresh(
                cached, "2026-08-31", "monthly", ttl=3600, now=now,
            ))

    def test_freshness_rejects_partial_historical_and_stale_current_cache(self):
        with mock.patch.object(main_web.dt, "date", _FixedDate):
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

            self.assertFalse(main_web._disk_currency_cache_is_fresh(
                partial_history, "USD", 2026, 8,
            ))
            self.assertFalse(main_web._disk_currency_cache_is_fresh(
                wrong_month_tail, "USD", 2026, 8,
            ))
            self.assertFalse(main_web._disk_currency_cache_is_fresh(
                missing_month_start, "USD", 2026, 8,
            ))
            self.assertTrue(main_web._disk_currency_cache_is_fresh(
                full_history, "USD", 2026, 8,
            ))
            self.assertTrue(main_web._disk_currency_cache_is_fresh(
                schema_history, "USD", 2026, 8,
            ))
            self.assertFalse(main_web._disk_currency_cache_is_fresh(
                schema_history_missing_middle, "USD", 2026, 8,
            ))
            self.assertFalse(main_web._disk_currency_cache_is_fresh(
                stale_current, "USD", 2026, 9,
            ))
            self.assertTrue(main_web._disk_currency_cache_is_fresh(
                fresh_current, "USD", 2026, 9,
            ))
            self.assertFalse(main_web._disk_currency_cache_is_fresh(
                missing_middle, "USD", 2026, 9,
            ))
            self.assertFalse(main_web._disk_currency_cache_is_fresh(
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
                mock.patch.object(main_web, "RATES_DATA_DIR", rates_dir),
                mock.patch.object(main_web.dt, "date", _FixedDate),
            ):
                main_web._save_rates_month_file(2026, 9, {"USD": usd})

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
            mock.patch.object(main_web.dt, "date", _FixedDate),
            mock.patch.object(functions, "get_rates_from_cache", return_value={}),
            mock.patch.object(main_web, "_load_rates_month_file", return_value=disk_data),
            mock.patch.object(
                    functions, "get_historical_rates_cached", return_value={"USD": downloaded},
            ) as fetch,
            mock.patch.object(main_web, "_save_rates_month_file"),
        ):
            result = main_web._fetch_rates_parallel(
                ["USD"], "2026-09-01", "2026-09-30", max_workers=1,
            )

        fetch.assert_called_once()
        self.assertEqual(float(result["USD"].iloc[0]), 7.0)


class ItineraryValidationTests(unittest.TestCase):
    def test_two_locations_cannot_claim_the_same_day(self):
        entries = [
            main_web.ItineraryEntryIn(
                location="A",
                ranges=[main_web.RangeIn(start="2026-09-01", end="2026-09-01")],
            ),
            main_web.ItineraryEntryIn(
                location="B",
                ranges=[main_web.RangeIn(start="2026-09-01", end="2026-09-01")],
            ),
        ]
        registry = {
            "A": {"type": "variable", "currency": "CNY"},
            "B": {"type": "variable", "currency": "CNY"},
        }

        with self.assertRaisesRegex(ValueError, "同一天只能属于一个地点"):
            main_web._expand_itinerary(entries, 2026, 9, registry)


class RouteRegistrationTests(unittest.TestCase):
    def test_annual_routes_are_registered_before_static_mount(self):
        routes = list(main_web.app.routes)
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
