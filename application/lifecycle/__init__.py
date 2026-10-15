"""lifecycle 模块公开入口。"""

from .service import (
    AUTO_SHUTDOWN_ENABLED,
    SHUTDOWN_GRACE_SECONDS,
    _SHUTDOWN_FLUSH_SECONDS as SHUTDOWN_FLUSH_SECONDS,
    _TAB_LEASE_SECONDS as TAB_LEASE_SECONDS,
    _tabs_lock as tabs_lock,
    _open_tabs as open_tabs,
    _shutdown_timer as shutdown_timer,
    _tab_expiry_timer as tab_expiry_timer,
    _cancel_shutdown_timer as cancel_shutdown_timer,
    _arm_shutdown_timer as arm_shutdown_timer,
    _cancel_tab_expiry_timer_locked as cancel_tab_expiry_timer_locked,
    _schedule_tab_expiry_check_locked as schedule_tab_expiry_check_locked,
    _expire_stale_tabs as expire_stale_tabs,
    api_tabs_register as tabs_register,
    api_tabs_heartbeat as tabs_heartbeat,
    api_tabs_unregister as tabs_unregister,
    configure,
    settings,
)
