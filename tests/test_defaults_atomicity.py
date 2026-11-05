import copy
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from application.defaults import service as defaults


class DefaultsAtomicityTests(unittest.TestCase):
    @staticmethod
    def _payload(snapshot):
        return copy.deepcopy({
            key: snapshot[key]
            for key in ("variable", "fixed", "extra", "travel", "subscriptions",
                        "location_names", "currency_names")
        })

    def test_default_snapshot_is_deep_and_self_contained(self):
        snapshot = defaults.default_standards_snapshot()
        location = next(iter(snapshot["variable"]))
        currency = next(iter(snapshot["variable"][location]))
        original = snapshot["variable"][location][currency]

        snapshot["variable"][location][currency] = original + 999
        snapshot["location_names"]["Injected"] = "不应泄漏"

        fresh = defaults.default_standards_snapshot()
        self.assertEqual(fresh["variable"][location][currency], original)
        self.assertNotIn("Injected", fresh["location_names"])

    def test_failed_defaults_file_delete_does_not_change_live_defaults(self):
        before = defaults.default_standards_snapshot()
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "defaults.json"
            path.write_text("{}", encoding="utf-8")
            with mock.patch.object(defaults, "_DEFAULTS_FILE", path), \
                    mock.patch.object(Path, "unlink", side_effect=OSError("locked")):
                with self.assertRaisesRegex(ValueError, "删除默认标准文件失败"):
                    defaults.restore_builtin_defaults()

        after = defaults.default_standards_snapshot()
        self.assertEqual(after, before)

    def test_corrupt_defaults_file_cannot_be_silently_overwritten(self):
        before = defaults.default_standards_snapshot()
        payload = self._payload(before)
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "defaults.json"
            path.write_text("{broken", encoding="utf-8")
            with (
                mock.patch.object(defaults, "_DEFAULTS_FILE", path),
                mock.patch.object(defaults, "_DEFAULTS_LOAD_ERROR", "JSON 文件损坏"),
            ):
                with self.assertRaisesRegex(ValueError, "避免覆盖原始证据"):
                    defaults.save_default_standards(
                        payload, expected_revision=before["revision"],
                    )
            self.assertEqual(path.read_text(encoding="utf-8"), "{broken")

    def test_stale_full_defaults_snapshot_cannot_overwrite_another_tab(self):
        before = defaults.default_standards_snapshot()
        base_payload = self._payload(before)
        first = copy.deepcopy(base_payload)
        first_location = next(iter(first["variable"]))
        first_currency = next(iter(first["variable"][first_location]))
        first["variable"][first_location][first_currency] += 1
        stale_second = copy.deepcopy(base_payload)
        region = next(iter(stale_second["fixed"]))
        second_currency = next(iter(stale_second["fixed"][region]))
        stale_second["fixed"][region][second_currency] += 1

        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "defaults.json"
            try:
                with mock.patch.object(defaults, "_DEFAULTS_FILE", path):
                    defaults.save_default_standards(
                        first, expected_revision=before["revision"],
                    )
                    with self.assertRaisesRegex(
                            defaults.DefaultsRevisionConflict, "另一个标签页"):
                        defaults.save_default_standards(
                            stale_second, expected_revision=before["revision"],
                        )
                    current = defaults.default_standards_snapshot()
                    self.assertEqual(
                        current["variable"][first_location][first_currency],
                        first["variable"][first_location][first_currency],
                    )
                    self.assertEqual(
                        current["fixed"][region][second_currency],
                        base_payload["fixed"][region][second_currency],
                    )
            finally:
                with defaults._DEFAULTS_LOCK:
                    defaults._apply_defaults_dict(
                        base_payload,
                        subscriptions_configured=before["subscriptions_configured"],
                    )
                    defaults._DEFAULTS_LOADED_FROM_FILE = before["customized"]
                    defaults._DEFAULTS_LOAD_ERROR = before["load_error"]

    def test_default_subscription_catalog_is_validated_and_revisioned(self):
        before = defaults.default_standards_snapshot()
        payload = self._payload(before)
        payload["subscriptions"] = [{
            "id": "sub-cloud",
            "name": "云服务",
            "currency": "USD",
            "cycle": "yearly",
            "amount": 120.0,
            "includeByDefault": True,
            "appliesTo": {"Mainland": True, "Overseas": False},
        }]
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "defaults.json"
            try:
                with mock.patch.object(defaults, "_DEFAULTS_FILE", path):
                    defaults.save_default_standards(payload, expected_revision=before["revision"])
                    after = defaults.default_standards_snapshot()
                    self.assertTrue(after["subscriptions_configured"])
                    self.assertEqual(after["subscriptions"], payload["subscriptions"])
                    self.assertNotEqual(after["revision"], before["revision"])
                    persisted = path.read_text(encoding="utf-8")
                    self.assertIn('"subscriptions"', persisted)

                    invalid = self._payload(after)
                    invalid["subscriptions"] = [{**payload["subscriptions"][0], "amount": -1}]
                    with self.assertRaisesRegex(ValueError, "amount"):
                        defaults.save_default_standards(invalid, expected_revision=after["revision"])
                    invalid_regions = self._payload(after)
                    invalid_regions["subscriptions"] = [{
                        **payload["subscriptions"][0],
                        "appliesTo": {"Mainland": False, "Overseas": False},
                    }]
                    with self.assertRaisesRegex(ValueError, "至少选择一个预算区域"):
                        defaults.save_default_standards(
                            invalid_regions,
                            expected_revision=after["revision"],
                        )
            finally:
                with defaults._DEFAULTS_LOCK:
                    defaults._apply_defaults_dict(
                        self._payload(before),
                        subscriptions_configured=before["subscriptions_configured"],
                    )
                    defaults._DEFAULTS_LOADED_FROM_FILE = before["customized"]
                    defaults._DEFAULTS_LOAD_ERROR = before["load_error"]


if __name__ == "__main__":
    unittest.main()
