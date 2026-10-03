# -*- coding: utf-8 -*-
"""多币种旅行预算计算器 —— Web 版后端入口（FastAPI）

启动方式（在项目根目录）：
    python main_web.py                      # 默认 http://127.0.0.1:8123，并自动打开浏览器
    python main_web.py --port 9000          # 自定义端口并自动打开浏览器

依赖：fastapi、uvicorn、yfinance、pandas、numpy、requests
说明：
    - 行程、每月标准修改、计算结果与默认标准保存在项目 data/ 目录（随仓库同步），
      页面 localStorage 仅作本机缓存。汇率缓存在 data/rates/。
      磁盘写入对 Windows / macOS（含 iCloud、OneDrive）做了原子写与失败回退。
    - 汇率数据来自 Yahoo Finance；默认走内存/磁盘缓存，汇率页「重新拉取」会强制重新下载。
    - 仅供本地个人使用（绑定 127.0.0.1）。
"""

from __future__ import annotations

import argparse
import copy
import datetime as dt
import json
import logging
import math
import os
import re
import subprocess
import sys
import threading
import time
import webbrowser
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError, as_completed
from pathlib import Path

import pandas as pd
from fastapi import FastAPI, Query
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from typing import Literal

import functions

# ---------------------------------------------------------------------------
# 基础配置
# ---------------------------------------------------------------------------
BASE_DIR = Path(__file__).resolve().parent
WEB_DIR = BASE_DIR / "web"

logger = logging.getLogger("budget-web")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

# 展示用中文名映射（仅影响页面显示，不参与计算）
LOCATION_NAMES = {
    "Shenzhen": "深圳", "Hong_Kong": "香港", "Chengdu": "成都",
    "Shanghai": "上海", "Taipei": "台北", "Bangkok": "曼谷",
    "Extra": "额外预算",
}
REGION_NAMES = {"Mainland": "内地", "Overseas": "境外"}
CURRENCY_NAMES = {"CNY": "人民币", "HKD": "港币", "USD": "美元", "TWD": "新台币", "THB": "泰铢"}


def _all_currencies(defaults_snapshot: dict | None = None) -> list[str]:
    """当前生效默认标准涉及的全部币种（按字母序，保证响应稳定）。"""
    snapshot = defaults_snapshot or functions.default_standards_snapshot()
    curr = set(snapshot["extra"].keys())
    for std in (snapshot["variable"], snapshot["fixed"]):
        for inner in std.values():
            curr.update(inner.keys())
    # 旅居标准结构为 {地点: {币种: {"daily":.., "once":..}}}，币种名在最内层字典的键
    for inner in snapshot["travel"].values():
        curr.update(inner.keys())
    return sorted(curr)


def _location_names(saved_names: dict | None = None) -> dict[str, str]:
    names = dict(LOCATION_NAMES)
    names.update(functions.saved_location_names() if saved_names is None else saved_names)
    return names


def _currency_names(saved_names: dict | None = None) -> dict[str, str]:
    names = dict(CURRENCY_NAMES)
    names.update(functions.saved_currency_names() if saved_names is None else saved_names)
    return names


# ---------------------------------------------------------------------------
# 业务异常与全局错误处理
# ---------------------------------------------------------------------------
class RateFetchError(Exception):
    """汇率拉取失败（网络/数据源问题），映射为 502。"""


class RepositoryUploadError(Exception):
    """数据提交或推送失败，向页面返回可操作的错误提示。"""


class StateConflictError(Exception):
    """另一个标签页已修改同一状态键；拒绝用旧基线覆盖。"""


app = FastAPI(title="多币种旅行预算计算器", docs_url=None, redoc_url=None, openapi_url=None)


@app.middleware("http")
async def _no_cache_web_assets(request, call_next):
    """本地开发时禁止缓存 HTML/CSS/JS，避免改完页面仍看到旧遮罩/旧脚本。"""
    response = await call_next(request)
    path = request.url.path
    if not path.startswith("/api"):
        response.headers["Cache-Control"] = "no-store, max-age=0"
        response.headers["Pragma"] = "no-cache"
    return response


@app.exception_handler(ValueError)
async def _value_error_handler(request, exc: ValueError):
    """业务参数错误 → 400（含清晰的中文提示）。"""
    return JSONResponse(status_code=400, content={"error": {"code": "BAD_REQUEST", "message": str(exc)}})


@app.exception_handler(RequestValidationError)
async def _validation_error_handler(request, exc: RequestValidationError):
    """请求体结构错误 → 422（附字段级详情）。"""
    return JSONResponse(status_code=422, content={
        "error": {"code": "VALIDATION_ERROR", "message": "请求参数校验失败", "detail": exc.errors()},
    })


@app.exception_handler(RateFetchError)
async def _rate_fetch_error_handler(request, exc: RateFetchError):
    return JSONResponse(status_code=502, content={
        "error": {"code": "RATE_FETCH_FAILED", "message": f"汇率数据获取失败：{exc}"},
    })


@app.exception_handler(RepositoryUploadError)
async def _repository_upload_error_handler(request, exc: RepositoryUploadError):
    return JSONResponse(status_code=409, content={
        "error": {"code": "DATA_UPLOAD_FAILED", "message": str(exc)},
    })


@app.exception_handler(StateConflictError)
async def _state_conflict_error_handler(request, exc: StateConflictError):
    return JSONResponse(status_code=409, content={
        "error": {"code": "STATE_CONFLICT", "message": str(exc)},
    })


@app.exception_handler(functions.DefaultsRevisionConflict)
async def _defaults_conflict_error_handler(request, exc: functions.DefaultsRevisionConflict):
    return JSONResponse(status_code=409, content={
        "error": {"code": "DEFAULTS_CONFLICT", "message": str(exc)},
    })


@app.exception_handler(Exception)
async def _unhandled_error_handler(request, exc: Exception):
    logger.exception("未处理异常：%s %s", request.method, request.url.path)
    return JSONResponse(status_code=500, content={
        "error": {"code": "INTERNAL_ERROR", "message": "服务器内部错误，请查看服务端日志"},
    })


# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------
def _month_bounds(year: int, month: int) -> tuple[str, str]:
    """返回该月首日 / 月末日（含）的 'YYYY-MM-DD' 字符串。"""
    first = pd.Timestamp(year=year, month=month, day=1)
    last = first + pd.offsets.MonthEnd(1)
    return first.strftime("%Y-%m-%d"), last.strftime("%Y-%m-%d")


def _validate_supported_year(year: int) -> None:
    if not (2000 <= year <= 2100):
        raise ValueError(f"年份超出支持范围：{year}（支持 2000-2100）")


def _validate_year_month(year: int, month: int) -> None:
    _validate_supported_year(year)
    if not (1 <= month <= 12):
        raise ValueError(f"月份无效：{month}（应为 1-12）")
    # 未来月份没有历史汇率数据，提前给出清晰提示
    today = dt.date.today()
    if (year, month) > (today.year, today.month):
        raise ValueError(f"{year}年{month}月是未来月份，尚无汇率数据，请选择当月或历史月份")


def _parse_ymd(text: str, location: str) -> dt.date:
    try:
        return dt.date.fromisoformat(text.strip())
    except (ValueError, AttributeError):
        raise ValueError(f"地点 {location} 的日期格式无效：{text!r}（应为 YYYY-MM-DD）")


# ---------------------------------------------------------------------------
# 汇率磁盘持久化（按月保存已下载的汇率，避免重复请求 Yahoo Finance）
# 读取顺序：进程内缓存 → 磁盘缓存(data/rates/YYYY-MM.json) → 下载并回写磁盘。
# 「重新拉取」(refresh=true) 跳过前两级，强制下载并覆盖缓存。
# ---------------------------------------------------------------------------
RATES_DATA_DIR = BASE_DIR / "data" / "rates"
APP_STATE_FILE = BASE_DIR / "data" / "app-state.json"
_rates_disk_lock = threading.Lock()
_state_disk_lock = threading.Lock()
# 同一标签页的状态写入可能因 fetch / sendBeacon 并发而逆序到达。该表只在
# _state_disk_lock 内访问；记录“已见过”的最高序号，而不是仅记录成功写盘序号，
# 这样较新的请求即使因真实跨标签冲突被拒绝，迟到的旧请求也不能随后落盘。
_state_write_sequences: dict[str, int] = {}
_repository_upload_lock = threading.Lock()
_GIT_COMMAND_TIMEOUT = 30
_GIT_PUSH_TIMEOUT = 120


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
    for p in RATES_DATA_DIR.iterdir():
        if p.is_file() and p.suffix.lower() == ".json" and re.fullmatch(r"\d{4}-\d{2}", p.stem):
            months.append(p.stem)
    return sorted(set(months))


def _load_rates_month_file(year: int, month: int) -> dict | None:
    """读取该月磁盘缓存 {currency: {date: rate}}；文件不存在或损坏返回 None。"""
    path = _rates_month_file(year, month)
    if not path.exists():
        return None
    try:
        with _rates_disk_lock:
            data = functions.read_json_file(path)
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
            data = functions.read_json_file(path) or {}
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
            functions.atomic_write_text(path, json.dumps(data, ensure_ascii=False))
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
    if isinstance(meta, dict):
        # schema=1 由本程序按自然日完整写入。中间任意日期缺失或值损坏都说明
        # 文件被截断/篡改，不能再用前后两个点 ffill 成一整月的伪数据。
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


def _series_from_disk(data: dict, start: str, end: str) -> pd.Series:
    """从磁盘缓存构造整月汇率序列（缺失日期用最近可用值填充）。"""
    index = pd.date_range(start, end)
    series = pd.Series(
        [data.get(d.strftime("%Y-%m-%d")) for d in index],
        index=index,
        dtype="float64",
    )
    completed = functions.fill_month_rate_series(series, start, end)
    if completed is None:
        raise RateFetchError(f"磁盘汇率缓存没有 {start} 至 {end} 的有效数据")
    return completed


def _fetch_rates_parallel(currencies: list[str], start: str, end: str,
                          max_workers: int = 4, refresh: bool = False) -> dict[str, pd.Series]:
    """获取整月多币种汇率。

    refresh=False：进程内缓存 → 磁盘缓存 → 仅下载缺失币种并回写磁盘。
    refresh=True：跳过内存与磁盘缓存，向 Yahoo Finance 重新下载并覆盖两级缓存。
    任一币种失败即整体失败并给出清晰错误（避免图表缺线导致误解）。
    """
    if not currencies:
        return {}
    year, month = int(start[:4]), int(start[5:7])

    rates: dict[str, pd.Series] = {}
    missing = list(currencies)

    if refresh:
        functions.purge_rates_cache(start, end, rate_kind="monthly")
    else:
        # 1) 进程内缓存命中（不触发下载）
        rates = dict(functions.get_rates_from_cache(currencies, start, end))
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
                        rates[curr] = _series_from_disk(disk_data[curr], start, end)
                    except (RateFetchError, TypeError, ValueError) as exc:
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
            return functions.get_historical_rates_cached(
                [curr], start, end, force=refresh,
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
            raise RateFetchError("；".join(errors))
        rates.update(downloaded)
        _save_rates_month_file(year, month, downloaded)

    return rates


def _series_stats(series: pd.Series) -> dict:
    """汇率序列统计（起始/期末/均值/最低/最高），空序列各字段为 None。"""
    vals = series.dropna()
    if vals.empty:
        return {"start": None, "end": None, "avg": None, "min": None, "max": None}
    return {
        "start": round(float(vals.iloc[0]), 6),
        "end": round(float(vals.iloc[-1]), 6),
        "avg": round(float(vals.mean()), 6),
        "min": round(float(vals.min()), 6),
        "max": round(float(vals.max()), 6),
    }


def _rates_payload(rates: dict[str, pd.Series], order: list[str]) -> dict:
    """构造前端图表所需的序列数据（含 NaN→null 清洗，保证 JSON 合法）。"""
    dates: list[str] = []
    series_json: dict[str, list] = {}
    stats: dict[str, dict] = {}
    for curr in order:
        s = rates[curr]
        if not dates:
            dates = [d.strftime("%Y-%m-%d") for d in s.index]
        series_json[curr] = [
            None if pd.isna(v) else round(float(v), 6) for v in s.tolist()
        ]
        stats[curr] = _series_stats(s)
    return {"dates": dates, "series": series_json, "stats": stats}


def _annual_bounds(year: int) -> tuple[str, str]:
    """全年汇率区间：当年截至今日，历史年截至 12 月 31 日。"""
    today = dt.date.today()
    if not (2000 <= year <= today.year):
        if year > today.year:
            raise ValueError(f"{year}年是未来年份，尚无可用的收盘汇率")
        raise ValueError(f"年份超出支持范围：{year}（支持 2000-{today.year}）")
    end = today if year == today.year else dt.date(year, 12, 31)
    return dt.date(year, 1, 1).isoformat(), end.isoformat()


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
        return functions.get_historical_close_rates_cached(
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
    stats = functions.annual_rate_stats(rates, order)
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


# ---------------------------------------------------------------------------
# 请求模型
# ---------------------------------------------------------------------------
class RangeIn(BaseModel):
    start: str = Field(description="开始日期，YYYY-MM-DD")
    end: str = Field(description="结束日期，YYYY-MM-DD（含当日）")


class ItineraryEntryIn(BaseModel):
    location: str = Field(description="地点 key，如 Shenzhen")
    ranges: list[RangeIn] = Field(default_factory=list, description="该地点的日期区间列表")


class CalculateRequest(BaseModel):
    year: int = Field(ge=2000, le=2100, description="计算年份")
    month: int = Field(ge=1, le=12, description="计算月份")
    region: Literal["Mainland", "Overseas"] = Field(description="主要居住区域")
    itinerary: list[ItineraryEntryIn] = Field(min_length=1, description="行程（按地点索引）")
    standards_override: dict | None = Field(default=None, description="本次计算使用的预算标准覆盖")
    include_travel: bool = Field(default=False, description="是否包含旅居预算")
    travel_locations: list[str] | None = Field(default=None, description="勾选包含旅居时生效的旅居地点列表；null=全部，[]=不包含任何旅居地点")


class AnnualBudgetRequest(BaseModel):
    year: int = Field(ge=2000, le=2100, description="全年预算年份")
    amounts: dict = Field(default_factory=dict, description="各币种全年当地金额")


class DefaultsPayload(BaseModel):
    base_revision: str = Field(min_length=64, max_length=64)
    variable: dict
    fixed: dict
    extra: dict = Field(default_factory=dict)
    travel: dict = Field(default_factory=dict)
    location_names: dict[str, str] = Field(default_factory=dict)
    currency_names: dict[str, str] = Field(default_factory=dict)


class DefaultsResetIn(BaseModel):
    base_revision: str = Field(min_length=64, max_length=64)


class AppStateIn(BaseModel):
    version: int | None = 1
    updatedAt: str | None = None
    year: int | None = None
    month: int | None = None
    itineraryByMonth: dict = Field(default_factory=dict)
    optionsByMonth: dict = Field(default_factory=dict)
    overridesByMonth: dict = Field(default_factory=dict)
    resultsByMonth: dict = Field(default_factory=dict)
    annualBudgetsByYear: dict = Field(default_factory=dict)
    annualResultsByYear: dict = Field(default_factory=dict)
    baseValues: dict | None = Field(
        default=None,
        description="本次实际修改键的读取基线，用于阻止旧标签页覆盖并发更新",
    )
    tabId: str | None = Field(
        default=None, min_length=1, max_length=64,
        description="发起状态写入的浏览器标签页标识；与 sequence 成对提交",
    )
    sequence: int | None = Field(
        default=None, ge=1,
        description="同一标签页内单调递增的状态写入序号；与 tabId 成对提交",
    )
    replace: bool = Field(default=False, description="为 true 时整份覆盖（数据管理「清空全部」）")


def _expand_itinerary(entries: list[ItineraryEntryIn], year: int, month: int,
                      loc_registry: dict,
                      include_travel: bool = False,
                      travel_locations: list[str] | None = None,
                      ) -> tuple[list[dict], list[str], int]:
    """把「地点 + 日期区间列表」展开为逐日记录。

    校验：地点在注册表（默认 + 当月新建）中、日期合法、不跨月。
    去重：同地点的重叠日期只保留一天；同一日属于不同地点则明确拒绝。
    旅居过滤：include_travel=False 时排除全部旅居；否则仅保留 travel_locations
    中选中地点（None 表示全部）。
    返回 (逐日记录列表, 警告列表, 去重天数)。
    """
    month_start = dt.date(year, month, 1)
    month_end = dt.date(year, month + 1, 1) - dt.timedelta(days=1) if month < 12 else dt.date(year + 1, 1, 1) - dt.timedelta(days=1)

    expanded: list[dict] = []
    warnings: list[str] = []
    seen: set[tuple[str, str, bool]] = set()
    owners: dict[str, str] = {}
    dup_count = 0

    for entry in entries:
        loc = entry.location
        if loc not in loc_registry:
            raise ValueError(f"未知地点：{loc}（可先在页面「新建预算标准」中添加）")
        # 行程类型由地点类别决定（定居 → 可变预算；旅居 → 旅游预算）
        is_travel = loc_registry[loc]["type"] == "travel"

        for rng in entry.ranges:
            s = _parse_ymd(rng.start, loc)
            e = _parse_ymd(rng.end, loc)
            if s > e:
                raise ValueError(f"地点 {loc} 的日期区间开始晚于结束：{rng.start} ~ {rng.end}")
            if s < month_start or e > month_end:
                raise ValueError(
                    f"地点 {loc} 的日期区间 {rng.start} ~ {rng.end} 超出 {year}年{month}月，仅支持当月日期"
                )

            day = s
            while day <= e:
                day_key = day.isoformat()
                owner = owners.get(day_key)
                if owner is not None and owner != loc:
                    raise ValueError(
                        f"日期 {day_key} 同时分配给了地点 {owner} 与 {loc}；同一天只能属于一个地点"
                    )
                owners[day_key] = loc
                key = (day_key, loc, is_travel)
                if key in seen:
                    dup_count += 1
                else:
                    seen.add(key)
                    expanded.append({"date": day.isoformat(), "location": loc, "is_travel": is_travel})
                day += dt.timedelta(days=1)

    # 旅居过滤（在去重之后执行，保证统计准确）
    if include_travel and travel_locations is not None:
        selected = {t for t in travel_locations if t in loc_registry and loc_registry[t]["type"] == "travel"}
        dropped = [e for e in expanded if e["is_travel"] and e["location"] not in selected]
        if dropped:
            warnings.append(
                f"旅居选择仅包含 {len(selected)} 个地点，已排除 {len(dropped)} 天未选中的旅居行程"
            )
        expanded = [e for e in expanded if not (e["is_travel"] and e["location"] not in selected)]
    elif not include_travel:
        dropped = [e for e in expanded if e["is_travel"]]
        if dropped:
            warnings.append(f"未勾选「包含旅居」，已排除 {len(dropped)} 天旅居行程及其单次费用")
        expanded = [e for e in expanded if not e["is_travel"]]

    if dup_count:
        warnings.append(f"已自动合并 {dup_count} 天重复行程（同地点重叠日期只计一次）")
    return expanded, warnings, dup_count


# ---------------------------------------------------------------------------
# 浏览器标签页跟踪与「关闭页面自动停止服务」
# 机制：每个打开的页面在加载时注册一个 tab_id，并定期刷新租约；页面关闭时
# 仍优先通过 sendBeacon 注销。Safari 等浏览器若漏发关闭事件，租约超时也会
# 清理失联标签页，避免本地服务永久残留。
# ---------------------------------------------------------------------------
AUTO_SHUTDOWN_ENABLED = True
SHUTDOWN_GRACE_SECONDS = 0.0
# 立即退出前最少等待，让 unregister 响应先发出，并给刷新/多标签一个极短的重注册窗口
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
        acquired = _state_disk_lock.acquire(timeout=2.0)
        if acquired:
            _state_disk_lock.release()
        # 用户可能在上传完成前关闭页面；不要在 Git commit/push 中途杀掉进程。
        upload_acquired = _repository_upload_lock.acquire(timeout=_GIT_PUSH_TIMEOUT + 5)
        if upload_acquired:
            _repository_upload_lock.release()
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


class TabRegisterIn(BaseModel):
    tab_id: str = Field(min_length=1, max_length=64, description="浏览器页面唯一标识")
    state: dict | None = Field(default=None, description="关闭页面前附带的完整行程状态，先落盘再退出")


@app.post("/api/tabs/register")
def api_tabs_register(body: TabRegisterIn):
    """页面加载时注册；任意注册都会取消待执行的自动退出。"""
    with _tabs_lock:
        _open_tabs[body.tab_id] = time.monotonic()
        _cancel_shutdown_timer()
        _schedule_tab_expiry_check_locked()
        count = len(_open_tabs)
    return {"open_tabs": count}


@app.post("/api/tabs/heartbeat")
def api_tabs_heartbeat(body: TabRegisterIn):
    """刷新标签页租约；即使首次注册请求丢失，也把本标签页补登记。"""
    with _tabs_lock:
        _open_tabs[body.tab_id] = time.monotonic()
        _cancel_shutdown_timer()
        _schedule_tab_expiry_check_locked()
        count = len(_open_tabs)
    return {"open_tabs": count}


@app.post("/api/tabs/unregister")
def api_tabs_unregister(body: TabRegisterIn):
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
            _save_app_state(
                payload,
                replace=False,
                base_values=base_values,
                tab_id=state_tab_id,
                sequence=sequence,
                allow_partial_conflicts=True,
            )
        except StateConflictError as exc:
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


# ---------------------------------------------------------------------------
# API 路由
# ---------------------------------------------------------------------------
@app.get("/api/health")
def api_health():
    return {"status": "ok"}


# Yahoo Finance 连通性检测的超时上限（秒）
NETWORK_CHECK_TIMEOUT = 8.0


@app.get("/api/network-check")
def api_network_check():
    """快速检测能否从 Yahoo Finance 下载汇率数据（供页面打开时提示网络状态）。

    用最近 6 个自然日窗口探测单个稳定币种 HKD，超时或失败返回 ok=False；
    服务本身可达（能收到该响应）而数据源不可达时，前端据此提示「网络异常，请打开VPN」。
    """
    today = dt.date.today()
    start = (today - dt.timedelta(days=6)).isoformat()
    end = (today - dt.timedelta(days=1)).isoformat()
    t0 = time.monotonic()
    pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="netcheck")
    try:
        # 注意：必须走原始下载器（绕过内存/磁盘缓存），否则离线时检测会“假通过”
        fut = pool.submit(functions.get_historical_rates, ["HKD"], start, end)
        try:
            rates = fut.result(timeout=NETWORK_CHECK_TIMEOUT)
        except FutureTimeoutError as exc:
            fut.cancel()
            raise RateFetchError(f"连接 Yahoo Finance 超过 {NETWORK_CHECK_TIMEOUT:g} 秒") from exc
        series = rates["HKD"]
        if series is None or series.dropna().empty:
            raise RateFetchError("探测窗口内无汇率数据")
        latency_ms = int((time.monotonic() - t0) * 1000)
        return {"ok": True, "latency_ms": latency_ms, "source": "Yahoo Finance"}
    except Exception as exc:  # noqa: BLE001 - 所有失败都视为不可达
        logger.warning("Yahoo Finance 连通性检测失败：%s", exc)
        return JSONResponse(status_code=200, content={
            "ok": False,
            "error": str(exc)[:300],
            "hint": "网络异常，请打开VPN后重试（无法从 Yahoo Finance 获取汇率数据）",
        })
    finally:
        # wait=False 才能使上面的超时成为真正的请求墙钟上限。
        pool.shutdown(wait=False, cancel_futures=True)


class MonthListIn(BaseModel):
    months: list[str] = Field(default_factory=list, description="YYYY-MM 月份列表")


@app.get("/api/data/rates")
def api_data_rates_list():
    """列出磁盘上已保存的汇率月份（供「数据管理」界面展示）。"""
    return {"months": _list_rate_months()}


@app.post("/api/data/rates/delete")
def api_data_rates_delete(body: MonthListIn):
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
        _validate_supported_year(year)
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
                raise RateFetchError(f"删除汇率缓存失败 {path}：{exc}")
        start, end = _month_bounds(year, month)
        functions.purge_rates_cache(start, end, rate_kind="monthly")
    return {"removed": removed, "months": _list_rate_months()}


def _git_error_detail(result: subprocess.CompletedProcess[str]) -> str:
    """提取简短 Git 错误，并隐藏 URL 中可能存在的凭据。"""
    detail = (result.stderr or result.stdout or "").strip()
    detail = re.sub(r"(https?://)[^/@\s]+@", r"\1***@", detail)
    lines = [line.strip() for line in detail.splitlines() if line.strip()]
    return "；".join(lines[-4:])[:800]


def _run_git(args: list[str], cwd: Path, *, timeout: int = _GIT_COMMAND_TIMEOUT,
             allowed_codes: tuple[int, ...] = (0,)) -> subprocess.CompletedProcess[str]:
    """跨平台、非交互执行 Git；始终使用参数数组，避免 shell 注入。"""
    env = os.environ.copy()
    env["GIT_TERMINAL_PROMPT"] = "0"
    env["GCM_INTERACTIVE"] = "Never"
    try:
        result = subprocess.run(
            ["git", *args],
            cwd=str(cwd),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            env=env,
            check=False,
        )
    except FileNotFoundError as exc:
        raise RepositoryUploadError("未找到 Git，请先安装 Git 并重新启动程序") from exc
    except subprocess.TimeoutExpired as exc:
        raise RepositoryUploadError("Git 操作超时，请检查网络或远程仓库连接后重试") from exc
    if result.returncode not in allowed_codes:
        detail = _git_error_detail(result)
        hint = "请检查 Git 登录状态、远程仓库权限以及是否需要先手动拉取远端更新"
        raise RepositoryUploadError(f"{detail or 'Git 命令执行失败'}。{hint}")
    return result


def _repository_context(base_dir: Path) -> tuple[Path, str, str, str]:
    """返回仓库根目录、远程名、当前分支与 data/ 的仓库相对路径。"""
    root_text = _run_git(["rev-parse", "--show-toplevel"], base_dir).stdout.strip()
    root = Path(root_text).resolve()
    project = base_dir.resolve()
    try:
        data_relative = (project / "data").resolve().relative_to(root).as_posix()
    except ValueError as exc:
        raise RepositoryUploadError("当前项目的 data 目录不在 Git 仓库内，无法上传") from exc

    remotes = [name.strip() for name in _run_git(["remote"], root).stdout.splitlines() if name.strip()]
    if not remotes:
        raise RepositoryUploadError("尚未配置 Git 远程仓库，请先添加 origin")
    if "origin" in remotes:
        remote = "origin"
    elif len(remotes) == 1:
        remote = remotes[0]
    else:
        raise RepositoryUploadError("存在多个远程仓库但没有 origin，请先配置 origin")

    branch = _run_git(["branch", "--show-current"], root).stdout.strip()
    if not branch:
        raise RepositoryUploadError("当前处于 detached HEAD，请先切换到一个分支")
    return root, remote, branch, data_relative


def _upload_data_to_remote(base_dir: Path = BASE_DIR) -> dict:
    """提交 data/ 的全部新增、修改和删除，再推送当前分支。"""
    with _repository_upload_lock:
        root, remote, branch, data_relative = _repository_context(base_dir)
        if not (base_dir / "data").is_dir():
            raise RepositoryUploadError("项目 data 目录不存在，无法上传")

        # 等本地状态与汇率写盘完成，再一次性截取 data/ 快照进入 Git 暂存区。
        with _state_disk_lock, _rates_disk_lock:
            _run_git(["add", "-A", "--", data_relative], root)
        changed = _run_git(
            ["diff", "--cached", "--quiet", "--", data_relative],
            root,
            allowed_codes=(0, 1),
        ).returncode == 1
        if changed:
            message = f"保存预算数据 {dt.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"
            _run_git(["commit", "--only", "-m", message, "--", data_relative], root)

        commit = _run_git(["rev-parse", "--short", "HEAD"], root).stdout.strip()
        try:
            _run_git(
                ["push", remote, f"HEAD:refs/heads/{branch}"],
                root,
                timeout=_GIT_PUSH_TIMEOUT,
            )
        except RepositoryUploadError as exc:
            if changed:
                raise RepositoryUploadError(
                    f"数据已在本地提交为 {commit}，但上传失败：{exc}；修复后可直接再次点击上传"
                ) from exc
            raise
        return {
            "uploaded": True,
            "committed": changed,
            "remote": remote,
            "branch": branch,
            "commit": commit,
            "message": "数据已提交并上传" if changed else "数据没有新变化，远程仓库已同步",
        }


@app.post("/api/data/upload")
def api_data_upload():
    """将 data/ 的全部数据提交并推送到已配置的 Git 远程仓库。"""
    return _upload_data_to_remote()


def _empty_app_state() -> dict:
    return {
        "version": 1,
        "updatedAt": None,
        "year": None,
        "month": None,
        "itineraryByMonth": {},
        "optionsByMonth": {},
        "overridesByMonth": {},
        "resultsByMonth": {},
        "annualBudgetsByYear": {},
        "annualResultsByYear": {},
    }


def _compact_results_map(results: dict) -> dict:
    """去掉汇率明细，避免 app-state.json 过大、Safari 也无法用 localStorage 扛住。"""
    out = {}
    if not isinstance(results, dict):
        return out
    for key, val in results.items():
        if not isinstance(val, dict):
            continue
        out[str(key)] = {k: v for k, v in val.items() if k not in ("rates", "rates_dict")}
    return out


def _normalize_annual_budgets(raw: dict | None) -> dict:
    """严格规范全年输入；旧 app-state 缺少该字段时自然返回空对象。"""
    out: dict[str, dict[str, float]] = {}
    if raw is None:
        return out
    if not isinstance(raw, dict):
        raise ValueError("annualBudgetsByYear 必须是对象")
    for raw_year, raw_amounts in raw.items():
        year = str(raw_year)
        if not re.fullmatch(r"\d{4}", year) or not (2000 <= int(year) <= 2100):
            raise ValueError(f"annualBudgetsByYear 年份无效：{raw_year!r}")
        if not isinstance(raw_amounts, dict):
            raise ValueError(f"annualBudgetsByYear.{year} 必须是币种金额对象")
        amounts: dict[str, float] = {}
        for raw_currency, raw_amount in raw_amounts.items():
            currency = str(raw_currency).strip().upper()
            if not re.fullmatch(r"[A-Z]{2,6}", currency):
                raise ValueError(f"annualBudgetsByYear.{year} 币种代码无效：{raw_currency!r}")
            if currency in amounts:
                raise ValueError(f"annualBudgetsByYear.{year} 币种重复：{currency}")
            if (isinstance(raw_amount, bool) or not isinstance(raw_amount, (int, float))
                    or not math.isfinite(float(raw_amount)) or float(raw_amount) < 0):
                raise ValueError(
                    f"annualBudgetsByYear.{year}.{currency} 必须是非负有限数字"
                )
            amounts[currency] = float(raw_amount)
        if amounts:
            out[year] = amounts
    return out


def _compact_annual_results(raw: dict | None) -> dict:
    """严格校验全年结果并只保留紧凑摘要/明细。"""
    out = {}
    if raw is None:
        return out
    if not isinstance(raw, dict):
        raise ValueError("annualResultsByYear 必须是对象")
    for raw_year, result in raw.items():
        year = str(raw_year)
        if not re.fullmatch(r"\d{4}", year) or not (2000 <= int(year) <= 2100):
            raise ValueError(f"annualResultsByYear 年份无效：{raw_year!r}")
        if not isinstance(result, dict):
            raise ValueError(f"annualResultsByYear.{year} 必须是结果对象")
        compact = {
            key: value for key, value in result.items()
            if key not in ("rates", "rates_dict", "series")
        }
        if not compact:
            raise ValueError(f"annualResultsByYear.{year} 不能是空结果")
        result_year = compact.get("year")
        if result_year is not None and (
                isinstance(result_year, bool) or not isinstance(result_year, int)
                or result_year != int(year)):
            raise ValueError(f"annualResultsByYear.{year}.year 必须与外层年份一致")
        if "price_field" in compact and compact["price_field"] != "Close":
            raise ValueError(f"annualResultsByYear.{year}.price_field 必须是 Close")
        if ("non_trading_days" in compact
                and compact["non_trading_days"] != "excluded"):
            raise ValueError(
                f"annualResultsByYear.{year}.non_trading_days 必须是 excluded"
            )

        parsed_dates: dict[str, dt.date | None] = {}
        for field in ("start_date", "requested_through", "observed_through"):
            value = compact.get(field)
            if value is None:
                parsed_dates[field] = None
                continue
            if not isinstance(value, str):
                raise ValueError(f"annualResultsByYear.{year}.{field} 必须是日期字符串")
            try:
                parsed = dt.date.fromisoformat(value)
            except ValueError as exc:
                raise ValueError(
                    f"annualResultsByYear.{year}.{field} 日期无效"
                ) from exc
            if parsed.year != int(year):
                raise ValueError(f"annualResultsByYear.{year}.{field} 年份不一致")
            parsed_dates[field] = parsed
        start_date = parsed_dates["start_date"]
        requested_through = parsed_dates["requested_through"]
        observed_through = parsed_dates["observed_through"]
        if start_date is not None and start_date != dt.date(int(year), 1, 1):
            raise ValueError(f"annualResultsByYear.{year}.start_date 必须是当年 01-01")
        if start_date and requested_through and requested_through < start_date:
            raise ValueError(f"annualResultsByYear.{year} 日期范围顺序无效")
        if observed_through and start_date and observed_through < start_date:
            raise ValueError(f"annualResultsByYear.{year}.observed_through 早于开始日期")
        if observed_through and requested_through and observed_through > requested_through:
            raise ValueError(f"annualResultsByYear.{year}.observed_through 超出请求范围")
        summary = compact.get("summary")
        details = compact.get("details")
        if not isinstance(summary, dict):
            raise ValueError(f"annualResultsByYear.{year}.summary 必须是对象")
        total = summary.get("全年预算合计(人民币)")
        if (isinstance(total, bool) or not isinstance(total, (int, float))
                or not math.isfinite(float(total)) or float(total) < 0):
            raise ValueError(
                f"annualResultsByYear.{year}.summary.全年预算合计(人民币) 必须是非负有限数字"
            )
        if not isinstance(details, list):
            raise ValueError(f"annualResultsByYear.{year}.details 必须是数组")
        seen_currencies: set[str] = set()
        detail_total = 0.0
        for index, row in enumerate(details):
            path = f"annualResultsByYear.{year}.details[{index}]"
            if not isinstance(row, dict):
                raise ValueError(f"{path} 必须是对象")
            currency = row.get("currency")
            if not isinstance(currency, str) or not re.fullmatch(r"[A-Z]{2,6}", currency):
                raise ValueError(f"{path}.currency 无效")
            if currency in seen_currencies:
                raise ValueError(f"{path}.currency 重复：{currency}")
            seen_currencies.add(currency)
            for field in ("amount", "cny_amount"):
                value = row.get(field)
                if (isinstance(value, bool) or not isinstance(value, (int, float))
                        or not math.isfinite(float(value)) or float(value) < 0):
                    raise ValueError(f"{path}.{field} 必须是非负有限数字")
            rate = row.get("average_rate")
            if rate is None:
                if float(row["amount"]) != 0:
                    raise ValueError(f"{path}.average_rate 缺失")
                expected_cny = 0.0
            elif (isinstance(rate, bool) or not isinstance(rate, (int, float))
                  or not math.isfinite(float(rate)) or float(rate) <= 0):
                raise ValueError(f"{path}.average_rate 必须是正有限数字")
            else:
                expected_cny = round(float(row["amount"]) * float(rate), 2)
            if not math.isclose(
                    float(row["cny_amount"]), expected_cny,
                    rel_tol=0.0, abs_tol=1e-9):
                raise ValueError(f"{path}.cny_amount 与金额乘年平均汇率不一致")
            detail_total += float(row["cny_amount"])
            if not math.isfinite(detail_total):
                raise ValueError(
                    f"annualResultsByYear.{year}.details 人民币金额合计超出有限数范围"
                )

            observation_count = row.get("observation_count")
            if observation_count is not None and (
                    isinstance(observation_count, bool)
                    or not isinstance(observation_count, int)
                    or observation_count < 0):
                raise ValueError(f"{path}.observation_count 必须是非负整数")
            row_dates = {}
            for field in ("first_date", "last_date"):
                value = row.get(field)
                if value is None:
                    row_dates[field] = None
                    continue
                if not isinstance(value, str):
                    raise ValueError(f"{path}.{field} 必须是日期字符串或 null")
                try:
                    parsed = dt.date.fromisoformat(value)
                except ValueError as exc:
                    raise ValueError(f"{path}.{field} 日期无效") from exc
                if parsed.year != int(year):
                    raise ValueError(f"{path}.{field} 年份不一致")
                row_dates[field] = parsed
            if row_dates["first_date"] and row_dates["last_date"]:
                if row_dates["first_date"] > row_dates["last_date"]:
                    raise ValueError(f"{path} 行情日期范围顺序无效")
                if start_date and row_dates["first_date"] < start_date:
                    raise ValueError(f"{path}.first_date 超出全年范围")
                if requested_through and row_dates["last_date"] > requested_through:
                    raise ValueError(f"{path}.last_date 超出请求范围")
        expected_total = round(detail_total, 2)
        if not math.isclose(float(total), expected_total, rel_tol=0.0, abs_tol=1e-9):
            raise ValueError(
                f"annualResultsByYear.{year}.summary.全年预算合计(人民币) 与明细合计不一致"
            )
        if "errors" in compact and not isinstance(compact["errors"], dict):
            raise ValueError(f"annualResultsByYear.{year}.errors 必须是对象")
        out[year] = compact
    return out


def _normalize_app_state(raw: dict | None) -> dict:
    state = _empty_app_state()
    if raw is None:
        return state
    if not isinstance(raw, dict):
        raise ValueError("app-state 根节点必须是对象")
    if isinstance(raw.get("version"), int) and not isinstance(raw.get("version"), bool):
        state["version"] = raw["version"]
    if isinstance(raw.get("updatedAt"), str):
        state["updatedAt"] = raw["updatedAt"]
    year, month = raw.get("year"), raw.get("month")
    if year is not None:
        if isinstance(year, bool) or not isinstance(year, int) or not (2000 <= year <= 2100):
            raise ValueError("app-state.year 必须是 2000-2100 的整数或 null")
        state["year"] = year
    if month is not None:
        if isinstance(month, bool) or not isinstance(month, int) or not (1 <= month <= 12):
            raise ValueError("app-state.month 必须是 1-12 的整数或 null")
        state["month"] = month
    for field in (
            "itineraryByMonth", "optionsByMonth", "overridesByMonth",
            "resultsByMonth", "annualBudgetsByYear", "annualResultsByYear"):
        if field in raw and raw[field] is not None and not isinstance(raw[field], dict):
            raise ValueError(f"app-state.{field} 必须是对象")
    itin_in = raw.get("itineraryByMonth")
    if isinstance(itin_in, dict):
        cleaned = {}
        for month, month_itin in itin_in.items():
            cleaned[str(month)] = _exclusive_itinerary_month(
                month_itin if isinstance(month_itin, dict) else {}
            )
        state["itineraryByMonth"] = cleaned
    for field in ("optionsByMonth", "overridesByMonth"):
        val = raw.get(field)
        if isinstance(val, dict):
            state[field] = val
    state["resultsByMonth"] = _compact_results_map(raw.get("resultsByMonth") or {})
    state["annualBudgetsByYear"] = _normalize_annual_budgets(raw.get("annualBudgetsByYear"))
    state["annualResultsByYear"] = _compact_annual_results(raw.get("annualResultsByYear"))
    return state


def _itinerary_range_count(itinerary: dict | None) -> int:
    n = 0
    if not isinstance(itinerary, dict):
        return 0
    for loc_ranges in itinerary.values():
        if not isinstance(loc_ranges, dict):
            continue
        for ranges in loc_ranges.values():
            if isinstance(ranges, list):
                n += len(ranges)
    return n


def _iter_days(start: str, end: str) -> list[str]:
    """按日历日期枚举闭区间，避免时区/DST 把某一天算到另一个地点。"""
    try:
        cur = dt.date.fromisoformat(str(start).strip())
        last = dt.date.fromisoformat(str(end).strip())
    except (TypeError, ValueError):
        return []
    if cur > last:
        return []
    days = []
    while cur <= last:
        days.append(cur.isoformat())
        cur += dt.timedelta(days=1)
    return days


def _ranges_from_days(days: list[str]) -> list[dict]:
    uniq = sorted(set(days))
    if not uniq:
        return []
    ranges = []
    start = prev = uniq[0]
    for day in uniq[1:]:
        try:
            consecutive = dt.date.fromisoformat(day) == dt.date.fromisoformat(prev) + dt.timedelta(days=1)
        except ValueError:
            consecutive = False
        if consecutive:
            prev = day
            continue
        ranges.append({"start": start, "end": prev})
        start = prev = day
    ranges.append({"start": start, "end": prev})
    return ranges


def _exclusive_itinerary_month(month) -> dict:
    """同一天只属于一个地点：更短的日期段优先，避免香港大段覆盖深圳空隙。"""
    if not isinstance(month, dict):
        return {}
    owners: dict[str, tuple[str, int]] = {}
    for loc, ranges in month.items():
        if not isinstance(ranges, list):
            continue
        loc_key = str(loc)
        for rng in ranges:
            if not isinstance(rng, dict):
                continue
            days = _iter_days(rng.get("start"), rng.get("end"))
            length = len(days)
            if not length:
                continue
            for day in days:
                prev = owners.get(day)
                if prev is None or length < prev[1]:
                    owners[day] = (loc_key, length)
    claimed: dict[str, list[str]] = {}
    for day, (loc, _) in owners.items():
        claimed.setdefault(loc, []).append(day)
    out = {}
    for loc in month:
        loc_key = str(loc)
        if loc_key in claimed:
            out[loc_key] = _ranges_from_days(claimed.pop(loc_key))
    for loc_key, days in claimed.items():
        out[loc_key] = _ranges_from_days(days)
    return out


def _merge_itinerary_map(disk: dict, incoming: dict) -> dict:
    """按月合并行程。

    浏览器提交了某个月（含空对象=已清空）时，以本次提交为准，不再把磁盘上
    旧的香港大段追加回去；完全没提交行程字段时保留磁盘，避免空缓存清空仓库。
    """
    disk = disk if isinstance(disk, dict) else {}
    incoming = incoming if isinstance(incoming, dict) else {}
    out = {}
    if incoming:
        for month, inc in incoming.items():
            cleaned = _exclusive_itinerary_month(inc if isinstance(inc, dict) else {})
            if cleaned:
                out[month] = cleaned
        for month, cur in disk.items():
            if month in incoming:
                continue
            cleaned = _exclusive_itinerary_month(cur if isinstance(cur, dict) else {})
            if cleaned:
                out[month] = cleaned
        return out
    for month, cur in disk.items():
        cleaned = _exclusive_itinerary_month(cur if isinstance(cur, dict) else {})
        if cleaned:
            out[month] = cleaned
    return out


def _merge_present_month_map(disk, incoming) -> dict:
    """浏览器提交了某个月（含空对象=已清空）则以本次为准；未提交的月份保留磁盘。"""
    disk = disk if isinstance(disk, dict) else {}
    incoming = incoming if isinstance(incoming, dict) else {}
    if not incoming:
        return dict(disk)
    out = {}
    for month, val in incoming.items():
        if isinstance(val, dict) and val:
            out[month] = val
    for month, val in disk.items():
        if month in incoming:
            continue
        if isinstance(val, dict) and val:
            out[month] = val
    return out


def _is_default_options(opt) -> bool:
    if not isinstance(opt, dict):
        return True
    region = "Overseas" if opt.get("region") == "Overseas" else "Mainland"
    travel = bool(opt.get("includeTravel"))
    sel = opt.get("travelSelected")
    has_sel = isinstance(sel, list) and len(sel) > 0
    return region == "Mainland" and not travel and not has_sel and not opt.get("savedAt")


def _fill_options_from_results(options: dict, results: dict) -> dict:
    out = dict(options or {})
    for month, res in (results or {}).items():
        if not isinstance(res, dict):
            continue
        summary = res.get("summary") if isinstance(res.get("summary"), dict) else {}
        region = res.get("region") or summary.get("居住区域")
        include = res.get("includeTravel")
        cur = out.get(month)
        if cur and not _is_default_options(cur):
            continue
        next_opt = dict(cur) if isinstance(cur, dict) else {
            "region": "Mainland", "includeTravel": False, "travelSelected": None,
        }
        if region in ("Mainland", "Overseas"):
            next_opt["region"] = region
        if include is not None:
            next_opt["includeTravel"] = bool(include)
        out[month] = next_opt
    return out


def _merge_app_state(disk: dict | None, incoming: dict | None, replace: bool = False) -> dict:
    """把浏览器提交的状态合并进磁盘文件。

    提交了某个月则以本次为准（空对象=已清空）；完全没提交的月份保留磁盘。
    打开页面只读，不得靠合并本机缓存来改仓库。
    """
    incoming_raw = dict(incoming) if isinstance(incoming, dict) else {}
    # 请求中的空年度对象是按年份删除用的墓碑，只参与本次合并，不会写入磁盘。
    raw_annual_budgets = incoming_raw.get("annualBudgetsByYear")
    annual_budget_tombstones = {
        str(year) for year, value in raw_annual_budgets.items() if value == {}
    } if isinstance(raw_annual_budgets, dict) else set()
    raw_annual_results = incoming_raw.get("annualResultsByYear")
    annual_result_tombstones = {
        str(year) for year, value in raw_annual_results.items() if value == {}
    } if isinstance(raw_annual_results, dict) else set()
    for field, tombstones in (
            ("annualBudgetsByYear", annual_budget_tombstones),
            ("annualResultsByYear", annual_result_tombstones)):
        for year in tombstones:
            if not re.fullmatch(r"\d{4}", year) or not (2000 <= int(year) <= 2100):
                raise ValueError(f"{field} 年份无效：{year!r}")
    if annual_result_tombstones:
        incoming_raw["annualResultsByYear"] = {
            year: value for year, value in raw_annual_results.items() if value != {}
        }
    incoming_n = _normalize_app_state(incoming_raw)
    if (incoming_n["year"] is None) != (incoming_n["month"] is None):
        raise ValueError("year 与 month 必须成对提交")
    if replace:
        # 整份覆盖时空年度项就是“结果中不存在该年”，不能把墓碑写进磁盘。
        return incoming_n
    for year in annual_budget_tombstones:
        incoming_n["annualBudgetsByYear"][year] = {}
    for year in annual_result_tombstones:
        incoming_n["annualResultsByYear"][year] = {}
    disk_n = _normalize_app_state(disk)
    itinerary = _merge_itinerary_map(
        disk_n["itineraryByMonth"],
        incoming_n["itineraryByMonth"],
    )
    options = _merge_present_month_map(
        disk_n["optionsByMonth"],
        incoming_n["optionsByMonth"],
    )
    overrides = _merge_present_month_map(
        disk_n["overridesByMonth"],
        incoming_n["overridesByMonth"],
    )
    results = _merge_present_month_map(
        disk_n["resultsByMonth"],
        incoming_n["resultsByMonth"],
    )
    annual_budgets = _merge_present_month_map(
        disk_n["annualBudgetsByYear"],
        incoming_n["annualBudgetsByYear"],
    )
    annual_results = _merge_present_month_map(
        disk_n["annualResultsByYear"],
        incoming_n["annualResultsByYear"],
    )
    year, month = disk_n["year"], disk_n["month"]
    if incoming_n["year"] and incoming_n["month"]:
        year, month = incoming_n["year"], incoming_n["month"]
    return _normalize_app_state({
        "version": max(disk_n.get("version") or 1, incoming_n.get("version") or 1),
        "year": year,
        "month": month,
        "itineraryByMonth": itinerary,
        "optionsByMonth": options,
        "overridesByMonth": overrides,
        "resultsByMonth": results,
        "annualBudgetsByYear": annual_budgets,
        "annualResultsByYear": annual_results,
    })


def _read_app_state_file() -> dict | None:
    """用户状态不是可丢弃缓存：已存在但损坏时必须拒绝静默覆盖。"""
    return functions.read_json_file(APP_STATE_FILE, strict=True)


def _load_app_state() -> dict:
    with _state_disk_lock:
        raw = _normalize_app_state(_read_app_state_file())
        raw["optionsByMonth"] = _fill_options_from_results(
            raw.get("optionsByMonth") or {},
            raw.get("resultsByMonth") or {},
        )
        return raw


_STATE_MAP_FIELDS = (
    "itineraryByMonth",
    "optionsByMonth",
    "overridesByMonth",
    "resultsByMonth",
    "annualBudgetsByYear",
    "annualResultsByYear",
)


def _state_marker_matches(current, marker: dict) -> bool:
    expected_exists = marker["exists"]
    current_exists = current is not _MISSING_STATE_VALUE
    return current_exists == expected_exists and (
        not expected_exists or current == marker["value"]
    )


def _payload_target_marker(payload: dict, field: str, key: str | None):
    if key is None:
        if field not in payload:
            return None
        return {"exists": True, "value": payload[field]}
    values = payload.get(field)
    if not isinstance(values, dict) or key not in values:
        return None
    value = values[key]
    # 所有状态 map 都以空对象表达删除；磁盘不会保留墓碑。
    if isinstance(value, dict) and not value:
        return {"exists": False}
    return {"exists": True, "value": value}


def _assert_state_patch_base(disk: dict, base_values: dict | None,
                             payload: dict | None = None) -> None:
    """逐键比较前端读取基线；只冲突真正修改的键，允许不同月份并行保存。"""
    if base_values is None:
        return
    if not isinstance(base_values, dict):
        raise ValueError("baseValues 必须是对象")
    allowed = {"year", "month", *_STATE_MAP_FIELDS}
    unknown = set(base_values) - allowed
    if unknown:
        raise ValueError(f"baseValues 包含未知字段：{', '.join(sorted(unknown))}")

    payload = payload if isinstance(payload, dict) else {}

    # 旧客户端完全不提交 baseValues 时仍按既有合并语义兼容；一旦选择使用
    # 乐观并发协议，就必须为每个实际写入键提供比较基线，不能靠漏 marker
    # 绕过同键冲突。year/month 是一个不可拆分的选择值，marker 也必须成对。
    has_year_base = "year" in base_values
    has_month_base = "month" in base_values
    if has_year_base != has_month_base:
        raise ValueError("baseValues.year 与 baseValues.month 必须成对提交")

    payload_year = payload.get("year")
    payload_month = payload.get("month")
    if (payload_year is None) != (payload_month is None):
        raise ValueError("year 与 month 必须成对提交")
    if payload_year is not None and not (has_year_base and has_month_base):
        raise ValueError("baseValues 必须同时包含 year 与 month 的读取基线")

    for field in _STATE_MAP_FIELDS:
        values = payload.get(field)
        if not isinstance(values, dict) or not values:
            continue
        field_base = base_values.get(field)
        if field_base is None:
            missing = ", ".join(sorted(str(key) for key in values))
            raise ValueError(f"baseValues.{field} 缺少写入键：{missing}")
        if not isinstance(field_base, dict):
            raise ValueError(f"baseValues.{field} 必须是对象")
        marker_keys = {str(key) for key in field_base}
        missing = [str(key) for key in values if str(key) not in marker_keys]
        if missing:
            raise ValueError(
                f"baseValues.{field} 缺少写入键：{', '.join(sorted(missing))}"
            )

    def validate_basic_marker(marker, label: str) -> None:
        if not isinstance(marker, dict) or not isinstance(marker.get("exists"), bool):
            raise ValueError(f"baseValues.{label} 格式无效")
        if marker["exists"] and "value" not in marker:
            raise ValueError(f"baseValues.{label} 缺少 value")

    def assert_marker(field: str, key: str | None, current, marker) -> None:
        label = f"{field}.{key}" if key is not None else field
        validate_basic_marker(marker, label)
        alternatives = marker.get("alternatives", [])
        if not isinstance(alternatives, list) or len(alternatives) > 4:
            raise ValueError(f"baseValues.{label}.alternatives 格式无效")
        for index, alternative in enumerate(alternatives):
            validate_basic_marker(alternative, f"{label}.alternatives[{index}]")
        candidates = [marker, *alternatives]
        if any(_state_marker_matches(current, candidate) for candidate in candidates):
            return
        # 请求重试或最终 beacon 可能在上一笔同值写入之后到达；目标值已在
        # 磁盘时视为幂等成功，不覆盖其它未提交键。
        target = _payload_target_marker(payload, field, key)
        if target is not None and _state_marker_matches(current, target):
            return
        raise StateConflictError(
            f"{label} 已被另一个标签页修改，本次旧快照未覆盖；请刷新页面后重试"
        )

    for field in ("year", "month"):
        if field in base_values:
            assert_marker(field, None, disk.get(field, _MISSING_STATE_VALUE), base_values[field])
    for field in _STATE_MAP_FIELDS:
        field_base = base_values.get(field)
        if field_base is None:
            continue
        if not isinstance(field_base, dict):
            raise ValueError(f"baseValues.{field} 必须是对象")
        current_map = disk.get(field) if isinstance(disk.get(field), dict) else {}
        for key, marker in field_base.items():
            assert_marker(field, str(key), current_map.get(str(key), _MISSING_STATE_VALUE), marker)


_MISSING_STATE_VALUE = object()


def _validate_state_write_identity(tab_id, sequence) -> tuple[str | None, int | None]:
    """校验可选的同标签页写入顺序标识；旧客户端可同时省略两者。"""
    if tab_id is None and sequence is None:
        return None, None
    if not isinstance(tab_id, str) or not tab_id or len(tab_id) > 64:
        raise ValueError("tabId 必须是 1-64 个字符的非空字符串")
    if isinstance(sequence, bool) or not isinstance(sequence, int) or sequence < 1:
        raise ValueError("sequence 必须是从 1 开始递增的整数")
    return tab_id, sequence


def _partition_state_patch(disk: dict, base_values: dict, payload: dict) -> tuple[dict, list[str]]:
    """按“月份/年度”逻辑键拆分 CAS，返回无冲突组和冲突组。

    同一月份的行程、选项、标准和结果视为一个原子组；同一年度的全年输入
    和全年结果也视为一个原子组。普通 PUT 由调用者保持整请求全有或全无；
    页面已离开的 unregister 可以保存这里返回的安全组，同时不会写出半个
    月份或半个年度的状态。
    """
    if not isinstance(base_values, dict):
        raise ValueError("baseValues 必须是对象")
    allowed = {"year", "month", *_STATE_MAP_FIELDS}
    unknown = set(base_values) - allowed
    if unknown:
        raise ValueError(f"baseValues 包含未知字段：{', '.join(sorted(unknown))}")

    payload_year = payload.get("year")
    payload_month = payload.get("month")
    has_payload_selection = payload_year is not None or payload_month is not None
    if (payload_year is None) != (payload_month is None):
        raise ValueError("year 与 month 必须成对提交")
    if ("year" in base_values) != ("month" in base_values):
        raise ValueError("baseValues.year 与 baseValues.month 必须成对提交")
    if has_payload_selection and "year" not in base_values:
        raise ValueError("baseValues 必须同时包含 year 与 month 的读取基线")

    safe: dict = {
        key: payload[key] for key in ("version", "updatedAt") if key in payload
    }
    conflicts: list[str] = []
    if has_payload_selection:
        selection_payload = {"year": payload_year, "month": payload_month}
        selection_base = {
            "year": base_values["year"], "month": base_values["month"],
        }
        try:
            _assert_state_patch_base(disk, selection_base, selection_payload)
        except StateConflictError:
            conflicts.append("year/month")
        else:
            safe.update(selection_payload)

    groups: dict[tuple[str, str], dict[str, dict]] = {}
    expected_markers: dict[str, set[str]] = {}
    for field in _STATE_MAP_FIELDS:
        values = payload.get(field)
        if values is None:
            continue
        if not isinstance(values, dict):
            raise ValueError(f"{field} 必须是对象")
        expected_markers[field] = {str(key) for key in values}
        field_base = base_values.get(field)
        if values and not isinstance(field_base, dict):
            missing = ", ".join(sorted(str(key) for key in values))
            raise ValueError(f"baseValues.{field} 缺少写入键：{missing}")
        for raw_key, value in values.items():
            key = str(raw_key)
            if key not in field_base:
                raise ValueError(f"baseValues.{field} 缺少写入键：{key}")
            domain = "annual" if field.startswith("annual") else "month"
            group = groups.setdefault((domain, key), {"payload": {}, "base": {}})
            group["payload"].setdefault(field, {})[key] = value
            group["base"].setdefault(field, {})[key] = field_base[key]

    # 多余 marker 没有对应写入目标，通常意味着客户端协议实现有误；拒绝它，
    # 避免无关旧基线制造伪冲突或掩盖漏字段。
    for field in _STATE_MAP_FIELDS:
        field_base = base_values.get(field)
        if field_base is None:
            continue
        if not isinstance(field_base, dict):
            raise ValueError(f"baseValues.{field} 必须是对象")
        extras = {str(key) for key in field_base} - expected_markers.get(field, set())
        if extras:
            raise ValueError(
                f"baseValues.{field} 包含未写入键：{', '.join(sorted(extras))}"
            )

    for (domain, key), group in groups.items():
        try:
            _assert_state_patch_base(disk, group["base"], group["payload"])
        except StateConflictError:
            conflicts.append(f"{domain}:{key}")
            continue
        for field, values in group["payload"].items():
            safe.setdefault(field, {}).update(values)
    return safe, conflicts


def _save_app_state(payload: dict, replace: bool = False,
                    base_values: dict | None = None,
                    tab_id: str | None = None,
                    sequence: int | None = None,
                    allow_partial_conflicts: bool = False) -> dict:
    tab_id, sequence = _validate_state_write_identity(tab_id, sequence)
    with _state_disk_lock:
        disk = _normalize_app_state(_read_app_state_file())
        disk["optionsByMonth"] = _fill_options_from_results(
            disk.get("optionsByMonth") or {}, disk.get("resultsByMonth") or {},
        )
        if tab_id is not None:
            previous_sequence = _state_write_sequences.get(tab_id)
            if previous_sequence is not None and sequence <= previous_sequence:
                return disk
            # 记录最高“已见”序号，而非仅记录成功写盘序号。较新的请求代表该
            # 标签页的最终意图；即使它随后因跨标签 CAS 冲突而被拒绝，旧请求
            # 也不能在锁释放后反向落盘。
            _state_write_sequences[tab_id] = sequence
        conflicts: list[str] = []
        safe_payload = payload
        if not replace and base_values is not None:
            safe_payload, conflicts = _partition_state_patch(disk, base_values, payload)
            # 普通 PUT 必须全有或全无。若先写入无冲突组再返回 409，浏览器会
            # 保留整份旧基线，后续编辑和删除便会与已部分落盘的状态分叉。
            # 只有页面已经离开的 unregister 可以按组抢救无冲突修改。
            if conflicts and not allow_partial_conflicts:
                raise StateConflictError(
                    "以下状态已被另一个标签页修改，本次请求未写入："
                    f"{', '.join(conflicts)}。请刷新页面后重试"
                )
        meaningful = replace or any(
            key in safe_payload for key in ("year", "month", *_STATE_MAP_FIELDS)
        )
        if meaningful:
            state = _merge_app_state(disk, safe_payload, replace=replace)
            state["updatedAt"] = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            functions.atomic_write_text(
                APP_STATE_FILE,
                json.dumps(state, ensure_ascii=False, indent=2),
            )
        else:
            state = disk
        if conflicts:
            saved_note = "；其它无冲突月份/年度已保存" if meaningful else ""
            raise StateConflictError(
                f"以下状态已被另一个标签页修改，本次旧快照未覆盖：{', '.join(conflicts)}"
                f"{saved_note}。请刷新页面后重试"
            )
    return state


@app.get("/api/state")
def api_get_state():
    """读取随仓库同步的行程、每月选项、标准覆盖与计算结果。"""
    return _load_app_state()


@app.put("/api/state")
def api_put_state(body: AppStateIn):
    """把浏览器当前数据合并写入 data/app-state.json。空缓存不会清掉磁盘上已有行程。"""
    payload = body.model_dump() if hasattr(body, "model_dump") else body.dict()
    replace = bool(payload.pop("replace", False))
    base_values = payload.pop("baseValues", None)
    tab_id = payload.pop("tabId", None)
    sequence = payload.pop("sequence", None)
    return _save_app_state(
        payload,
        replace=replace,
        base_values=base_values,
        tab_id=tab_id,
        sequence=sequence,
    )


def _meta_payload() -> dict:
    """当前生效的默认标准与展示元数据（含用户保存的地点/币种中文名）。"""
    defaults = functions.default_standards_snapshot()
    loc_names = _location_names(defaults["location_names"])
    curr_names = _currency_names(defaults["currency_names"])
    locations = []
    for loc, std in defaults["variable"].items():
        curr = next(iter(std))
        locations.append({
            "key": loc, "name": loc_names.get(loc, loc), "category": "variable",
            "currency": curr, "currency_name": curr_names.get(curr, curr),
            "default": std[curr],
        })
    for loc, std in defaults["travel"].items():
        curr = next(iter(std))
        locations.append({
            "key": loc, "name": loc_names.get(loc, loc), "category": "travel",
            "currency": curr, "currency_name": curr_names.get(curr, curr),
            "daily": std[curr]["daily"], "once": std[curr]["once"],
        })
    regions = [
        {"key": r, "name": REGION_NAMES.get(r, r),
         "currencies": {c: curr_names.get(c, c) for c in std}}
        for r, std in defaults["fixed"].items()
    ]
    warnings = []
    if defaults["load_error"]:
        warnings.append(defaults["load_error"])
    return {
        "default_standards": {
            "variable": defaults["variable"],
            "fixed": defaults["fixed"],
            "travel": defaults["travel"],
            "extra": defaults["extra"],
        },
        "locations": locations,
        "regions": regions,
        "currencies": _all_currencies(defaults),
        "currency_names": curr_names,
        "location_names": loc_names,
        "defaults_customized": defaults["customized"],
        "defaults_revision": defaults["revision"],
        "warnings": warnings,
    }


@app.get("/api/meta")
def api_meta():
    """返回当前生效的默认预算标准、地点/区域元数据（前端据此渲染编辑界面）。"""
    return _meta_payload()


@app.post("/api/defaults")
def api_save_defaults(body: DefaultsPayload):
    """把当前预算标准保存为服务器默认值（data/defaults.json），立即对后续月份生效。"""
    payload = body.model_dump() if hasattr(body, "model_dump") else body.dict()
    base_revision = payload.pop("base_revision")
    functions.save_default_standards(payload, expected_revision=base_revision)
    return _meta_payload()


@app.post("/api/defaults/reset")
def api_reset_defaults(body: DefaultsResetIn):
    """删除 data/defaults.json，恢复 functions.py 出厂默认标准。"""
    functions.restore_builtin_defaults(expected_revision=body.base_revision)
    return _meta_payload()


@app.get("/api/rates")
def api_rates(year: int, month: int,
              currencies: str | None = Query(default=None, description="逗号分隔的币种列表，缺省为全部"),
              refresh: bool = Query(default=False, description="为 true 时忽略内存/磁盘缓存，重新向 Yahoo Finance 下载")):
    """当月每日汇率（兑人民币）与月度统计，供折线图与统计表使用。"""
    _validate_year_month(year, month)
    curr_list = _parse_currencies(currencies)
    start, end = _month_bounds(year, month)
    rates = _fetch_rates_parallel(curr_list, start, end, refresh=refresh)
    return _rates_payload(rates, curr_list)


def _parse_currencies(currencies: str | None) -> list[str]:
    if currencies is None:
        return _all_currencies()
    parts = [c.strip().upper() for c in currencies.split(",") if c.strip()]
    # 支持自定义币种（新建预算标准产生）：仅校验格式，实际可下载性由 Yahoo 决定
    bad = [c for c in parts if not re.fullmatch(r"[A-Z]{2,6}", c)]
    if bad:
        raise ValueError(f"币种代码无效：{', '.join(bad)}（应为 2-6 位字母，如 EUR）")
    # 去重且保持稳定顺序
    return sorted(set(parts))


@app.get("/api/annual-rates")
def api_annual_rates(year: int,
                     currencies: str | None = Query(default=None, description="逗号分隔的币种列表，缺省为全部"),
                     refresh: bool = Query(default=False, description="为 true 时跳过年度 Close 进程内缓存")):
    """年初至截止日的实际交易日收盘汇率统计（不填充非交易日）。"""
    start, end = _annual_bounds(year)
    curr_list = _parse_currencies(currencies)
    rates, errors = _fetch_annual_close_rates(curr_list, start, end, refresh=refresh)
    return _annual_rates_payload(year, start, end, rates, curr_list, errors)


@app.post("/api/annual-budget")
def api_annual_budget(req: AnnualBudgetRequest):
    """用各币种实际交易日 Close 年平均值计算全年预算。"""
    start, end = _annual_bounds(req.year)
    amounts: dict[str, float] = {}
    for raw_currency, raw_amount in req.amounts.items():
        currency = str(raw_currency).strip().upper()
        if not re.fullmatch(r"[A-Z]{2,6}", currency):
            raise ValueError(f"币种代码无效：{raw_currency}（应为 2-6 位字母，如 EUR）")
        if currency in amounts:
            raise ValueError(f"全年预算币种重复：{currency}")
        if (isinstance(raw_amount, bool) or not isinstance(raw_amount, (int, float))
                or not math.isfinite(float(raw_amount)) or float(raw_amount) < 0):
            raise ValueError(f"全年预算 {currency} 金额必须是非负有限数")
        amounts[currency] = float(raw_amount)

    curr_list = sorted(amounts)
    rates, errors = _fetch_annual_close_rates(curr_list, start, end)
    blocking = [currency for currency, amount in amounts.items() if amount > 0 and currency in errors]
    if blocking:
        detail = "；".join(f"{currency}: {errors[currency]}" for currency in blocking)
        raise RateFetchError(detail)

    stats = functions.annual_rate_stats(rates, curr_list)
    averages = {currency: row["average"] for currency, row in stats.items()}
    result = functions.calculate_annual_budget(amounts, averages)
    for detail in result["details"]:
        rate_stat = stats.get(detail["currency"])
        detail["observation_count"] = rate_stat["observation_count"] if rate_stat else 0
        detail["first_date"] = rate_stat["first_date"] if rate_stat else None
        detail["last_date"] = rate_stat["last_date"] if rate_stat else None
    result.update({
        "year": req.year,
        "start_date": start,
        "requested_through": end,
        "observed_through": _annual_observed_through(stats),
        "source": "Yahoo Finance",
        "price_field": "Close",
        "non_trading_days": "excluded",
        "errors": errors,
    })
    return result


@app.post("/api/calculate")
def api_calculate(req: CalculateRequest):
    """执行当月预算计算：标准解析 → 行程展开/旅居过滤 → 汇率 → 计算。"""
    # 1) 解析本次计算的预算标准（含当月新建的自定义地点/币种），得到地点注册表
    resolved_standards = functions.resolve_standards(req.standards_override)
    _, fixed_std, _, loc_registry, extra_std = resolved_standards

    # 2) 行程展开 + 旅居过滤（include_travel / travel_locations）
    expanded, warnings, dup_count = _expand_itinerary(
        req.itinerary, req.year, req.month, loc_registry,
        include_travel=req.include_travel,
        travel_locations=req.travel_locations,
    )
    if not expanded:
        raise ValueError("行程为空（或旅居全部被排除），请至少保留一个日期区间")

    start, end = _month_bounds(req.year, req.month)
    currencies: set[str] = set()
    for entry in expanded:
        currencies.add(loc_registry[entry["location"]]["currency"])
    currencies.update(fixed_std[req.region].keys())
    currencies.update(curr for curr, amt in extra_std.items() if amt)
    curr_list = sorted(currencies)

    rates = _fetch_rates_parallel(curr_list, start, end)

    result = functions.calculate_travel_budget(
        expanded, req.region, req.year, req.month,
        standards_override=req.standards_override,
        rates_dict=rates,
        resolved_standards=resolved_standards,
    )
    result["warnings"] = warnings
    result["deduped_entries"] = dup_count
    result["rates"] = _rates_payload(rates, curr_list)
    return result


# ---------------------------------------------------------------------------
# 静态资源（必须最后挂载，避免遮挡 /api 路由）
# ---------------------------------------------------------------------------
app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")


# ---------------------------------------------------------------------------
# 启动入口
# ---------------------------------------------------------------------------
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

    global AUTO_SHUTDOWN_ENABLED, SHUTDOWN_GRACE_SECONDS
    if args.no_autoshutdown:
        AUTO_SHUTDOWN_ENABLED = False
    else:
        SHUTDOWN_GRACE_SECONDS = max(0.0, args.autoshutdown_grace)

    url = f"http://{args.host}:{args.port}/"
    print("=" * 60)
    print("多币种旅行预算计算器 Web 版已启动")
    print(f"地址：{url}")
    if functions.defaults_are_customized():
        print("默认预算标准：data/defaults.json（用户保存）")
    else:
        print("默认预算标准：functions.py 出厂值")
    if functions.defaults_load_error():
        print(f"警告：{functions.defaults_load_error()}")
    state_readable = True
    try:
        st = _load_app_state()
    except ValueError as exc:
        # 启动信息只需要统计，不能因为用户状态损坏而让修复页面也无法打开。
        # API 的严格读写仍会拒绝该文件，前端可回退 localStorage 并明确提示。
        state_readable = False
        st = _empty_app_state()
        print(f"警告：项目状态无法读取，服务将以只读修复模式启动：{exc}")
    itin_months = [
        m for m, v in (st.get("itineraryByMonth") or {}).items()
        if _itinerary_range_count({m: v}) > 0
    ]
    print(f"行程数据：data/app-state.json（{len(itin_months)} 个有行程的月份）")
    print(f"内地/境外选项：{len(st.get('optionsByMonth') or {})} 个月")
    print(f"汇率缓存：data/rates/（{len(_list_rate_months())} 个月）")
    if state_readable and not itin_months:
        print("提示：行程仍为空。请在「有旧行程的那台 Windows 浏览器」打开本页一次，再 git add data/app-state.json && git commit && git push")
    if args.open_browser:
        print("即将自动打开浏览器")
    if AUTO_SHUTDOWN_ENABLED:
        if SHUTDOWN_GRACE_SECONDS > _SHUTDOWN_FLUSH_SECONDS:
            print(f"自动关闭：关闭页面后约 {SHUTDOWN_GRACE_SECONDS:g} 秒停止服务并释放端口")
        else:
            print("自动关闭：关闭页面后立即保存数据、停止服务并释放端口")
        print(f"自动关闭兜底：浏览器漏发关闭事件时，失联约 {_TAB_LEASE_SECONDS:g} 秒后停止服务")
    else:
        print("自动关闭：已禁用（--no-autoshutdown），请手动 Ctrl+C 停止服务")
    print("按 Ctrl+C 停止服务")
    print("=" * 60)

    if args.open_browser:
        threading.Timer(1.2, webbrowser.open, args=(url,)).start()

    import uvicorn
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
