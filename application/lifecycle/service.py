"""标签页租约与服务关闭协调。"""

from __future__ import annotations

from fastapi.responses import JSONResponse
import os
import threading
import time
from application import contracts as app_contracts
from application import repository as app_repository
from application import state as app_state
import logging

logger = logging.getLogger("budget-web")


AUTO_SHUTDOWN_ENABLED = True



SHUTDOWN_GRACE_SECONDS = 0.0



_SHUTDOWN_FLUSH_SECONDS = 0.3



_TAB_LEASE_SECONDS = 20.0



_tabs_lock = threading.Lock()



_open_tabs: dict[str, float] = {}



_shutdown_timer: threading.Timer | None = None



_tab_expiry_timer: threading.Timer | None = None



def _cancel_shutdown_timer() -> None:
    global _shutdown_timer
    if _shutdown_timer is not None:
        _shutdown_timer.cancel()
        _shutdown_timer = None



def _arm_shutdown_timer() -> None:
    """最后一个页面已关闭：保存完成后立即退出进程并释放端口。"""
    global _shutdown_timer
    _cancel_shutdown_timer()
    delay = max(_SHUTDOWN_FLUSH_SECONDS, float(SHUTDOWN_GRACE_SECONDS or 0.0))

    def _do_shutdown() -> None:
        logger.info("所有浏览器页面均已关闭，立即停止服务并释放端口。")
        # 等正在写入的 app-state.json 完成，避免 Windows 上 replace 被中途杀掉
        acquired = app_state.state_disk_lock.acquire(timeout=2.0)
        if acquired:
            app_state.state_disk_lock.release()
        # 用户可能在上传完成前关闭页面；不要在 Git commit/push 中途杀掉进程。
        upload_acquired = app_repository.repository_upload_lock.acquire(timeout=app_repository.GIT_PUSH_TIMEOUT + 5)
        if upload_acquired:
            app_repository.repository_upload_lock.release()
        os._exit(0)

    _shutdown_timer = threading.Timer(delay, _do_shutdown)
    _shutdown_timer.daemon = True
    _shutdown_timer.start()



def _cancel_tab_expiry_timer_locked() -> None:
    """取消标签页租约计时器；调用方必须持有 _tabs_lock。"""
    global _tab_expiry_timer
    if _tab_expiry_timer is not None:
        _tab_expiry_timer.cancel()
        _tab_expiry_timer = None



def _schedule_tab_expiry_check_locked() -> None:
    """按最早租约到期时间安排检查；调用方必须持有 _tabs_lock。"""
    global _tab_expiry_timer
    _cancel_tab_expiry_timer_locked()
    if not _open_tabs:
        return
    earliest_expiry = min(_open_tabs.values()) + _TAB_LEASE_SECONDS
    delay = max(0.05, earliest_expiry - time.monotonic())
    _tab_expiry_timer = threading.Timer(delay, _expire_stale_tabs)
    _tab_expiry_timer.daemon = True
    _tab_expiry_timer.start()



def _expire_stale_tabs(now: float | None = None) -> None:
    """清理停止心跳的标签页；最后一个失联后按正常流程停止服务。"""
    now = time.monotonic() if now is None else float(now)
    with _tabs_lock:
        cutoff = now - _TAB_LEASE_SECONDS
        expired = [tab_id for tab_id, seen_at in _open_tabs.items() if seen_at <= cutoff]
        for tab_id in expired:
            _open_tabs.pop(tab_id, None)
        if _open_tabs:
            _schedule_tab_expiry_check_locked()
            return
        _cancel_tab_expiry_timer_locked()
        if expired and AUTO_SHUTDOWN_ENABLED:
            logger.info("已清理 %d 个失联浏览器标签页，准备停止服务。", len(expired))
            _arm_shutdown_timer()



def api_tabs_register(body: app_contracts.TabRegisterIn):
    """页面加载时注册；任意注册都会取消待执行的自动退出。"""
    with _tabs_lock:
        _open_tabs[body.tab_id] = time.monotonic()
        _cancel_shutdown_timer()
        _schedule_tab_expiry_check_locked()
        count = len(_open_tabs)
    return {"open_tabs": count}



def api_tabs_heartbeat(body: app_contracts.TabRegisterIn):
    """刷新标签页租约；即使首次注册请求丢失，也把本标签页补登记。"""
    with _tabs_lock:
        _open_tabs[body.tab_id] = time.monotonic()
        _cancel_shutdown_timer()
        _schedule_tab_expiry_check_locked()
        count = len(_open_tabs)
    return {"open_tabs": count}



def api_tabs_unregister(body: app_contracts.TabRegisterIn):
    """页面关闭时注销；先写入本次行程，再在最后一个页面关闭后停止服务。"""
    state_saved = True
    if isinstance(body.state, dict) and body.state:
        try:
            payload = dict(body.state)
            payload.pop("replace", None)
            base_values = payload.pop("baseValues", None)
            state_tab_id = payload.pop("tabId", None)
            sequence = payload.pop("sequence", None)
            if state_tab_id is not None and state_tab_id != body.tab_id:
                raise ValueError("关闭页面状态的 tabId 与注销标签页不一致")
            app_state.save_app_state(
                payload,
                replace=False,
                base_values=base_values,
                tab_id=state_tab_id,
                sequence=sequence,
                allow_partial_conflicts=True,
            )
        except app_contracts.StateConflictError as exc:
            # 旧标签页关闭时不能覆盖其它标签页刚保存的同一月份/年份；冲突键
            # 已安全拒绝，因此仍可完成注销，不把服务误留在后台。
            logger.warning("关闭页面时忽略旧状态快照：%s", exc)
        except Exception:
            state_saved = False
            logger.exception("关闭页面前保存行程失败")
    with _tabs_lock:
        _open_tabs.pop(body.tab_id, None)
        count = len(_open_tabs)
        if count == 0:
            _cancel_tab_expiry_timer_locked()
            if AUTO_SHUTDOWN_ENABLED and state_saved:
                _arm_shutdown_timer()
        else:
            _cancel_shutdown_timer()
    if not state_saved:
        return JSONResponse(status_code=500, content={
            "error": {
                "code": "STATE_SAVE_FAILED",
                "message": "关闭前保存数据失败，服务将保持运行以避免数据丢失",
            },
            "open_tabs": count,
        })
    return {"open_tabs": count}


def configure(*, auto_shutdown: bool, grace: float) -> None:
    """由启动入口设置生命周期选项。"""
    global AUTO_SHUTDOWN_ENABLED, SHUTDOWN_GRACE_SECONDS
    AUTO_SHUTDOWN_ENABLED = auto_shutdown
    SHUTDOWN_GRACE_SECONDS = max(0.0, grace)

def settings() -> dict:
    return {"enabled": AUTO_SHUTDOWN_ENABLED, "grace": SHUTDOWN_GRACE_SECONDS}
