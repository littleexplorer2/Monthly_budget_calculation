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
            self.assertEqual(manifest["excluded"], ["data/rates/"])


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
