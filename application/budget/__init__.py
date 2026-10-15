"""budget 模块公开入口。"""

from .service import (
    _expand_itinerary as expand_itinerary,
    api_annual_budget as annual_budget,
    api_calculate as calculate,
)

from .compatibility import legacy_calculate_travel_budget
