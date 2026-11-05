"""不绑定项目路径的 UTF-8 文件读写。"""

import json
import os
from pathlib import Path
import secrets


def _fsync_directory(path: Path) -> None:
    """尽力同步目录项；Windows 不支持目录句柄时保持文件级保证。"""
    flags = os.O_RDONLY
    if hasattr(os, "O_DIRECTORY"):
        flags |= os.O_DIRECTORY
    try:
        fd = os.open(str(path), flags)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)

def atomic_write_text(path: Path, text: str) -> None:
    """跨平台原子写文本（UTF-8）。

    先把完整内容写入同目录唯一临时文件并 fsync，再用 os.replace 发布。
    replace 失败时保留原文件并把错误交给调用方；不得回退为非原子覆盖。
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{secrets.token_hex(16)}.tmp")
    payload = text.encode("utf-8")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_BINARY"):
        flags |= os.O_BINARY
    fd = os.open(str(tmp), flags, 0o644)
    try:
        remaining = memoryview(payload)
        while remaining:
            written = os.write(fd, remaining)
            if written <= 0:
                raise OSError("临时文件写入未取得进展")
            remaining = remaining[written:]
        os.fsync(fd)
    finally:
        os.close(fd)
    try:
        os.replace(str(tmp), str(path))
        _fsync_directory(path.parent)
    except Exception:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        raise


def read_json_file(path: Path, *, strict: bool = False) -> dict | None:
    """读取 JSON 对象；兼容 UTF-8 BOM（Windows 记事本）。

    默认用于可重建的缓存：损坏或缺失返回 None。对用户真实状态设置
    ``strict=True``：文件存在但无法读取时抛出带路径的明确错误，防止后续空状态覆盖。
    """
    path = Path(path)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as exc:
        if strict:
            raise ValueError(f"JSON 文件无法读取或已损坏：{path}（{exc}）") from exc
        return None
    if not isinstance(data, dict):
        if strict:
            raise ValueError(f"JSON 文件顶层必须是对象：{path}")
        return None
    return data
