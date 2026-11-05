"""月度及年度预算应用用例。"""

from __future__ import annotations

import datetime as dt
import math
import re
from application import contracts as app_contracts
from application import defaults as app_defaults
from application import metadata as app_metadata
from application import rates as app_rates
from core import budget as budget_core
from core import rates as rates_core
from .inputs import required_currencies


def _expand_itinerary(entries: list[app_contracts.ItineraryEntryIn], year: int, month: int,
                      loc_registry: dict,
                      include_travel: bool = False,
                      travel_locations: list[str] | None = None,
                      ) -> tuple[list[dict], list[str], int]:
    """把「地点 + 日期区间列表」展开为逐日记录。

    校验：地点在注册表（默认 + 当月新建）中、日期合法、不跨月。
    去重：同地点的重叠日期只保留一天；同一日属于不同地点则明确拒绝。
    旅居过滤：include_travel=False 时排除全部旅居；否则仅保留 travel_locations
    中选中地点（None 表示全部）。
    返回 (逐日记录列表, 警告列表, 去重天数)。
    """
    month_start = dt.date(year, month, 1)
    month_end = dt.date(year, month + 1, 1) - dt.timedelta(days=1) if month < 12 else dt.date(year + 1, 1, 1) - dt.timedelta(days=1)

    expanded: list[dict] = []
    warnings: list[str] = []
    seen: set[tuple[str, str, bool]] = set()
    owners: dict[str, str] = {}
    dup_count = 0

    for entry in entries:
        loc = entry.location
        if loc not in loc_registry:
            raise ValueError(f"未知地点：{loc}（可先在页面「新建预算标准」中添加）")
        # 行程类型由地点类别决定（定居 → 可变预算；旅居 → 旅游预算）
        is_travel = loc_registry[loc]["type"] == "travel"

        for rng in entry.ranges:
            s = app_contracts.parse_ymd(rng.start, loc)
            e = app_contracts.parse_ymd(rng.end, loc)
            if s > e:
                raise ValueError(f"地点 {loc} 的日期区间开始晚于结束：{rng.start} ~ {rng.end}")
            if s < month_start or e > month_end:
                raise ValueError(
                    f"地点 {loc} 的日期区间 {rng.start} ~ {rng.end} 超出 {year}年{month}月，仅支持当月日期"
                )

            day = s
            while day <= e:
                day_key = day.isoformat()
                owner = owners.get(day_key)
                if owner is not None and owner != loc:
                    raise ValueError(
                        f"日期 {day_key} 同时分配给了地点 {owner} 与 {loc}；同一天只能属于一个地点"
                    )
                owners[day_key] = loc
                key = (day_key, loc, is_travel)
                if key in seen:
                    dup_count += 1
                else:
                    seen.add(key)
                    expanded.append({"date": day.isoformat(), "location": loc, "is_travel": is_travel})
                day += dt.timedelta(days=1)

    # 旅居过滤（在去重之后执行，保证统计准确）
    if include_travel and travel_locations is not None:
        selected = {t for t in travel_locations if t in loc_registry and loc_registry[t]["type"] == "travel"}
        dropped = [e for e in expanded if e["is_travel"] and e["location"] not in selected]
        if dropped:
            warnings.append(
                f"旅居选择仅包含 {len(selected)} 个地点，已排除 {len(dropped)} 天未选中的旅居行程"
            )
        expanded = [e for e in expanded if not (e["is_travel"] and e["location"] not in selected)]
    elif not include_travel:
        dropped = [e for e in expanded if e["is_travel"]]
        if dropped:
            warnings.append(f"未勾选「包含旅居」，已排除 {len(dropped)} 天旅居行程及其单次费用")
        expanded = [e for e in expanded if not e["is_travel"]]

    if dup_count:
        warnings.append(f"已自动合并 {dup_count} 天重复行程（同地点重叠日期只计一次）")
    return expanded, warnings, dup_count



def api_annual_budget(req: app_contracts.AnnualBudgetRequest):
    """用各币种实际交易日 Close 年平均值计算全年预算。"""
    start, end = app_contracts.annual_bounds(req.year)
    amounts: dict[str, float] = {}
    for raw_currency, raw_amount in req.amounts.items():
        currency = str(raw_currency).strip().upper()
        if not re.fullmatch(r"[A-Z]{2,6}", currency):
            raise ValueError(f"币种代码无效：{raw_currency}（应为 2-6 位字母，如 EUR）")
        if currency in amounts:
            raise ValueError(f"全年预算币种重复：{currency}")
        if (isinstance(raw_amount, bool) or not isinstance(raw_amount, (int, float))
                or not math.isfinite(float(raw_amount)) or float(raw_amount) < 0):
            raise ValueError(f"全年预算 {currency} 金额必须是非负有限数")
        amounts[currency] = float(raw_amount)

    curr_list = app_metadata.sort_currencies(amounts)
    rates, errors = app_rates.fetch_annual_close_rates(curr_list, start, end)
    blocking = [currency for currency, amount in amounts.items() if amount > 0 and currency in errors]
    if blocking:
        detail = "；".join(f"{currency}: {errors[currency]}" for currency in blocking)
        raise app_contracts.RateFetchError(detail)

    stats = rates_core.annual_rate_stats(rates, curr_list)
    averages = {currency: row["average"] for currency, row in stats.items()}
    result = budget_core.calculate_annual_budget(amounts, averages)
    for detail in result["details"]:
        rate_stat = stats.get(detail["currency"])
        detail["observation_count"] = rate_stat["observation_count"] if rate_stat else 0
        detail["first_date"] = rate_stat["first_date"] if rate_stat else None
        detail["last_date"] = rate_stat["last_date"] if rate_stat else None
    result.update({
        "year": req.year,
        "start_date": start,
        "requested_through": end,
        "observed_through": app_rates.annual_observed_through(stats),
        "source": "Yahoo Finance",
        "price_field": "Close",
        "non_trading_days": "excluded",
        "errors": errors,
    })
    return result



def api_calculate(req: app_contracts.CalculateRequest):
    """执行当月预算计算：标准解析 → 行程展开/旅居过滤 → 汇率 → 计算。"""
    # 1) 解析本次计算的预算标准（含当月新建的自定义地点/币种），得到地点注册表
    resolved_standards = app_defaults.resolve_standards(req.standards_override)
    _, _, _, loc_registry, _ = resolved_standards

    # 2) 行程展开 + 旅居过滤（include_travel / travel_locations）
    expanded, warnings, dup_count = _expand_itinerary(
        req.itinerary, req.year, req.month, loc_registry,
        include_travel=req.include_travel,
        travel_locations=req.travel_locations,
    )
    if not expanded:
        raise ValueError("行程为空（或旅居全部被排除），请至少保留一个日期区间")

    budget_curr_list = required_currencies(expanded, req.region, resolved_standards)

    rates, rate_source = app_rates.fetch_budget_rates(
        budget_curr_list, req.year, req.month,
    )
    if rate_source.get("fallback"):
        warnings.append(
            f"{rate_source['requested_month']} 月首日暂无可用行情，"
            f"已使用 {rate_source['source_month']} 月平均汇率计算"
        )

    result = budget_core.calculate_travel_budget(
        expanded, req.region, req.year, req.month,
        standards_override=req.standards_override,
        rates_dict=rates,
        resolved_standards=resolved_standards,
    )
    result["warnings"] = warnings
    result["deduped_entries"] = dup_count
    result["rate_source"] = rate_source
    return result
