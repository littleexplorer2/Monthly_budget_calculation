from application.repository import service as repository_service
import json
import subprocess
import tempfile
import unittest
from pathlib import Path



def run_git(cwd: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=str(cwd),
        capture_output=True,
        check=True,
        text=True,
        encoding="utf-8",
    )


class RepositoryUploadTests(unittest.TestCase):
    def test_upload_commits_budget_state_and_defaults_but_not_rate_cache(self):
        with tempfile.TemporaryDirectory() as temp:
            temp_dir = Path(temp)
            root = temp_dir / "repo"
            remote = temp_dir / "remote.git"
            project = root / "每月预算"
            data_dir = project / "data"
            data_dir.mkdir(parents=True)
            root.mkdir(exist_ok=True)

            run_git(root, "init", "-b", "main")
            run_git(root, "config", "user.name", "Budget Test")
            run_git(root, "config", "user.email", "budget@example.invalid")
            run_git(temp_dir, "init", "--bare", str(remote))

            state_file = data_dir / "app-state.json"
            defaults_file = data_dir / "defaults.json"
            rates_dir = data_dir / "rates"
            rates_dir.mkdir()
            rate_file = rates_dir / "2026-10.json"
            other_file = root / "other.txt"
            state_file.write_text(json.dumps({"version": 1}), encoding="utf-8")
            defaults_file.write_text(json.dumps({"fixed": {"Mainland": {"CNY": 1}}}), encoding="utf-8")
            rate_file.write_text(json.dumps({"USD": {"2026-10-01": 7.0}}), encoding="utf-8")
            other_file.write_text("original", encoding="utf-8")
            run_git(root, "add", "--", "每月预算/data", "other.txt")
            run_git(root, "commit", "-m", "initial")
            run_git(root, "remote", "add", "origin", str(remote))

            state_file.write_text(json.dumps({"version": 2}), encoding="utf-8")
            defaults_file.write_text(json.dumps({"fixed": {"Mainland": {"CNY": 2}}}), encoding="utf-8")
            rate_file.write_text(json.dumps({"USD": {"2026-10-01": 7.2}}), encoding="utf-8")
            other_file.write_text("keep staged", encoding="utf-8")
            run_git(root, "add", "--", "other.txt")

            result = repository_service._upload_data_to_remote(project)

            self.assertTrue(result["uploaded"])
            self.assertTrue(result["committed"])
            self.assertEqual(result["remote"], "origin")
            self.assertEqual(result["branch"], "main")
            self.assertEqual(run_git(root, "show", "HEAD:other.txt").stdout, "original")
            self.assertEqual(run_git(root, "diff", "--cached", "--name-only").stdout.strip(), "other.txt")
            remote_state = run_git(root, "--git-dir", str(remote), "show", "main:每月预算/data/app-state.json")
            self.assertEqual(json.loads(remote_state.stdout), {"version": 2})
            remote_defaults = run_git(root, "--git-dir", str(remote), "show", "main:每月预算/data/defaults.json")
            self.assertEqual(json.loads(remote_defaults.stdout), {"fixed": {"Mainland": {"CNY": 2}}})
            remote_rates = run_git(root, "--git-dir", str(remote), "show", "main:每月预算/data/rates/2026-10.json")
            self.assertEqual(json.loads(remote_rates.stdout), {"USD": {"2026-10-01": 7.0}})
            status = run_git(root, "-c", "core.quotePath=false", "status", "--short").stdout
            self.assertIn("每月预算/data/rates/2026-10.json", status)


if __name__ == "__main__":
    unittest.main()
