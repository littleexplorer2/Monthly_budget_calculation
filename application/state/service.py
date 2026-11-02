"""唯一状态持久化、兼容迁移与并发冲突处理。"""

from __future__ import annotations

import datetime as dt
import json
import math
import re
import threading
from application import config as app_config
from application import contracts as app_contracts
from application import defaults as app_defaults
from core import storage


APP_STATE_FILE = app_config.BASE_DIR / "data" / "app-state.json"



_state_disk_lock = threading.RLock()



_state_write_sequences: dict[str, int] = {}



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
        return out
    for key, val in results.items():
        if not isinstance(val, dict):
            continue
        out[str(key)] = {k: v for k, v in val.items() if k not in ("rates", "rates_dict")}
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
        unknown = set(raw_snapshot) - {"items"}
        if unknown:
            raise ValueError(f"{path} 包含未知字段：{', '.join(sorted(unknown))}")
        raw_items = raw_snapshot.get("items")
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
                "id", "name", "currency", "cycle", "amount",
                "included", "includeByDefault",
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
            items.append({
                "id": item_id,
                "name": _state_text(raw_item.get("name"), f"{item_path}.name"),
                "currency": currency,
                "cycle": cycle,
                "amount": _state_amount(raw_item.get("amount"), f"{item_path}.amount"),
                "included": included,
                "includeByDefault": include_by_default,
            })
        out[month] = {"items": items}
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


def _has_legacy_fixed_overrides(raw: dict | None) -> bool:
    """旧月份里手工固定/额外预算已由订阅月均汇总取代。"""
    if not isinstance(raw, dict):
        return False
    overrides = raw.get("overridesByMonth")
    if not isinstance(overrides, dict):
        return False
    return any(
        isinstance(snapshot, dict)
        and bool(_LEGACY_FIXED_OVERRIDE_FIELDS.intersection(snapshot))
        for snapshot in overrides.values()
    )


def _normalize_overrides(raw: dict | None) -> dict:
    """兼容读取旧月度快照，但不再让旧固定/额外预算进入运行时。"""
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise ValueError("app-state.overridesByMonth 必须是对象")
    out = {}
    for month, snapshot in raw.items():
        if not isinstance(snapshot, dict):
            out[str(month)] = snapshot
            continue
        clean = dict(snapshot)
        for field in _LEGACY_FIXED_OVERRIDE_FIELDS:
            clean.pop(field, None)
        out[str(month)] = clean
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
        for month, month_itin in itin_in.items():
            cleaned[str(month)] = _exclusive_itinerary_month(
                month_itin if isinstance(month_itin, dict) else {}
            )
        state["itineraryByMonth"] = cleaned
    val = raw.get("optionsByMonth")
    if isinstance(val, dict):
        state["optionsByMonth"] = val
    state["overridesByMonth"] = _normalize_overrides(raw.get("overridesByMonth"))
    state["resultsByMonth"] = _compact_results_map(raw.get("resultsByMonth") or {})
    state["subscriptionsByMonth"] = _normalize_subscriptions(raw.get("subscriptionsByMonth"))
    state["annualBudgetsByYear"] = _normalize_annual_budgets(raw.get("annualBudgetsByYear"))
    state["annualResultsByYear"] = _compact_annual_results(raw.get("annualResultsByYear"))
    state["assetPortfoliosById"] = _normalize_asset_portfolios(raw.get("assetPortfoliosById"))
    return state



def _itinerary_range_count(itinerary: dict | None) -> int:
    n = 0
    if not isinstance(itinerary, dict):
        return 0
    for loc_ranges in itinerary.values():
        if not isinstance(loc_ranges, dict):
            continue
        for ranges in loc_ranges.values():
            if isinstance(ranges, list):
                n += len(ranges)
    return n



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



def _merge_itinerary_map(disk: dict, incoming: dict) -> dict:
    """按月合并行程。

    浏览器提交了某个月（含空对象=已清空）时，以本次提交为准，不再把磁盘上
    旧的香港大段追加回去；完全没提交行程字段时保留磁盘，避免空缓存清空仓库。
    """
    disk = disk if isinstance(disk, dict) else {}
    incoming = incoming if isinstance(incoming, dict) else {}
    out = {}
    if incoming:
        for month, inc in incoming.items():
            cleaned = _exclusive_itinerary_month(inc if isinstance(inc, dict) else {})
            if cleaned:
                out[month] = cleaned
        for month, cur in disk.items():
            if month in incoming:
                continue
            cleaned = _exclusive_itinerary_month(cur if isinstance(cur, dict) else {})
            if cleaned:
                out[month] = cleaned
        return out
    for month, cur in disk.items():
        cleaned = _exclusive_itinerary_month(cur if isinstance(cur, dict) else {})
        if cleaned:
            out[month] = cleaned
    return out



def _merge_present_month_map(disk, incoming) -> dict:
    """浏览器提交了某个月（含空对象=已清空）则以本次为准；未提交的月份保留磁盘。"""
    disk = disk if isinstance(disk, dict) else {}
    incoming = incoming if isinstance(incoming, dict) else {}
    if not incoming:
        return dict(disk)
    out = {}
    for month, val in incoming.items():
        if isinstance(val, dict) and val:
            out[month] = val
    for month, val in disk.items():
        if month in incoming:
            continue
        if isinstance(val, dict) and val:
            out[month] = val
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



def _merge_app_state(disk: dict | None, incoming: dict | None, replace: bool = False) -> dict:
    """把浏览器提交的状态合并进磁盘文件。

    提交了某个月则以本次为准（空对象=已清空）；完全没提交的月份保留磁盘。
    打开页面只读，不得靠合并本机缓存来改仓库。
    """
    incoming_raw = dict(incoming) if isinstance(incoming, dict) else {}
    # 请求中的空年度对象是按年份删除用的墓碑，只参与本次合并，不会写入磁盘。
    raw_annual_budgets = incoming_raw.get("annualBudgetsByYear")
    annual_budget_tombstones = {
        str(year) for year, value in raw_annual_budgets.items() if value == {}
    } if isinstance(raw_annual_budgets, dict) else set()
    raw_annual_results = incoming_raw.get("annualResultsByYear")
    annual_result_tombstones = {
        str(year) for year, value in raw_annual_results.items() if value == {}
    } if isinstance(raw_annual_results, dict) else set()
    for field, tombstones in (
            ("annualBudgetsByYear", annual_budget_tombstones),
            ("annualResultsByYear", annual_result_tombstones)):
        for year in tombstones:
            if not re.fullmatch(r"\d{4}", year) or not (2000 <= int(year) <= 2100):
                raise ValueError(f"{field} 年份无效：{year!r}")
    if annual_result_tombstones:
        incoming_raw["annualResultsByYear"] = {
            year: value for year, value in raw_annual_results.items() if value != {}
        }
    incoming_n = _normalize_app_state(incoming_raw)
    if (incoming_n["year"] is None) != (incoming_n["month"] is None):
        raise ValueError("year 与 month 必须成对提交")
    if replace:
        # 整份覆盖时空年度项就是“结果中不存在该年”，不能把墓碑写进磁盘。
        return incoming_n
    for year in annual_budget_tombstones:
        incoming_n["annualBudgetsByYear"][year] = {}
    for year in annual_result_tombstones:
        incoming_n["annualResultsByYear"][year] = {}
    disk_n = _normalize_app_state(disk)
    itinerary = _merge_itinerary_map(
        disk_n["itineraryByMonth"],
        incoming_n["itineraryByMonth"],
    )
    options = _merge_present_month_map(
        disk_n["optionsByMonth"],
        incoming_n["optionsByMonth"],
    )
    overrides = _merge_present_month_map(
        disk_n["overridesByMonth"],
        incoming_n["overridesByMonth"],
    )
    results = _merge_present_month_map(
        disk_n["resultsByMonth"],
        incoming_n["resultsByMonth"],
    )
    subscriptions = _merge_present_month_map(
        disk_n["subscriptionsByMonth"],
        incoming_n["subscriptionsByMonth"],
    )
    annual_budgets = _merge_present_month_map(
        disk_n["annualBudgetsByYear"],
        incoming_n["annualBudgetsByYear"],
    )
    annual_results = _merge_present_month_map(
        disk_n["annualResultsByYear"],
        incoming_n["annualResultsByYear"],
    )
    asset_portfolios = _merge_present_month_map(
        disk_n["assetPortfoliosById"],
        incoming_n["assetPortfoliosById"],
    )
    year, month = disk_n["year"], disk_n["month"]
    if incoming_n["year"] and incoming_n["month"]:
        year, month = incoming_n["year"], incoming_n["month"]
    return _normalize_app_state({
        "version": max(disk_n.get("version") or 1, incoming_n.get("version") or 1),
        "year": year,
        "month": month,
        "itineraryByMonth": itinerary,
        "optionsByMonth": options,
        "overridesByMonth": overrides,
        "resultsByMonth": results,
        "subscriptionsByMonth": subscriptions,
        "annualBudgetsByYear": annual_budgets,
        "annualResultsByYear": annual_results,
        "assetPortfoliosById": asset_portfolios,
    })



def _read_app_state_file() -> dict | None:
    """用户状态不是可丢弃缓存：已存在但损坏时必须拒绝静默覆盖。"""
    return storage.read_json_file(APP_STATE_FILE, strict=True)



def _load_app_state() -> dict:
    with _state_disk_lock:
        raw = _normalize_app_state(_read_app_state_file())
        raw["optionsByMonth"] = _fill_options_from_results(
            raw.get("optionsByMonth") or {},
            raw.get("resultsByMonth") or {},
        )
        return raw



_STATE_MAP_FIELDS = (
    "itineraryByMonth",
    "optionsByMonth",
    "overridesByMonth",
    "resultsByMonth",
    "subscriptionsByMonth",
    "annualBudgetsByYear",
    "annualResultsByYear",
    "assetPortfoliosById",
)



def _state_marker_matches(current, marker: dict) -> bool:
    expected_exists = marker["exists"]
    current_exists = current is not _MISSING_STATE_VALUE
    return current_exists == expected_exists and (
        not expected_exists or current == marker["value"]
    )



def _payload_target_marker(payload: dict, field: str, key: str | None):
    if key is None:
        if field not in payload:
            return None
        return {"exists": True, "value": payload[field]}
    values = payload.get(field)
    if not isinstance(values, dict) or key not in values:
        return None
    value = values[key]
    # 所有状态 map 都以空对象表达删除；磁盘不会保留墓碑。
    if isinstance(value, dict) and not value:
        return {"exists": False}
    return {"exists": True, "value": value}



def _assert_state_patch_base(disk: dict, base_values: dict | None,
                             payload: dict | None = None) -> None:
    """逐键比较前端读取基线；只冲突真正修改的键，允许不同月份并行保存。"""
    if base_values is None:
        return
    if not isinstance(base_values, dict):
        raise ValueError("baseValues 必须是对象")
    allowed = {"year", "month", *_STATE_MAP_FIELDS}
    unknown = set(base_values) - allowed
    if unknown:
        raise ValueError(f"baseValues 包含未知字段：{', '.join(sorted(unknown))}")

    payload = payload if isinstance(payload, dict) else {}

    # 旧客户端完全不提交 baseValues 时仍按既有合并语义兼容；一旦选择使用
    # 乐观并发协议，就必须为每个实际写入键提供比较基线，不能靠漏 marker
    # 绕过同键冲突。year/month 是一个不可拆分的选择值，marker 也必须成对。
    has_year_base = "year" in base_values
    has_month_base = "month" in base_values
    if has_year_base != has_month_base:
        raise ValueError("baseValues.year 与 baseValues.month 必须成对提交")

    payload_year = payload.get("year")
    payload_month = payload.get("month")
    if (payload_year is None) != (payload_month is None):
        raise ValueError("year 与 month 必须成对提交")
    if payload_year is not None and not (has_year_base and has_month_base):
        raise ValueError("baseValues 必须同时包含 year 与 month 的读取基线")

    for field in _STATE_MAP_FIELDS:
        values = payload.get(field)
        if not isinstance(values, dict) or not values:
            continue
        field_base = base_values.get(field)
        if field_base is None:
            missing = ", ".join(sorted(str(key) for key in values))
            raise ValueError(f"baseValues.{field} 缺少写入键：{missing}")
        if not isinstance(field_base, dict):
            raise ValueError(f"baseValues.{field} 必须是对象")
        marker_keys = {str(key) for key in field_base}
        missing = [str(key) for key in values if str(key) not in marker_keys]
        if missing:
            raise ValueError(
                f"baseValues.{field} 缺少写入键：{', '.join(sorted(missing))}"
            )

    def validate_basic_marker(marker, label: str) -> None:
        if not isinstance(marker, dict) or not isinstance(marker.get("exists"), bool):
            raise ValueError(f"baseValues.{label} 格式无效")
        if marker["exists"] and "value" not in marker:
            raise ValueError(f"baseValues.{label} 缺少 value")

    def assert_marker(field: str, key: str | None, current, marker) -> None:
        label = f"{field}.{key}" if key is not None else field
        validate_basic_marker(marker, label)
        alternatives = marker.get("alternatives", [])
        if not isinstance(alternatives, list) or len(alternatives) > 4:
            raise ValueError(f"baseValues.{label}.alternatives 格式无效")
        for index, alternative in enumerate(alternatives):
            validate_basic_marker(alternative, f"{label}.alternatives[{index}]")
        candidates = [marker, *alternatives]
        if any(_state_marker_matches(current, candidate) for candidate in candidates):
            return
        # 请求重试或最终 beacon 可能在上一笔同值写入之后到达；目标值已在
        # 磁盘时视为幂等成功，不覆盖其它未提交键。
        target = _payload_target_marker(payload, field, key)
        if target is not None and _state_marker_matches(current, target):
            return
        raise app_contracts.StateConflictError(
            f"{label} 已被另一个标签页修改，本次旧快照未覆盖；请刷新页面后重试"
        )

    for field in ("year", "month"):
        if field in base_values:
            assert_marker(field, None, disk.get(field, _MISSING_STATE_VALUE), base_values[field])
    for field in _STATE_MAP_FIELDS:
        field_base = base_values.get(field)
        if field_base is None:
            continue
        if not isinstance(field_base, dict):
            raise ValueError(f"baseValues.{field} 必须是对象")
        current_map = disk.get(field) if isinstance(disk.get(field), dict) else {}
        for key, marker in field_base.items():
            assert_marker(field, str(key), current_map.get(str(key), _MISSING_STATE_VALUE), marker)



_MISSING_STATE_VALUE = object()



def _validate_state_write_identity(tab_id, sequence) -> tuple[str | None, int | None]:
    """校验可选的同标签页写入顺序标识；旧客户端可同时省略两者。"""
    if tab_id is None and sequence is None:
        return None, None
    if not isinstance(tab_id, str) or not tab_id or len(tab_id) > 64:
        raise ValueError("tabId 必须是 1-64 个字符的非空字符串")
    if isinstance(sequence, bool) or not isinstance(sequence, int) or sequence < 1:
        raise ValueError("sequence 必须是从 1 开始递增的整数")
    return tab_id, sequence



def _partition_state_patch(disk: dict, base_values: dict, payload: dict) -> tuple[dict, list[str]]:
    """按“月份/年度”逻辑键拆分 CAS，返回无冲突组和冲突组。

    同一月份的行程、选项、标准和结果视为一个原子组；同一年度的全年输入
    和全年结果也视为一个原子组。普通 PUT 由调用者保持整请求全有或全无；
    页面已离开的 unregister 可以保存这里返回的安全组，同时不会写出半个
    月份或半个年度的状态。
    """
    if not isinstance(base_values, dict):
        raise ValueError("baseValues 必须是对象")
    allowed = {"year", "month", *_STATE_MAP_FIELDS}
    unknown = set(base_values) - allowed
    if unknown:
        raise ValueError(f"baseValues 包含未知字段：{', '.join(sorted(unknown))}")

    payload_year = payload.get("year")
    payload_month = payload.get("month")
    has_payload_selection = payload_year is not None or payload_month is not None
    if (payload_year is None) != (payload_month is None):
        raise ValueError("year 与 month 必须成对提交")
    if ("year" in base_values) != ("month" in base_values):
        raise ValueError("baseValues.year 与 baseValues.month 必须成对提交")
    if has_payload_selection and "year" not in base_values:
        raise ValueError("baseValues 必须同时包含 year 与 month 的读取基线")

    safe: dict = {
        key: payload[key] for key in ("version", "updatedAt") if key in payload
    }
    conflicts: list[str] = []
    if has_payload_selection:
        selection_payload = {"year": payload_year, "month": payload_month}
        selection_base = {
            "year": base_values["year"], "month": base_values["month"],
        }
        try:
            _assert_state_patch_base(disk, selection_base, selection_payload)
        except app_contracts.StateConflictError:
            conflicts.append("year/month")
        else:
            safe.update(selection_payload)

    groups: dict[tuple[str, str], dict[str, dict]] = {}
    expected_markers: dict[str, set[str]] = {}
    for field in _STATE_MAP_FIELDS:
        values = payload.get(field)
        if values is None:
            continue
        if not isinstance(values, dict):
            raise ValueError(f"{field} 必须是对象")
        expected_markers[field] = {str(key) for key in values}
        field_base = base_values.get(field)
        if values and not isinstance(field_base, dict):
            missing = ", ".join(sorted(str(key) for key in values))
            raise ValueError(f"baseValues.{field} 缺少写入键：{missing}")
        for raw_key, value in values.items():
            key = str(raw_key)
            if key not in field_base:
                raise ValueError(f"baseValues.{field} 缺少写入键：{key}")
            if field.startswith("annual"):
                domain = "annual"
            elif field == "assetPortfoliosById":
                domain = "asset"
            else:
                domain = "month"
            group = groups.setdefault((domain, key), {"payload": {}, "base": {}})
            group["payload"].setdefault(field, {})[key] = value
            group["base"].setdefault(field, {})[key] = field_base[key]

    # 多余 marker 没有对应写入目标，通常意味着客户端协议实现有误；拒绝它，
    # 避免无关旧基线制造伪冲突或掩盖漏字段。
    for field in _STATE_MAP_FIELDS:
        field_base = base_values.get(field)
        if field_base is None:
            continue
        if not isinstance(field_base, dict):
            raise ValueError(f"baseValues.{field} 必须是对象")
        extras = {str(key) for key in field_base} - expected_markers.get(field, set())
        if extras:
            raise ValueError(
                f"baseValues.{field} 包含未写入键：{', '.join(sorted(extras))}"
            )

    for (domain, key), group in groups.items():
        try:
            _assert_state_patch_base(disk, group["base"], group["payload"])
        except app_contracts.StateConflictError:
            conflicts.append(f"{domain}:{key}")
            continue
        for field, values in group["payload"].items():
            safe.setdefault(field, {}).update(values)
    return safe, conflicts



def _save_app_state(payload: dict, replace: bool = False,
                    base_values: dict | None = None,
                    tab_id: str | None = None,
                    sequence: int | None = None,
                    allow_partial_conflicts: bool = False) -> dict:
    tab_id, sequence = _validate_state_write_identity(tab_id, sequence)
    with _state_disk_lock:
        raw_disk = _read_app_state_file()
        needs_fixed_budget_migration = _has_legacy_fixed_overrides(raw_disk)
        disk = _normalize_app_state(raw_disk)
        disk["optionsByMonth"] = _fill_options_from_results(
            disk.get("optionsByMonth") or {}, disk.get("resultsByMonth") or {},
        )
        if tab_id is not None:
            previous_sequence = _state_write_sequences.get(tab_id)
            if previous_sequence is not None and sequence <= previous_sequence:
                return disk
            # 记录最高“已见”序号，而非仅记录成功写盘序号。较新的请求代表该
            # 标签页的最终意图；即使它随后因跨标签 CAS 冲突而被拒绝，旧请求
            # 也不能在锁释放后反向落盘。
            _state_write_sequences[tab_id] = sequence
        conflicts: list[str] = []
        safe_payload = payload
        if not replace and base_values is not None:
            safe_payload, conflicts = _partition_state_patch(disk, base_values, payload)
            # 普通 PUT 必须全有或全无。若先写入无冲突组再返回 409，浏览器会
            # 保留整份旧基线，后续编辑和删除便会与已部分落盘的状态分叉。
            # 只有页面已经离开的 unregister 可以按组抢救无冲突修改。
            if conflicts and not allow_partial_conflicts:
                raise app_contracts.StateConflictError(
                    "以下状态已被另一个标签页修改，本次请求未写入："
                    f"{', '.join(conflicts)}。请刷新页面后重试"
                )
        meaningful = replace or any(
            key in safe_payload for key in ("year", "month", *_STATE_MAP_FIELDS)
        )
        if meaningful:
            if needs_fixed_budget_migration:
                # 迁移会从所有月份移除旧 fixed/extra 字段。必须先留下完整、
                # 只追加且不参与计算的原始快照；备份失败则本次写入整体失败。
                from application import backups as app_backups
                app_backups.create_data_backup(
                    reason="pre-subscription-fixed-migration",
                    state_lock=_state_disk_lock,
                    defaults_lock=app_defaults.defaults_disk_lock,
                )
            state = _merge_app_state(disk, safe_payload, replace=replace)
            state["updatedAt"] = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            storage.atomic_write_text(
                APP_STATE_FILE,
                json.dumps(state, ensure_ascii=False, indent=2),
            )
        else:
            state = disk
        if conflicts:
            saved_note = "；其它无冲突月份/年度已保存" if meaningful else ""
            raise app_contracts.StateConflictError(
                f"以下状态已被另一个标签页修改，本次旧快照未覆盖：{', '.join(conflicts)}"
                f"{saved_note}。请刷新页面后重试"
            )
    return state



def api_get_state():
    """读取随仓库同步的行程、每月选项、标准覆盖与计算结果。"""
    return _load_app_state()



def api_put_state(body: app_contracts.AppStateIn):
    """把浏览器当前数据合并写入 data/app-state.json。空缓存不会清掉磁盘上已有行程。"""
    payload = body.model_dump() if hasattr(body, "model_dump") else body.dict()
    replace = bool(payload.pop("replace", False))
    base_values = payload.pop("baseValues", None)
    tab_id = payload.pop("tabId", None)
    sequence = payload.pop("sequence", None)
    return _save_app_state(
        payload,
        replace=replace,
        base_values=base_values,
        tab_id=tab_id,
        sequence=sequence,
    )
