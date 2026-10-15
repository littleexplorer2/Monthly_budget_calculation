"""不绑定项目路径的 UTF-8 文件读写。"""

import json
import os
from pathlib import Path

def atomic_write_text(path: Path, text: str) -> None:
    """跨平台原子写文本（UTF-8）。

    先写同目录临时文件并 fsync，再 os.replace。macOS / iCloud / OneDrive 上
    replace 偶发失败时回退为直接覆盖，避免读到半截文件。
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    payload = text.encode("utf-8")
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    if hasattr(os, "O_BINARY"):
        flags |= os.O_BINARY
    fd = os.open(str(tmp), flags, 0o644)
    try:
        os.write(fd, payload)
        os.fsync(fd)
    finally:
        os.close(fd)
    try:
        os.replace(str(tmp), str(path))
    except OSError:
        path.write_bytes(payload)
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass


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
