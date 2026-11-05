from __future__ import annotations

import copy
import datetime as dt
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from application import backups as app_backups
from application import config as app_config
from application import contracts as app_contracts
from application.budget import service as budget_service
from application.defaults import service as defaults_service
from application.state import v2


def _defaults_snapshot(*, configured: bool = True) -> dict:
    return {
        "variable": {"Shenzhen": {"CNY": 85.0}},
        "fixed": {"Mainland": {"CNY": 0.0}, "Overseas": {"CNY": 0.0}},
        "extra": {"CNY": 0.0, "HKD": 0.0, "USD": 0.0},
        "travel": {"Shanghai": {"CNY": {"daily": 100.0, "once": 20.0}}},
        "subscriptions": [{
            "id": "nomad-esim", "name": "Nomad Esim", "currency": "USD",
            "cycle": "monthly", "amount": 8.0, "includeByDefault": True,
            "appliesTo": {"Mainland": True, "Overseas": True},
        }],
        "subscriptions_configured": configured,
        "location_names": {"Shenzhen": "深圳", "Shanghai": "上海"},
        "currency_names": {"CNY": "人民币", "USD": "美元"},
        "customized": configured,
        "load_error": None,
        "revision": "0" * 64,
    }


class StateV2Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.data = self.root / "data"
        self.data.mkdir()
        self.backups = self.root / "backups"
        self.patchers = [
            mock.patch.object(v2, "APP_STATE_FILE", self.data / "app-state.json"),
            mock.patch.object(v2, "GLOBAL_STATE_FILE", self.data / "global.json"),
            mock.patch.object(v2, "MONTHS_DIR", self.data / "months"),
            mock.patch.object(v2, "LEGACY_DATA_DIR", self.data / "legacy"),
            mock.patch.object(app_config, "DATA_DIR", self.data),
            mock.patch.object(app_config, "BACKUP_DIR", self.backups),
            mock.patch.object(defaults_service, "_DEFAULTS_FILE", self.data / "defaults.json"),
            mock.patch.object(v2.app_defaults, "default_standards_snapshot", _defaults_snapshot),
        ]
        for patcher in self.patchers:
            patcher.start()

    def tearDown(self):
        for patcher in reversed(self.patchers):
            patcher.stop()
        self.temp.cleanup()

    def test_migration_is_validated_archived_and_idempotent(self):
        source = {
            "version": 1,
            "updatedAt": "2026-03-20T00:00:00Z",
            "year": 2026,
            "month": 3,
            "itineraryByMonth": {
                "2026-03": {"Shenzhen": [{"start": "2026-03-01", "end": "2026-03-03"}]},
            },
            "optionsByMonth": {"2026-03": {"region": "Mainland", "includeTravel": False}},
            "subscriptionsByMonth": {"2026-03": {"items": [], "retiredIds": []}},
            "annualBudgetsByYear": {"2026": {"CNY": 1200}},
        }
        source_bytes = (json.dumps(source, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        v2.APP_STATE_FILE.write_bytes(source_bytes)

        result = v2.migrate_v1_to_v2()

        self.assertTrue(result["migrated"])
        self.assertFalse(v2.APP_STATE_FILE.exists())
        months, global_document = v2.validate_v2_store()
        self.assertEqual(set(months), {"2026-03"})
        self.assertEqual(months["2026-03"]["itinerary"]["Shenzhen"][0]["end"], "2026-03-03")
        self.assertEqual(global_document["selectedMonth"], "2026-03")
        self.assertEqual(global_document["annualBudgetsByYear"]["2026"]["CNY"], 1200.0)
        archives = list(v2.LEGACY_DATA_DIR.glob("app-state.v1-*.json"))
        self.assertEqual(len(archives), 1)
        self.assertEqual(archives[0].read_bytes(), source_bytes)
        reports = list(v2.LEGACY_DATA_DIR.glob("migration-v1-to-v2-*.json"))
        self.assertEqual(len(reports), 1)
        report = json.loads(reports[0].read_text(encoding="utf-8"))
        self.assertEqual(report["unmigrated"], [])
        self.assertEqual(report["months"][0]["sourceFields"], [
            "itineraryByMonth", "optionsByMonth", "subscriptionsByMonth",
        ])
        self.assertEqual(report["months"][0]["output"]["itineraryLocations"], 1)
        self.assertTrue(list(self.backups.iterdir()), "迁移前必须创建不可变备份")
        checkpoint = Path(report["postMigrationCheckpoint"])
        self.assertTrue(checkpoint.is_dir())
        checkpoint_row = next(
            row for row in v2.list_backups()["backups"] if row["id"] == checkpoint.name
        )
        self.assertTrue(checkpoint_row["restorable"])

        again = v2.migrate_v1_to_v2()
        self.assertEqual(again["status"], "v2-ready")
        self.assertEqual(len(list(v2.LEGACY_DATA_DIR.glob("app-state.v1-*.json"))), 1)

    def test_month_entity_cas_and_subscription_inheritance(self):
        march, created = v2.ensure_month("2026-03")
        self.assertTrue(created)
        self.assertEqual(march["createdFrom"], {
            "kind": "defaults", "defaultsRevision": "0" * 64,
        })
        self.assertEqual([item["id"] for item in march["subscriptions"]["items"]], ["nomad-esim"])

        changed = copy.deepcopy(march)
        changed["subscriptions"]["items"][0]["amount"] = 99
        changed["subscriptions"]["items"][0]["appliesTo"] = {
            "Mainland": False, "Overseas": True,
        }
        saved = v2.save_month("2026-03", changed, base_revision=1)
        self.assertEqual(saved["revision"], 2)

        april, _ = v2.ensure_month("2026-04")
        item = april["subscriptions"]["items"][0]
        self.assertEqual(item["amount"], 8.0, "新月份重新使用目录标准金额")
        self.assertEqual(item["appliesTo"], {"Mainland": False, "Overseas": True})
        with self.assertRaises(app_contracts.StateConflictError):
            v2.save_month("2026-03", changed, base_revision=1)

    def test_ensure_rejects_defaults_revision_that_changed_after_confirmation(self):
        with self.assertRaisesRegex(v2.app_defaults.DefaultsRevisionConflict, "发生变化"):
            v2.ensure_month("2026-03", expected_defaults_revision="f" * 64)
        self.assertFalse((v2.MONTHS_DIR / "2026-03.json").exists())

    def test_new_future_month_is_rejected_before_any_file_is_created(self):
        today = dt.date.today()
        if today.month == 12:
            year, month = today.year + 1, 1
        else:
            year, month = today.year, today.month + 1
        key = f"{year:04d}-{month:02d}"
        with self.assertRaisesRegex(ValueError, "未来月份"):
            v2.ensure_month(key)
        self.assertFalse((v2.MONTHS_DIR / f"{key}.json").exists())

    def test_corrupt_defaults_block_new_month_and_v1_migration(self):
        with mock.patch.object(v2.app_defaults, "defaults_load_error", return_value="损坏"):
            with self.assertRaisesRegex(ValueError, "拒绝用出厂值"):
                v2.ensure_month("2026-03")
            v2.APP_STATE_FILE.write_text(json.dumps({"version": 1}), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "迁移已中止"):
                v2.migrate_v1_to_v2()
        self.assertTrue(v2.APP_STATE_FILE.exists())
        self.assertFalse(v2.GLOBAL_STATE_FILE.exists())

    def test_new_month_snapshot_includes_builtin_display_names(self):
        snapshot = _defaults_snapshot()
        snapshot["location_names"] = {}
        snapshot["currency_names"] = {}
        with mock.patch.object(v2.app_defaults, "default_standards_snapshot", return_value=snapshot):
            month, _ = v2.ensure_month("2026-03")
        self.assertEqual(month["standards"]["_location_names"]["Shenzhen"], "深圳")
        self.assertEqual(month["standards"]["_currency_names"]["CNY"], "人民币")

    def test_existing_month_does_not_drift_when_defaults_change(self):
        march, _ = v2.ensure_month("2026-03")
        march_bytes = (v2.MONTHS_DIR / "2026-03.json").read_bytes()
        changed = _defaults_snapshot()
        changed["variable"]["Shenzhen"]["CNY"] = 999.0
        changed["subscriptions"][0]["amount"] = 88.0
        with mock.patch.object(v2.app_defaults, "default_standards_snapshot", return_value=changed):
            april, _ = v2.ensure_month("2026-04")
        self.assertEqual((v2.MONTHS_DIR / "2026-03.json").read_bytes(), march_bytes)
        self.assertEqual(march["standards"]["variable"]["Shenzhen"]["CNY"], 85.0)
        self.assertEqual(april["standards"]["variable"]["Shenzhen"]["CNY"], 999.0)
        self.assertEqual(april["subscriptions"]["items"][0]["amount"], 88.0)

    def test_input_edit_marks_server_result_stale_and_binds_input_revision(self):
        month, _ = v2.ensure_month("2026-03")
        with_result = v2.save_month_result(
            "2026-03", {"summary": {"总预算(人民币)": 123}},
            base_revision=month["revision"],
        )
        self.assertEqual(with_result["result"]["inputRevision"], 1)
        self.assertFalse(with_result["result"]["stale"])
        changed = copy.deepcopy(with_result)
        changed["options"]["region"] = "Overseas"
        saved = v2.save_month("2026-03", changed, base_revision=with_result["revision"])
        self.assertTrue(saved["result"]["stale"])
        self.assertIn("重新计算", saved["result"]["staleReason"])

    def test_delete_is_durable_until_explicit_ensure(self):
        month, _ = v2.ensure_month("2026-03")
        v2.delete_month("2026-03", base_revision=month["revision"])
        self.assertIsNone(v2.load_month("2026-03"))
        self.assertEqual(v2.list_months(), {})
        with self.assertRaises(app_contracts.StateConflictError):
            v2.save_month("2026-03", month, base_revision=month["revision"])
        recreated, created = v2.ensure_month("2026-03")
        self.assertTrue(created)
        self.assertEqual(recreated["revision"], 1)

    def test_corrupt_month_is_reported_without_hiding_valid_months(self):
        v2.ensure_month("2026-03")
        (v2.MONTHS_DIR / "2026-04.json").write_text("{broken", encoding="utf-8")
        months, errors = v2.scan_months()
        self.assertEqual(set(months), {"2026-03"})
        self.assertIn("2026-04.json", errors)
        payload = v2.api_get_months()
        self.assertEqual(set(payload["months"]), {"2026-03"})
        self.assertIn("2026-04.json", payload["errors"])
        with self.assertRaisesRegex(ValueError, "2026-04.json"):
            v2.list_months()

    def test_migration_rejects_overlapping_raw_v1_itinerary_without_rewriting_source(self):
        source = {
            "version": 1, "year": 2026, "month": 3,
            "itineraryByMonth": {"2026-03": {
                "Shenzhen": [{"start": "2026-03-01", "end": "2026-03-02"}],
                "Shanghai": [{"start": "2026-03-02", "end": "2026-03-03"}],
            }},
        }
        source_bytes = (json.dumps(source, ensure_ascii=False) + "\n").encode("utf-8")
        v2.APP_STATE_FILE.write_bytes(source_bytes)
        with self.assertRaisesRegex(ValueError, "同时分配"):
            v2.migrate_v1_to_v2()
        self.assertEqual(v2.APP_STATE_FILE.read_bytes(), source_bytes)
        self.assertFalse(v2.GLOBAL_STATE_FILE.exists())

    def test_migration_resumes_after_month_directory_was_published_before_global(self):
        source = {
            "version": 1, "updatedAt": "2026-03-20T00:00:00Z",
            "year": 2026, "month": 3,
            "itineraryByMonth": {"2026-03": {
                "Shenzhen": [{"start": "2026-03-01", "end": "2026-03-01"}],
            }},
        }
        v2.APP_STATE_FILE.write_text(json.dumps(source), encoding="utf-8")
        months, _, _ = v2._build_migration_documents(source)
        v2.MONTHS_DIR.mkdir()
        for month, document in months.items():
            (v2.MONTHS_DIR / f"{month}.json").write_text(v2._json_text(document), encoding="utf-8")

        result = v2.migrate_v1_to_v2()

        self.assertTrue(result["migrated"])
        self.assertTrue(v2.GLOBAL_STATE_FILE.exists())
        self.assertFalse(v2.APP_STATE_FILE.exists())
        self.assertEqual(set(v2.list_months()), {"2026-03"})

    def test_migration_rejects_unknown_v1_top_level_fields_without_rewriting_source(self):
        source = {"version": 1, "userNote": "must not disappear"}
        source_bytes = (json.dumps(source) + "\n").encode("utf-8")
        v2.APP_STATE_FILE.write_bytes(source_bytes)

        with self.assertRaisesRegex(ValueError, "无法迁移的未知字段.*userNote"):
            v2.migrate_v1_to_v2()

        self.assertEqual(v2.APP_STATE_FILE.read_bytes(), source_bytes)
        self.assertFalse(v2.GLOBAL_STATE_FILE.exists())
        self.assertFalse(self.backups.exists())

    def test_migration_rejects_unknown_or_mistyped_v1_versions(self):
        for version in (999, True, "1"):
            with self.subTest(version=version):
                source_bytes = (json.dumps({"version": version}) + "\n").encode("utf-8")
                v2.APP_STATE_FILE.write_bytes(source_bytes)
                with self.assertRaisesRegex(ValueError, "version 仅支持"):
                    v2.migrate_v1_to_v2()
                self.assertEqual(v2.APP_STATE_FILE.read_bytes(), source_bytes)
                self.assertFalse(v2.GLOBAL_STATE_FILE.exists())

    def test_published_v2_must_exactly_match_residual_v1_before_archiving(self):
        v2.ensure_month("2026-04")
        v2.save_selection("2026-04")
        existing_global = v2.GLOBAL_STATE_FILE.read_bytes()
        existing_april = (v2.MONTHS_DIR / "2026-04.json").read_bytes()
        source = {
            "version": 1, "updatedAt": "2026-03-20T00:00:00Z",
            "year": 2026, "month": 3,
            "itineraryByMonth": {"2026-03": {
                "Shenzhen": [{"start": "2026-03-01", "end": "2026-03-01"}],
            }},
        }
        source_bytes = (json.dumps(source) + "\n").encode("utf-8")
        v2.APP_STATE_FILE.write_bytes(source_bytes)

        with self.assertRaisesRegex(ValueError, "残留 v1 与已发布 v2 不一致"):
            v2.migrate_v1_to_v2()

        self.assertEqual(v2.APP_STATE_FILE.read_bytes(), source_bytes)
        self.assertEqual(v2.GLOBAL_STATE_FILE.read_bytes(), existing_global)
        self.assertEqual((v2.MONTHS_DIR / "2026-04.json").read_bytes(), existing_april)
        self.assertFalse(v2.LEGACY_DATA_DIR.exists())

    def test_exact_published_v2_resumes_with_full_report_and_checkpoint(self):
        source = {
            "version": 1, "updatedAt": "2026-03-20T00:00:00Z",
            "year": 2026, "month": 3,
            "itineraryByMonth": {"2026-03": {
                "Shenzhen": [{"start": "2026-03-01", "end": "2026-03-01"}],
            }},
        }
        source_bytes = (json.dumps(source) + "\n").encode("utf-8")
        v2.APP_STATE_FILE.write_bytes(source_bytes)
        months, global_document, _ = v2._build_migration_documents(source)
        v2.MONTHS_DIR.mkdir()
        for month, document in months.items():
            (v2.MONTHS_DIR / f"{month}.json").write_text(
                v2._json_text(document), encoding="utf-8",
            )
        v2.GLOBAL_STATE_FILE.write_text(v2._json_text(global_document), encoding="utf-8")

        result = v2.migrate_v1_to_v2()

        self.assertEqual(result["status"], "archive-completed")
        self.assertFalse(v2.APP_STATE_FILE.exists())
        report = json.loads(Path(result["report"]).read_text(encoding="utf-8"))
        self.assertEqual(report["months"][0]["sourceFields"], ["itineraryByMonth"])
        pre_backup = Path(report["preMigrationBackup"])
        self.assertTrue(pre_backup.is_dir())
        pre_manifest = json.loads(
            (pre_backup / "manifest.json").read_text(encoding="utf-8")
        )
        self.assertIn("data/app-state.json", {
            entry["path"] for entry in pre_manifest["files"]
        })
        self.assertTrue(Path(report["postMigrationCheckpoint"]).is_dir())
        self.assertEqual(v2.migrate_v1_to_v2()["status"], "v2-ready")

    def test_report_is_resumed_after_archive_completed_before_report_publish(self):
        source = {
            "version": 1, "updatedAt": "2026-03-20T00:00:00Z",
            "year": 2026, "month": 3,
            "itineraryByMonth": {"2026-03": {
                "Shenzhen": [{"start": "2026-03-01", "end": "2026-03-01"}],
            }},
        }
        source_bytes = (json.dumps(source) + "\n").encode("utf-8")
        v2.APP_STATE_FILE.write_bytes(source_bytes)
        with mock.patch.object(v2, "_write_migration_report", side_effect=OSError("report fail")):
            with self.assertRaisesRegex(OSError, "report fail"):
                v2.migrate_v1_to_v2()
        self.assertFalse(v2.APP_STATE_FILE.exists())
        self.assertEqual(len(list(v2.LEGACY_DATA_DIR.glob("*.pending.json"))), 1)

        result = v2.migrate_v1_to_v2()

        self.assertEqual(result["status"], "report-completed")
        self.assertFalse(list(v2.LEGACY_DATA_DIR.glob("*.pending.json")))
        report = json.loads(Path(result["report"]).read_text(encoding="utf-8"))
        self.assertEqual(report["months"][0]["sourceFields"], ["itineraryByMonth"])

    def test_retry_reuses_prepared_evidence_when_archive_initially_fails(self):
        source = {
            "version": 1, "updatedAt": "2026-03-20T00:00:00Z",
            "year": 2026, "month": 3,
            "itineraryByMonth": {"2026-03": {
                "Shenzhen": [{"start": "2026-03-01", "end": "2026-03-01"}],
            }},
        }
        v2.APP_STATE_FILE.write_text(json.dumps(source), encoding="utf-8")
        with mock.patch.object(v2, "_archive_legacy", side_effect=OSError("archive fail")):
            with self.assertRaisesRegex(OSError, "archive fail"):
                v2.migrate_v1_to_v2()
        pending_path = next(v2.LEGACY_DATA_DIR.glob("*.pending.json"))
        pending = json.loads(pending_path.read_text(encoding="utf-8"))
        original_pre = pending["preMigrationBackup"]
        original_post = pending["postMigrationCheckpoint"]
        backup_count = len(list(self.backups.iterdir()))

        result = v2.migrate_v1_to_v2()

        self.assertEqual(result["status"], "archive-completed")
        report = json.loads(Path(result["report"]).read_text(encoding="utf-8"))
        self.assertEqual(report["preMigrationBackup"], original_pre)
        self.assertEqual(report["postMigrationCheckpoint"], original_post)
        self.assertEqual(len(list(self.backups.iterdir())), backup_count)
        self.assertFalse(pending_path.exists())

    def test_retry_after_prepared_journal_write_failure_keeps_a_prebackup_reference(self):
        source = {
            "version": 1, "updatedAt": "2026-03-20T00:00:00Z",
            "year": 2026, "month": 3,
            "itineraryByMonth": {"2026-03": {
                "Shenzhen": [{"start": "2026-03-01", "end": "2026-03-01"}],
            }},
        }
        v2.APP_STATE_FILE.write_text(json.dumps(source), encoding="utf-8")
        with mock.patch.object(
                v2, "_write_migration_pending", side_effect=OSError("journal fail")):
            with self.assertRaisesRegex(OSError, "journal fail"):
                v2.migrate_v1_to_v2()
        self.assertTrue(v2.APP_STATE_FILE.exists())
        self.assertFalse(v2.GLOBAL_STATE_FILE.exists())

        result = v2.migrate_v1_to_v2()

        report = json.loads(Path(result["report"]).read_text(encoding="utf-8"))
        self.assertIsInstance(report["preMigrationBackup"], str)
        self.assertTrue(Path(report["preMigrationBackup"]).is_dir())
        self.assertTrue(Path(report["postMigrationCheckpoint"]).is_dir())

    def test_legacy_archive_preserves_all_source_bytes_and_rejects_conflicts(self):
        payloads = (
            b'{"version":1}\n',
            b'{"version":1}\r\n',
            b'\xef\xbb\xbf{"version":1}\n',
            b'\xef\xbb\xbf{"version":1}\r\n',
        )
        for payload in payloads:
            with self.subTest(payload=payload):
                v2.APP_STATE_FILE.write_bytes(payload)
                source_hash = hashlib.sha256(payload).hexdigest()
                archive = v2._archive_legacy(payload, source_hash)
                self.assertEqual(archive.read_bytes(), payload)
                self.assertFalse(v2.APP_STATE_FILE.exists())

        conflict_payload = b'{"version":2}\n'
        source_hash = hashlib.sha256(conflict_payload).hexdigest()
        conflict_target = v2.LEGACY_DATA_DIR / f"app-state.v1-{source_hash[:16]}.json"
        conflict_target.write_bytes(b"different")
        v2.APP_STATE_FILE.write_bytes(conflict_payload)
        with self.assertRaisesRegex(ValueError, "归档冲突"):
            v2._archive_legacy(conflict_payload, source_hash)
        self.assertEqual(v2.APP_STATE_FILE.read_bytes(), conflict_payload)

    def test_cross_location_overlap_is_rejected_at_state_boundary(self):
        document, _ = v2.ensure_month("2026-03")
        candidate = copy.deepcopy(document)
        candidate["itinerary"] = {
            "Shenzhen": [{"start": "2026-03-01", "end": "2026-03-02"}],
            "Shanghai": [{"start": "2026-03-02", "end": "2026-03-03"}],
        }
        with self.assertRaisesRegex(ValueError, "同时分配"):
            v2.save_month("2026-03", candidate, base_revision=1)

    def test_selection_does_not_advance_business_revision(self):
        first = v2.save_selection("2026-03")
        self.assertEqual(first["revision"], 0)
        saved = v2.save_global({
            "annualBudgetsByYear": {"2026": {"CNY": 100}},
            "annualResultsByYear": {},
            "assetPortfoliosById": {},
        }, base_revision=0)
        self.assertEqual(saved["revision"], 1)
        self.assertEqual(saved["selectedMonth"], "2026-03")
        selected = v2.save_selection("2026-04")
        self.assertEqual(selected["revision"], 1)

    def test_calculate_does_not_save_result_after_input_revision_changes(self):
        document, _ = v2.ensure_month("2026-03")
        candidate = copy.deepcopy(document)
        candidate["itinerary"] = {
            "Shenzhen": [{"start": "2026-03-01", "end": "2026-03-01"}],
        }
        document = v2.save_month("2026-03", candidate, base_revision=1)

        def edit_during_calculation(_request):
            latest = v2.load_month("2026-03")
            latest["options"]["region"] = "Overseas"
            v2.save_month("2026-03", latest, base_revision=latest["revision"])
            return {"summary": {"总预算(人民币)": 1}}

        with mock.patch.object(budget_service, "api_calculate", side_effect=edit_during_calculation):
            with self.assertRaises(app_contracts.StateConflictError):
                budget_service.api_calculate_stored_month(
                    "2026-03", app_contracts.StoredMonthCalculateIn(base_revision=document["revision"]),
                )
        latest = v2.load_month("2026-03")
        self.assertIsNone(latest["result"])
        self.assertEqual(latest["options"]["region"], "Overseas")

    def test_clear_uses_revision_guard_and_creates_backup(self):
        month, _ = v2.ensure_month("2026-03")
        global_document = v2.save_selection("2026-03")
        with self.assertRaises(app_contracts.StateConflictError):
            v2.clear_all(
                user_confirmed=True,
                global_revision=global_document["revision"],
                month_revisions={"2026-03": month["revision"] + 1},
            )
        result = v2.clear_all(
            user_confirmed=True,
            global_revision=global_document["revision"],
            month_revisions={"2026-03": month["revision"]},
        )
        self.assertTrue(result["cleared"])
        self.assertFalse(v2.GLOBAL_STATE_FILE.exists())
        self.assertFalse(v2.MONTHS_DIR.exists())
        manifest = json.loads((Path(result["backup"]) / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(
            {entry["path"] for entry in manifest["files"]},
            {"data/global.json", "data/months/2026-03.json"},
        )

    def test_restore_replaces_whole_store_and_invalidates_stale_tabs(self):
        march, _ = v2.ensure_month("2026-03")
        march = v2.save_month_result(
            "2026-03", {"summary": {"总预算(人民币)": 123}},
            base_revision=march["revision"],
        )
        v2.save_selection("2026-03")
        snapshot = app_backups.create_data_backup(
            reason="test-restore-source",
            state_lock=v2.legacy._state_disk_lock,
            defaults_lock=v2.app_defaults.defaults_disk_lock,
        )

        changed = copy.deepcopy(march)
        changed["options"]["region"] = "Overseas"
        v2.save_month("2026-03", changed, base_revision=march["revision"])
        v2.ensure_month("2026-04")
        catalog = v2.list_backups()

        restored = v2.restore_backup(
            backup_id=snapshot.name,
            base_token=catalog["currentToken"],
            user_confirmed=True,
        )

        self.assertTrue(restored["restored"])
        self.assertEqual(set(v2.list_months()), {"2026-03"})
        current = v2.load_month("2026-03")
        self.assertEqual(current["options"]["region"], "Mainland")
        self.assertGreater(current["revision"], march["revision"])
        self.assertTrue(current["result"]["stale"])
        self.assertIn("备份恢复", current["result"]["staleReason"])
        self.assertTrue(Path(restored["preRestoreBackup"]).is_dir())
        self.assertTrue(snapshot.is_dir(), "恢复不得覆盖、重命名或删除历史快照")
        with self.assertRaises(app_contracts.StateConflictError):
            v2.restore_backup(
                backup_id=snapshot.name,
                base_token=catalog["currentToken"],
                user_confirmed=True,
            )

    def test_restore_can_recover_corrupt_current_month_without_publishing_bad_backup(self):
        v2.ensure_month("2026-03")
        v2.save_selection("2026-03")
        snapshot = app_backups.create_data_backup(
            reason="test-corrupt-recovery-source",
            state_lock=v2.legacy._state_disk_lock,
            defaults_lock=v2.app_defaults.defaults_disk_lock,
        )
        broken = v2.MONTHS_DIR / "2026-03.json"
        broken.write_bytes(b"{broken-current")
        token = v2.list_backups()["currentToken"]

        result = v2.restore_backup(
            backup_id=snapshot.name, base_token=token, user_confirmed=True,
        )

        self.assertIsNone(result["preRestoreBackup"])
        archive = Path(result["recoveryArchive"])
        self.assertEqual((archive / "months" / "2026-03.json").read_bytes(), b"{broken-current")
        self.assertEqual(set(v2.list_months()), {"2026-03"})

    def test_restore_publish_failure_rolls_back_exact_current_authority(self):
        march, _ = v2.ensure_month("2026-03")
        v2.save_selection("2026-03")
        snapshot = app_backups.create_data_backup(
            reason="test-restore-rollback-source",
            state_lock=v2.legacy._state_disk_lock,
            defaults_lock=v2.app_defaults.defaults_disk_lock,
        )
        changed = copy.deepcopy(march)
        changed["options"]["region"] = "Overseas"
        v2.save_month("2026-03", changed, base_revision=march["revision"])
        v2.ensure_month("2026-04")
        before = {
            path.relative_to(self.data).as_posix(): path.read_bytes()
            for path in [v2.GLOBAL_STATE_FILE, *sorted(v2.MONTHS_DIR.glob("*.json"))]
        }
        token = v2.list_backups()["currentToken"]
        real_replace = v2.os.replace

        def fail_global_publish(source, destination):
            source = Path(source)
            if source.name == "global.json" and source.parent.name.startswith(".restore-") \
                    and not source.parent.name.startswith(".restore-old-"):
                raise OSError("injected global publish failure")
            return real_replace(source, destination)

        with mock.patch.object(v2.os, "replace", side_effect=fail_global_publish):
            with self.assertRaisesRegex(OSError, "injected global"):
                v2.restore_backup(
                    backup_id=snapshot.name, base_token=token, user_confirmed=True,
                )

        after = {
            path.relative_to(self.data).as_posix(): path.read_bytes()
            for path in [v2.GLOBAL_STATE_FILE, *sorted(v2.MONTHS_DIR.glob("*.json"))]
        }
        self.assertEqual(after, before)
        self.assertFalse(any(path.name.startswith(".restore-") for path in self.data.iterdir()))


if __name__ == "__main__":
    unittest.main()
