"""预算用例共用的输入编排，不包含金额计算。"""

import pandas as pd

from application import metadata as app_metadata


def required_currencies(itinerary, region, resolved_standards) -> list[str]:
    """从同一标准快照和实际行程推导所需行情币种。"""
    _, fixed, _, registry, extra = resolved_standards
    currencies = set(fixed[region])
    for location in pd.DataFrame(itinerary)["location"].unique():
        if location not in registry:
            raise ValueError(f"未知地点：{location}（可先在页面「新建预算标准」中添加）")
        currencies.add(registry[location]["currency"])
    currencies.update(currency for currency, amount in extra.items() if amount)
    return app_metadata.sort_currencies(currencies)
