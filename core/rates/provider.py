"""Yahoo Finance 行情适配器，按调用方选择月度或年度规范化。"""

import datetime
import time

import pandas as pd
import yfinance as yf

from .normalization import _normalize_close_rate_frame, _normalize_rate_frame


def _download_ticker_rates(ticker, start_date, end_date, normalizer):
    """下载单个 Yahoo ticker，并通过指定的月度/年度规范化器返回序列。"""
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


def _download_cnh_cny_rate(start_date, end_date, normalizer):
    """由 Yahoo 的 USD/CNY 与 USD/CNH 同日行情推导 1 CNH 可兑换的 CNY。"""
    onshore = _download_ticker_rates("CNY=X", start_date, end_date, normalizer)
    offshore = _download_ticker_rates("CNH=X", start_date, end_date, normalizer)
    onshore, offshore = onshore.align(offshore, join="inner")
    derived = (pd.to_numeric(onshore, errors="coerce")
               / pd.to_numeric(offshore, errors="coerce"))
    derived = derived.replace([float("inf"), float("-inf")], pd.NA).dropna()
    derived = derived[derived > 0]
    if derived.empty:
        raise ValueError("USD/CNY 与 USD/CNH 没有可用于推导 CNH/CNY 的同日行情")
    derived.name = getattr(onshore, "name", None) or "rate"
    return derived

def _download_currency_rates(currency, start_date, end_date, normalizer, *, cny_calendar=True):
    """下载单个币种并交给指定规范化器；月度/年度共用同一备援链。"""
    if currency == "CNY":
        # 月度算法需要完整日历轴；全年 Close 统计只需一个恒等汇率观测，
        # 避免把 CNY/CNY 的日历日伪装成 Yahoo 实际交易日收盘样本。
        index = pd.date_range(start_date, end_date) if cny_calendar else pd.DatetimeIndex([
            pd.Timestamp(end_date).normalize(),
        ])
        return pd.Series(1.0, index=index, name="rate")

    if currency == "CNH":
        return _download_cnh_cny_rate(start_date, end_date, normalizer)

    ticker = f"{currency}CNY=X"
    return _download_ticker_rates(ticker, start_date, end_date, normalizer)


def get_historical_rates(currencies, start_date, end_date):
    return {
        curr: _download_currency_rates(curr, start_date, end_date, _normalize_rate_frame)
        for curr in currencies
    }


def get_historical_close_rates(currencies, start_date, end_date):
    return {
        curr: _download_currency_rates(
            curr, start_date, end_date, _normalize_close_rate_frame, cny_calendar=False,
        )
        for curr in currencies
    }
