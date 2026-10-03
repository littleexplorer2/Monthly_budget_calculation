import copy
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import functions


class DefaultsAtomicityTests(unittest.TestCase):
    @staticmethod
    def _payload(snapshot):
        return copy.deepcopy({
            key: snapshot[key]
            for key in ("variable", "fixed", "extra", "travel",
                        "location_names", "currency_names")
        })

    def test_default_snapshot_is_deep_and_self_contained(self):
        snapshot = functions.default_standards_snapshot()
        location = next(iter(snapshot["variable"]))
        currency = next(iter(snapshot["variable"][location]))
        original = snapshot["variable"][location][currency]

        snapshot["variable"][location][currency] = original + 999
        snapshot["location_names"]["Injected"] = "不应泄漏"

        fresh = functions.default_standards_snapshot()
        self.assertEqual(fresh["variable"][location][currency], original)
        self.assertNotIn("Injected", fresh["location_names"])

    def test_failed_defaults_file_delete_does_not_change_live_defaults(self):
        before = functions.default_standards_snapshot()
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "defaults.json"
            path.write_text("{}", encoding="utf-8")
            with mock.patch.object(functions, "_DEFAULTS_FILE", path), \
                    mock.patch.object(Path, "unlink", side_effect=OSError("locked")):
                with self.assertRaisesRegex(ValueError, "删除默认标准文件失败"):
                    functions.restore_builtin_defaults()

        after = functions.default_standards_snapshot()
        self.assertEqual(after, before)

    def test_stale_full_defaults_snapshot_cannot_overwrite_another_tab(self):
        before = functions.default_standards_snapshot()
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
                with mock.patch.object(functions, "_DEFAULTS_FILE", path):
                    functions.save_default_standards(
                        first, expected_revision=before["revision"],
                    )
                    with self.assertRaisesRegex(
                            functions.DefaultsRevisionConflict, "另一个标签页"):
                        functions.save_default_standards(
                            stale_second, expected_revision=before["revision"],
                        )
                    current = functions.default_standards_snapshot()
                    self.assertEqual(
                        current["variable"][first_location][first_currency],
                        first["variable"][first_location][first_currency],
                    )
                    self.assertEqual(
                        current["fixed"][region][second_currency],
                        base_payload["fixed"][region][second_currency],
                    )
            finally:
                with functions._DEFAULTS_LOCK:
                    functions._apply_defaults_dict(base_payload)
                    functions._DEFAULTS_LOADED_FROM_FILE = before["customized"]
                    functions._DEFAULTS_LOAD_ERROR = before["load_error"]


if __name__ == "__main__":
    unittest.main()
