"""把权威用户数据写入只追加、永不参与计算的退出快照。"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
from pathlib import Path
import shutil
import uuid

from application import config as app_config
from core.storage import atomic_write_text


BACKUP_FORMAT_VERSION = 1
BACKUP_DATA_FILES = ("app-state.json", "defaults.json")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _snapshot_name(created_at: dt.datetime, token: str) -> str:
    local = created_at.astimezone()
    milliseconds = local.microsecond // 1000
    offset = local.strftime("%z") or "+0000"
    return (
        f"{local:%Y-%m-%d_%H-%M-%S}.{milliseconds:03d}_"
        f"UTC{offset}_run-{token[:8]}"
    )


def create_data_backup(*, reason: str = "server-stopped", now: dt.datetime | None = None,
                       state_lock, defaults_lock) -> Path:
    """建立一个新的退出快照；只创建新目录，从不读取或改写历史备份。

    备份只包含不可重建的用户状态和默认配置。汇率缓存不属于权威用户数据，
    因而不复制。调用方可把 ``DATA_DIR`` / ``BACKUP_DIR`` 指向临时目录测试。
    """
    created_at = (now or dt.datetime.now().astimezone()).astimezone()
    backup_root = app_config.BACKUP_DIR
    backup_root.mkdir(parents=True, exist_ok=True)

    token = uuid.uuid4().hex
    final = backup_root / _snapshot_name(created_at, token)
    while final.exists():
        token = uuid.uuid4().hex
        final = backup_root / _snapshot_name(created_at, token)
    pending = backup_root / f".pending-{token}"
    pending.mkdir(parents=False, exist_ok=False)

    try:
        files = []
        # 固定锁顺序：状态 -> 默认配置。复制完成前两个权威文件均不能被替换。
        with state_lock:
            with defaults_lock:
                data_copy = pending / "data"
                data_copy.mkdir()
                for filename in BACKUP_DATA_FILES:
                    source = app_config.DATA_DIR / filename
                    if not source.is_file():
                        continue
                    target = data_copy / filename
                    shutil.copy2(source, target)
                    files.append({
                        "path": f"data/{filename}",
                        "bytes": target.stat().st_size,
                        "sha256": _sha256(target),
                    })

        manifest = {
            "formatVersion": BACKUP_FORMAT_VERSION,
            "createdAt": created_at.isoformat(timespec="milliseconds"),
            "reason": str(reason)[:120],
            "immutable": True,
            "calculationInput": False,
            "files": files,
            "excluded": ["data/rates/"],
        }
        atomic_write_text(
            pending / "manifest.json",
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        )
        pending.rename(final)
        return final
    except Exception:
        # 只清理本次尚未发布的临时目录；历史快照从不进入此分支。
        if pending.exists():
            shutil.rmtree(pending)
        raise
