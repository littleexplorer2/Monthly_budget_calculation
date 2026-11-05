"""按币种、时间范围和行情种类隔离的线程安全进程缓存。"""

import datetime
import threading
import time

from .provider import get_historical_close_rates, get_historical_rates

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
                                 ttl=RATES_CACHE_DEFAULT_TTL, force=False,
                                 fetcher_kwargs=None):
    """共享的进程内汇率缓存，按 rate_kind 隔离月度派生值与年度 Close。"""
    result = {}
    to_fetch = []
    force_keys = [_rates_cache_key(curr, start_date, end_date, rate_kind) for curr in currencies]
    if force:
        # 强制刷新期间让普通请求等待，但在新数据成功前保留最后一个有效值。
        # 刷新调用本身失败会明确报错；之后的普通读取仍可使用未过期旧值。
        with _RATES_CACHE_LOCK:
            for key in force_keys:
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
                series = fetcher(
                    [curr], start_date, end_date, **(fetcher_kwargs or {}),
                )[curr]
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


def get_historical_rates_cached(currencies, start_date, end_date, *, as_of,
                                ttl=RATES_CACHE_DEFAULT_TTL, force=False):
    """带进程内缓存的月度汇率获取（供 Web 接口复用）。

    返回 {currency: pd.Series}。线程安全：同一 (币种, 起止) 并发只下载一次，
    缓存未过期时直接命中，不重复请求 Yahoo Finance。
    force=True 时跳过读缓存，强制重新下载并覆盖进程内缓存。
    """
    return _get_historical_rates_cached(
        currencies, start_date, end_date,
        fetcher=get_historical_rates, rate_kind="monthly", ttl=ttl, force=force,
        fetcher_kwargs={"as_of": as_of},
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
