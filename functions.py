"""计算引擎与预算标准（仅供 Web 版 main_web.py 使用）。

包含：出厂/用户默认预算标准、预算标准校验与落盘、汇率下载与三级缓存，
以及核心计算方法 calculate_travel_budget / calculate_annual_budget / resolve_standards。
金额与日期校验都在这里完成，Web 层不复制计算规则。
"""

from __future__ import annotations

import copy
import datetime
import hashlib
import json
import math
import os
import re
import threading
import time
from pathlib import Path

import pandas as pd
import yfinance as yf


# 预设的预算标准（出厂默认；若存在 data/defaults.json，启动时覆盖为用户保存的默认值）
VARIABLE_BUDGET_STANDARDS = {
    # 深圳定居预算
    "Shenzhen": {"CNY": 80},
    # 香港定居预算
    "Hong_Kong": {"HKD": 150},
    # 成都定居预算
    "Chengdu": {"CNY": 30},
}

FIXED_BUDGET_STANDARDS = {
    # 内地
    "Mainland": {"USD": 22, "CNY": 64, "HKD": 46},
    # 境外
    "Overseas": {"USD": 10, "CNY": 64, "HKD": 88},
}

# 额外预算（与固定预算相同：各币种月额 × 当月平均汇率，每月只计算一次）
EXTRA_BUDGET_STANDARDS = {
    "CNY": 0,
    "USD": 0,
    "HKD": 0,
}

TRAVEL_BUDGET_STANDARDS = {
    # 上海旅居预算
    "Shanghai": {"CNY": {
            "daily": 175,
            "once": 200,
        },},
    # 台北旅居预算
    "Taipei": {"TWD": {
            "daily": 1450,
            "once": 1000,
        },},
    # 曼谷旅居预算
    "Bangkok": {"THB": {
            "daily": 1100,
            "once": 2000,
        },},
}

ALL_BUDGET_LOCATIONS = {**VARIABLE_BUDGET_STANDARDS, **TRAVEL_BUDGET_STANDARDS}

# 代码内建默认值（「恢复出厂默认」用）；运行时生效值可能被 data/defaults.json 覆盖
_BUILTIN_VARIABLE_BUDGET_STANDARDS = copy.deepcopy(VARIABLE_BUDGET_STANDARDS)
_BUILTIN_FIXED_BUDGET_STANDARDS = copy.deepcopy(FIXED_BUDGET_STANDARDS)
_BUILTIN_EXTRA_BUDGET_STANDARDS = copy.deepcopy(EXTRA_BUDGET_STANDARDS)
_BUILTIN_TRAVEL_BUDGET_STANDARDS = copy.deepcopy(TRAVEL_BUDGET_STANDARDS)

_DEFAULTS_FILE = Path(__file__).resolve().parent / "data" / "defaults.json"
_DEFAULTS_LOCK = threading.RLock()
_SAVED_LOCATION_NAMES: dict[str, str] = {}
_SAVED_CURRENCY_NAMES: dict[str, str] = {}
_DEFAULTS_LOADED_FROM_FILE = False
_DEFAULTS_LOAD_ERROR: str | None = None


class DefaultsRevisionConflict(Exception):
    """保存默认标准时，调用方读取的版本已被另一标签页更新。"""


def _replace_mapping(target: dict, source: dict) -> None:
    target.clear()
    target.update(copy.deepcopy(source))


def _refresh_all_budget_locations() -> None:
    ALL_BUDGET_LOCATIONS.clear()
    ALL_BUDGET_LOCATIONS.update({**VARIABLE_BUDGET_STANDARDS, **TRAVEL_BUDGET_STANDARDS})


def saved_location_names() -> dict[str, str]:
    with _DEFAULTS_LOCK:
        return dict(_SAVED_LOCATION_NAMES)


def saved_currency_names() -> dict[str, str]:
    with _DEFAULTS_LOCK:
        return dict(_SAVED_CURRENCY_NAMES)


def defaults_are_customized() -> bool:
    """只有用户默认值文件已成功校验并加载时才返回 True。

    单纯以文件存在为准会把损坏的 defaults.json 误报为“已自定义”。
    """
    with _DEFAULTS_LOCK:
        return _DEFAULTS_LOADED_FROM_FILE


def defaults_load_error() -> str | None:
    """返回启动时用户默认值文件的校验错误，供 Web 端明确提示。"""
    with _DEFAULTS_LOCK:
        return _DEFAULTS_LOAD_ERROR


def default_standards_snapshot() -> dict:
    """在同一把锁下返回当前默认标准及其元数据的完整快照。"""
    with _DEFAULTS_LOCK:
        snapshot = {
            "variable": copy.deepcopy(VARIABLE_BUDGET_STANDARDS),
            "fixed": copy.deepcopy(FIXED_BUDGET_STANDARDS),
            "extra": copy.deepcopy(EXTRA_BUDGET_STANDARDS),
            "travel": copy.deepcopy(TRAVEL_BUDGET_STANDARDS),
            "location_names": dict(_SAVED_LOCATION_NAMES),
            "currency_names": dict(_SAVED_CURRENCY_NAMES),
            "customized": _DEFAULTS_LOADED_FROM_FILE,
            "load_error": _DEFAULTS_LOAD_ERROR,
        }
        revision_payload = {
            key: snapshot[key]
            for key in ("variable", "fixed", "extra", "travel",
                        "location_names", "currency_names")
        }
        snapshot["revision"] = hashlib.sha256(json.dumps(
            revision_payload,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")).hexdigest()
        return snapshot


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


def _read_defaults_file() -> dict | None:
    if not _DEFAULTS_FILE.exists():
        return None
    with _DEFAULTS_LOCK:
        return read_json_file(_DEFAULTS_FILE, strict=True)


def _write_defaults_file(data: dict) -> None:
    text = json.dumps(data, ensure_ascii=False, indent=2)
    with _DEFAULTS_LOCK:
        atomic_write_text(_DEFAULTS_FILE, text)


def _apply_defaults_dict(data: dict) -> None:
    _replace_mapping(VARIABLE_BUDGET_STANDARDS, data["variable"])
    _replace_mapping(FIXED_BUDGET_STANDARDS, data["fixed"])
    _replace_mapping(EXTRA_BUDGET_STANDARDS, data["extra"])
    _replace_mapping(TRAVEL_BUDGET_STANDARDS, data["travel"])
    _SAVED_LOCATION_NAMES.clear()
    _SAVED_LOCATION_NAMES.update(data.get("location_names") or {})
    _SAVED_CURRENCY_NAMES.clear()
    _SAVED_CURRENCY_NAMES.update(data.get("currency_names") or {})
    _refresh_all_budget_locations()


def _normalize_defaults_payload(payload: dict) -> dict:
    """校验并规范化「保存为默认」的完整标准快照。"""
    if not isinstance(payload, dict):
        raise ValueError("默认标准必须是对象")

    def _one_currency_amount(holder, path):
        if not isinstance(holder, dict) or len(holder) != 1:
            raise ValueError(f"{path} 必须是「单一币种: 金额」对象")
        curr = next(iter(holder))
        if not isinstance(curr, str) or not re.fullmatch(r"[A-Z]{2,6}", curr):
            raise ValueError(f"{path} 币种代码无效：{curr}")
        _validate_positive_amount(holder[curr], f"{path}.{curr}")
        return {curr: float(holder[curr])}

    variable_in = payload.get("variable")
    if not isinstance(variable_in, dict) or not variable_in:
        raise ValueError("可变预算至少需要一个定居地点")
    variable = {}
    for loc, std in variable_in.items():
        loc_key = str(loc).strip()
        if not loc_key:
            raise ValueError("可变预算地点名称不能为空")
        variable[loc_key] = _one_currency_amount(std, f"可变预算.{loc_key}")

    fixed_in = payload.get("fixed")
    if not isinstance(fixed_in, dict):
        raise ValueError("固定预算必须是对象")
    fixed = {}
    for region in ("Mainland", "Overseas"):
        if region not in fixed_in or not isinstance(fixed_in[region], dict) or not fixed_in[region]:
            raise ValueError(f"固定预算缺少区域 {region} 的币种金额")
        region_std = {}
        for curr, amount in fixed_in[region].items():
            if not isinstance(curr, str) or not re.fullmatch(r"[A-Z]{2,6}", curr):
                raise ValueError(f"固定预算.{region} 币种代码无效：{curr}")
            _validate_positive_amount(amount, f"固定预算.{region}.{curr}")
            region_std[curr] = float(amount)
        fixed[region] = region_std
    extra_in = payload.get("extra") or {}
    if not isinstance(extra_in, dict):
        raise ValueError("额外预算必须是对象")
    extra = {}
    for curr in ("CNY", "USD", "HKD"):
        amount = extra_in[curr] if curr in extra_in else EXTRA_BUDGET_STANDARDS.get(curr, 0)
        _validate_positive_amount(amount, f"额外预算.{curr}")
        extra[curr] = float(amount)

    travel_in = payload.get("travel") or {}
    if not isinstance(travel_in, dict):
        raise ValueError("旅居预算必须是对象")
    travel = {}
    for loc, std in travel_in.items():
        loc_key = str(loc).strip()
        if not loc_key:
            raise ValueError("旅居预算地点名称不能为空")
        if not isinstance(std, dict) or len(std) != 1:
            raise ValueError(f"旅居预算.{loc_key} 必须是「单一币种: {{daily, once}}」对象")
        curr = next(iter(std))
        if not isinstance(curr, str) or not re.fullmatch(r"[A-Z]{2,6}", curr):
            raise ValueError(f"旅居预算.{loc_key} 币种代码无效：{curr}")
        sub = std[curr]
        if not isinstance(sub, dict) or "daily" not in sub or "once" not in sub:
            raise ValueError(f"旅居预算.{loc_key} 需同时提供 daily 与 once")
        _validate_positive_amount(sub["daily"], f"旅居预算.{loc_key}.{curr}.daily")
        _validate_positive_amount(sub["once"], f"旅居预算.{loc_key}.{curr}.once")
        travel[loc_key] = {curr: {"daily": float(sub["daily"]), "once": float(sub["once"])}}

    overlap = sorted(set(variable).intersection(travel))
    if overlap:
        raise ValueError(f"定居与旅居地点不能使用同一标识：{', '.join(overlap)}")

    def _name_map(raw, label):
        raw = raw or {}
        if not isinstance(raw, dict):
            raise ValueError(f"{label} 必须是对象")
        out = {}
        for key, name in raw.items():
            k, n = str(key).strip(), str(name).strip()
            if k and n:
                out[k] = n
        return out

    return {
        "variable": variable,
        "fixed": fixed,
        "extra": extra,
        "travel": travel,
        "location_names": _name_map(payload.get("location_names"), "location_names"),
        "currency_names": _name_map(payload.get("currency_names"), "currency_names"),
    }


def save_default_standards(payload: dict, expected_revision: str | None = None) -> dict:
    """把完整标准快照校验后写入 data/defaults.json，并立即作为模块默认值生效。"""
    global _DEFAULTS_LOADED_FROM_FILE, _DEFAULTS_LOAD_ERROR
    with _DEFAULTS_LOCK:
        current_revision = default_standards_snapshot()["revision"]
        if expected_revision is not None and expected_revision != current_revision:
            raise DefaultsRevisionConflict(
                "服务器默认标准已被另一个标签页修改；请刷新页面后重新编辑"
            )
        normalized = _normalize_defaults_payload(payload)
        _write_defaults_file(normalized)
        _apply_defaults_dict(normalized)
        _DEFAULTS_LOADED_FROM_FILE = True
        _DEFAULTS_LOAD_ERROR = None
        return normalized


def restore_builtin_defaults(expected_revision: str | None = None) -> None:
    """删除已保存的默认标准文件，恢复 functions.py 内建值。"""
    global _DEFAULTS_LOADED_FROM_FILE, _DEFAULTS_LOAD_ERROR
    with _DEFAULTS_LOCK:
        current_revision = default_standards_snapshot()["revision"]
        if expected_revision is not None and expected_revision != current_revision:
            raise DefaultsRevisionConflict(
                "服务器默认标准已被另一个标签页修改；请刷新页面后再恢复出厂默认"
            )
        if _DEFAULTS_FILE.exists():
            try:
                _DEFAULTS_FILE.unlink()
            except OSError as exc:
                raise ValueError(f"删除默认标准文件失败：{exc}") from exc
        _replace_mapping(VARIABLE_BUDGET_STANDARDS, _BUILTIN_VARIABLE_BUDGET_STANDARDS)
        _replace_mapping(FIXED_BUDGET_STANDARDS, _BUILTIN_FIXED_BUDGET_STANDARDS)
        _replace_mapping(EXTRA_BUDGET_STANDARDS, _BUILTIN_EXTRA_BUDGET_STANDARDS)
        _replace_mapping(TRAVEL_BUDGET_STANDARDS, _BUILTIN_TRAVEL_BUDGET_STANDARDS)
        _SAVED_LOCATION_NAMES.clear()
        _SAVED_CURRENCY_NAMES.clear()
        _refresh_all_budget_locations()
        _DEFAULTS_LOADED_FROM_FILE = False
        _DEFAULTS_LOAD_ERROR = None


def load_saved_defaults() -> bool:
    """启动时校验并加载 data/defaults.json；损坏时保留出厂值并记录错误。"""
    global _DEFAULTS_LOADED_FROM_FILE, _DEFAULTS_LOAD_ERROR
    with _DEFAULTS_LOCK:
        try:
            data = _read_defaults_file()
        except ValueError as exc:
            _DEFAULTS_LOADED_FROM_FILE = False
            _DEFAULTS_LOAD_ERROR = str(exc)
            return False
        if not data:
            _DEFAULTS_LOADED_FROM_FILE = False
            _DEFAULTS_LOAD_ERROR = None
            return False
        try:
            normalized = _normalize_defaults_payload(data)
        except ValueError as exc:
            _DEFAULTS_LOADED_FROM_FILE = False
            _DEFAULTS_LOAD_ERROR = f"默认预算标准校验失败：{exc}"
            return False
        _apply_defaults_dict(normalized)
        _DEFAULTS_LOADED_FROM_FILE = True
        _DEFAULTS_LOAD_ERROR = None
        return True



def fill_month_rate_series(series, start_date, end_date, as_of=None):
    """Fill calendar-day rates and estimate future days with month-to-date average.

    Weekends and holidays up to ``as_of`` use the nearest available rate. For the
    current month, dates after ``as_of`` use the average of all elapsed calendar
    days in that month instead of the latest single-day rate.
    """
    start = pd.Timestamp(start_date).normalize()
    end = pd.Timestamp(end_date).normalize()
    today = pd.Timestamp(as_of or datetime.date.today()).normalize()
    cutoff = min(end, today)

    values = pd.Series(series, dtype="float64").copy()
    index = pd.to_datetime(values.index)
    if getattr(index, "tz", None) is not None:
        index = index.tz_localize(None)
    values.index = index.normalize()
    values = values.groupby(level=0).last().sort_index()
    values = values[(values.index >= start) & (values.index <= cutoff)].dropna()
    values = values[values.map(lambda value: math.isfinite(float(value)) and float(value) > 0)]
    if values.empty:
        return None

    known = values.reindex(pd.date_range(start, cutoff)).ffill().bfill()
    completed = known.reindex(pd.date_range(start, end))
    if cutoff < end:
        completed.loc[completed.index > cutoff] = float(known.mean())
    else:
        completed = completed.ffill().bfill()
    completed.name = getattr(series, "name", None) or "rate"
    return completed


def _prepare_rate_frame(data):
    """统一 yfinance 单 ticker 的列层级与日期索引。"""
    if data is None or getattr(data, "empty", True):
        return None

    frame = data.copy()
    if isinstance(frame.columns, pd.MultiIndex):
        frame.columns = frame.columns.get_level_values(0)
    index = pd.to_datetime(frame.index)
    if getattr(index, "tz", None) is not None:
        index = index.tz_localize(None)
    frame.index = index.normalize()
    return frame


def _price_column(frame, name):
    """取单个价格列，只压缩列维，不在单行行情时丢掉日期索引。"""
    values = frame[name]
    if isinstance(values, pd.DataFrame):
        values = values.iloc[:, 0]
    return pd.Series(values, index=frame.index, dtype="float64")


def _normalize_rate_frame(data, start_date, end_date):
    """将 yfinance 返回的数据规范成月度预算使用的日度汇率序列。

    兼容两种数据形态：
    - 新版 yfinance(1.x) + pandas 多级列：列名为 ('Close', 'HKDCNY=X') 的 MultiIndex；
    - 旧版单级列：'Open' / 'Close' / 'Adj Close' 等扁平列名。
    同时兼容带时区与不带时区的索引（统一转为无时区日期）。
    """
    frame = _prepare_rate_frame(data)
    if frame is None:
        return None

    # 保持既有月度算法：优先 Open/Close 均值。
    if "Open" in frame.columns and "Close" in frame.columns:
        daily_rates = (_price_column(frame, "Open") + _price_column(frame, "Close")) / 2
    elif "Close" in frame.columns:
        daily_rates = _price_column(frame, "Close")
    elif "Adj Close" in frame.columns:
        daily_rates = _price_column(frame, "Adj Close")
    else:
        return None

    # 对齐整月日期范围：缺失（周末/节假日/未来日期）按既有规则填充。
    return fill_month_rate_series(daily_rates, start_date, end_date)


def _normalize_close_rate_frame(data, start_date, end_date):
    """提取实际交易日的 Close，供全年预算计算年平均收盘汇率。

    与月度算法不同，这里不补周末/节假日，也不使用 Open/Close 均值。
    """
    frame = _prepare_rate_frame(data)
    if frame is None:
        return None
    # 全年接口对外声明使用实际 Close；不能在缺列时静默换成 Adj Close，
    # 否则响应的数据契约与真正参与计算的字段不一致。
    if "Close" not in frame.columns:
        return None
    values = pd.to_numeric(_price_column(frame, "Close"), errors="coerce")
    start = pd.Timestamp(start_date).normalize()
    end = pd.Timestamp(end_date).normalize()
    values = values[(values.index >= start) & (values.index <= end)]
    values = values.groupby(level=0).last().dropna().sort_index()
    values = values[values.map(lambda value: math.isfinite(float(value)) and float(value) > 0)]
    if values.empty:
        return None
    values.name = "close"
    return values



def _download_currency_rates(currency, start_date, end_date, normalizer, *, cny_calendar=True):
    """下载单个币种并交给指定规范化器；月度/年度共用同一备援链。"""
    if currency == "CNY":
        # 月度算法需要完整日历轴；全年 Close 统计只需一个恒等汇率观测，
        # 避免把 CNY/CNY 的日历日伪装成 Yahoo 实际交易日收盘样本。
        index = pd.date_range(start_date, end_date) if cny_calendar else pd.DatetimeIndex([
            pd.Timestamp(end_date).normalize(),
        ])
        return pd.Series(1.0, index=index, name="rate")

    ticker = f"{currency}CNY=X"
    end_dt = pd.to_datetime(end_date) + datetime.timedelta(days=1)  # Yahoo 的 end 为右开区间
    end_str = end_dt.strftime("%Y-%m-%d")
    last_error = None
    fetchers = [
        lambda: yf.download(
            ticker, start=start_date, end=end_str, progress=False, interval="1d",
            auto_adjust=False,
        ),
        lambda: yf.Ticker(ticker).history(
            start=start_date, end=end_str, interval="1d", auto_adjust=False
        ),
    ]
    for attempt, fetch in enumerate(fetchers, start=1):
        try:
            series = normalizer(fetch(), start_date, end_date)
            if series is not None:
                return series
            last_error = ValueError(f"下载后汇率数据集为空，无法获取汇率：{ticker}")
        except Exception as exc:  # noqa: BLE001 - 失败后还要尝试 Ticker.history 备援
            last_error = exc
        if attempt < len(fetchers):
            time.sleep(attempt)
    raise ValueError(f"无法下载汇率数据集：{ticker}") from last_error


# 月度预算既有汇率算法（优先开收盘均值 + 日历日补齐）
def get_historical_rates(currencies, start_date, end_date):
    return {
        curr: _download_currency_rates(curr, start_date, end_date, _normalize_rate_frame)
        for curr in currencies
    }


# 全年预算专用：只保留实际交易日收盘价，不改变上面的月度算法
def get_historical_close_rates(currencies, start_date, end_date):
    return {
        curr: _download_currency_rates(
            curr, start_date, end_date, _normalize_close_rate_frame, cny_calendar=False,
        )
        for curr in currencies
    }


# ---------------------------------------------------------------------------
# Web 端共享的汇率缓存（进程内、TTL 过期、线程安全）
# 用于避免页面反复请求 / 计算时重复向 Yahoo Finance 拉取同一月的数据。
# ---------------------------------------------------------------------------
_RATES_CACHE: dict = {}              # key: (currency, start, end, rate_kind) -> (timestamp, pd.Series)
_RATES_CACHE_LOCK = threading.Lock()
_RATES_CACHE_KEY_LOCKS: dict = {}    # key -> threading.Lock，防止同一 key 并发重复下载
_RATES_CACHE_REFRESHING: dict = {}   # key -> 强制刷新请求数；普通读取需等待
RATES_CACHE_DEFAULT_TTL = 60 * 60    # 默认缓存 1 小时


def _rates_cache_key(currency, start_date, end_date, rate_kind="monthly"):
    return (currency, str(start_date), str(end_date), rate_kind)


def _get_rates_key_lock(key):
    with _RATES_CACHE_LOCK:
        return _RATES_CACHE_KEY_LOCKS.setdefault(key, threading.Lock())


def _cached_rate_is_fresh(cached, end_date, rate_kind, ttl, now=None):
    """校验进程内缓存 TTL；当前月缓存还必须是今天抓取的。"""
    if not isinstance(cached, tuple) or len(cached) != 2:
        return False
    timestamp = cached[0]
    current_time = time.time() if now is None else now
    try:
        if current_time - float(timestamp) >= ttl:
            return False
    except (TypeError, ValueError):
        return False

    if rate_kind == "monthly":
        today = datetime.date.today()
        try:
            end_day = datetime.date.fromisoformat(str(end_date)[:10])
            fetched_day = datetime.datetime.fromtimestamp(float(timestamp)).date()
        except (OSError, OverflowError, TypeError, ValueError):
            return False
        if ((end_day.year, end_day.month) == (today.year, today.month)
                and fetched_day != today):
            return False
    return True


def _get_historical_rates_cached(currencies, start_date, end_date, *, fetcher, rate_kind,
                                 ttl=RATES_CACHE_DEFAULT_TTL, force=False):
    """共享的进程内汇率缓存，按 rate_kind 隔离月度派生值与年度 Close。"""
    result = {}
    to_fetch = []
    force_keys = [_rates_cache_key(curr, start_date, end_date, rate_kind) for curr in currencies]
    if force:
        # 刷新一开始就隔离旧值；刷新失败后也不能让年度计算悄悄复用旧缓存。
        # 计数让并发普通请求等待所有同 key 强制刷新结束。
        with _RATES_CACHE_LOCK:
            for key in force_keys:
                _RATES_CACHE.pop(key, None)
                _RATES_CACHE_REFRESHING[key] = _RATES_CACHE_REFRESHING.get(key, 0) + 1
    for curr in currencies:
        key = _rates_cache_key(curr, start_date, end_date, rate_kind)
        if not force:
            with _RATES_CACHE_LOCK:
                cached = _RATES_CACHE.get(key)
                refreshing = bool(_RATES_CACHE_REFRESHING.get(key))
            if not refreshing and _cached_rate_is_fresh(cached, end_date, rate_kind, ttl):
                result[curr] = cached[1]
                continue
        to_fetch.append((curr, key))

    try:
        for curr, key in to_fetch:
            with _get_rates_key_lock(key):
                if not force:
                    with _RATES_CACHE_LOCK:
                        cached = _RATES_CACHE.get(key)
                    if _cached_rate_is_fresh(cached, end_date, rate_kind, ttl):
                        result[curr] = cached[1]
                        continue
                series = fetcher([curr], start_date, end_date)[curr]
                with _RATES_CACHE_LOCK:
                    _RATES_CACHE[key] = (time.time(), series)
                result[curr] = series
    finally:
        if force:
            with _RATES_CACHE_LOCK:
                for key in force_keys:
                    remaining = _RATES_CACHE_REFRESHING.get(key, 0) - 1
                    if remaining > 0:
                        _RATES_CACHE_REFRESHING[key] = remaining
                    else:
                        _RATES_CACHE_REFRESHING.pop(key, None)
    return result


def get_historical_rates_cached(currencies, start_date, end_date, ttl=RATES_CACHE_DEFAULT_TTL, force=False):
    """带进程内缓存的月度汇率获取（供 Web 接口复用）。

    返回 {currency: pd.Series}。线程安全：同一 (币种, 起止) 并发只下载一次，
    缓存未过期时直接命中，不重复请求 Yahoo Finance。
    force=True 时跳过读缓存，强制重新下载并覆盖进程内缓存。
    """
    return _get_historical_rates_cached(
        currencies, start_date, end_date,
        fetcher=get_historical_rates, rate_kind="monthly", ttl=ttl, force=force,
    )


def get_historical_close_rates_cached(currencies, start_date, end_date,
                                      ttl=RATES_CACHE_DEFAULT_TTL, force=False):
    """带独立进程内缓存的实际交易日 Close 序列。"""
    return _get_historical_rates_cached(
        currencies, start_date, end_date,
        fetcher=get_historical_close_rates, rate_kind="daily_close", ttl=ttl, force=force,
    )


def get_rates_from_cache(currencies, start_date, end_date, ttl=RATES_CACHE_DEFAULT_TTL):
    """仅从进程内缓存取汇率，不触发任何下载。

    供上层（Web 端磁盘缓存层）先查内存缓存、再查磁盘缓存、最后才下载。
    返回 {currency: pd.Series}，可能为空 dict。
    """
    result = {}
    now = time.time()
    for curr in currencies:
        key = _rates_cache_key(curr, start_date, end_date, "monthly")
        with _RATES_CACHE_LOCK:
            cached = _RATES_CACHE.get(key)
        if _cached_rate_is_fresh(cached, end_date, "monthly", ttl, now=now):
            result[curr] = cached[1]
    return result


def purge_rates_cache(start_date, end_date, rate_kind=None):
    """清除指定日期范围的进程内汇率缓存；可限定行情种类。"""
    start_str, end_str = str(start_date), str(end_date)
    with _RATES_CACHE_LOCK:
        stale = [
            key for key in _RATES_CACHE
            if key[1] == start_str and key[2] == end_str
            and (rate_kind is None or key[3] == rate_kind)
        ]
        for k in stale:
            _RATES_CACHE.pop(k, None)


def _validate_positive_amount(value, path):
    """校验预算标准金额为非负有限数字，否则抛出带定位路径的 ValueError。"""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"预算标准 {path} 必须是数字，当前为 {value!r}")
    if not math.isfinite(float(value)) or value < 0:
        raise ValueError(f"预算标准 {path} 必须是非负有限数字，当前为 {value!r}")


def _parse_custom_locations(raw):
    """校验并规范化「新建预算标准」中的自定义地点列表。

    结构：[{key, name, category(variable|travel), currency}]。
    返回 {key: {name, category, currency}}；任何一项非法即抛 ValueError。
    """
    customs = {}
    if not raw:
        return customs
    if not isinstance(raw, list):
        raise ValueError("custom_locations 必须是列表")
    for item in raw:
        if not isinstance(item, dict):
            raise ValueError("自定义地点格式错误")
        key = str(item.get("key", "")).strip()
        name = str(item.get("name", "")).strip()
        category = str(item.get("category", "")).strip()
        currency = str(item.get("currency", "")).strip().upper()
        if not key or not name:
            raise ValueError(f"自定义地点缺少名称：{item}")
        if category not in ("variable", "travel"):
            raise ValueError(f"自定义地点类别无效：{category}（应为 variable/travel）")
        if not re.fullmatch(r"[A-Z]{2,6}", currency):
            raise ValueError(f"币种代码无效：{currency}（应为 2-6 位字母，如 EUR）")
        if key in VARIABLE_BUDGET_STANDARDS or key in TRAVEL_BUDGET_STANDARDS:
            # 该地点已被保存为默认标准时，忽略过期的 custom_locations 记录
            continue
        if key in customs:
            raise ValueError(f"自定义地点重复：{key}")
        customs[key] = {"name": name, "category": category, "currency": currency}
    return customs


def _build_location_registry(customs):
    """构建地点注册表 {loc: {type: variable|travel, currency}}（默认 + 自定义）。"""
    registry = {}
    for loc, currency_std in VARIABLE_BUDGET_STANDARDS.items():
        registry[loc] = {"type": "variable", "currency": next(iter(currency_std))}
    for loc, currency_std in TRAVEL_BUDGET_STANDARDS.items():
        registry[loc] = {"type": "travel", "currency": next(iter(currency_std))}
    for key, meta in customs.items():
        registry[key] = {"type": meta["category"], "currency": meta["currency"]}
    return registry


def _resolve_standards_unlocked(overrides=None):
    """将「本次计算」的覆盖标准合并到默认标准。

    返回 5 元组：(variable, fixed, travel, location_registry, extra)。
    - 覆盖仅作用于单次计算；本函数不修改模块级默认标准。
    - 支持通过 custom_locations 新建旅居/定居地点（自定义币种），
      以及通过 fixed 覆盖为某区域新增币种。
    - extra 为额外预算 {CNY/USD/HKD: 月额}，与固定预算同样每月只计算一次。
    - 未知地点 / 非法金额 / 非法币种时抛出 ValueError，由调用方转成 400 响应。
    """
    overrides = overrides or {}
    if overrides.get("_snapshot"):
        snapshot = _normalize_defaults_payload({
            "variable": overrides.get("variable"),
            "fixed": overrides.get("fixed"),
            "travel": overrides.get("travel"),
            "extra": overrides.get("extra"),
            "location_names": overrides.get("_location_names") or {},
            "currency_names": overrides.get("_currency_names") or {},
        })
        variable = snapshot["variable"]
        fixed = snapshot["fixed"]
        travel = snapshot["travel"]
        extra = snapshot["extra"]
        registry = {}
        for loc, currency_std in variable.items():
            registry[loc] = {"type": "variable", "currency": next(iter(currency_std))}
        for loc, currency_std in travel.items():
            registry[loc] = {"type": "travel", "currency": next(iter(currency_std))}
        return variable, fixed, travel, registry, extra

    customs = _parse_custom_locations(overrides.get("custom_locations"))
    variable = _merge_variable_standards(overrides.get("variable"), customs)
    fixed = _merge_fixed_standards(overrides.get("fixed"))
    travel = _merge_travel_standards(overrides.get("travel"), customs)
    extra = _merge_extra_standards(overrides.get("extra"))
    registry = _build_location_registry(customs)
    return variable, fixed, travel, registry, extra


def resolve_standards(overrides=None):
    """在线程安全的一致默认值快照上解析本次计算标准。"""
    with _DEFAULTS_LOCK:
        return _resolve_standards_unlocked(overrides)


def _merge_variable_standards(override, customs):
    if override is None:
        override = {}
    if not isinstance(override, dict):
        raise ValueError("可变预算覆盖必须是字典")
    merged = {}
    # 默认定居地点
    for loc, currency_std in VARIABLE_BUDGET_STANDARDS.items():
        curr = next(iter(currency_std))
        amount = currency_std[curr]
        if loc in override:
            ov = override[loc]
            if not isinstance(ov, dict) or curr not in ov:
                raise ValueError(f"可变预算覆盖 '{loc}' 缺少币种 {curr} 的金额")
            amount = ov[curr]
        _validate_positive_amount(amount, f"可变预算.{loc}.{curr}")
        merged[loc] = {curr: float(amount)}
    # 自定义定居地点（金额必须由覆盖提供）
    for loc, meta in customs.items():
        if meta["category"] != "variable":
            continue
        curr = meta["currency"]
        if loc not in override or not isinstance(override[loc], dict) or curr not in override[loc]:
            raise ValueError(f"新增定居地点 '{loc}' 缺少每日预算金额")
        _validate_positive_amount(override[loc][curr], f"可变预算.{loc}.{curr}")
        merged[loc] = {curr: float(override[loc][curr])}
    # 覆盖中出现、既非默认也非自定义的地点 → 提示先新建
    for loc in override:
        if loc not in merged:
            raise ValueError(f"未知的可变预算地点：{loc}（可先在页面「新建预算标准」中添加）")
    return merged


def _merge_fixed_standards(override):
    if override is None:
        override = {}
    if not isinstance(override, dict):
        raise ValueError("固定预算覆盖必须是字典")
    merged = {}
    for region, currency_std in FIXED_BUDGET_STANDARDS.items():
        merged_region = {}
        for curr, amount in currency_std.items():
            if region in override and isinstance(override[region], dict) and curr in override[region]:
                amount = override[region][curr]
            _validate_positive_amount(amount, f"固定预算.{region}.{curr}")
            merged_region[curr] = float(amount)
        # 该区域新增的自定义币种
        if region in override and isinstance(override[region], dict):
            for curr, amount in override[region].items():
                if curr in merged_region:
                    continue
                if not isinstance(curr, str) or not re.fullmatch(r"[A-Z]{2,6}", curr):
                    raise ValueError(f"固定预算币种代码无效：{curr}（应为 2-6 位字母）")
                _validate_positive_amount(amount, f"固定预算.{region}.{curr}")
                merged_region[curr] = float(amount)
        merged[region] = merged_region
    for region in override:
        if region not in merged:
            raise ValueError(f"未知的固定预算区域：{region}")
    return merged


def _merge_extra_standards(override):
    """合并额外预算覆盖。仅允许 CNY / USD / HKD 三个币种。"""
    override = override or {}
    if not isinstance(override, dict):
        raise ValueError("额外预算覆盖必须是字典")
    merged = {}
    for curr, amount in EXTRA_BUDGET_STANDARDS.items():
        if curr in override:
            amount = override[curr]
        _validate_positive_amount(amount, f"额外预算.{curr}")
        merged[curr] = float(amount)
    for curr in override:
        if curr not in merged:
            raise ValueError(f"未知的额外预算币种：{curr}（仅支持 CNY / USD / HKD）")
    return merged


def _merge_travel_standards(override, customs):
    if override is None:
        override = {}
    if not isinstance(override, dict):
        raise ValueError("旅居预算覆盖必须是字典")
    merged = {}
    # 默认旅居地点
    for loc, currency_std in TRAVEL_BUDGET_STANDARDS.items():
        curr = next(iter(currency_std))
        daily = currency_std[curr]["daily"]
        once = currency_std[curr]["once"]
        if loc in override:
            ov = override[loc]
            if not isinstance(ov, dict) or curr not in ov:
                raise ValueError(f"旅居预算覆盖 '{loc}' 缺少币种 {curr} 的金额")
            sub = ov[curr]
            if not isinstance(sub, dict) or "daily" not in sub or "once" not in sub:
                raise ValueError(f"旅居预算覆盖 '{loc}' 需同时提供 daily 与 once 金额")
            daily = sub["daily"]
            once = sub["once"]
        _validate_positive_amount(daily, f"旅居预算.{loc}.{curr}.daily")
        _validate_positive_amount(once, f"旅居预算.{loc}.{curr}.once")
        merged[loc] = {curr: {"daily": float(daily), "once": float(once)}}
    # 自定义旅居地点
    for loc, meta in customs.items():
        if meta["category"] != "travel":
            continue
        curr = meta["currency"]
        if loc not in override or not isinstance(override[loc], dict) or curr not in override[loc]:
            raise ValueError(f"新增旅居地点 '{loc}' 缺少预算金额")
        sub = override[loc][curr]
        if not isinstance(sub, dict) or "daily" not in sub or "once" not in sub:
            raise ValueError(f"旅居预算覆盖 '{loc}' 需同时提供 daily 与 once 金额")
        _validate_positive_amount(sub["daily"], f"旅居预算.{loc}.{curr}.daily")
        _validate_positive_amount(sub["once"], f"旅居预算.{loc}.{curr}.once")
        merged[loc] = {curr: {"daily": float(sub["daily"]), "once": float(sub["once"])}}
    # 覆盖中出现、既非默认也非自定义的地点 → 提示先新建
    for loc in override:
        if loc not in merged:
            raise ValueError(f"未知的旅居预算地点：{loc}（可先在页面「新建预算标准」中添加）")
    return merged


def calculate_annual_budget(amounts, average_rates):
    """按“各币种全年金额 × 年初至截止日平均收盘汇率”计算人民币总额。

    ``average_rates`` 只接收上层根据实际交易日 Close 算出的算术平均；
    本函数不读取行情，便于用固定向量独立验证全年预算算法。
    """
    if not isinstance(amounts, dict):
        raise ValueError("全年预算金额必须是「币种: 金额」对象")
    if not isinstance(average_rates, dict):
        raise ValueError("年平均汇率必须是「币种: 汇率」对象")

    normalized_amounts = {}
    for raw_currency, raw_amount in amounts.items():
        currency = str(raw_currency).strip().upper()
        if not re.fullmatch(r"[A-Z]{2,6}", currency):
            raise ValueError(f"全年预算币种代码无效：{raw_currency}")
        if currency in normalized_amounts:
            raise ValueError(f"全年预算币种重复：{currency}")
        _validate_positive_amount(raw_amount, f"全年预算.{currency}")
        normalized_amounts[currency] = float(raw_amount)

    details = []
    total_cny = 0.0
    for currency, amount in sorted(normalized_amounts.items()):
        raw_rate = average_rates.get(currency)
        if raw_rate is None and amount == 0:
            average_rate = None
            cny_amount = 0.0
        else:
            if isinstance(raw_rate, bool) or not isinstance(raw_rate, (int, float)):
                raise ValueError(f"缺少 {currency} 的有效年平均收盘汇率")
            average_rate = float(raw_rate)
            if not math.isfinite(average_rate) or average_rate <= 0:
                raise ValueError(f"{currency} 的年平均收盘汇率必须是正有限数")
            raw_cny_amount = amount * average_rate
            if not math.isfinite(raw_cny_amount):
                raise ValueError(f"{currency} 的全年金额换算结果超出有限数范围")
            cny_amount = round(raw_cny_amount, 2)
        next_total = total_cny + cny_amount
        if not math.isfinite(next_total):
            raise ValueError("全年预算合计超出有限数范围")
        total_cny = next_total
        details.append({
            "currency": currency,
            "amount": amount,
            # 保留参与计算的真实均值；展示层可自行格式化小数位，避免已保存
            # 结果里的汇率与人民币金额无法互相复算。
            "average_rate": average_rate,
            "cny_amount": cny_amount,
        })
    return {
        "summary": {"全年预算合计(人民币)": round(total_cny, 2)},
        "details": details,
    }


def _valid_rate_series(rates_dict, currency):
    """规范并校验计算层收到的单币种汇率序列。"""
    if not isinstance(rates_dict, dict) or currency not in rates_dict:
        raise ValueError(f"缺少币种 {currency} 的汇率数据")
    raw = rates_dict[currency]
    if not isinstance(raw, pd.Series) or raw.empty:
        raise ValueError(f"币种 {currency} 的汇率数据为空或格式无效")
    try:
        index = pd.to_datetime(raw.index)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"币种 {currency} 的汇率日期无效") from exc
    if getattr(index, "tz", None) is not None:
        index = index.tz_localize(None)
    values = pd.to_numeric(pd.Series(raw.to_numpy(), index=index.normalize()), errors="coerce")
    values = values.groupby(level=0).last().sort_index().dropna()
    values = values[values.map(lambda value: math.isfinite(float(value)) and float(value) > 0)]
    if values.empty:
        raise ValueError(f"币种 {currency} 没有可用的正数汇率")
    return values


def annual_rate_stats(rates_dict, currencies):
    """汇总实际交易日收盘汇率，保留未舍入均值供全年预算计算。

    年度算法的唯一实现位于计算层：这里只统计行情中真实存在的正数观测，
    不补齐周末/节假日，也不先按月平均。缺少的币种由调用层结合下载错误处理。
    """
    if not isinstance(rates_dict, dict):
        raise ValueError("全年汇率必须是「币种: 序列」对象")
    stats = {}
    for raw_currency in currencies:
        currency = str(raw_currency).strip().upper()
        if currency not in rates_dict:
            continue
        values = _valid_rate_series(rates_dict, currency)
        stats[currency] = {
            "average": float(values.mean()),
            "observation_count": int(values.size),
            "first_date": values.index[0].strftime("%Y-%m-%d"),
            "last_date": values.index[-1].strftime("%Y-%m-%d"),
        }
    return stats


def _rates_for_dates(rates_dict, currency, dates):
    """从完整行情轴上为目标日期取值，不把全 NaN 静默求和为 0。"""
    values = _valid_rate_series(rates_dict, currency)
    target = pd.DatetimeIndex(pd.to_datetime(dates)).normalize()
    completed = values.reindex(values.index.union(target)).sort_index().ffill().bfill().reindex(target)
    if completed.isna().any():
        missing = target[completed.isna()].strftime("%Y-%m-%d").tolist()
        raise ValueError(f"币种 {currency} 缺少行程日汇率：{', '.join(missing[:3])}")
    return completed


def _average_rate(rates_dict, currency):
    values = _valid_rate_series(rates_dict, currency)
    average = float(values.mean())
    if not math.isfinite(average) or average <= 0:
        raise ValueError(f"币种 {currency} 没有可用的平均汇率")
    return average


def calculate_travel_budget(itinerary, region, year, month,
                            standards_override=None, rates_dict=None,
                            resolved_standards=None):
    """根据行程安排与各地预算标准，精确计算本月多币种折合人民币的总预算。

    standards_override：可选，本次计算专用的预算标准覆盖（结构见 resolve_standards），
    默认 None 时使用模块级默认标准。
    rates_dict：可选，外部传入的 {currency: pd.Series} 汇率，Web 端可复用缓存避免重复下载；
    默认 None 时内部通过 get_historical_rates_cached 获取。
    resolved_standards：Web 层为展开行程已解析出的同一份标准快照；传入后不再
    二次读取可能被其它请求更新的模块默认值。
    """
    # 0. 解析本次计算的预算标准（覆盖合并到默认标准，不修改默认值）
    if resolved_standards is None:
        resolved_standards = resolve_standards(standards_override)
    if not isinstance(resolved_standards, (tuple, list)) or len(resolved_standards) != 5:
        raise ValueError("resolved_standards 必须是 resolve_standards 返回的 5 元组")
    variable_std, fixed_std, travel_std, loc_registry, extra_std = resolved_standards

    # 1. 解析行程数据
    df_itinerary = pd.DataFrame(itinerary)
    df_itinerary["date"] = pd.to_datetime(df_itinerary["date"])

    start_date = pd.Timestamp(year=year, month=month, day=1).strftime("%Y-%m-%d")
    end_date = (pd.Timestamp(year=year, month=month, day=1) + pd.offsets.MonthEnd(1)).strftime("%Y-%m-%d")

    # 2. 识别涉及的城市、币种及旅行类型（币种映射来自地点注册表，含自定义地点）
    visited_locations = df_itinerary["location"].unique()
    currencies = set()
    for loc in visited_locations:
        if loc not in loc_registry:
            raise ValueError(f"未知地点：{loc}（可先在页面「新建预算标准」中添加）")
        currencies.add(loc_registry[loc]["currency"])
    currencies.update(fixed_std[region].keys())
    currencies.update(curr for curr, amt in extra_std.items() if amt)

    # 3. 统一获取整月每日汇率数据（优先复用外部传入的缓存）
    if rates_dict is None:
        rates_dict = get_historical_rates_cached(currencies, start_date, end_date)

    # 4. 按地点汇总天数，计算可变预算（按居住天数逐日换算）
    total_variable_rmb = 0.0
    variable_details = []

    settle_itinerary = df_itinerary[df_itinerary["is_travel"] == False]
    for loc, group in settle_itinerary.groupby("location"):
        budget_standard = variable_std[loc]
        curr = next(iter(budget_standard.keys()))
        standard = budget_standard[curr]

        # 当地每天的汇率，按每一天分别换算，最后汇总
        group_dates = pd.to_datetime(group["date"])
        rate_series = _rates_for_dates(rates_dict, curr, group_dates)

        day_count = len(group)
        variable_cost_local = standard * day_count
        variable_cost_rmb = float((rate_series * standard).sum())

        total_variable_rmb += variable_cost_rmb
        variable_details.append({
            "location": loc,
            "type": "可变预算",
            "currency": curr,
            "day_count": day_count,
            "daily_standard_local": standard,  # 当地每日预算额
            "variable_cost_local": variable_cost_local,
            "variable_cost_rmb": round(variable_cost_rmb, 2)
        })

    # 4.2 旅居地点的每日预算（按当地 daily * 当日汇率逐日计算）
    travel_itinerary = df_itinerary[df_itinerary["is_travel"] == True]
    for loc, group in travel_itinerary.groupby("location"):
        budget_standard = travel_std[loc]
        curr = next(iter(budget_standard.keys()))
        standard = budget_standard[curr]

        group_dates = pd.to_datetime(group["date"])
        rate_series = _rates_for_dates(rates_dict, curr, group_dates)

        day_count = len(group)
        travel_daily_local = standard["daily"] * day_count
        travel_daily_rmb = float((rate_series * standard["daily"]).sum())

        total_variable_rmb += travel_daily_rmb
        variable_details.append({
            "location": loc,
            "type": "旅居每日预算",
            "currency": curr,
            "day_count": day_count,
            "daily_standard_local": standard["daily"],  # 当地每日预算额
            "variable_cost_local": travel_daily_local,
            "variable_cost_rmb": round(travel_daily_rmb, 2)
        })

    # 5. 计算每月固定费用（按内地/境外每月只计算一次）
    total_fixed_rmb = 0.0
    fixed_details = []

    fixed_standard = fixed_std[region]
    for curr, monthly_local in fixed_standard.items():
        avg_rate = _average_rate(rates_dict, curr)
        monthly_rmb = monthly_local * avg_rate

        total_fixed_rmb += monthly_rmb
        fixed_details.append({
            "location": region,
            "type": "固定预算",
            "currency": curr,
            "avg_rate": round(avg_rate, 4),
            "local_cost": monthly_local,
            "rmb_cost": round(monthly_rmb, 2)
        })

    # 5.2 额外预算（各币种月额 × 当月平均汇率，每月只计算一次；金额为 0 的币种不计入）
    #     额外预算单独放进 extra_details，供界面与固定预算分开展示；
    #     金额仍计入 total_fixed_rmb / 固定费用合计，总预算与旧存档数值保持不变。
    total_extra_rmb = 0.0
    extra_details = []
    for curr, monthly_local in extra_std.items():
        if not monthly_local:
            continue
        avg_rate = _average_rate(rates_dict, curr)
        monthly_rmb = monthly_local * avg_rate

        total_extra_rmb += monthly_rmb
        total_fixed_rmb += monthly_rmb
        extra_details.append({
            "location": "Extra",
            "type": "额外预算",
            "currency": curr,
            "avg_rate": round(avg_rate, 4),
            "local_cost": monthly_local,
            "rmb_cost": round(monthly_rmb, 2)
        })

    # 6. 旅居地点的once费用（每个地点当月仅计算一次）
    travel_locs = df_itinerary[df_itinerary["is_travel"] == True]["location"].unique()
    for loc in travel_locs:
        budget_standard = travel_std[loc]
        curr = next(iter(budget_standard.keys()))
        standard = budget_standard[curr]
        
        avg_rate = _average_rate(rates_dict, curr)
        once_local = standard["once"]
        once_rmb = once_local * avg_rate

        total_fixed_rmb += once_rmb
        fixed_details.append({
            "location": loc,
            "type": "旅居一次性费用",
            "currency": curr,
            "avg_rate": round(avg_rate, 4),
            "local_cost": once_local,
            "rmb_cost": round(once_rmb, 2)
        })

    # 7. 汇总所有费用
    grand_total_rmb = total_variable_rmb + total_fixed_rmb

    return {
        "summary": {
            "计算月份": f"{year}年{month}月",
            "居住区域": region,
            "可变费用合计(人民币)": round(total_variable_rmb, 2),
            "固定费用合计(人民币)": round(total_fixed_rmb, 2),
            # 固定费用合计里属于额外预算的部分，供界面把额外预算与固定预算分开显示
            "额外预算合计(人民币)": round(total_extra_rmb, 2),
            "总预算(人民币)": round(grand_total_rmb, 2)
        },
        "daily_details": variable_details,
        "fixed_details": fixed_details,
        "extra_details": extra_details,
        "rates_dict": rates_dict  # 保留汇率原始数据供核对
    }


# 启动时加载用户保存的默认标准（损坏或缺失则继续使用上方出厂值）
load_saved_defaults()
