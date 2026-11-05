"""命令行启动参数与本机服务启动。"""

from __future__ import annotations

import argparse
import ipaddress
import logging
import socket
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


def _assert_port_available(host: str, port: int) -> None:
    """在输出成功信息或打开浏览器前检查监听地址。"""
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    with socket.socket(family, socket.SOCK_STREAM) as probe:
        try:
            probe.bind((host, port))
        except OSError as exc:
            raise RuntimeError(
                f"无法监听 {host}:{port}；端口可能已被占用，请关闭旧服务或使用 --port。"
            ) from exc


def _assert_loopback_host(host: str) -> None:
    candidate = str(host).strip().lower().strip("[]")
    if candidate == "localhost":
        return
    try:
        if ipaddress.ip_address(candidate).is_loopback:
            return
    except ValueError:
        pass
    raise RuntimeError("本工具只允许监听回环地址（127.0.0.1、::1 或 localhost）")



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
    parser.add_argument("--autoshutdown-grace", type=float, default=2.0,
                        help="最后一个页面关闭后等待的宽限期秒数（默认 2，允许刷新重新注册）")
    args = parser.parse_args()

    try:
        _assert_loopback_host(args.host)
        _assert_port_available(args.host, args.port)
    except RuntimeError as exc:
        parser.exit(3, f"错误：{exc}\n")

    try:
        migration = app_state.migrate_v1_to_v2()
    except (OSError, ValueError) as exc:
        parser.exit(4, f"错误：用户状态迁移/校验失败，未启动服务：{exc}\n")

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
    months, month_errors = app_state.scan_months()
    global_state = app_state.load_global()
    itin_months = [
        month for month, document in months.items()
        if any(document.get("itinerary", {}).values())
    ]
    if migration.get("migrated"):
        print(f"状态迁移：已完成 v1 → v2（{migration.get('months', 0)} 个月份）")
        print(f"迁移报告：{migration.get('report')}")
    print(f"月份实体：data/months/（{len(months)} 个月，{len(itin_months)} 个有行程）")
    if month_errors:
        print(f"警告：{len(month_errors)} 个月份文件损坏，已隔离；请从只追加备份核对恢复：")
        for filename, message in sorted(month_errors.items()):
            print(f"  - {filename}: {message}")
    print(f"全局数据：data/global.json（修订 {global_state['revision']}）")
    print(f"汇率缓存：data/rates/（{len(app_rates.list_rate_months())} 个月）")
    print(f"退出备份：{app_config.BACKUP_DIR}（只追加，不参与预算计算）")
    if not itin_months:
        print("提示：行程仍为空；可在预算页确认新增月份后录入行程。")
    if args.open_browser:
        print("即将自动打开浏览器")
    if app_lifecycle.settings()["enabled"]:
        if app_lifecycle.settings()["grace"] > app_lifecycle.SHUTDOWN_FLUSH_SECONDS:
            print(f"自动关闭：关闭页面后约 {app_lifecycle.settings()['grace']:g} 秒停止服务并释放端口")
        else:
            print("自动关闭：关闭页面后保存数据、停止服务并释放端口")
        print(f"自动关闭兜底：浏览器漏发关闭事件时，失联约 {app_lifecycle.TAB_LEASE_SECONDS:g} 秒后停止服务")
    else:
        print("自动关闭：已禁用（--no-autoshutdown），请手动 Ctrl+C 停止服务")
    print("按 Ctrl+C 停止服务")
    print("=" * 60)

    browser_timer = None
    if args.open_browser:
        browser_timer = threading.Timer(1.2, webbrowser.open, args=(url,))
        browser_timer.daemon = True
        browser_timer.start()

    import uvicorn
    try:
        uvicorn.run(app_api.app, host=args.host, port=args.port, log_level="info")
    finally:
        if browser_timer is not None:
            browser_timer.cancel()
        try:
            backup_path = app_backups.create_data_backup(
                reason="server-process-stopped",
                state_lock=app_state.state_disk_lock,
                defaults_lock=app_defaults.defaults_disk_lock,
            )
            logging.getLogger("budget-web").info("退出备份已创建：%s", backup_path)
        except Exception:
            logging.getLogger("budget-web").exception("服务已停止，但退出备份创建失败")
