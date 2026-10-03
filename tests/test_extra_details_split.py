# -*- coding: utf-8 -*-
"""计算引擎回归测试：额外预算必须与固定预算分开明细，且合计与总预算不变。

背景：额外预算原先混在 fixed_details 里（type="额外预算"），结果页把它和固定预算行
排在同一张表。现在引擎把额外预算单独放进 extra_details，本测试锁住这个结构，
并顺带核对 summary 的合计（额外预算仍计入「固定费用合计」，总预算不变）。

预算标准通过 standards_override 的 _snapshot 传入，不依赖 data/defaults.json，
也不会写任何 data/ 文件。
"""
import unittest
from unittest import mock

import pandas as pd

import functions

STANDARDS_SNAPSHOT = {
    "_snapshot": True,
    "variable": {"Shenzhen": {"CNY": 100.0}},
    "fixed": {"Mainland": {"CNY": 50.0, "USD": 10.0}, "Overseas": {"CNY": 1.0}},
    "travel": {"Shanghai": {"CNY": {"daily": 20.0, "once": 30.0}}},
    "extra": {"CNY": 0.0, "USD": 5.0, "HKD": 0.0},
    "_location_names": {},
    "_currency_names": {},
}

# 整月常量汇率，便于手算核对
RATES = {"CNY": 1.0, "USD": 7.0}


def _rates_dict():
    days = pd.date_range("2026-09-01", "2026-09-30", freq="D")
    return {curr: pd.Series(rate, index=days) for curr, rate in RATES.items()}


def _itinerary():
    rows = [{"location": "Shenzhen", "date": "2026-09-%02d" % day, "is_travel": False}
            for day in (1, 2, 3)]
    rows += [{"location": "Shanghai", "date": "2026-09-%02d" % day, "is_travel": True}
             for day in (10, 11, 12)]
    return rows


class ExtraDetailsSplitTests(unittest.TestCase):
    def setUp(self):
        self.result = functions.calculate_travel_budget(
            _itinerary(), "Mainland", 2026, 9,
            standards_override=STANDARDS_SNAPSHOT,
            rates_dict=_rates_dict(),
        )

    def test_extra_budget_has_its_own_details(self):
        extra = self.result["extra_details"]
        self.assertEqual([d["type"] for d in extra], ["额外预算"])
        self.assertEqual(extra[0]["currency"], "USD")
        self.assertEqual(extra[0]["rmb_cost"], 35.0)  # 5 USD × 7.0

    def test_fixed_details_excludes_extra_budget(self):
        fixed = self.result["fixed_details"]
        self.assertEqual(
            [d["type"] for d in fixed],
            ["固定预算", "固定预算", "旅居一次性费用"],
        )
        self.assertFalse([d for d in fixed if d["type"] == "额外预算"])

    def test_totals_unchanged_by_the_split(self):
        summary = self.result["summary"]
        self.assertEqual(summary["额外预算合计(人民币)"], 35.0)
        self.assertEqual(summary["可变费用合计(人民币)"], 360.0)   # 100×3 + 20×3
        self.assertEqual(summary["固定费用合计(人民币)"], 185.0)   # 50 + 10×7 + 5×7 + 30
        self.assertEqual(summary["总预算(人民币)"], 545.0)

    def test_detail_totals_add_up_to_the_fixed_total(self):
        fixed = self.result["fixed_details"]
        extra = self.result["extra_details"]
        detail_sum = sum(d["rmb_cost"] for d in fixed) + sum(d["rmb_cost"] for d in extra)
        self.assertAlmostEqual(detail_sum, self.result["summary"]["固定费用合计(人民币)"], places=2)

    def test_pre_resolved_standards_are_not_resolved_again(self):
        resolved = functions.resolve_standards(STANDARDS_SNAPSHOT)
        with mock.patch.object(
                functions, "resolve_standards",
                side_effect=AssertionError("不得二次读取运行时默认值")):
            result = functions.calculate_travel_budget(
                _itinerary(), "Mainland", 2026, 9,
                standards_override=STANDARDS_SNAPSHOT,
                rates_dict=_rates_dict(),
                resolved_standards=resolved,
            )
        self.assertEqual(result["summary"]["总预算(人民币)"], 545.0)


if __name__ == "__main__":
    unittest.main()
