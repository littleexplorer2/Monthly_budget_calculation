"""项目路径的唯一来源；与工作目录及入口调用方式无关。"""

from pathlib import Path

BASE_DIR = Path(__file__).resolve().parents[2]
DATA_DIR = BASE_DIR / "data"
WEB_DIR = BASE_DIR / "web"
