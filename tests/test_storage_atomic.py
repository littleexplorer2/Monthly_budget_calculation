# -*- coding: utf-8 -*-
"""权威 JSON 的原子写必须完整发布，失败时不得破坏旧文件。"""

import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from core.storage import atomic_write_text
from core.storage import files as storage_files


class AtomicStorageTests(unittest.TestCase):
    def test_short_os_writes_are_retried_until_payload_is_complete(self):
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / "state.json"
            real_write = os.write

            def short_write(fd, payload):
                return real_write(fd, bytes(payload[:3]))

            with mock.patch.object(storage_files.os, "write", side_effect=short_write):
                atomic_write_text(target, '{"中文":"完整内容"}\n')
            self.assertEqual(target.read_text(encoding="utf-8"), '{"中文":"完整内容"}\n')

    def test_replace_failure_keeps_old_file_and_removes_pending_temp(self):
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / "state.json"
            target.write_text('{"old":true}\n', encoding="utf-8")
            with mock.patch.object(storage_files.os, "replace", side_effect=OSError("locked")):
                with self.assertRaisesRegex(OSError, "locked"):
                    atomic_write_text(target, '{"new":true}\n')
            self.assertEqual(target.read_text(encoding="utf-8"), '{"old":true}\n')
            self.assertEqual([path for path in target.parent.iterdir() if path != target], [])


if __name__ == "__main__":
    unittest.main()
