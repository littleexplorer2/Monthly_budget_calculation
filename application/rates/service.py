"""汇率查询、磁盘缓存与数据管理用例。"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeoutError
from concurrent.futures import as_completed
from fastapi.responses import JSONResponse
from pathlib import Path
import datetime as dt
import json
import math
import pandas as pd
import re
import threading
import time
from application import config as app_config
from application import contracts as app_contracts
from application import metadata as app_metadata
from core import rates as rates_core
from core import storage
import logging

logger = logging.getLogger("budget-web")


RATES_DATA_DIR = app_config.BASE_DIR / "data" / "rates"



_rates_disk_lock = threading.Lock()



def _rates_month_file(year: int, month: int) -> Path:
    """该月汇率文件路径；macOS 大小写敏感，兼容 .JSON 等变体。"""
    name = f"{year:04d}-{month:02d}.json"
    path = RATES_DATA_DIR / name
    if path.exists() or not RATES_DATA_DIR.exists():
        return path
    target = name.lower()
    for p in RATES_DATA_DIR.iterdir():
        if p.is_file() and p.name.lower() == target:
            return p
    return path



def _list_rate_months() -> list[str]:
    """列出磁盘上已保存汇率的月份（YYYY-MM，升序）。"""
    if not RATES_DATA_DIR.exists():
        return []
    months = []
    today = dt.date.today()
    for p in RATES_DATA_DIR.iterdir():
        match = re.fullmatch(r"(\d{4})-(\d{2})", p.stem)
        if not p.is_file() or p.suffix.lower() != ".json" or match is None:
            continue
        year, month = (int(part) for part in match.groups())
        if not (2000 <= year <= 2100 and 1 <= month <= 12):
            continue
        if (year, month) <= (today.year, today.month):
            months.append(p.stem)
    return sorted(set(months))



def _load_rates_month_file(year: int, month: int) -> dict | None:
    """读取该月磁盘缓存 {currency: {date: rate}}；文件不存在或损坏返回 None。"""
    path = _rates_month_file(year, month)
    if not path.exists():
        return None
    try:
        with _rates_disk_lock:
            data = storage.read_json_file(path)
        return data
    except OSError as exc:
        logger.warning("读取汇率磁盘缓存失败 %s：%s", path, exc)
        return None



def _save_rates_month_file(year: int, month: int, series_map: dict[str, pd.Series]) -> None:
    """把整月汇率写入磁盘缓存（原子写，Windows / macOS 均可）。

    读取、合并与原子替换位于同一个锁内，避免两个标签页同时写不同
    币种时后写者覆盖先写者。重新拉取只替换请求中的币种，不能删除
    同一文件里其它未请求币种的有效缓存。
    """
    try:
        RATES_DATA_DIR.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        logger.warning("创建汇率缓存目录失败：%s", exc)
        return
    path = _rates_month_file(year, month)
    month_end = pd.Timestamp(year=year, month=month, day=1) + pd.offsets.MonthEnd(0)
    today = pd.Timestamp(dt.date.today())
    save_through = min(month_end, today)
    try:
        with _rates_disk_lock:
            data = storage.read_json_file(path) or {}
            meta = data.get("_meta") if isinstance(data.get("_meta"), dict) else {}
            refreshed = meta.get("currency_refreshed_on")
            refreshed = dict(refreshed) if isinstance(refreshed, dict) else {}
            for curr, series in series_map.items():
                data[curr] = {
                    d.strftime("%Y-%m-%d"): float(v)
                    for d, v in series.items()
                    if (pd.notna(v) and math.isfinite(float(v)) and float(v) > 0
                        and pd.Timestamp(d).normalize() <= save_through)
                }
                refreshed[curr] = dt.date.today().isoformat()
            data["_meta"] = {
                "schema": 1,
                "rate_kind": "monthly_open_close_estimate",
                "currency_refreshed_on": refreshed,
            }
            storage.atomic_write_text(path, json.dumps(data, ensure_ascii=False))
    except OSError as exc:
        logger.warning("写入汇率磁盘缓存失败 %s：%s", path, exc)



def _disk_currency_cache_is_fresh(data: dict, currency: str, year: int, month: int) -> bool:
    """判断单币种磁盘缓存是否覆盖了应有区间且足够新。"""
    currency_data = data.get(currency) if isinstance(data, dict) else None
    if not isinstance(currency_data, dict) or not currency_data:
        return False

    today = dt.date.today()
    month_start = dt.date(year, month, 1)
    month_end = (
        dt.date(year + 1, 1, 1) - dt.timedelta(days=1)
        if month == 12 else dt.date(year, month + 1, 1) - dt.timedelta(days=1)
    )
    try:
        cached_dates = [dt.date.fromisoformat(str(day)) for day in currency_data]
    except (TypeError, ValueError):
        return False
    cached_dates = [day for day in cached_dates if month_start <= day <= month_end]
    if not cached_dates:
        return False
    first_cached = min(cached_dates)
    last_cached = max(cached_dates)
    if first_cached > month_start:
        return False
    meta = data.get("_meta") if isinstance(data, dict) else None
    if isinstance(meta, dict) and (
            meta.get("schema") != 1
            or meta.get("rate_kind") != "monthly_open_close_estimate"):
        return False
    expected_end = month_end if (year, month) < (today.year, today.month) else min(today, month_end)
    if expected_end < month_start:
        return False
    # 旧缓存也必须逐日完整且为有效正数；只检查首尾会把中间缺口交给
    # fill_month_rate_series 伪造成一整月数据。
    expected_dates = {
        (month_start + dt.timedelta(days=offset)).isoformat()
        for offset in range((expected_end - month_start).days + 1)
    }
    if not expected_dates.issubset(currency_data):
        return False
    for day in expected_dates:
        value = currency_data.get(day)
        if (isinstance(value, bool) or not isinstance(value, (int, float))
                or not math.isfinite(float(value)) or float(value) <= 0):
            return False
    if (year, month) < (today.year, today.month):
        # 历史缓存可能是在当月中途生成后一直未刷新；只有确实覆盖月末
        # 才能视为完整。旧版无 _meta 的完整缓存仍可继续使用。
        return last_cached >= month_end
    if (year, month) != (today.year, today.month) or last_cached < min(today, month_end):
        return False
    refreshed = meta.get("currency_refreshed_on") if isinstance(meta, dict) else None
    return isinstance(refreshed, dict) and refreshed.get(currency) == today.isoformat()



def _series_from_disk(data: dict, start: str, end: str, *, as_of: dt.date) -> pd.Series:
    """从磁盘缓存构造整月汇率序列（缺失日期用最近可用值填充）。"""
    index = pd.date_range(start, end)
    series = pd.Series(
        [data.get(d.strftime("%Y-%m-%d")) for d in index],
        index=index,
        dtype="float64",
    )
    completed = rates_core.fill_month_rate_series(series, start, end, as_of=as_of)
    if completed is None:
        raise app_contracts.RateFetchError(f"磁盘汇率缓存没有 {start} 至 {end} 的有效数据")
    return completed



def _fetch_rates_parallel(currencies: list[str], start: str, end: str,
                          max_workers: int = 4, refresh: bool = False,
                          as_of: dt.date | None = None) -> dict[str, pd.Series]:
    """获取整月多币种汇率。

    refresh=False：进程内缓存 → 磁盘缓存 → 仅下载缺失币种并回写磁盘。
    refresh=True：跳过内存与磁盘缓存，向 Yahoo Finance 重新下载并覆盖两级缓存。
    任一预算币种失败即整体失败并给出清晰错误，避免生成缺少汇率的不完整预算。
    """
    if not currencies:
        return {}
    current_day = as_of or dt.date.today()
    year, month = int(start[:4]), int(start[5:7])

    rates: dict[str, pd.Series] = {}
    missing = list(currencies)

    if refresh:
        rates_core.purge_rates_cache(start, end, rate_kind="monthly")
    else:
        # 1) 进程内缓存命中（不触发下载）
        rates = dict(rates_core.get_rates_from_cache(currencies, start, end))
        missing = [c for c in currencies if c not in rates]
        if not missing:
            return rates

        # 2) 磁盘缓存：整月文件已存在 → 直接构造序列
        disk_data = _load_rates_month_file(year, month)
        if disk_data:
            for curr in missing:
                if (curr in disk_data and disk_data[curr]
                        and _disk_currency_cache_is_fresh(disk_data, curr, year, month)):
                    try:
                        rates[curr] = _series_from_disk(
                            disk_data[curr], start, end, as_of=current_day,
                        )
                    except (app_contracts.RateFetchError, TypeError, ValueError) as exc:
                        # 单个缓存条目损坏时把它当成 miss 并重新下载；缓存不是
                        # 用户输入，不能让可修复的本地缓存错误映射成请求参数 400。
                        logger.warning("忽略损坏的汇率缓存 %s %s：%s", curr, start[:7], exc)
            missing = [c for c in missing if c not in rates]

    # 3) 下载缺失币种（refresh 时即为全部请求币种），成功后回写磁盘与内存
    if missing:
        workers = max(1, min(max_workers, len(missing)))
        downloaded: dict[str, pd.Series] = {}
        errors: list[str] = []

        def _download_one(curr: str) -> pd.Series:
            return rates_core.get_historical_rates_cached(
                [curr], start, end, as_of=current_day, force=refresh,
            )[curr]

        with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="rates") as pool:
            futures = {pool.submit(_download_one, c): c for c in missing}
            for fut in as_completed(futures):
                curr = futures[fut]
                try:
                    downloaded[curr] = fut.result()
                except Exception as exc:  # noqa: BLE001 - 汇总所有币种的失败原因
                    errors.append(f"{curr}: {exc}")
        if errors:
            raise app_contracts.RateFetchError("；".join(errors))
        rates.update(downloaded)
        _save_rates_month_file(year, month, downloaded)

    return rates


def _previous_month(year: int, month: int) -> tuple[int, int]:
    """Return the calendar month immediately before ``year``/``month``."""
    if month == 1:
        return year - 1, 12
    return year, month - 1


def _fetch_budget_rates(currencies: list[str], year: int, month: int,
                        today: dt.date | None = None,
                        ) -> tuple[dict[str, pd.Series], dict]:
    """Fetch monthly rates for one budget calculation.

    Yahoo may legitimately have no observation for the new month on its first
    calendar day.  Only for the actual current month on day 1, a completely
    unavailable current-month request falls back to the previous calendar
    month's arithmetic mean.  The mean is expanded to the requested month's
    calendar axis so the pure budget formulas keep receiving explicit daily
    inputs and do not acquire any clock, network, or cache dependency.
    """
    app_contracts.validate_year_month(year, month)
    start, end = app_contracts.month_bounds(year, month)
    requested_month = f"{year:04d}-{month:02d}"
    current_day = today or dt.date.today()
    try:
        rates = _fetch_rates_parallel(currencies, start, end, as_of=current_day)
        return rates, {
            "kind": "current_month",
            "requested_month": requested_month,
            "fallback": False,
        }
    except app_contracts.RateFetchError as current_error:
        if ((year, month) != (current_day.year, current_day.month)
                or current_day.day != 1):
            raise

        previous_year, previous_month = _previous_month(year, month)
        previous_start, previous_end = app_contracts.month_bounds(
            previous_year, previous_month,
        )
        source_month = f"{previous_year:04d}-{previous_month:02d}"
        try:
            previous_rates = _fetch_rates_parallel(
                currencies, previous_start, previous_end, as_of=current_day,
            )
            target_index = pd.date_range(start, end)
            fallback_rates: dict[str, pd.Series] = {}
            averages: dict[str, float] = {}
            for currency in currencies:
                values = rates_core.valid_rate_series(previous_rates, currency)
                average = float(values.mean())
                fallback_rates[currency] = pd.Series(
                    average,
                    index=target_index,
                    name=getattr(previous_rates[currency], "name", None) or "rate",
                    dtype="float64",
                )
                averages[currency] = average
        except (app_contracts.RateFetchError, ValueError) as previous_error:
            raise app_contracts.RateFetchError(
                f"{current_error}；{source_month} 月平均汇率回退失败：{previous_error}"
            ) from previous_error

        return fallback_rates, {
            "kind": "previous_month_average",
            "requested_month": requested_month,
            "source_month": source_month,
            "fallback": True,
            "averages": averages,
        }



def _fetch_annual_close_rates(currencies: list[str], start: str, end: str,
                              max_workers: int = 4, refresh: bool = False,
                              ) -> tuple[dict[str, pd.Series], dict[str, str]]:
    """并行获取全年实际交易日 Close；不与月度磁盘缓存混用。"""
    if not currencies:
        return {}, {}
    rates: dict[str, pd.Series] = {}
    errors: dict[str, str] = {}
    workers = max(1, min(max_workers, len(currencies)))

    def _download_one(currency: str) -> pd.Series:
        return rates_core.get_historical_close_rates_cached(
            [currency], start, end, force=refresh,
        )[currency]

    with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="annual-close") as pool:
        futures = {pool.submit(_download_one, currency): currency for currency in currencies}
        for future in as_completed(futures):
            currency = futures[future]
            try:
                rates[currency] = future.result()
            except Exception as exc:  # noqa: BLE001 - 按币种返回部分失败，不伪造总额
                errors[currency] = str(exc)
    return rates, errors



def _annual_observed_through(stats: dict[str, dict]) -> str | None:
    """返回所有实际外币行情共同覆盖到的保守截止日。

    CNY/CNY 是恒等汇率，不是 Yahoo 交易日收盘样本，存在其它币种时不让
    它把截止日错误推进到自然日当天。
    """
    foreign_dates = [
        row["last_date"] for currency, row in stats.items()
        if currency != "CNY" and row.get("last_date")
    ]
    if foreign_dates:
        return min(foreign_dates)
    identity_dates = [row["last_date"] for row in stats.values() if row.get("last_date")]
    return min(identity_dates) if identity_dates else None



def _annual_rates_payload(year: int, start: str, end: str, rates: dict[str, pd.Series],
                          order: list[str], errors: dict[str, str] | None = None) -> dict:
    stats = rates_core.annual_rate_stats(rates, order)
    return {
        "year": year,
        "start_date": start,
        "requested_through": end,
        "observed_through": _annual_observed_through(stats),
        "source": "Yahoo Finance",
        "price_field": "Close",
        "non_trading_days": "excluded",
        "stats": stats,
        "errors": errors or {},
        "complete": not bool(errors),
    }


def _asset_rates_payload(start: str, end: str, rates: dict[str, pd.Series],
                         order: list[str], errors: dict[str, str] | None = None) -> dict:
    """资产换算使用的最近 365 天实际交易日 Close 均值。"""
    stats = rates_core.annual_rate_stats(rates, order)
    return {
        "kind": "trailing_365_day_close_average",
        "window_days": 365,
        "start_date": start,
        "requested_through": end,
        "observed_through": _annual_observed_through(stats),
        "source": "Yahoo Finance",
        "price_field": "Close",
        "non_trading_days": "excluded",
        "stats": stats,
        "errors": errors or {},
        "complete": not bool(errors),
    }



# yfinance 的主下载与 Ticker.history 备援各自最多可能等待约 10 秒，
# 两次尝试之间还有 1 秒退避。外层墙钟上限必须覆盖完整备援链，否则会在
# 底层仍有机会成功时先返回失败，把正常但冷启动较慢的连接误报成不可达。
NETWORK_CHECK_TIMEOUT = 24.0



def api_network_check():
    """快速检测能否从 Yahoo Finance 下载汇率数据（供页面打开时提示网络状态）。

    用最近 6 个自然日窗口探测单个稳定币种 HKD。该接口只能判断 Yahoo
    数据源本次请求是否成功，不能把超时、限流或空响应直接诊断成用户网络或
    VPN 故障，因此失败响应会保留具体原因并使用中性提示。
    """
    today = dt.date.today()
    start = (today - dt.timedelta(days=6)).isoformat()
    end = (today - dt.timedelta(days=1)).isoformat()
    t0 = time.monotonic()
    pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="netcheck")
    try:
        # 注意：必须走原始下载器（绕过内存/磁盘缓存），否则离线时检测会“假通过”
        fut = pool.submit(rates_core.get_historical_rates, ["HKD"], start, end)
        try:
            rates = fut.result(timeout=NETWORK_CHECK_TIMEOUT)
        except FutureTimeoutError:
            fut.cancel()
            message = f"Yahoo Finance 响应超过 {NETWORK_CHECK_TIMEOUT:g} 秒"
            logger.warning("Yahoo Finance 连通性检测超时：%s", message)
            return JSONResponse(status_code=200, content={
                "ok": False,
                "reason": "timeout",
                "error": message,
                "hint": "Yahoo Finance 响应超时，本次连通性检测未完成；实际汇率请求仍会按正常流程重试。",
            })
        series = rates["HKD"]
        if series is None or series.dropna().empty:
            raise app_contracts.RateFetchError("探测窗口内无汇率数据")
        latency_ms = int((time.monotonic() - t0) * 1000)
        return {"ok": True, "latency_ms": latency_ms, "source": "Yahoo Finance"}
    except Exception as exc:  # noqa: BLE001 - 所有失败都视为不可达
        logger.warning("Yahoo Finance 连通性检测失败：%s", exc)
        return JSONResponse(status_code=200, content={
            "ok": False,
            "reason": "source_unavailable",
            "error": str(exc)[:300],
            "hint": "暂时无法从 Yahoo Finance 获取汇率数据；请稍后重试，若持续失败再检查网络或代理设置。",
        })
    finally:
        # wait=False 才能使上面的超时成为真正的请求墙钟上限。
        pool.shutdown(wait=False, cancel_futures=True)



def api_data_rates_list():
    """列出磁盘上已保存的汇率月份（供「数据管理」界面展示）。"""
    return {"months": _list_rate_months()}



def api_data_rates_delete(body: app_contracts.MonthListIn):
    """删除指定月份的磁盘汇率缓存，并同步清理进程内缓存。

    先全量校验月份格式，再执行删除（避免部分成功后才发现非法月份）。
    """
    # 1) 全量校验
    parsed: list[tuple[int, int]] = []
    for m in body.months:
        match = re.fullmatch(r"([0-9]{4})-(0[1-9]|1[0-2])", m)
        if match is None:
            raise ValueError(f"月份格式无效：{m!r}（应为 YYYY-MM）")
        year, month = (int(part) for part in match.groups())
        app_contracts.validate_supported_year(year)
        parsed.append((year, month))

    # 2) 执行删除
    removed: list[str] = []
    for (year, month), m in zip(parsed, body.months):
        path = _rates_month_file(year, month)
        if path.exists():
            try:
                with _rates_disk_lock:
                    path.unlink()
                removed.append(m)
            except OSError as exc:
                raise app_contracts.RateFetchError(f"删除汇率缓存失败 {path}：{exc}")
        start, end = app_contracts.month_bounds(year, month)
        rates_core.purge_rates_cache(start, end, rate_kind="monthly")
    return {"removed": removed, "months": _list_rate_months()}



def api_annual_rates(year: int,
                     currencies: str | None = None,
                     refresh: bool = False):
    """年初至截止日的实际交易日收盘汇率统计（不填充非交易日）。"""
    start, end = app_contracts.annual_bounds(year)
    curr_list = app_metadata.parse_currencies(currencies)
    rates, errors = _fetch_annual_close_rates(curr_list, start, end, refresh=refresh)
    return _annual_rates_payload(year, start, end, rates, curr_list, errors)


def api_asset_rates(currencies: str | None = "HKD,USD",
                    refresh: bool = False):
    """资产参考汇率：最近 365 天实际交易日 Close 算术平均。"""
    start, end = app_contracts.trailing_year_bounds()
    curr_list = app_metadata.parse_currencies(currencies)
    rates, errors = _fetch_annual_close_rates(curr_list, start, end, refresh=refresh)
    return _asset_rates_payload(start, end, rates, curr_list, errors)
