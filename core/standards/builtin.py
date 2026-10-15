"""预算出厂默认值的唯一来源；用户覆盖由应用层管理。"""

import copy

# 出厂配置不随用户覆盖改变；应用层复制后维护运行时标准。
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


def builtin_standards_snapshot() -> dict:
    """返回可独立修改的出厂配置副本，不共享嵌套可变对象。"""
    return copy.deepcopy({
        "variable": VARIABLE_BUDGET_STANDARDS,
        "fixed": FIXED_BUDGET_STANDARDS,
        "extra": EXTRA_BUDGET_STANDARDS,
        "travel": TRAVEL_BUDGET_STANDARDS,
    })
