"""旧计算入口的兼容层；新代码直接调用 core 或 application 对应模块。

这里不持有标准、缓存或计算公式。用户默认值由应用层提供，底层只接收快照。
"""

from application.defaults import (
    ALL_BUDGET_LOCATIONS,
    DefaultsRevisionConflict,
    EXTRA_BUDGET_STANDARDS,
    FIXED_BUDGET_STANDARDS,
    TRAVEL_BUDGET_STANDARDS,
    VARIABLE_BUDGET_STANDARDS,
    default_standards_snapshot,
    defaults_are_customized,
    defaults_load_error,
    load_saved_defaults,
    resolve_standards,
    restore_builtin_defaults,
    save_default_standards,
    saved_currency_names,
    saved_location_names,
)
from core.budget import calculate_annual_budget
from application.budget import legacy_calculate_travel_budget as calculate_travel_budget
from core.rates import (
    RATES_CACHE_DEFAULT_TTL,
    annual_rate_stats,
    fill_month_rate_series,
    get_historical_close_rates,
    get_historical_close_rates_cached,
    get_historical_rates,
    get_historical_rates_cached,
    get_rates_from_cache,
    purge_rates_cache,
)
from core.storage import atomic_write_text, read_json_file
