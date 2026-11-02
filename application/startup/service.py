"""命令行启动参数与本机服务启动。"""

from __future__ import annotations

import argparse
import logging
import sys
import threading
import webbrowser
from application import api as app_api
from application import backups as app_backups
from application import config as app_config
from application import defaults as app_defaults
from application import lifecycle as app_lifecycle
from application import rates as app_rates
from application import state as app_state


def _ensure_console_utf8() -> None:
    """Windows 控制台默认 GBK，重配置为 UTF-8 保证中文正常输出。"""
    for stream in (sys.stdout, sys.stderr):
        if stream is not None and hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8")
            except Exception:  # noqa: BLE001 - 重配置失败不影响功能
                pass



def main() -> None:
    _ensure_console_utf8()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    parser = argparse.ArgumentParser(description="多币种旅行预算计算器 Web 版")
    parser.add_argument("--host", default="127.0.0.1", help="监听地址（默认仅本机）")
    parser.add_argument("--port", type=int, default=8123, help="监听端口（默认 8123）")
    parser.add_argument("--open", dest="open_browser", action="store_true", default=True,
                        help="启动后自动在浏览器中打开（默认开启）")
    parser.add_argument("--no-open", dest="open_browser", action="store_false",
                        help="启动后不自动打开浏览器")
    parser.add_argument("--no-autoshutdown", action="store_true",
                        help="关闭浏览器页面时不自动停止服务（服务常驻，需手动 Ctrl+C 停止）")
    parser.add_argument("--autoshutdown-grace", type=float, default=0.0,
                        help="最后一个页面关闭后等待的宽限期秒数（默认 0，立即停止并释放端口）")
    args = parser.parse_args()

    app_lifecycle.configure(auto_shutdown=not args.no_autoshutdown, grace=args.autoshutdown_grace)

    url = f"http://{args.host}:{args.port}/"
    print("=" * 60)
    print("多币种旅行预算计算器 Web 版已启动")
    print(f"地址：{url}")
    if app_defaults.defaults_are_customized():
        print("默认预算标准：data/defaults.json（用户保存）")
    else:
        print("默认预算标准：core/standards/builtin.py 出厂值")
    if app_defaults.defaults_load_error():
        print(f"警告：{app_defaults.defaults_load_error()}")
    state_readable = True
    try:
        st = app_state.load_app_state()
    except ValueError as exc:
        # 启动信息只需要统计，不能因为用户状态损坏而让修复页面也无法打开。
        # API 的严格读写仍会拒绝该文件，前端可回退 localStorage 并明确提示。
        state_readable = False
        st = app_state.empty_app_state()
        print(f"警告：项目状态无法读取，服务将以只读修复模式启动：{exc}")
    itin_months = [
        m for m, v in (st.get("itineraryByMonth") or {}).items()
        if app_state.itinerary_range_count({m: v}) > 0
    ]
    print(f"行程数据：data/app-state.json（{len(itin_months)} 个有行程的月份）")
    print(f"内地/境外选项：{len(st.get('optionsByMonth') or {})} 个月")
    print(f"汇率缓存：data/rates/（{len(app_rates.list_rate_months())} 个月）")
    print(f"退出备份：{app_config.BACKUP_DIR}（只追加，不参与预算计算）")
    if state_readable and not itin_months:
        print("提示：行程仍为空。请在「有旧行程的那台 Windows 浏览器」打开本页一次，再 git add data/app-state.json && git commit && git push")
    if args.open_browser:
        print("即将自动打开浏览器")
    if app_lifecycle.settings()["enabled"]:
        if app_lifecycle.settings()["grace"] > app_lifecycle.SHUTDOWN_FLUSH_SECONDS:
            print(f"自动关闭：关闭页面后约 {app_lifecycle.settings()['grace']:g} 秒停止服务并释放端口")
        else:
            print("自动关闭：关闭页面后立即保存数据、停止服务并释放端口")
        print(f"自动关闭兜底：浏览器漏发关闭事件时，失联约 {app_lifecycle.TAB_LEASE_SECONDS:g} 秒后停止服务")
    else:
        print("自动关闭：已禁用（--no-autoshutdown），请手动 Ctrl+C 停止服务")
    print("按 Ctrl+C 停止服务")
    print("=" * 60)

    if args.open_browser:
        threading.Timer(1.2, webbrowser.open, args=(url,)).start()

    import uvicorn
    try:
        uvicorn.run(app_api.app, host=args.host, port=args.port, log_level="info")
    finally:
        try:
            backup_path = app_backups.create_data_backup(
                reason="server-process-stopped",
                state_lock=app_state.state_disk_lock,
                defaults_lock=app_defaults.defaults_disk_lock,
            )
            logging.getLogger("budget-web").info("退出备份已创建：%s", backup_path)
        except Exception:
            logging.getLogger("budget-web").exception("服务已停止，但退出备份创建失败")
