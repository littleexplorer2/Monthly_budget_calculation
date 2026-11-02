"""生产模块目录清单；新增、移动或重命名模块时同步更新。"""

PYTHON_MODULES = {
    "core": ("standards", "budget", "rates", "storage"),
    "application": (
        "config", "defaults", "contracts", "rates", "state", "backups", "lifecycle",
        "repository", "budget", "metadata", "api", "startup",
    ),
}
