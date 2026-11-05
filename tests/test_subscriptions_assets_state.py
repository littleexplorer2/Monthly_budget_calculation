"""订阅与资产状态契约；文件写入测试全部定向到临时目录。"""

import unittest

from application.state import service as state_service


def subscription(item_id: str, **overrides):
    item = {
        "id": item_id,
        "name": item_id,
        "currency": "USD",
        "cycle": "monthly",
        "amount": 10,
        "included": True,
        "includeByDefault": True,
    }
    item.update(overrides)
    return item


def portfolio():
    return {
        "calculationBase": {"CNY": 20000, "HKD": 1000, "USD": 500},
        "rates": {"CNY": 1, "HKD": 0.92, "USD": 7.2},
        "items": [
            {
                "id": "cash-cny",
                "kind": "cash",
                "location": "深圳",
                "name": "消费账户",
                "purpose": "spending",
                "currency": "CNY",
                "amount": 3000,
            },
            {
                "id": "term-usd",
                "kind": "term",
                "location": "汇丰银行",
                "name": "美元定期",
                "purpose": "other",
                "currency": "USD",
                "amount": 2000,
            },
        ],
    }


class SubscriptionAssetStateTests(unittest.TestCase):
    def test_missing_fields_are_backward_compatible(self):
        state = state_service._normalize_app_state({"version": 1})
        self.assertEqual(state["subscriptionsByMonth"], {})
        self.assertEqual(state["assetPortfoliosById"], {})

    def test_valid_state_is_normalized_without_changing_month_snapshots(self):
        state = state_service._normalize_app_state({
            "subscriptionsByMonth": {
                "2026-09": {"items": [subscription("monthly")]},
                "2026-10": {"items": [subscription(
                    "yearly", cycle="yearly", amount=1200,
                    included=False, includeByDefault=False,
                )]},
            },
            "assetPortfoliosById": {"current": portfolio()},
        })
        self.assertTrue(state["subscriptionsByMonth"]["2026-09"]["items"][0]["included"])
        self.assertEqual(
            state["subscriptionsByMonth"]["2026-09"]["items"][0]["appliesTo"],
            {"Mainland": True, "Overseas": True},
            "旧订阅缺少地点字段时必须兼容为内地、海外均适用",
        )
        self.assertFalse(state["subscriptionsByMonth"]["2026-10"]["items"][0]["included"])
        self.assertEqual(state["subscriptionsByMonth"]["2026-10"]["retiredIds"], [])
        self.assertEqual(
            state["subscriptionsByMonth"]["2026-10"]["items"][0]["amount"],
            1200.0,
        )
        self.assertEqual(state["assetPortfoliosById"]["current"]["rates"]["CNY"], 1.0)
        self.assertEqual(
            state["assetPortfoliosById"]["current"]["calculationBase"],
            {"CNY": 20000.0, "HKD": 1000.0, "USD": 500.0},
        )
        self.assertEqual(state["assetPortfoliosById"]["current"]["items"][1]["amount"], 2000.0)

    def test_legacy_numeric_calculation_base_is_normalized_as_cny_only(self):
        legacy = portfolio()
        legacy["calculationBase"] = 20000
        state = state_service._normalize_app_state({
            "assetPortfoliosById": {"current": legacy},
        })
        self.assertEqual(
            state["assetPortfoliosById"]["current"]["calculationBase"],
            {"CNY": 20000.0, "HKD": 0.0, "USD": 0.0},
        )

    def test_legacy_fixed_and_extra_overrides_are_ignored_for_every_month(self):
        state = state_service._normalize_app_state({
            "overridesByMonth": {
                "2026-03": {
                    "_snapshot": True,
                    "variable": {"深圳": {"CNY": 80}},
                    "fixed": {"Mainland": {"CNY": 999}},
                    "extra": {"CNY": 88},
                },
                "2026-10": {
                    "travel": {},
                    "fixed": {"Overseas": {"USD": 50}},
                },
            },
        })
        self.assertNotIn("fixed", state["overridesByMonth"]["2026-03"])
        self.assertNotIn("extra", state["overridesByMonth"]["2026-03"])
        self.assertEqual(
            state["overridesByMonth"]["2026-03"]["variable"],
            {"深圳": {"CNY": 80}},
        )
        self.assertNotIn("fixed", state["overridesByMonth"]["2026-10"])

    def test_subscription_validation_rejects_corrupt_boundaries(self):
        invalid = [
            ({"subscriptionsByMonth": []}, "subscriptionsByMonth 必须是对象"),
            ({"subscriptionsByMonth": {"2026-13": {"items": []}}}, "月份无效"),
            ({"subscriptionsByMonth": {"2026-09": {"items": [
                subscription("bad", currency="EUR")
            ]}}}, "仅支持 CNY"),
            ({"subscriptionsByMonth": {"2026-09": {"items": [
                subscription("bad", amount=True)
            ]}}}, "amount 必须是非负有限数字"),
            ({"subscriptionsByMonth": {"2026-09": {"items": [
                subscription("bad", included=1)
            ]}}}, "included 必须是布尔值"),
            ({"subscriptionsByMonth": {"2026-09": {"items": [
                subscription("bad", appliesTo={"Mainland": True})
            ]}}}, "appliesTo 必须同时包含 Mainland 和 Overseas"),
            ({"subscriptionsByMonth": {"2026-09": {"items": [
                subscription("bad", appliesTo={"Mainland": False, "Overseas": False})
            ]}}}, "appliesTo 至少选择一个预算区域"),
            ({"subscriptionsByMonth": {"2026-09": {
                "items": [], "retiredIds": "bad",
            }}}, "retiredIds 必须是数组"),
            ({"subscriptionsByMonth": {"2026-09": {
                "items": [], "retiredIds": ["same", "same"],
            }}}, r"retiredIds\[1\] 重复"),
            ({"subscriptionsByMonth": {"2026-09": {
                "items": [subscription("same")], "retiredIds": ["same"],
            }}}, "retiredIds 不能包含仍在 items 中的项目"),
        ]
        for payload, message in invalid:
            with self.subTest(payload=payload):
                with self.assertRaisesRegex(ValueError, message):
                    state_service._normalize_app_state(payload)

    def test_retired_subscription_ids_are_preserved_as_forward_only_tombstones(self):
        state = state_service._normalize_app_state({
            "subscriptionsByMonth": {
                "2026-09": {"items": [subscription("active")]},
                "2026-10": {"items": [], "retiredIds": ["cancelled"]},
            },
        })
        self.assertEqual(
            state["subscriptionsByMonth"]["2026-09"]["retiredIds"], [],
            "旧快照缺少字段时应兼容为空墓碑列表",
        )
        self.assertEqual(
            state["subscriptionsByMonth"]["2026-10"],
            {"items": [], "retiredIds": ["cancelled"]},
        )

    def test_asset_validation_rejects_fake_or_ambiguous_totals(self):
        invalid = []
        bad_rate = portfolio()
        bad_rate["rates"]["USD"] = 0
        invalid.append((bad_rate, "rates.USD 必须是正有限数字"))
        bad_cny = portfolio()
        bad_cny["rates"]["CNY"] = 0.99
        invalid.append((bad_cny, "rates.CNY 必须是 1"))
        bad_amount = portfolio()
        bad_amount["items"][0]["amount"] = float("nan")
        invalid.append((bad_amount, "amount 必须是非负有限数字"))
        bad_kind = portfolio()
        bad_kind["items"][0]["kind"] = "crypto"
        invalid.append((bad_kind, "kind 必须是 cash"))
        empty_base = portfolio()
        empty_base["calculationBase"] = {"CNY": 0, "HKD": 0, "USD": 0}
        invalid.append((empty_base, "至少一种币种必须大于 0"))
        unknown_base = portfolio()
        unknown_base["calculationBase"] = {"CNY": 20000, "EUR": 100}
        invalid.append((unknown_base, "calculationBase 包含未知币种"))

        for value, message in invalid:
            with self.subTest(message=message):
                with self.assertRaisesRegex(ValueError, message):
                    state_service._normalize_app_state({
                        "assetPortfoliosById": {"current": value},
                    })

if __name__ == "__main__":
    unittest.main()
