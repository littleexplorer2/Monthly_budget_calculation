"""把权威用户数据写入只追加快照，并校验显式恢复输入；快照永不参与计算。"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
from pathlib import Path
import re
import shutil
import uuid

from application import config as app_config
from core.storage import atomic_write_text


BACKUP_FORMAT_VERSION = 2
# 公开常量只描述权威数据类别；实际文件集合由 _authoritative_data_files
# 在同一把状态锁内解析，月份实体可以动态增减。
BACKUP_DATA_FILES = ("global.json", "months/*.json", "defaults.json")
_BACKUP_ID_RE = re.compile(r"[A-Za-z0-9._+-]{1,200}")
_MONTH_BACKUP_PATH_RE = re.compile(r"data/months/(\d{4}-(?:0[1-9]|1[0-2]))\.json")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _validated_json_object(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as exc:
        raise ValueError(f"拒绝备份损坏的 JSON 文件：{path.name}（{exc}）") from exc
    if not isinstance(value, dict):
        raise ValueError(f"拒绝备份顶层不是对象的 JSON 文件：{path.name}")
    return value


def _snapshot_name(created_at: dt.datetime, token: str) -> str:
    local = created_at.astimezone()
    milliseconds = local.microsecond // 1000
    offset = local.strftime("%z") or "+0000"
    return (
        f"{local:%Y-%m-%d_%H-%M-%S}.{milliseconds:03d}_"
        f"UTC{offset}_run-{token[:8]}"
    )


def _authoritative_data_files() -> list[Path]:
    """返回当前存储代际的权威 JSON；从不包含缓存或本机 legacy 归档。"""
    data_dir = app_config.DATA_DIR
    global_file = data_dir / "global.json"
    files: list[Path] = []
    if global_file.is_file():
        files.append(global_file)
        months_dir = data_dir / "months"
        if months_dir.exists():
            files.extend(sorted(path for path in months_dir.glob("*.json") if path.is_file()))
    else:
        # 只供尚未迁移的启动前备份使用；v2 运行时不读取该文件。
        legacy_state = data_dir / "app-state.json"
        if legacy_state.is_file():
            files.append(legacy_state)
    defaults = data_dir / "defaults.json"
    if defaults.is_file():
        files.append(defaults)
    return files


def _current_authoritative_paths() -> list[Path]:
    """为恢复 CAS 计算当前原始字节集合，损坏/未完成的存储也必须可参与。"""
    data_dir = app_config.DATA_DIR
    candidates: list[Path] = []
    for name in ("global.json", "defaults.json", "app-state.json"):
        path = data_dir / name
        if path.is_file():
            candidates.append(path)
    months_dir = data_dir / "months"
    if months_dir.is_dir():
        candidates.extend(sorted(path for path in months_dir.glob("*.json") if path.is_file()))
    return sorted(candidates, key=lambda path: path.relative_to(data_dir).as_posix())


def current_data_token() -> str:
    """返回覆盖损坏文件原始字节的存储令牌，用于显式恢复的乐观并发保护。"""
    digest = hashlib.sha256()
    for path in _current_authoritative_paths():
        relative = path.relative_to(app_config.DATA_DIR).as_posix().encode("utf-8")
        payload = path.read_bytes()
        digest.update(len(relative).to_bytes(4, "big"))
        digest.update(relative)
        digest.update(len(payload).to_bytes(8, "big"))
        digest.update(payload)
    return digest.hexdigest()


def _backup_directory(snapshot_id: str) -> Path:
    if not isinstance(snapshot_id, str) or not _BACKUP_ID_RE.fullmatch(snapshot_id):
        raise ValueError("备份标识无效")
    root = app_config.BACKUP_DIR.resolve()
    candidate = (root / snapshot_id).resolve()
    if candidate.parent != root or not candidate.is_dir():
        raise ValueError("所选备份不存在")
    return candidate


def _load_restore_snapshot(snapshot_id: str) -> dict:
    """校验一个 v2 快照的清单、路径、摘要与 JSON，再返回只读文档。"""
    directory = _backup_directory(snapshot_id)
    manifest_path = directory / "manifest.json"
    manifest = _validated_json_object(manifest_path)
    if manifest.get("formatVersion") != BACKUP_FORMAT_VERSION or manifest.get("immutable") is not True:
        raise ValueError("所选备份不是受支持的不可变 v2 快照")
    entries = manifest.get("files")
    if not isinstance(entries, list):
        raise ValueError("备份清单缺少 files 数组")

    documents: dict[str, dict] = {}
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            raise ValueError(f"备份清单 files[{index}] 必须是对象")
        relative = entry.get("path")
        if not isinstance(relative, str):
            raise ValueError(f"备份清单 files[{index}].path 必须是字符串")
        allowed = relative in {"data/global.json", "data/defaults.json"} \
            or _MONTH_BACKUP_PATH_RE.fullmatch(relative)
        if not allowed:
            raise ValueError(f"备份包含不受支持的路径：{relative!r}")
        if relative in documents:
            raise ValueError(f"备份清单路径重复：{relative}")
        source = directory.joinpath(*relative.split("/"))
        if not source.is_file():
            raise ValueError(f"备份文件缺失：{relative}")
        payload = source.read_bytes()
        if entry.get("bytes") != len(payload) or entry.get("sha256") != _sha256(source):
            raise ValueError(f"备份文件摘要不匹配：{relative}")
        documents[relative] = _validated_json_object(source)

    actual = {
        path.relative_to(directory).as_posix()
        for path in (directory / "data").rglob("*.json")
        if path.is_file()
    } if (directory / "data").is_dir() else set()
    if actual != set(documents):
        raise ValueError("备份数据目录与清单不一致")
    if "data/global.json" not in documents:
        raise ValueError("备份不含 v2 global.json，不能用于整库恢复")
    return {"id": snapshot_id, "manifest": manifest, "documents": documents}


def _inspect_snapshot_manifest(directory: Path) -> dict:
    """只读清单和文件元数据；列表接口不得扫描历史快照 payload。"""
    manifest = _validated_json_object(directory / "manifest.json")
    entries = manifest.get("files")
    if not isinstance(entries, list):
        raise ValueError("备份清单缺少 files 数组")
    paths: list[str] = []
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            raise ValueError(f"备份清单 files[{index}] 必须是对象")
        relative = entry.get("path")
        if not isinstance(relative, str):
            raise ValueError(f"备份清单 files[{index}].path 必须是字符串")
        is_v2_path = relative in {"data/global.json", "data/defaults.json"} \
            or _MONTH_BACKUP_PATH_RE.fullmatch(relative)
        is_v1_path = relative in {"data/app-state.json", "data/defaults.json"}
        if not is_v2_path and not is_v1_path:
            raise ValueError(f"备份包含不受支持的路径：{relative!r}")
        if relative in paths:
            raise ValueError(f"备份清单路径重复：{relative}")
        source = directory.joinpath(*relative.split("/"))
        if not source.is_file():
            raise ValueError(f"备份文件缺失：{relative}")
        expected_bytes = entry.get("bytes")
        if isinstance(expected_bytes, bool) or not isinstance(expected_bytes, int) \
                or expected_bytes < 0 or source.stat().st_size != expected_bytes:
            raise ValueError(f"备份文件大小与清单不一致：{relative}")
        digest = entry.get("sha256")
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", digest):
            raise ValueError(f"备份清单摘要无效：{relative}")
        paths.append(relative)

    actual = {
        path.relative_to(directory).as_posix()
        for path in (directory / "data").rglob("*.json")
        if path.is_file()
    } if (directory / "data").is_dir() else set()
    if actual != set(paths):
        raise ValueError("备份数据目录与清单不一致")

    v2_paths = all(
        path in {"data/global.json", "data/defaults.json"}
        or _MONTH_BACKUP_PATH_RE.fullmatch(path)
        for path in paths
    )
    is_v2 = (
        manifest.get("formatVersion") == BACKUP_FORMAT_VERSION
        and manifest.get("immutable") is True
        and "data/global.json" in paths
        and v2_paths
    )
    is_v1 = (
        manifest.get("immutable") is True
        and "data/app-state.json" in paths
        and set(paths) <= {"data/app-state.json", "data/defaults.json"}
    )
    if is_v2:
        kind = "v2"
        restorable = True
        error = None
    elif is_v1:
        kind = "legacy-v1"
        restorable = False
        error = "旧版 v1 快照须使用对应旧版本在隔离目录中人工回滚"
    else:
        kind = "unsupported"
        restorable = False
        error = "快照格式不受当前整库恢复流程支持"
    return {
        "id": directory.name,
        "createdAt": manifest.get("createdAt"),
        "reason": manifest.get("reason"),
        "fileCount": len(paths),
        "monthCount": sum(1 for path in paths if _MONTH_BACKUP_PATH_RE.fullmatch(path)),
        "kind": kind,
        "restorable": restorable,
        "verification": "restore-time" if restorable else "manifest-only",
        "error": error,
    }


def list_data_backups() -> dict:
    """只读清单列出备份；payload 仅在用户明确恢复后读取和验真。"""
    entries = []
    root = app_config.BACKUP_DIR
    if root.is_dir():
        for directory in sorted((path for path in root.iterdir() if path.is_dir()), reverse=True):
            if directory.name.startswith("."):
                continue
            try:
                entries.append(_inspect_snapshot_manifest(directory))
            except (OSError, ValueError) as exc:
                entries.append({
                    "id": directory.name,
                    "createdAt": None,
                    "reason": None,
                    "fileCount": 0,
                    "monthCount": 0,
                    "kind": "damaged-manifest",
                    "restorable": False,
                    "verification": "manifest-only",
                    "error": str(exc),
                })
    return {"backups": entries, "currentToken": current_data_token()}


def load_restore_snapshot(snapshot_id: str) -> dict:
    """公开的恢复输入加载器；调用方仍须执行 v2 schema 校验与原子发布。"""
    return _load_restore_snapshot(snapshot_id)


def create_data_backup(*, reason: str = "server-stopped", now: dt.datetime | None = None,
                       state_lock, defaults_lock,
                       legacy_v1_only: bool = False) -> Path:
    """建立一个新的退出快照；只创建新目录，从不读取或改写历史备份。

    备份只包含不可重建的用户状态和默认配置。``legacy_v1_only`` 仅供
    v2 已发布但 v1 尚未归档的迁移续跑使用，强制保存 v1+defaults。
    汇率缓存不属于权威用户数据，因而不复制。调用方可把
    ``DATA_DIR`` / ``BACKUP_DIR`` 指向临时目录测试。
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
        # 固定锁顺序：状态 -> 默认配置。复制完成前全部权威文件均不能被替换。
        with state_lock:
            with defaults_lock:
                data_copy = pending / "data"
                data_copy.mkdir()
                if legacy_v1_only:
                    legacy_state = app_config.DATA_DIR / "app-state.json"
                    if not legacy_state.is_file():
                        raise ValueError("迁移续跑缺少 data/app-state.json，无法建立 v1 快照")
                    sources = [legacy_state]
                    legacy_defaults = app_config.DATA_DIR / "defaults.json"
                    if legacy_defaults.is_file():
                        sources.append(legacy_defaults)
                else:
                    sources = _authoritative_data_files()
                for source in sources:
                    relative = source.relative_to(app_config.DATA_DIR)
                    target = data_copy / relative
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(source, target)
                    document = _validated_json_object(target)
                    files.append({
                        "path": f"data/{relative.as_posix()}",
                        "bytes": target.stat().st_size,
                        "sha256": _sha256(target),
                        "jsonObject": True,
                        "schemaVersion": document.get("schemaVersion", document.get("version")),
                    })

        manifest = {
            "formatVersion": BACKUP_FORMAT_VERSION,
            "createdAt": created_at.isoformat(timespec="milliseconds"),
            "reason": str(reason)[:120],
            "immutable": True,
            "calculationInput": False,
            "files": files,
            "excluded": ["data/rates/", "data/legacy/"],
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
