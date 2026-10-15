"""旧 Python 调用方式的应用编排；复用同一套标准、汇率与预算算法。"""

import pandas as pd

from application.contracts import month_bounds
from application.defaults import resolve_standards
from core.budget import calculate_travel_budget as _calculate_travel_budget
from core.rates import get_historical_rates_cached
from .inputs import required_currencies


def legacy_calculate_travel_budget(itinerary, region, year, month,
                            standards_override=None, rates_dict=None,
                            resolved_standards=None):
    """兼容旧调用：在应用层取默认标准后调用显式依赖的底层计算器。"""
    # 旧入口接受 DataFrame 和一次性迭代器；只规范化一次，避免取币种后耗尽输入。
    itinerary = pd.DataFrame(itinerary)
    if resolved_standards is None:
        resolved_standards = resolve_standards(standards_override)
    if rates_dict is None:
        currencies = required_currencies(itinerary, region, resolved_standards)
        start, end = month_bounds(year, month)
        rates_dict = get_historical_rates_cached(currencies, start, end)
    return _calculate_travel_budget(
        itinerary, region, year, month,
        standards_override=standards_override,
        rates_dict=rates_dict,
        resolved_standards=resolved_standards,
    )
