"""state 模块公开入口：v2 月份实体与全局实体。"""

from .service import (
    _state_disk_lock as state_disk_lock,
)
from .v2 import (
    SCHEMA_VERSION,
    api_clear_all as clear_all,
    api_delete_month as delete_month,
    api_ensure_month as ensure_month,
    api_get_global as get_global,
    api_get_month as get_month,
    api_get_months as get_months,
    api_put_global as put_global,
    api_put_month as put_month,
    api_put_selection as put_selection,
    api_list_backups as list_backups,
    api_restore_backup as restore_backup,
    scan_months,
    load_global,
    load_month,
    migrate_v1_to_v2,
    save_final_bundle,
    save_month_result,
)

__all__ = [
    "SCHEMA_VERSION", "state_disk_lock", "scan_months", "load_global", "load_month",
    "migrate_v1_to_v2", "save_final_bundle", "save_month_result",
    "get_months", "get_month", "ensure_month", "put_month", "delete_month",
    "get_global", "put_global", "put_selection", "clear_all", "list_backups",
    "restore_backup",
]
