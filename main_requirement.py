# -*- coding: utf-8 -*-
"""一键安装项目依赖。

用法：
    python main_requirement.py

脚本使用当前 Python 解释器执行 pip，因此在虚拟环境中运行时，
依赖会安装到当前虚拟环境，而不是系统 Python。
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent
REQUIREMENTS_FILE = BASE_DIR / "requirements.txt"


def main() -> int:
    if not REQUIREMENTS_FILE.is_file():
        print(f"错误：找不到依赖清单：{REQUIREMENTS_FILE}", file=sys.stderr)
        return 1

    command = [
        sys.executable,
        "-m",
        "pip",
        "install",
        "--upgrade",
        "-r",
        str(REQUIREMENTS_FILE),
    ]
    print(f"使用 Python：{sys.executable}")
    print(f"安装依赖：{REQUIREMENTS_FILE}")

    try:
        completed = subprocess.run(command, cwd=BASE_DIR, check=False)
    except OSError as exc:
        print(f"错误：无法启动 pip：{exc}", file=sys.stderr)
        return 1

    if completed.returncode != 0:
        print(
            f"错误：依赖安装失败，pip 返回码为 {completed.returncode}",
            file=sys.stderr,
        )
        return completed.returncode

    print("依赖安装完成。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
