"""订阅与资产状态契约；文件写入测试全部定向到临时目录。"""

import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from application import backups as app_backups
from application.backups import service as backup_service
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

    def test_first_state_write_backs_up_then_removes_legacy_fixed_fields(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            data = root / "data"
            backups = root / "backups"
            data.mkdir()
            state_path = data / "app-state.json"
            original = {
                "version": 1,
                "year": 2026,
                "month": 9,
                "overridesByMonth": {
                    "2026-03": {"fixed": {"Mainland": {"CNY": 10}}, "extra": {"CNY": 2}},
                    "2026-09": {"variable": {"深圳": {"CNY": 80}}},
                },
            }
            state_path.write_text(json.dumps(original, ensure_ascii=False), encoding="utf-8")
            (data / "defaults.json").write_text("{}", encoding="utf-8")
            state_service._state_write_sequences.clear()
            with (
                mock.patch.object(state_service, "APP_STATE_FILE", state_path),
                mock.patch.object(backup_service.app_config, "DATA_DIR", data),
                mock.patch.object(backup_service.app_config, "BACKUP_DIR", backups),
            ):
                saved = state_service._save_app_state({"year": 2026, "month": 9})

            snapshots = [path for path in backups.iterdir() if path.is_dir()]
            self.assertEqual(len(snapshots), 1)
            manifest = json.loads((snapshots[0] / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["reason"], "pre-subscription-fixed-migration")
            backup_state = json.loads(
                (snapshots[0] / "data" / "app-state.json").read_text(encoding="utf-8")
            )
            self.assertIn("fixed", backup_state["overridesByMonth"]["2026-03"])
            self.assertNotIn("fixed", saved["overridesByMonth"]["2026-03"])
            self.assertNotIn("extra", saved["overridesByMonth"]["2026-03"])
            persisted = json.loads(state_path.read_text(encoding="utf-8"))
            self.assertNotIn("fixed", persisted["overridesByMonth"]["2026-03"])

    def test_backup_failure_aborts_fixed_budget_migration_write(self):
        with tempfile.TemporaryDirectory() as temp:
            state_path = Path(temp) / "app-state.json"
            original_bytes = json.dumps({
                "version": 1,
                "year": 2026,
                "month": 9,
                "overridesByMonth": {"2026-09": {"fixed": {"Mainland": {"CNY": 10}}}},
            }).encode("utf-8")
            state_path.write_bytes(original_bytes)
            with (
                mock.patch.object(state_service, "APP_STATE_FILE", state_path),
                mock.patch.object(app_backups, "create_data_backup", side_effect=OSError("disk full")),
            ):
                with self.assertRaisesRegex(OSError, "disk full"):
                    state_service._save_app_state({"year": 2026, "month": 9})
            self.assertEqual(state_path.read_bytes(), original_bytes)

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

    def test_merging_one_subscription_month_preserves_other_months(self):
        disk = {
            "subscriptionsByMonth": {
                "2026-09": {"items": [subscription("september", included=True)]},
                "2026-10": {"items": [subscription("october", included=True)]},
            },
            "assetPortfoliosById": {"current": portfolio()},
        }
        merged = state_service._merge_app_state(disk, {
            "subscriptionsByMonth": {
                "2026-10": {"items": [subscription("october", included=False)]},
            },
        })
        self.assertTrue(merged["subscriptionsByMonth"]["2026-09"]["items"][0]["included"])
        self.assertFalse(merged["subscriptionsByMonth"]["2026-10"]["items"][0]["included"])
        self.assertEqual(merged["assetPortfoliosById"]["current"], portfolio())

    def test_empty_objects_are_merge_tombstones(self):
        disk = {
            "subscriptionsByMonth": {"2026-09": {"items": [subscription("one")]}},
            "assetPortfoliosById": {"current": portfolio()},
        }
        merged = state_service._merge_app_state(disk, {
            "subscriptionsByMonth": {"2026-09": {}},
            "assetPortfoliosById": {"current": {}},
        })
        self.assertNotIn("2026-09", merged["subscriptionsByMonth"])
        self.assertNotIn("current", merged["assetPortfoliosById"])


if __name__ == "__main__":
    unittest.main()
