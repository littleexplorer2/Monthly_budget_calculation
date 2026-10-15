"""月度日历汇率与年度真实交易日 Close 的独立规范化规则。"""

import datetime
import math

import pandas as pd

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


def valid_rate_series(rates_dict, currency):
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
        values = valid_rate_series(rates_dict, currency)
        stats[currency] = {
            "average": float(values.mean()),
            "observation_count": int(values.size),
            "first_date": values.index[0].strftime("%Y-%m-%d"),
            "last_date": values.index[-1].strftime("%Y-%m-%d"),
        }
    return stats
