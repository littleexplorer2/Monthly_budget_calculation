"""通用存储模块的公共接口。"""

from .files import atomic_write_text, read_json_file

__all__ = ["atomic_write_text", "read_json_file"]
