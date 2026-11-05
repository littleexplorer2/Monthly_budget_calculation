"""v1 归档解析与迁移辅助。

生产 HTTP/前端不再有旧聚合写管线；v2 运行时入口只在
``application.state.v2``。这里仅保留 v1 迁移解析及 v2 子文档复用的严格规范化函数。
"""

from __future__ import annotations

import datetime as dt
import math
import re
import threading
from application import config as app_config
from application import contracts as app_contracts


APP_STATE_FILE = app_config.BASE_DIR / "data" / "app-state.json"



_state_disk_lock = threading.RLock()



def _empty_app_state() -> dict:
    return {
        "version": 1,
        "updatedAt": None,
        "year": None,
        "month": None,
        "itineraryByMonth": {},
        "optionsByMonth": {},
        "overridesByMonth": {},
        "resultsByMonth": {},
        "subscriptionsByMonth": {},
        "annualBudgetsByYear": {},
        "annualResultsByYear": {},
        "assetPortfoliosById": {},
    }



def _compact_results_map(results: dict) -> dict:
    """去掉汇率明细，避免 app-state.json 过大、Safari 也无法用 localStorage 扛住。"""
    out = {}
    if not isinstance(results, dict):
        raise ValueError("resultsByMonth 必须是对象")
    for raw_key, val in results.items():
        key = _month_state_key(raw_key, "resultsByMonth")
        if not isinstance(val, dict):
            raise ValueError(f"resultsByMonth.{key} 必须是对象")
        out[key] = {k: v for k, v in val.items() if k not in ("rates", "rates_dict")}
    return out



def _normalize_annual_budgets(raw: dict | None) -> dict:
    """严格规范全年输入；旧 app-state 缺少该字段时自然返回空对象。"""
    out: dict[str, dict[str, float]] = {}
    if raw is None:
        return out
    if not isinstance(raw, dict):
        raise ValueError("annualBudgetsByYear 必须是对象")
    for raw_year, raw_amounts in raw.items():
        year = str(raw_year)
        if not re.fullmatch(r"\d{4}", year) or not (2000 <= int(year) <= 2100):
            raise ValueError(f"annualBudgetsByYear 年份无效：{raw_year!r}")
        if not isinstance(raw_amounts, dict):
            raise ValueError(f"annualBudgetsByYear.{year} 必须是币种金额对象")
        amounts: dict[str, float] = {}
        for raw_currency, raw_amount in raw_amounts.items():
            currency = str(raw_currency).strip().upper()
            if not re.fullmatch(r"[A-Z]{2,6}", currency):
                raise ValueError(f"annualBudgetsByYear.{year} 币种代码无效：{raw_currency!r}")
            if currency in amounts:
                raise ValueError(f"annualBudgetsByYear.{year} 币种重复：{currency}")
            if (isinstance(raw_amount, bool) or not isinstance(raw_amount, (int, float))
                    or not math.isfinite(float(raw_amount)) or float(raw_amount) < 0):
                raise ValueError(
                    f"annualBudgetsByYear.{year}.{currency} 必须是非负有限数字"
                )
            amounts[currency] = float(raw_amount)
        if amounts:
            out[year] = amounts
    return out



def _compact_annual_results(raw: dict | None) -> dict:
    """严格校验全年结果并只保留紧凑摘要/明细。"""
    out = {}
    if raw is None:
        return out
    if not isinstance(raw, dict):
        raise ValueError("annualResultsByYear 必须是对象")
    for raw_year, result in raw.items():
        year = str(raw_year)
        if not re.fullmatch(r"\d{4}", year) or not (2000 <= int(year) <= 2100):
            raise ValueError(f"annualResultsByYear 年份无效：{raw_year!r}")
        if not isinstance(result, dict):
            raise ValueError(f"annualResultsByYear.{year} 必须是结果对象")
        compact = {
            key: value for key, value in result.items()
            if key not in ("rates", "rates_dict", "series")
        }
        if not compact:
            raise ValueError(f"annualResultsByYear.{year} 不能是空结果")
        result_year = compact.get("year")
        if result_year is not None and (
                isinstance(result_year, bool) or not isinstance(result_year, int)
                or result_year != int(year)):
            raise ValueError(f"annualResultsByYear.{year}.year 必须与外层年份一致")
        if "price_field" in compact and compact["price_field"] != "Close":
            raise ValueError(f"annualResultsByYear.{year}.price_field 必须是 Close")
        if ("non_trading_days" in compact
                and compact["non_trading_days"] != "excluded"):
            raise ValueError(
                f"annualResultsByYear.{year}.non_trading_days 必须是 excluded"
            )

        parsed_dates: dict[str, dt.date | None] = {}
        for field in ("start_date", "requested_through", "observed_through"):
            value = compact.get(field)
            if value is None:
                parsed_dates[field] = None
                continue
            if not isinstance(value, str):
                raise ValueError(f"annualResultsByYear.{year}.{field} 必须是日期字符串")
            try:
                parsed = dt.date.fromisoformat(value)
            except ValueError as exc:
                raise ValueError(
                    f"annualResultsByYear.{year}.{field} 日期无效"
                ) from exc
            if parsed.year != int(year):
                raise ValueError(f"annualResultsByYear.{year}.{field} 年份不一致")
            parsed_dates[field] = parsed
        start_date = parsed_dates["start_date"]
        requested_through = parsed_dates["requested_through"]
        observed_through = parsed_dates["observed_through"]
        if start_date is not None and start_date != dt.date(int(year), 1, 1):
            raise ValueError(f"annualResultsByYear.{year}.start_date 必须是当年 01-01")
        if start_date and requested_through and requested_through < start_date:
            raise ValueError(f"annualResultsByYear.{year} 日期范围顺序无效")
        if observed_through and start_date and observed_through < start_date:
            raise ValueError(f"annualResultsByYear.{year}.observed_through 早于开始日期")
        if observed_through and requested_through and observed_through > requested_through:
            raise ValueError(f"annualResultsByYear.{year}.observed_through 超出请求范围")
        summary = compact.get("summary")
        details = compact.get("details")
        if not isinstance(summary, dict):
            raise ValueError(f"annualResultsByYear.{year}.summary 必须是对象")
        total = summary.get("全年预算合计(人民币)")
        if (isinstance(total, bool) or not isinstance(total, (int, float))
                or not math.isfinite(float(total)) or float(total) < 0):
            raise ValueError(
                f"annualResultsByYear.{year}.summary.全年预算合计(人民币) 必须是非负有限数字"
            )
        if not isinstance(details, list):
            raise ValueError(f"annualResultsByYear.{year}.details 必须是数组")
        seen_currencies: set[str] = set()
        detail_total = 0.0
        for index, row in enumerate(details):
            path = f"annualResultsByYear.{year}.details[{index}]"
            if not isinstance(row, dict):
                raise ValueError(f"{path} 必须是对象")
            currency = row.get("currency")
            if not isinstance(currency, str) or not re.fullmatch(r"[A-Z]{2,6}", currency):
                raise ValueError(f"{path}.currency 无效")
            if currency in seen_currencies:
                raise ValueError(f"{path}.currency 重复：{currency}")
            seen_currencies.add(currency)
            for field in ("amount", "cny_amount"):
                value = row.get(field)
                if (isinstance(value, bool) or not isinstance(value, (int, float))
                        or not math.isfinite(float(value)) or float(value) < 0):
                    raise ValueError(f"{path}.{field} 必须是非负有限数字")
            rate = row.get("average_rate")
            if rate is None:
                if float(row["amount"]) != 0:
                    raise ValueError(f"{path}.average_rate 缺失")
                expected_cny = 0.0
            elif (isinstance(rate, bool) or not isinstance(rate, (int, float))
                  or not math.isfinite(float(rate)) or float(rate) <= 0):
                raise ValueError(f"{path}.average_rate 必须是正有限数字")
            else:
                expected_cny = round(float(row["amount"]) * float(rate), 2)
            if not math.isclose(
                    float(row["cny_amount"]), expected_cny,
                    rel_tol=0.0, abs_tol=1e-9):
                raise ValueError(f"{path}.cny_amount 与金额乘年平均汇率不一致")
            detail_total += float(row["cny_amount"])
            if not math.isfinite(detail_total):
                raise ValueError(
                    f"annualResultsByYear.{year}.details 人民币金额合计超出有限数范围"
                )

            observation_count = row.get("observation_count")
            if observation_count is not None and (
                    isinstance(observation_count, bool)
                    or not isinstance(observation_count, int)
                    or observation_count < 0):
                raise ValueError(f"{path}.observation_count 必须是非负整数")
            row_dates = {}
            for field in ("first_date", "last_date"):
                value = row.get(field)
                if value is None:
                    row_dates[field] = None
                    continue
                if not isinstance(value, str):
                    raise ValueError(f"{path}.{field} 必须是日期字符串或 null")
                try:
                    parsed = dt.date.fromisoformat(value)
                except ValueError as exc:
                    raise ValueError(f"{path}.{field} 日期无效") from exc
                if parsed.year != int(year):
                    raise ValueError(f"{path}.{field} 年份不一致")
                row_dates[field] = parsed
            if row_dates["first_date"] and row_dates["last_date"]:
                if row_dates["first_date"] > row_dates["last_date"]:
                    raise ValueError(f"{path} 行情日期范围顺序无效")
                if start_date and row_dates["first_date"] < start_date:
                    raise ValueError(f"{path}.first_date 超出全年范围")
                if requested_through and row_dates["last_date"] > requested_through:
                    raise ValueError(f"{path}.last_date 超出请求范围")
        expected_total = round(detail_total, 2)
        if not math.isclose(float(total), expected_total, rel_tol=0.0, abs_tol=1e-9):
            raise ValueError(
                f"annualResultsByYear.{year}.summary.全年预算合计(人民币) 与明细合计不一致"
            )
        if "errors" in compact and not isinstance(compact["errors"], dict):
            raise ValueError(f"annualResultsByYear.{year}.errors 必须是对象")
        out[year] = compact
    return out


_MANAGED_CURRENCIES = {"CNY", "HKD", "USD"}
_STATE_ID_PATTERN = re.compile(r"[A-Za-z0-9._:-]{1,64}")
_LEGACY_FIXED_OVERRIDE_FIELDS = frozenset({"fixed", "extra"})


def _month_state_key(raw_month, field: str) -> str:
    month = str(raw_month)
    match = re.fullmatch(r"(\d{4})-(\d{2})", month)
    if not match or not (2000 <= int(match.group(1)) <= 2100) or not (1 <= int(match.group(2)) <= 12):
        raise ValueError(f"{field} 月份无效：{raw_month!r}")
    return month


def _state_amount(value, path: str, *, positive: bool = False) -> float:
    if (isinstance(value, bool) or not isinstance(value, (int, float))
            or not math.isfinite(float(value))
            or (float(value) <= 0 if positive else float(value) < 0)):
        qualifier = "正有限数字" if positive else "非负有限数字"
        raise ValueError(f"{path} 必须是{qualifier}")
    return float(value)


def _state_text(value, path: str, *, max_length: int = 120) -> str:
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > max_length:
        raise ValueError(f"{path} 必须是 1-{max_length} 个字符的非空字符串")
    return value.strip()


def _state_item_id(value, path: str) -> str:
    if not isinstance(value, str) or not _STATE_ID_PATTERN.fullmatch(value):
        raise ValueError(f"{path} 必须是 1-64 位字母、数字或 . _ : -")
    return value


def _normalize_subscriptions(raw: dict | None) -> dict:
    """校验逐月订阅快照；空对象保留为本次删除使用的墓碑。"""
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise ValueError("subscriptionsByMonth 必须是对象")
    out = {}
    for raw_month, raw_snapshot in raw.items():
        month = _month_state_key(raw_month, "subscriptionsByMonth")
        path = f"subscriptionsByMonth.{month}"
        if raw_snapshot == {}:
            out[month] = {}
            continue
        if not isinstance(raw_snapshot, dict):
            raise ValueError(f"{path} 必须是对象")
        unknown = set(raw_snapshot) - {"items", "retiredIds"}
        if unknown:
            raise ValueError(f"{path} 包含未知字段：{', '.join(sorted(unknown))}")
        raw_items = raw_snapshot.get("items")
        if not isinstance(raw_items, list):
            raise ValueError(f"{path}.items 必须是数组")
        if len(raw_items) > 500:
            raise ValueError(f"{path}.items 最多保存 500 项")
        raw_retired_ids = raw_snapshot.get("retiredIds", [])
        if not isinstance(raw_retired_ids, list):
            raise ValueError(f"{path}.retiredIds 必须是数组")
        if len(raw_retired_ids) > 500:
            raise ValueError(f"{path}.retiredIds 最多保存 500 项")
        retired_ids = []
        seen_retired_ids = set()
        for index, raw_id in enumerate(raw_retired_ids):
            item_id = _state_item_id(raw_id, f"{path}.retiredIds[{index}]")
            if item_id in seen_retired_ids:
                raise ValueError(f"{path}.retiredIds[{index}] 重复：{item_id}")
            seen_retired_ids.add(item_id)
            retired_ids.append(item_id)
        items = []
        seen_ids = set()
        for index, raw_item in enumerate(raw_items):
            item_path = f"{path}.items[{index}]"
            if not isinstance(raw_item, dict):
                raise ValueError(f"{item_path} 必须是对象")
            unknown = set(raw_item) - {
                "id", "name", "currency", "cycle", "amount",
                "included", "includeByDefault", "appliesTo",
            }
            if unknown:
                raise ValueError(f"{item_path} 包含未知字段：{', '.join(sorted(unknown))}")
            item_id = _state_item_id(raw_item.get("id"), f"{item_path}.id")
            if item_id in seen_ids:
                raise ValueError(f"{item_path}.id 重复：{item_id}")
            seen_ids.add(item_id)
            currency = raw_item.get("currency")
            if currency not in _MANAGED_CURRENCIES:
                raise ValueError(f"{item_path}.currency 仅支持 CNY / HKD / USD")
            cycle = raw_item.get("cycle")
            if cycle not in ("monthly", "yearly"):
                raise ValueError(f"{item_path}.cycle 必须是 monthly 或 yearly")
            included = raw_item.get("included")
            include_by_default = raw_item.get("includeByDefault")
            if not isinstance(included, bool):
                raise ValueError(f"{item_path}.included 必须是布尔值")
            if not isinstance(include_by_default, bool):
                raise ValueError(f"{item_path}.includeByDefault 必须是布尔值")
            applies_to = app_contracts.normalize_subscription_applies_to(
                raw_item.get("appliesTo"), f"{item_path}.appliesTo",
            )
            items.append({
                "id": item_id,
                "name": _state_text(raw_item.get("name"), f"{item_path}.name"),
                "currency": currency,
                "cycle": cycle,
                "amount": _state_amount(raw_item.get("amount"), f"{item_path}.amount"),
                "included": included,
                "includeByDefault": include_by_default,
                "appliesTo": applies_to,
            })
        overlap = seen_ids & seen_retired_ids
        if overlap:
            raise ValueError(
                f"{path}.retiredIds 不能包含仍在 items 中的项目：{sorted(overlap)[0]}"
            )
        out[month] = {"items": items, "retiredIds": retired_ids}
    return out


def _normalize_asset_calculation_base(raw, path: str) -> dict:
    """把旧版纯 CNY 数值单向规范为 CNY/HKD/USD 基数组合。"""
    if isinstance(raw, dict):
        unknown = set(raw) - _MANAGED_CURRENCIES
        if unknown:
            raise ValueError(f"{path} 包含未知币种：{', '.join(sorted(unknown))}")
        base = {
            currency: _state_amount(raw.get(currency, 0), f"{path}.{currency}")
            for currency in ("CNY", "HKD", "USD")
        }
        if not any(value > 0 for value in base.values()):
            raise ValueError(f"{path} 至少一种币种必须大于 0")
        return base
    legacy_cny = _state_amount(raw, path, positive=True)
    return {"CNY": legacy_cny, "HKD": 0.0, "USD": 0.0}


def _normalize_asset_portfolios(raw: dict | None) -> dict:
    """校验当前资产组合；计算基数支持三币种，旧数值按纯 CNY 兼容。"""
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise ValueError("assetPortfoliosById 必须是对象")
    out = {}
    for raw_portfolio_id, raw_portfolio in raw.items():
        portfolio_id = str(raw_portfolio_id)
        if portfolio_id != "current":
            raise ValueError(f"assetPortfoliosById 组合标识无效：{portfolio_id!r}")
        path = f"assetPortfoliosById.{portfolio_id}"
        if raw_portfolio == {}:
            out[portfolio_id] = {}
            continue
        if not isinstance(raw_portfolio, dict):
            raise ValueError(f"{path} 必须是对象")
        unknown = set(raw_portfolio) - {"calculationBase", "rates", "items"}
        if unknown:
            raise ValueError(f"{path} 包含未知字段：{', '.join(sorted(unknown))}")
        calculation_base = _normalize_asset_calculation_base(
            raw_portfolio.get("calculationBase"), f"{path}.calculationBase",
        )
        raw_rates = raw_portfolio.get("rates")
        if not isinstance(raw_rates, dict):
            raise ValueError(f"{path}.rates 必须是对象")
        unknown_rates = set(raw_rates) - _MANAGED_CURRENCIES
        if unknown_rates:
            raise ValueError(f"{path}.rates 包含未知币种：{', '.join(sorted(unknown_rates))}")
        cny_rate = raw_rates.get("CNY", 1)
        if (isinstance(cny_rate, bool) or not isinstance(cny_rate, (int, float))
                or float(cny_rate) != 1.0):
            raise ValueError(f"{path}.rates.CNY 必须是 1")
        rates = {"CNY": 1.0}
        for currency in ("HKD", "USD"):
            value = raw_rates.get(currency)
            rates[currency] = None if value is None else _state_amount(
                value, f"{path}.rates.{currency}", positive=True,
            )
        raw_items = raw_portfolio.get("items")
        if not isinstance(raw_items, list):
            raise ValueError(f"{path}.items 必须是数组")
        if len(raw_items) > 500:
            raise ValueError(f"{path}.items 最多保存 500 项")
        items = []
        seen_ids = set()
        for index, raw_item in enumerate(raw_items):
            item_path = f"{path}.items[{index}]"
            if not isinstance(raw_item, dict):
                raise ValueError(f"{item_path} 必须是对象")
            unknown = set(raw_item) - {
                "id", "kind", "location", "name", "purpose", "currency", "amount",
            }
            if unknown:
                raise ValueError(f"{item_path} 包含未知字段：{', '.join(sorted(unknown))}")
            item_id = _state_item_id(raw_item.get("id"), f"{item_path}.id")
            if item_id in seen_ids:
                raise ValueError(f"{item_path}.id 重复：{item_id}")
            seen_ids.add(item_id)
            kind = raw_item.get("kind")
            if kind not in ("cash", "term", "investment"):
                raise ValueError(f"{item_path}.kind 必须是 cash、term 或 investment")
            purpose = raw_item.get("purpose")
            if purpose not in ("spending", "reserve", "other"):
                raise ValueError(f"{item_path}.purpose 必须是 spending、reserve 或 other")
            currency = raw_item.get("currency")
            if currency not in _MANAGED_CURRENCIES:
                raise ValueError(f"{item_path}.currency 仅支持 CNY / HKD / USD")
            items.append({
                "id": item_id,
                "kind": kind,
                "location": _state_text(raw_item.get("location"), f"{item_path}.location"),
                "name": _state_text(raw_item.get("name"), f"{item_path}.name"),
                "purpose": purpose,
                "currency": currency,
                "amount": _state_amount(raw_item.get("amount"), f"{item_path}.amount"),
            })
        out[portfolio_id] = {
            "calculationBase": calculation_base,
            "rates": rates,
            "items": items,
        }
    return out


def _normalize_overrides(raw: dict | None) -> dict:
    """兼容读取旧月度快照，但不再让旧固定/额外预算进入运行时。"""
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise ValueError("app-state.overridesByMonth 必须是对象")
    out = {}
    for raw_month, snapshot in raw.items():
        month = _month_state_key(raw_month, "overridesByMonth")
        if not isinstance(snapshot, dict):
            raise ValueError(f"overridesByMonth.{month} 必须是对象")
        clean = dict(snapshot)
        for field in _LEGACY_FIXED_OVERRIDE_FIELDS:
            clean.pop(field, None)
        out[month] = clean
    return out



def _normalize_app_state(raw: dict | None) -> dict:
    state = _empty_app_state()
    if raw is None:
        return state
    if not isinstance(raw, dict):
        raise ValueError("app-state 根节点必须是对象")
    if isinstance(raw.get("version"), int) and not isinstance(raw.get("version"), bool):
        state["version"] = raw["version"]
    if isinstance(raw.get("updatedAt"), str):
        state["updatedAt"] = raw["updatedAt"]
    year, month = raw.get("year"), raw.get("month")
    if year is not None:
        if isinstance(year, bool) or not isinstance(year, int) or not (2000 <= year <= 2100):
            raise ValueError("app-state.year 必须是 2000-2100 的整数或 null")
        state["year"] = year
    if month is not None:
        if isinstance(month, bool) or not isinstance(month, int) or not (1 <= month <= 12):
            raise ValueError("app-state.month 必须是 1-12 的整数或 null")
        state["month"] = month
    for field in (
            "itineraryByMonth", "optionsByMonth", "overridesByMonth",
            "resultsByMonth", "subscriptionsByMonth", "annualBudgetsByYear",
            "annualResultsByYear", "assetPortfoliosById"):
        if field in raw and raw[field] is not None and not isinstance(raw[field], dict):
            raise ValueError(f"app-state.{field} 必须是对象")
    itin_in = raw.get("itineraryByMonth")
    if isinstance(itin_in, dict):
        cleaned = {}
        for raw_month, month_itin in itin_in.items():
            month = _month_state_key(raw_month, "itineraryByMonth")
            if not isinstance(month_itin, dict):
                raise ValueError(f"itineraryByMonth.{month} 必须是对象")
            cleaned[month] = _exclusive_itinerary_month(month_itin)
        state["itineraryByMonth"] = cleaned
    val = raw.get("optionsByMonth")
    if isinstance(val, dict):
        options = {}
        for raw_month, month_options in val.items():
            month = _month_state_key(raw_month, "optionsByMonth")
            if not isinstance(month_options, dict):
                raise ValueError(f"optionsByMonth.{month} 必须是对象")
            options[month] = dict(month_options)
        state["optionsByMonth"] = options
    state["overridesByMonth"] = _normalize_overrides(raw.get("overridesByMonth"))
    state["resultsByMonth"] = _compact_results_map(raw.get("resultsByMonth") or {})
    state["subscriptionsByMonth"] = _normalize_subscriptions(raw.get("subscriptionsByMonth"))
    state["annualBudgetsByYear"] = _normalize_annual_budgets(raw.get("annualBudgetsByYear"))
    state["annualResultsByYear"] = _compact_annual_results(raw.get("annualResultsByYear"))
    state["assetPortfoliosById"] = _normalize_asset_portfolios(raw.get("assetPortfoliosById"))
    return state



def _iter_days(start: str, end: str) -> list[str]:
    """按日历日期枚举闭区间，避免时区/DST 把某一天算到另一个地点。"""
    try:
        cur = dt.date.fromisoformat(str(start).strip())
        last = dt.date.fromisoformat(str(end).strip())
    except (TypeError, ValueError):
        return []
    if cur > last:
        return []
    days = []
    while cur <= last:
        days.append(cur.isoformat())
        cur += dt.timedelta(days=1)
    return days



def _ranges_from_days(days: list[str]) -> list[dict]:
    uniq = sorted(set(days))
    if not uniq:
        return []
    ranges = []
    start = prev = uniq[0]
    for day in uniq[1:]:
        try:
            consecutive = dt.date.fromisoformat(day) == dt.date.fromisoformat(prev) + dt.timedelta(days=1)
        except ValueError:
            consecutive = False
        if consecutive:
            prev = day
            continue
        ranges.append({"start": start, "end": prev})
        start = prev = day
    ranges.append({"start": start, "end": prev})
    return ranges



def _exclusive_itinerary_month(month) -> dict:
    """同一天只属于一个地点：更短的日期段优先，避免香港大段覆盖深圳空隙。"""
    if not isinstance(month, dict):
        return {}
    owners: dict[str, tuple[str, int]] = {}
    for loc, ranges in month.items():
        if not isinstance(ranges, list):
            continue
        loc_key = str(loc)
        for rng in ranges:
            if not isinstance(rng, dict):
                continue
            days = _iter_days(rng.get("start"), rng.get("end"))
            length = len(days)
            if not length:
                continue
            for day in days:
                prev = owners.get(day)
                if prev is None or length < prev[1]:
                    owners[day] = (loc_key, length)
    claimed: dict[str, list[str]] = {}
    for day, (loc, _) in owners.items():
        claimed.setdefault(loc, []).append(day)
    out = {}
    for loc in month:
        loc_key = str(loc)
        if loc_key in claimed:
            out[loc_key] = _ranges_from_days(claimed.pop(loc_key))
    for loc_key, days in claimed.items():
        out[loc_key] = _ranges_from_days(days)
    return out



def _is_default_options(opt) -> bool:
    if not isinstance(opt, dict):
        return True
    region = "Overseas" if opt.get("region") == "Overseas" else "Mainland"
    travel = bool(opt.get("includeTravel"))
    sel = opt.get("travelSelected")
    has_sel = isinstance(sel, list) and len(sel) > 0
    return region == "Mainland" and not travel and not has_sel and not opt.get("savedAt")



def _fill_options_from_results(options: dict, results: dict) -> dict:
    out = dict(options or {})
    for month, res in (results or {}).items():
        if not isinstance(res, dict):
            continue
        summary = res.get("summary") if isinstance(res.get("summary"), dict) else {}
        region = res.get("region") or summary.get("居住区域")
        include = res.get("includeTravel")
        cur = out.get(month)
        if cur and not _is_default_options(cur):
            continue
        next_opt = dict(cur) if isinstance(cur, dict) else {
            "region": "Mainland", "includeTravel": False, "travelSelected": None,
        }
        if region in ("Mainland", "Overseas"):
            next_opt["region"] = region
        if include is not None:
            next_opt["includeTravel"] = bool(include)
        out[month] = next_opt
    return out
