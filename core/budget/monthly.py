"""月度预算算法；标准由应用层传入，底层不持有用户状态。"""

import math

import pandas as pd

from core.rates import valid_rate_series
from core.standards import resolve_standards

def _rates_for_dates(rates_dict, currency, dates):
    """从完整行情轴上为目标日期取值，不把全 NaN 静默求和为 0。"""
    values = valid_rate_series(rates_dict, currency)
    target = pd.DatetimeIndex(pd.to_datetime(dates)).normalize()
    completed = values.reindex(values.index.union(target)).sort_index().ffill().bfill().reindex(target)
    if completed.isna().any():
        missing = target[completed.isna()].strftime("%Y-%m-%d").tolist()
        raise ValueError(f"币种 {currency} 缺少行程日汇率：{', '.join(missing[:3])}")
    return completed


def _average_rate(rates_dict, currency):
    values = valid_rate_series(rates_dict, currency)
    average = float(values.mean())
    if not math.isfinite(average) or average <= 0:
        raise ValueError(f"币种 {currency} 没有可用的平均汇率")
    return average


def calculate_travel_budget(itinerary, region, year, month,
                            standards_override=None, rates_dict=None,
                            resolved_standards=None, *, standards_snapshot=None):
    """根据行程安排与各地预算标准，精确计算本月多币种折合人民币的总预算。

    standards_override：可选，本次计算专用的预算标准覆盖（结构见 resolve_standards），
    默认 None 时使用显式传入的 standards_snapshot。
    rates_dict：必须由调用方传入 {currency: pd.Series} 汇率；本模块不下载行情。
    resolved_standards：Web 层为展开行程已解析出的同一份标准快照；传入后不再
    二次解析标准。底层不读取用户默认值文件或应用层运行时状态。
    """
    # 0. 解析本次计算的预算标准（覆盖合并到默认标准，不修改默认值）
    if resolved_standards is None:
        if standards_snapshot is None:
            raise ValueError("月度计算需要显式传入 standards_snapshot 或 resolved_standards")
        resolved_standards = resolve_standards(
            standards_override, defaults_snapshot=standards_snapshot,
        )
    if not isinstance(resolved_standards, (tuple, list)) or len(resolved_standards) != 5:
        raise ValueError("resolved_standards 必须是 resolve_standards 返回的 5 元组")
    variable_std, fixed_std, travel_std, loc_registry, extra_std = resolved_standards
    if rates_dict is None:
        raise ValueError("月度计算需要显式传入 rates_dict 汇率数据")

    # 1. 解析行程数据
    df_itinerary = pd.DataFrame(itinerary)
    df_itinerary["date"] = pd.to_datetime(df_itinerary["date"])
    # 保留旧计算入口的年月合法性检查，显式提供汇率时也不能绕过。
    pd.Timestamp(year=year, month=month, day=1)

    # 2. 校验涉及的地点（注册表含自定义地点）。
    visited_locations = df_itinerary["location"].unique()
    for loc in visited_locations:
        if loc not in loc_registry:
            raise ValueError(f"未知地点：{loc}（可先在页面「新建预算标准」中添加）")

    # 4. 按地点汇总天数，计算可变预算（按居住天数逐日换算）
    total_variable_rmb = 0.0
    variable_details = []

    settle_itinerary = df_itinerary[df_itinerary["is_travel"] == False]
    for loc, group in settle_itinerary.groupby("location"):
        budget_standard = variable_std[loc]
        curr = next(iter(budget_standard.keys()))
        standard = budget_standard[curr]

        # 当地每天的汇率，按每一天分别换算，最后汇总
        group_dates = pd.to_datetime(group["date"])
        rate_series = _rates_for_dates(rates_dict, curr, group_dates)

        day_count = len(group)
        variable_cost_local = standard * day_count
        variable_cost_rmb = float((rate_series * standard).sum())

        total_variable_rmb += variable_cost_rmb
        variable_details.append({
            "location": loc,
            "type": "可变预算",
            "currency": curr,
            "day_count": day_count,
            "daily_standard_local": standard,  # 当地每日预算额
            "variable_cost_local": variable_cost_local,
            "variable_cost_rmb": round(variable_cost_rmb, 2)
        })

    # 4.2 旅居地点的每日预算（按当地 daily * 当日汇率逐日计算）
    travel_itinerary = df_itinerary[df_itinerary["is_travel"] == True]
    for loc, group in travel_itinerary.groupby("location"):
        budget_standard = travel_std[loc]
        curr = next(iter(budget_standard.keys()))
        standard = budget_standard[curr]

        group_dates = pd.to_datetime(group["date"])
        rate_series = _rates_for_dates(rates_dict, curr, group_dates)

        day_count = len(group)
        travel_daily_local = standard["daily"] * day_count
        travel_daily_rmb = float((rate_series * standard["daily"]).sum())

        total_variable_rmb += travel_daily_rmb
        variable_details.append({
            "location": loc,
            "type": "旅居每日预算",
            "currency": curr,
            "day_count": day_count,
            "daily_standard_local": standard["daily"],  # 当地每日预算额
            "variable_cost_local": travel_daily_local,
            "variable_cost_rmb": round(travel_daily_rmb, 2)
        })

    # 5. 计算每月固定费用（按内地/境外每月只计算一次）
    total_fixed_rmb = 0.0
    fixed_details = []

    fixed_standard = fixed_std[region]
    for curr, monthly_local in fixed_standard.items():
        avg_rate = _average_rate(rates_dict, curr)
        monthly_rmb = monthly_local * avg_rate

        total_fixed_rmb += monthly_rmb
        fixed_details.append({
            "location": region,
            "type": "固定预算",
            "currency": curr,
            "avg_rate": round(avg_rate, 4),
            "local_cost": monthly_local,
            "rmb_cost": round(monthly_rmb, 2)
        })

    # 5.2 额外预算（各币种月额 × 当月平均汇率，每月只计算一次；金额为 0 的币种不计入）
    #     额外预算单独放进 extra_details，供界面与固定预算分开展示；
    #     金额仍计入 total_fixed_rmb / 固定费用合计，总预算与旧存档数值保持不变。
    total_extra_rmb = 0.0
    extra_details = []
    for curr, monthly_local in extra_std.items():
        if not monthly_local:
            continue
        avg_rate = _average_rate(rates_dict, curr)
        monthly_rmb = monthly_local * avg_rate

        total_extra_rmb += monthly_rmb
        total_fixed_rmb += monthly_rmb
        extra_details.append({
            "location": "Extra",
            "type": "额外预算",
            "currency": curr,
            "avg_rate": round(avg_rate, 4),
            "local_cost": monthly_local,
            "rmb_cost": round(monthly_rmb, 2)
        })

    # 6. 旅居地点的once费用（每个地点当月仅计算一次）
    travel_locs = df_itinerary[df_itinerary["is_travel"] == True]["location"].unique()
    for loc in travel_locs:
        budget_standard = travel_std[loc]
        curr = next(iter(budget_standard.keys()))
        standard = budget_standard[curr]

        avg_rate = _average_rate(rates_dict, curr)
        once_local = standard["once"]
        once_rmb = once_local * avg_rate

        total_fixed_rmb += once_rmb
        fixed_details.append({
            "location": loc,
            "type": "旅居一次性费用",
            "currency": curr,
            "avg_rate": round(avg_rate, 4),
            "local_cost": once_local,
            "rmb_cost": round(once_rmb, 2)
        })

    # 7. 汇总所有费用
    grand_total_rmb = total_variable_rmb + total_fixed_rmb

    return {
        "summary": {
            "计算月份": f"{year}年{month}月",
            "居住区域": region,
            "可变费用合计(人民币)": round(total_variable_rmb, 2),
            "固定费用合计(人民币)": round(total_fixed_rmb, 2),
            # 固定费用合计里属于额外预算的部分，供界面把额外预算与固定预算分开显示
            "额外预算合计(人民币)": round(total_extra_rmb, 2),
            "总预算(人民币)": round(grand_total_rmb, 2)
        },
        "daily_details": variable_details,
        "fixed_details": fixed_details,
        "extra_details": extra_details,
        "rates_dict": rates_dict  # 保留汇率原始数据供核对
    }
