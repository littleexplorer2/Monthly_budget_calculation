"""在项目内临时副本运行全部检查，不复制或写入真实 data/。

用法：python tests/run_checks.py [--browser]
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--browser", action="store_true", help="同时运行独立浏览器布局检查")
    args = parser.parse_args()
    node = shutil.which("node")
    if not node:
        print("未找到 Node.js，前端检查无法执行。", file=sys.stderr)
        return 1
    scratch = ROOT / ".scratch"
    scratch.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="checks-", dir=scratch) as temporary:
        project = Path(temporary)
        for directory in ("core", "application", "web", "tests"):
            shutil.copytree(ROOT / directory, project / directory,
                            ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        for filename in ("main_web.py", "functions.py", "main_requirement.py", "requirements.txt"):
            shutil.copy2(ROOT / filename, project / filename)
        temp = project / ".scratch"
        temp.mkdir()
        env = {**os.environ, "TEMP": str(temp), "TMP": str(temp), "TMPDIR": str(temp),
               "PYTHONUTF8": "1", "PYTHONDONTWRITEBYTECODE": "1"}
        commands = [
            [sys.executable, "-m", "py_compile", "functions.py", "main_web.py"],
            [sys.executable, "-m", "compileall", "-q", "core", "application"],
            [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py"],
        ]
        commands += [[node, "--check", str(path.relative_to(project))]
                     for path in sorted((project / "web").rglob("*.js"))
                     if "vendor" not in path.parts]
        commands += [[node, str(path.relative_to(project))]
                     for path in sorted((project / "tests").rglob("*.test.js"))
                     if args.browser or path.name != "annual_layout_browser.test.js"]
        for command in commands:
            print("\n> " + " ".join(command), flush=True)
            result = subprocess.run(command, cwd=project, env=env, check=False)
            if result.returncode:
                return result.returncode
    print("\n所有已选择的检查通过；临时项目副本已清理。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
