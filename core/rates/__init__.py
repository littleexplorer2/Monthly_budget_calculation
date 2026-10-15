"""汇率模块公共接口；磁盘缓存策略由应用层持有。"""

from .cache import (
    RATES_CACHE_DEFAULT_TTL,
    get_historical_close_rates_cached,
    get_historical_rates_cached,
    get_rates_from_cache,
    purge_rates_cache,
)
from .normalization import annual_rate_stats, fill_month_rate_series, valid_rate_series
from .provider import get_historical_close_rates, get_historical_rates

__all__ = [
    "RATES_CACHE_DEFAULT_TTL", "annual_rate_stats", "fill_month_rate_series",
    "get_historical_close_rates", "get_historical_close_rates_cached",
    "get_historical_rates", "get_historical_rates_cached", "get_rates_from_cache",
    "purge_rates_cache", "valid_rate_series",
]
