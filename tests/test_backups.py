# -*- coding: utf-8 -*-
"""退出备份的命名、只追加边界与生命周期接线。"""

import datetime as dt
import json
from pathlib import Path
import re
import tempfile
import threading
import unittest
from unittest import mock

from application.backups import service as backup_service
from application.lifecycle import service as lifecycle_service


class BackupServiceTests(unittest.TestCase):
    def test_backup_is_timestamped_append_only_and_excludes_rate_cache(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            data = root / "data"
            backups = root / "backups"
            rates = data / "rates"
            rates.mkdir(parents=True)
            (data / "app-state.json").write_bytes(b'{"month":10}\n')
            (data / "defaults.json").write_bytes(b'{"fixed":{}}\n')
            (rates / "2026-10.json").write_bytes(b'{"cache":true}\n')
            fixed_now = dt.datetime(
                2026, 11, 1, 14, 15, 16, 123000,
                tzinfo=dt.timezone(dt.timedelta(hours=8)),
            )
            tokens = [
                mock.Mock(hex="0123456789abcdef0123456789abcdef"),
                mock.Mock(hex="fedcba9876543210fedcba9876543210"),
            ]
            with (
                mock.patch.object(backup_service.app_config, "DATA_DIR", data),
                mock.patch.object(backup_service.app_config, "BACKUP_DIR", backups),
                mock.patch.object(backup_service.uuid, "uuid4", side_effect=tokens),
            ):
                first = backup_service.create_data_backup(
                    reason="test-run", now=fixed_now,
                    state_lock=threading.RLock(), defaults_lock=threading.RLock(),
                )
                first_state = (first / "data" / "app-state.json").read_bytes()
                first_manifest = (first / "manifest.json").read_bytes()

                (data / "app-state.json").write_bytes(b'{"month":11}\n')
                second = backup_service.create_data_backup(
                    reason="test-run", now=fixed_now,
                    state_lock=threading.RLock(), defaults_lock=threading.RLock(),
                )

            self.assertRegex(
                first.name,
                re.compile(r"^2026-11-01_14-15-16\.123_UTC\+0800_run-01234567$"),
            )
            self.assertNotEqual(first, second)
            self.assertEqual((first / "data" / "app-state.json").read_bytes(), first_state)
            self.assertEqual((first / "manifest.json").read_bytes(), first_manifest)
            self.assertEqual((second / "data" / "app-state.json").read_bytes(), b'{"month":11}\n')
            self.assertFalse((first / "data" / "rates").exists())
            manifest = json.loads(first_manifest.decode("utf-8"))
            self.assertTrue(manifest["immutable"])
            self.assertFalse(manifest["calculationInput"])
            self.assertEqual({row["path"] for row in manifest["files"]}, {
                "data/app-state.json", "data/defaults.json",
            })
            self.assertEqual(manifest["excluded"], ["data/rates/", "data/legacy/"])

    def test_backup_rejects_invalid_authoritative_json_before_publish(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            data = root / "data"
            backups = root / "backups"
            data.mkdir()
            (data / "app-state.json").write_text("{broken", encoding="utf-8")
            (data / "defaults.json").write_text("{}", encoding="utf-8")
            with (
                mock.patch.object(backup_service.app_config, "DATA_DIR", data),
                mock.patch.object(backup_service.app_config, "BACKUP_DIR", backups),
            ):
                with self.assertRaisesRegex(ValueError, "拒绝备份损坏的 JSON"):
                    backup_service.create_data_backup(
                        reason="invalid-json",
                        state_lock=threading.RLock(), defaults_lock=threading.RLock(),
                    )
            self.assertEqual(list(backups.iterdir()), [])

    def test_catalog_reads_only_manifests_and_defers_payload_validation_to_restore(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            data = root / "data"
            backups = root / "backups"
            months = data / "months"
            months.mkdir(parents=True)
            (data / "global.json").write_text(
                '{"schemaVersion":2,"revision":0,"updatedAt":null,'
                '"selectedMonth":null,"annualBudgetsByYear":{},'
                '"annualResultsByYear":{},"assetPortfoliosById":{}}\n',
                encoding="utf-8",
            )
            (months / "2026-03.json").write_text(
                '{"schemaVersion":2,"month":"2026-03"}\n', encoding="utf-8",
            )
            with (
                mock.patch.object(backup_service.app_config, "DATA_DIR", data),
                mock.patch.object(backup_service.app_config, "BACKUP_DIR", backups),
            ):
                snapshot = backup_service.create_data_backup(
                    reason="catalog-test",
                    state_lock=threading.RLock(), defaults_lock=threading.RLock(),
                )
                with (
                    mock.patch.object(
                        backup_service, "_load_restore_snapshot",
                        side_effect=AssertionError("catalog must not load payload"),
                    ),
                    mock.patch.object(
                        backup_service, "_sha256",
                        side_effect=AssertionError("catalog must not hash payload"),
                    ),
                ):
                    catalog = backup_service.list_data_backups()
            row = next(item for item in catalog["backups"] if item["id"] == snapshot.name)
            self.assertTrue(row["restorable"])
            self.assertEqual(row["kind"], "v2")
            self.assertEqual(row["verification"], "restore-time")

    def test_catalog_classifies_intact_v1_snapshot_as_manual_rollback(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            data = root / "data"
            backups = root / "backups"
            data.mkdir()
            (data / "app-state.json").write_text('{"version":1}\n', encoding="utf-8")
            with (
                mock.patch.object(backup_service.app_config, "DATA_DIR", data),
                mock.patch.object(backup_service.app_config, "BACKUP_DIR", backups),
            ):
                snapshot = backup_service.create_data_backup(
                    reason="pre-v1-to-v2-migration",
                    state_lock=threading.RLock(), defaults_lock=threading.RLock(),
                )
                catalog = backup_service.list_data_backups()
            row = next(item for item in catalog["backups"] if item["id"] == snapshot.name)
            self.assertFalse(row["restorable"])
            self.assertEqual(row["kind"], "legacy-v1")
            self.assertEqual(row["createdAt"], json.loads(
                (snapshot / "manifest.json").read_text(encoding="utf-8")
            )["createdAt"])
            self.assertIn("人工回滚", row["error"])

    def test_catalog_isolates_non_string_manifest_paths_and_restore_rejects_them(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            data = root / "data"
            backups = root / "backups"
            bad = backups / "bad-path"
            bad.mkdir(parents=True)
            data.mkdir()
            (bad / "manifest.json").write_text(json.dumps({
                "formatVersion": 2,
                "immutable": True,
                "files": [{"path": [], "bytes": 0, "sha256": "0" * 64}],
            }), encoding="utf-8")
            with (
                mock.patch.object(backup_service.app_config, "DATA_DIR", data),
                mock.patch.object(backup_service.app_config, "BACKUP_DIR", backups),
            ):
                catalog = backup_service.list_data_backups()
                with self.assertRaisesRegex(ValueError, "path 必须是字符串"):
                    backup_service.load_restore_snapshot("bad-path")
            self.assertEqual(len(catalog["backups"]), 1)
            self.assertEqual(catalog["backups"][0]["kind"], "damaged-manifest")
            self.assertIn("path 必须是字符串", catalog["backups"][0]["error"])

    def test_catalog_defers_same_length_payload_tamper_until_explicit_restore(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            data = root / "data"
            backups = root / "backups"
            data.mkdir()
            global_file = data / "global.json"
            global_file.write_text('{"schemaVersion":2,"revision":0}\n', encoding="utf-8")
            with (
                mock.patch.object(backup_service.app_config, "DATA_DIR", data),
                mock.patch.object(backup_service.app_config, "BACKUP_DIR", backups),
            ):
                snapshot = backup_service.create_data_backup(
                    reason="tamper-test",
                    state_lock=threading.RLock(), defaults_lock=threading.RLock(),
                )
                copied = snapshot / "data" / "global.json"
                copied.write_bytes(copied.read_bytes().replace(b'"revision":0', b'"revision":1'))
                row = backup_service.list_data_backups()["backups"][0]
                self.assertTrue(row["restorable"])
                self.assertEqual(row["verification"], "restore-time")
                with self.assertRaisesRegex(ValueError, "摘要不匹配"):
                    backup_service.load_restore_snapshot(snapshot.name)
            self.assertEqual(global_file.read_text(encoding="utf-8"),
                             '{"schemaVersion":2,"revision":0}\n')


class BackupLifecycleTests(unittest.TestCase):
    def test_auto_shutdown_backs_up_before_exit(self):
        state_lock = threading.RLock()
        defaults_lock = threading.RLock()
        with (
            mock.patch.object(lifecycle_service.app_state, "state_disk_lock", state_lock),
            mock.patch.object(lifecycle_service.app_defaults, "defaults_disk_lock", defaults_lock),
            mock.patch.object(lifecycle_service.app_repository, "repository_upload_lock", threading.RLock()),
            mock.patch.object(lifecycle_service.app_backups, "create_data_backup", return_value=Path("backups/snapshot")) as backup,
            mock.patch.object(lifecycle_service.os, "_exit") as exit_process,
        ):
            self.assertTrue(lifecycle_service._finish_shutdown())
        backup.assert_called_once_with(
            reason="last-browser-tab-closed",
            state_lock=state_lock,
            defaults_lock=defaults_lock,
        )
        exit_process.assert_called_once_with(0)

    def test_auto_shutdown_stays_running_when_backup_fails(self):
        with (
            mock.patch.object(lifecycle_service.app_state, "state_disk_lock", threading.RLock()),
            mock.patch.object(lifecycle_service.app_defaults, "defaults_disk_lock", threading.RLock()),
            mock.patch.object(lifecycle_service.app_repository, "repository_upload_lock", threading.RLock()),
            mock.patch.object(lifecycle_service.app_backups, "create_data_backup", side_effect=OSError("disk full")),
            mock.patch.object(lifecycle_service.os, "_exit") as exit_process,
            mock.patch.object(lifecycle_service.logger, "exception"),
        ):
            self.assertFalse(lifecycle_service._finish_shutdown())
        exit_process.assert_not_called()


if __name__ == "__main__":
    unittest.main()
