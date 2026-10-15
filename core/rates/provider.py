"""Yahoo Finance 行情适配器，按调用方选择月度或年度规范化。"""

import datetime
import time

import pandas as pd
import yfinance as yf

from .normalization import _normalize_close_rate_frame, _normalize_rate_frame

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
