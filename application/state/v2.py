"""v2 月份实体、全局实体与一次性 v1 迁移。

运行时只读写 ``data/months/YYYY-MM.json`` 与 ``data/global.json``。
旧 ``app-state.json`` 仅由 :func:`migrate_v1_to_v2` 在启动时读取一次；
迁移完成后归档原始字节，不保留双写或运行时兼容读取路径。
"""

from __future__ import annotations

import copy
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import uuid

from application import config as app_config
from application import contracts as app_contracts
from application import defaults as app_defaults
from core import standards as core_standards
from core import storage

from . import service as legacy


SCHEMA_VERSION = 2
_V1_TOP_LEVEL_FIELDS = {
    "version", "updatedAt", "year", "month", "itineraryByMonth",
    "optionsByMonth", "overridesByMonth", "resultsByMonth",
    "subscriptionsByMonth", "annualBudgetsByYear", "annualResultsByYear",
    "assetPortfoliosById",
}
APP_STATE_FILE = legacy.APP_STATE_FILE
GLOBAL_STATE_FILE = app_config.GLOBAL_STATE_FILE
MONTHS_DIR = app_config.MONTHS_DIR
LEGACY_DATA_DIR = app_config.LEGACY_DATA_DIR


def _utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _json_text(value: dict) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2) + "\n"


def _sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _month_key(raw, field: str = "month") -> str:
    return legacy._month_state_key(raw, field)


def _month_path(month: str) -> Path:
    return MONTHS_DIR / f"{_month_key(month)}.json"


def _normalize_name_map(raw, field: str) -> dict[str, str]:
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise ValueError(f"{field} 必须是对象")
    out: dict[str, str] = {}
    for raw_key, raw_name in raw.items():
        key = str(raw_key).strip()
        name = str(raw_name).strip()
        if not key or len(key) > 120:
            raise ValueError(f"{field} 包含无效标识")
        if not name or len(name) > 120:
            raise ValueError(f"{field}.{key} 必须是 1-120 个字符")
        out[key] = name
    return out


def _normalize_custom_locations(raw) -> list[dict]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ValueError("standards.custom_locations 必须是数组")
    out: list[dict] = []
    seen: set[str] = set()
    for index, item in enumerate(raw):
        path = f"standards.custom_locations[{index}]"
        if not isinstance(item, dict):
            raise ValueError(f"{path} 必须是对象")
        key = str(item.get("key", "")).strip()
        name = str(item.get("name", "")).strip()
        category = str(item.get("category", "")).strip()
        currency = str(item.get("currency", "")).strip().upper()
        if not key or len(key) > 120 or key in seen:
            raise ValueError(f"{path}.key 为空、过长或重复")
        if not name or len(name) > 120:
            raise ValueError(f"{path}.name 必须是 1-120 个字符")
        if category not in ("variable", "travel"):
            raise ValueError(f"{path}.category 只支持 variable 或 travel")
        if not re.fullmatch(r"[A-Z]{2,6}", currency):
            raise ValueError(f"{path}.currency 无效")
        seen.add(key)
        out.append({"key": key, "name": name, "category": category, "currency": currency})
    return out


def _normalize_locations(raw, *, variable: dict, travel: dict,
                         location_names: dict, currency_names: dict) -> list[dict]:
    by_key: dict[str, dict] = {}
    if raw is not None:
        if not isinstance(raw, list):
            raise ValueError("standards._locations 必须是数组")
        for index, item in enumerate(raw):
            path = f"standards._locations[{index}]"
            if not isinstance(item, dict):
                raise ValueError(f"{path} 必须是对象")
            key = str(item.get("key", "")).strip()
            name = str(item.get("name", key)).strip()
            category = str(item.get("category", "")).strip()
            currency = str(item.get("currency", "")).strip().upper()
            if not key or key in by_key:
                raise ValueError(f"{path}.key 为空或重复")
            if category not in ("variable", "travel"):
                raise ValueError(f"{path}.category 无效")
            if not re.fullmatch(r"[A-Z]{2,6}", currency):
                raise ValueError(f"{path}.currency 无效")
            by_key[key] = {
                "key": key,
                "name": name or key,
                "category": category,
                "currency": currency,
                "currency_name": str(item.get("currency_name") or currency_names.get(currency) or currency),
            }
    for category, standards in (("variable", variable), ("travel", travel)):
        for key, currency_values in standards.items():
            currency = next(iter(currency_values))
            expected = {
                "key": key,
                "name": location_names.get(key, key),
                "category": category,
                "currency": currency,
                "currency_name": currency_names.get(currency, currency),
            }
            current = by_key.get(key)
            if current and (current["category"] != category or current["currency"] != currency):
                raise ValueError(f"standards._locations.{key} 与预算标准不一致")
            by_key[key] = current or expected
    return list(by_key.values())


def normalize_month_standards(raw: dict | None) -> dict:
    """严格校验月份自有的每日/旅居标准快照。

    固定预算只由月份订阅汇总产生，额外预算固定为零，因此二者不进入月份
    标准实体，避免形成第二套可编辑金额来源。
    """
    if not isinstance(raw, dict):
        raise ValueError("month.standards 必须是完整对象")
    allowed = {
        "_snapshot", "variable", "travel", "custom_locations", "custom_currencies",
        "_locations", "_location_names", "_currency_names", "location_names", "currency_names",
    }
    unknown = set(raw) - allowed
    if unknown:
        raise ValueError(f"month.standards 包含未知字段：{', '.join(sorted(unknown))}")
    location_names = _normalize_name_map(
        raw.get("_location_names") or raw.get("location_names"),
        "standards._location_names",
    )
    currency_names = _normalize_name_map(
        raw.get("_currency_names") or raw.get("currency_names"),
        "standards._currency_names",
    )
    normalized = core_standards.normalize_defaults_payload({
        "variable": raw.get("variable"),
        "travel": raw.get("travel") or {},
        "fixed": {"Mainland": {"CNY": 0}, "Overseas": {"CNY": 0}},
        "extra": {"CNY": 0, "HKD": 0, "USD": 0},
        "location_names": location_names,
        "currency_names": currency_names,
    }, default_extra={"CNY": 0, "HKD": 0, "USD": 0})
    custom_locations = _normalize_custom_locations(raw.get("custom_locations"))
    custom_currencies = _normalize_name_map(
        raw.get("custom_currencies"), "standards.custom_currencies",
    )
    locations = _normalize_locations(
        raw.get("_locations"),
        variable=normalized["variable"],
        travel=normalized["travel"],
        location_names=normalized["location_names"],
        currency_names=normalized["currency_names"],
    )
    return {
        "_snapshot": True,
        "variable": normalized["variable"],
        "travel": normalized["travel"],
        "custom_locations": custom_locations,
        "custom_currencies": custom_currencies,
        "_locations": locations,
        "_location_names": normalized["location_names"],
        "_currency_names": normalized["currency_names"],
    }


def default_month_standards(defaults: dict | None = None) -> dict:
    # defaults.json 只保存用户自定义显示名；出厂中文名由 metadata 唯一维护。
    # 新月份快照必须把两者合并后冻结，否则首次使用内置地点会退化为英文 key。
    from application import metadata as app_metadata

    defaults = defaults or app_defaults.default_standards_snapshot()
    location_names = app_metadata.location_names(defaults["location_names"])
    currency_names = app_metadata.currency_names(defaults["currency_names"])
    locations = []
    for category in ("variable", "travel"):
        for key, values in defaults[category].items():
            currency = next(iter(values))
            locations.append({
                "key": key,
                "name": location_names.get(key, key),
                "category": category,
                "currency": currency,
                "currency_name": currency_names.get(currency, currency),
            })
    return normalize_month_standards({
        "_snapshot": True,
        "variable": defaults["variable"],
        "travel": defaults["travel"],
        "custom_locations": [],
        "custom_currencies": {},
        "_locations": locations,
        "_location_names": location_names,
        "_currency_names": currency_names,
    })


def normalize_itinerary(raw, month: str) -> dict:
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise ValueError("month.itinerary 必须是对象")
    expected_year, expected_month = map(int, month.split("-"))
    owners: dict[str, str] = {}
    out: dict[str, list[dict]] = {}
    for raw_location, raw_ranges in raw.items():
        location = str(raw_location).strip()
        if not location or len(location) > 120:
            raise ValueError("month.itinerary 包含无效地点")
        if not isinstance(raw_ranges, list):
            raise ValueError(f"month.itinerary.{location} 必须是数组")
        days: list[str] = []
        for index, raw_range in enumerate(raw_ranges):
            path = f"month.itinerary.{location}[{index}]"
            if not isinstance(raw_range, dict):
                raise ValueError(f"{path} 必须是对象")
            unknown = set(raw_range) - {"start", "end"}
            if unknown:
                raise ValueError(f"{path} 包含未知字段：{', '.join(sorted(unknown))}")
            start, end = raw_range.get("start"), raw_range.get("end")
            if not isinstance(start, str) or not isinstance(end, str):
                raise ValueError(f"{path} 缺少 start/end 日期")
            try:
                parsed_start = dt.date.fromisoformat(start)
                parsed_end = dt.date.fromisoformat(end)
            except ValueError as exc:
                raise ValueError(f"{path} 日期无效") from exc
            if parsed_start > parsed_end:
                raise ValueError(f"{path} 开始日期晚于结束日期")
            if ((parsed_start.year, parsed_start.month) != (expected_year, expected_month)
                    or (parsed_end.year, parsed_end.month) != (expected_year, expected_month)):
                raise ValueError(f"{path} 超出月份 {month}")
            days.extend(legacy._iter_days(start, end))
        unique_days = sorted(set(days))
        for day in unique_days:
            other = owners.get(day)
            if other is not None and other != location:
                raise ValueError(f"日期 {day} 同时分配给地点 {other} 与 {location}")
            owners[day] = location
        if unique_days:
            out[location] = legacy._ranges_from_days(unique_days)
    return out


def normalize_options(raw) -> dict:
    if raw is None:
        raw = {}
    if not isinstance(raw, dict):
        raise ValueError("month.options 必须是对象")
    unknown = set(raw) - {"region", "includeTravel", "travelSelected", "savedAt"}
    if unknown:
        raise ValueError(f"month.options 包含未知字段：{', '.join(sorted(unknown))}")
    region = raw.get("region", "Mainland")
    if region not in ("Mainland", "Overseas"):
        raise ValueError("month.options.region 只支持 Mainland 或 Overseas")
    include_travel = raw.get("includeTravel", False)
    if not isinstance(include_travel, bool):
        raise ValueError("month.options.includeTravel 必须是布尔值")
    selected = raw.get("travelSelected")
    if selected is not None:
        if not isinstance(selected, list):
            raise ValueError("month.options.travelSelected 必须是数组或 null")
        selected = list(dict.fromkeys(str(item).strip() for item in selected if str(item).strip()))
    out = {
        "region": region,
        "includeTravel": include_travel,
        "travelSelected": selected,
    }
    if isinstance(raw.get("savedAt"), str):
        out["savedAt"] = raw["savedAt"]
    return out


def normalize_subscriptions(raw, month: str) -> dict:
    normalized = legacy._normalize_subscriptions({month: raw or {"items": [], "retiredIds": []}})
    return normalized[month]


def normalize_result(raw, month: str):
    if raw is None:
        return None
    result = legacy._compact_results_map({month: raw})[month]
    input_revision = result.get("inputRevision")
    if input_revision is not None and (
            isinstance(input_revision, bool) or not isinstance(input_revision, int)
            or input_revision < 1):
        raise ValueError("month.result.inputRevision 必须是正整数")
    if "stale" in result and not isinstance(result["stale"], bool):
        raise ValueError("month.result.stale 必须是布尔值")
    if "staleReason" in result and result["staleReason"] is not None \
            and not isinstance(result["staleReason"], str):
        raise ValueError("month.result.staleReason 必须是字符串或 null")
    return result


def normalize_month_document(raw: dict, *, expected_month: str | None = None) -> dict:
    if not isinstance(raw, dict):
        raise ValueError("月份实体必须是对象")
    unknown = set(raw) - {
        "schemaVersion", "month", "createdAt", "createdFrom", "revision", "updatedAt",
        "itinerary", "options", "standards", "subscriptions", "result",
    }
    if unknown:
        raise ValueError(f"月份实体包含未知字段：{', '.join(sorted(unknown))}")
    schema = raw.get("schemaVersion")
    if schema != SCHEMA_VERSION:
        raise ValueError(f"月份实体 schemaVersion 必须是 {SCHEMA_VERSION}")
    month = _month_key(raw.get("month"), "month.month")
    if expected_month is not None and month != _month_key(expected_month):
        raise ValueError(f"月份实体标识 {month} 与文件名 {expected_month} 不一致")
    revision = raw.get("revision")
    if isinstance(revision, bool) or not isinstance(revision, int) or revision < 1:
        raise ValueError("月份实体 revision 必须是正整数")
    updated_at = raw.get("updatedAt")
    if not isinstance(updated_at, str) or not updated_at:
        raise ValueError("月份实体 updatedAt 必须是非空字符串")
    created_at = raw.get("createdAt")
    if not isinstance(created_at, str) or not created_at:
        raise ValueError("月份实体 createdAt 必须是非空字符串")
    created_from = raw.get("createdFrom")
    if not isinstance(created_from, dict) or set(created_from) != {"kind", "defaultsRevision"}:
        raise ValueError("月份实体 createdFrom 必须包含 kind 与 defaultsRevision")
    created_kind = created_from.get("kind")
    defaults_revision = created_from.get("defaultsRevision")
    if created_kind not in ("defaults", "migrated-v1"):
        raise ValueError("月份实体 createdFrom.kind 无效")
    if not isinstance(defaults_revision, str) or not re.fullmatch(r"[0-9a-f]{64}", defaults_revision):
        raise ValueError("月份实体 createdFrom.defaultsRevision 必须是 64 位 SHA-256")
    return {
        "schemaVersion": SCHEMA_VERSION,
        "month": month,
        "createdAt": created_at,
        "createdFrom": {
            "kind": created_kind,
            "defaultsRevision": defaults_revision,
        },
        "revision": revision,
        "updatedAt": updated_at,
        "itinerary": normalize_itinerary(raw.get("itinerary"), month),
        "options": normalize_options(raw.get("options")),
        "standards": normalize_month_standards(raw.get("standards")),
        "subscriptions": normalize_subscriptions(raw.get("subscriptions"), month),
        "result": normalize_result(raw.get("result"), month),
    }


def _empty_global() -> dict:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "revision": 0,
        "updatedAt": None,
        "selectedMonth": None,
        "annualBudgetsByYear": {},
        "annualResultsByYear": {},
        "assetPortfoliosById": {},
    }


def normalize_global_document(raw: dict | None) -> dict:
    if raw is None:
        return _empty_global()
    if not isinstance(raw, dict):
        raise ValueError("global.json 顶层必须是对象")
    unknown = set(raw) - {
        "schemaVersion", "revision", "updatedAt", "selectedMonth",
        "annualBudgetsByYear", "annualResultsByYear", "assetPortfoliosById",
    }
    if unknown:
        raise ValueError(f"global.json 包含未知字段：{', '.join(sorted(unknown))}")
    if raw.get("schemaVersion") != SCHEMA_VERSION:
        raise ValueError(f"global.json schemaVersion 必须是 {SCHEMA_VERSION}")
    revision = raw.get("revision")
    if isinstance(revision, bool) or not isinstance(revision, int) or revision < 0:
        raise ValueError("global.json revision 必须是非负整数")
    updated_at = raw.get("updatedAt")
    if updated_at is not None and not isinstance(updated_at, str):
        raise ValueError("global.json updatedAt 必须是字符串或 null")
    selected = raw.get("selectedMonth")
    if selected is not None:
        selected = _month_key(selected, "global.selectedMonth")
    return {
        "schemaVersion": SCHEMA_VERSION,
        "revision": revision,
        "updatedAt": updated_at,
        "selectedMonth": selected,
        "annualBudgetsByYear": legacy._normalize_annual_budgets(raw.get("annualBudgetsByYear")),
        "annualResultsByYear": legacy._compact_annual_results(raw.get("annualResultsByYear")),
        "assetPortfoliosById": legacy._normalize_asset_portfolios(raw.get("assetPortfoliosById")),
    }


def _read_month_unlocked(month: str) -> dict | None:
    path = _month_path(month)
    raw = storage.read_json_file(path, strict=True)
    return None if raw is None else normalize_month_document(raw, expected_month=month)


def load_month(month: str) -> dict | None:
    with legacy._state_disk_lock:
        return _read_month_unlocked(_month_key(month))


def _read_global_unlocked() -> dict:
    return normalize_global_document(storage.read_json_file(GLOBAL_STATE_FILE, strict=True))


def load_global() -> dict:
    with legacy._state_disk_lock:
        return _read_global_unlocked()


def scan_months() -> tuple[dict[str, dict], dict[str, str]]:
    """读取可用月份并单独报告损坏文件，避免一个坏月拖垮全部月份。"""
    with legacy._state_disk_lock:
        if not MONTHS_DIR.exists():
            return {}, {}
        out: dict[str, dict] = {}
        errors: dict[str, str] = {}
        for path in sorted(MONTHS_DIR.glob("*.json")):
            try:
                month = _month_key(path.stem, "月份文件名")
                if month in out:
                    raise ValueError(f"月份文件重复：{month}")
                raw = storage.read_json_file(path, strict=True)
                out[month] = normalize_month_document(raw, expected_month=month)
            except (OSError, ValueError) as exc:
                errors[path.name] = str(exc)
        return out, errors


def list_months() -> dict[str, dict]:
    months, errors = scan_months()
    if errors:
        detail = "；".join(f"{name}: {message}" for name, message in sorted(errors.items()))
        raise ValueError(f"月份实体校验失败：{detail}")
    return months


def _month_item_from_default(item: dict) -> dict:
    include = bool(item.get("includeByDefault", True))
    return {
        "id": str(item["id"]),
        "name": str(item["name"]),
        "currency": str(item["currency"]),
        "cycle": str(item["cycle"]),
        "amount": float(item["amount"]),
        "included": include,
        "includeByDefault": include,
        "appliesTo": app_contracts.normalize_subscription_applies_to(
            item.get("appliesTo"), f"默认订阅.{item['id']}.appliesTo",
        ),
    }


def _subscriptions_for_new_month(month: str, existing: dict[str, dict],
                                 defaults: dict | None = None) -> dict:
    previous_key = max((key for key in existing if key < month), default=None)
    previous = existing[previous_key]["subscriptions"] if previous_key else None
    defaults = defaults or app_defaults.default_standards_snapshot()
    configured = bool(defaults["subscriptions_configured"])
    catalog = defaults["subscriptions"] if configured else None
    retired = set(str(item) for item in ((previous or {}).get("retiredIds") or []))
    previous_items = (previous or {}).get("items") or []
    inherited: list[dict] = []
    if catalog is not None:
        by_id = {str(item["id"]): item for item in catalog}
        inherited_ids: set[str] = set()
        for old in previous_items:
            item_id = str(old["id"])
            default = by_id.get(item_id)
            if (item_id in retired or not old.get("includeByDefault") or default is None
                    or not default.get("includeByDefault")):
                retired.add(item_id)
                continue
            next_item = _month_item_from_default(default)
            next_item["included"] = True
            next_item["includeByDefault"] = True
            next_item["appliesTo"] = copy.deepcopy(old["appliesTo"])
            inherited.append(next_item)
            inherited_ids.add(item_id)
        for default in catalog:
            item_id = str(default["id"])
            if default.get("includeByDefault") and item_id not in inherited_ids and item_id not in retired:
                inherited.append(_month_item_from_default(default))
    else:
        for old in previous_items:
            item_id = str(old["id"])
            if item_id in retired or not old.get("includeByDefault"):
                retired.add(item_id)
                continue
            next_item = copy.deepcopy(old)
            next_item["included"] = True
            next_item["includeByDefault"] = True
            inherited.append(next_item)
    return normalize_subscriptions({"items": inherited, "retiredIds": sorted(retired)}, month)


def ensure_month(month: str, *, expected_defaults_revision: str | None = None) -> tuple[dict, bool]:
    month = _month_key(month)
    year, month_number = map(int, month.split("-"))
    app_contracts.validate_year_month(year, month_number)
    with legacy._state_disk_lock:
        existing = _read_month_unlocked(month)
        if existing is not None:
            return existing, False
        months = list_months()
        with app_defaults.defaults_disk_lock:
            if app_defaults.defaults_load_error():
                raise ValueError(
                    "data/defaults.json 已损坏；拒绝用出厂值静默建立新月份。"
                    "请先备份并显式恢复默认配置"
                )
            defaults = app_defaults.default_standards_snapshot()
            if (expected_defaults_revision is not None
                    and expected_defaults_revision != defaults["revision"]):
                raise app_defaults.DefaultsRevisionConflict(
                    "默认预算标准已在确认新增月份后发生变化；请刷新默认配置后重试"
                )
            created_at = _utc_now()
            document = normalize_month_document({
                "schemaVersion": SCHEMA_VERSION,
                "month": month,
                "createdAt": created_at,
                "createdFrom": {
                    "kind": "defaults",
                    "defaultsRevision": defaults["revision"],
                },
                "revision": 1,
                "updatedAt": created_at,
                "itinerary": {},
                "options": {"region": "Mainland", "includeTravel": False, "travelSelected": None},
                "standards": default_month_standards(defaults),
                "subscriptions": _subscriptions_for_new_month(month, months, defaults),
                "result": None,
            }, expected_month=month)
        storage.atomic_write_text(_month_path(month), _json_text(document))
        return document, True


def save_month(month: str, data: dict, *, base_revision: int) -> dict:
    month = _month_key(month)
    with legacy._state_disk_lock:
        current = _read_month_unlocked(month)
        if current is None:
            raise app_contracts.StateConflictError(
                f"月份 {month} 尚未建立；请先确认新增月份"
            )
        if current["revision"] != base_revision:
            raise app_contracts.StateConflictError(
                f"月份 {month} 已从修订 {base_revision} 更新为 {current['revision']}；本次旧实体未覆盖"
            )
        candidate = dict(data or {})
        candidate.update({
            "schemaVersion": SCHEMA_VERSION,
            "month": month,
            "createdAt": current["createdAt"],
            "createdFrom": copy.deepcopy(current["createdFrom"]),
            "revision": current["revision"] + 1,
            "updatedAt": _utc_now(),
        })
        document = normalize_month_document(candidate, expected_month=month)
        input_fields = ("itinerary", "options", "standards", "subscriptions")
        if any(document[field] != current[field] for field in input_fields) and document["result"]:
            # PUT 只能编辑月份输入或把旧结果标记过期；新鲜结果只允许由
            # calculate + save_month_result 在同一 revision CAS 中产生。
            document["result"] = copy.deepcopy(document["result"])
            document["result"]["stale"] = True
            document["result"]["staleReason"] = "月份输入已更新，请重新计算"
        storage.atomic_write_text(_month_path(month), _json_text(document))
        return document


def save_month_result(month: str, result: dict, *, base_revision: int) -> dict:
    month = _month_key(month)
    if not isinstance(result, dict):
        raise ValueError("月份计算结果必须是对象")
    with legacy._state_disk_lock:
        current = _read_month_unlocked(month)
        if current is None or current["revision"] != base_revision:
            actual = None if current is None else current["revision"]
            raise app_contracts.StateConflictError(
                f"月份 {month} 的计算输入已变化（期望修订 {base_revision}，当前 {actual}）；结果未保存"
            )
        candidate = copy.deepcopy(current)
        candidate["revision"] += 1
        candidate["updatedAt"] = _utc_now()
        candidate["result"] = copy.deepcopy(result)
        candidate["result"].update({
            "inputRevision": base_revision,
            "stale": False,
            "staleReason": None,
        })
        document = normalize_month_document(candidate, expected_month=month)
        storage.atomic_write_text(_month_path(month), _json_text(document))
        return document


def delete_month(month: str, *, base_revision: int) -> None:
    month = _month_key(month)
    with legacy._state_disk_lock:
        current = _read_month_unlocked(month)
        if current is None:
            return
        if current["revision"] != base_revision:
            raise app_contracts.StateConflictError(
                f"月份 {month} 已更新，删除请求未执行"
            )
        _month_path(month).unlink()


def save_global(data: dict, *, base_revision: int) -> dict:
    with legacy._state_disk_lock:
        current = _read_global_unlocked()
        if current["revision"] != base_revision:
            raise app_contracts.StateConflictError(
                f"全局数据已从修订 {base_revision} 更新为 {current['revision']}；本次旧实体未覆盖"
            )
        candidate = dict(data or {})
        candidate.update({
            "schemaVersion": SCHEMA_VERSION,
            "revision": current["revision"] + 1,
            "updatedAt": _utc_now(),
            # 选择不参与业务 CAS；慢业务写必须保留磁盘上的最新选择。
            "selectedMonth": current["selectedMonth"],
        })
        document = normalize_global_document(candidate)
        storage.atomic_write_text(GLOBAL_STATE_FILE, _json_text(document))
        return document


def save_selection(month: str | None) -> dict:
    selected = None if month is None else _month_key(month)
    with legacy._state_disk_lock:
        current = _read_global_unlocked()
        current["selectedMonth"] = selected
        current["updatedAt"] = _utc_now()
        document = normalize_global_document(current)
        storage.atomic_write_text(GLOBAL_STATE_FILE, _json_text(document))
        return document


def _strict_v1_itineraries(raw_v1: dict) -> dict[str, dict]:
    raw_map = raw_v1.get("itineraryByMonth")
    if raw_map is None:
        return {}
    if not isinstance(raw_map, dict):
        raise ValueError("app-state.itineraryByMonth 必须是对象")
    strict: dict[str, dict] = {}
    for raw_month, itinerary in raw_map.items():
        month = _month_key(raw_month, "itineraryByMonth")
        strict[month] = normalize_itinerary(itinerary, month)
    return strict


def _build_migration_documents(raw_v1: dict) -> tuple[dict[str, dict], dict, list[dict]]:
    if not isinstance(raw_v1, dict):
        raise ValueError("app-state 根节点必须是对象")
    unknown_top_level = set(raw_v1) - _V1_TOP_LEVEL_FIELDS
    if unknown_top_level:
        raise ValueError(
            "app-state 包含无法迁移的未知字段："
            + ", ".join(sorted(unknown_top_level))
        )
    if "version" in raw_v1:
        version = raw_v1["version"]
        if isinstance(version, bool) or not isinstance(version, int) or version != 1:
            raise ValueError("app-state.version 仅支持缺省或整数 1")
    strict_itineraries = _strict_v1_itineraries(raw_v1)
    old = legacy._normalize_app_state(raw_v1)
    # 旧读取器会按“最短区间优先”静默裁决跨地点重叠。迁移必须在裁决前
    # 严格拒绝，否则一次升级就会不可逆地改写用户原始行程。
    old["itineraryByMonth"] = strict_itineraries
    old["optionsByMonth"] = legacy._fill_options_from_results(
        old.get("optionsByMonth") or {}, old.get("resultsByMonth") or {},
    )
    keys: set[str] = set()
    for field in ("itineraryByMonth", "optionsByMonth", "overridesByMonth",
                  "resultsByMonth", "subscriptionsByMonth"):
        keys.update(old.get(field) or {})
    migrated_at = old.get("updatedAt") or "1970-01-01T00:00:00Z"
    migration_defaults = app_defaults.default_standards_snapshot()
    default_standards = default_month_standards(migration_defaults)
    months: dict[str, dict] = {}
    summaries: list[dict] = []
    source_maps = {
        field: (raw_v1.get(field) if isinstance(raw_v1.get(field), dict) else {})
        for field in ("itineraryByMonth", "optionsByMonth", "overridesByMonth",
                      "resultsByMonth", "subscriptionsByMonth")
    }
    for month in sorted(keys):
        standards = (old.get("overridesByMonth") or {}).get(month)
        raw_standards = source_maps["overridesByMonth"].get(month)
        retired_fields = sorted(
            field for field in ("fixed", "extra")
            if isinstance(raw_standards, dict) and field in raw_standards
        )
        standards_source = "migration-defaults"
        if standards:
            # 旧差异先相对迁移时默认标准合并，再固化为完整月份快照。
            if standards.get("_snapshot"):
                standards_source = "v1-snapshot"
                standards = normalize_month_standards(standards)
            else:
                standards_source = "v1-overlay-frozen-with-migration-defaults"
                merged = copy.deepcopy(default_standards)
                for category in ("variable", "travel"):
                    for key, values in (standards.get(category) or {}).items():
                        merged[category][key] = copy.deepcopy(values)
                merged["custom_locations"] = copy.deepcopy(standards.get("custom_locations") or [])
                merged["custom_currencies"] = copy.deepcopy(standards.get("custom_currencies") or {})
                standards = normalize_month_standards(merged)
        else:
            standards = copy.deepcopy(default_standards)
        document = normalize_month_document({
            "schemaVersion": SCHEMA_VERSION,
            "month": month,
            "createdAt": migrated_at,
            "createdFrom": {
                "kind": "migrated-v1",
                "defaultsRevision": migration_defaults["revision"],
            },
            "revision": 1,
            "updatedAt": migrated_at,
            "itinerary": (old.get("itineraryByMonth") or {}).get(month) or {},
            "options": (old.get("optionsByMonth") or {}).get(month) or {},
            "standards": standards,
            "subscriptions": (old.get("subscriptionsByMonth") or {}).get(month)
                or {"items": [], "retiredIds": []},
            "result": (old.get("resultsByMonth") or {}).get(month),
        }, expected_month=month)
        months[month] = document
        summaries.append({
            "month": month,
            "sourceFields": [
                field for field, values in source_maps.items() if month in values
            ],
            "standardsSource": standards_source,
            "optionsSource": (
                "v1-options" if month in source_maps["optionsByMonth"]
                else ("v1-result-fallback" if month in source_maps["resultsByMonth"] else "defaults")
            ),
            "retiredLegacyFields": retired_fields,
            "output": {
                "itineraryLocations": len(document["itinerary"]),
                "subscriptionItems": len(document["subscriptions"]["items"]),
                "hasResult": document["result"] is not None,
                "revision": document["revision"],
            },
        })
    selected = None
    if old.get("year") is not None and old.get("month") is not None:
        selected = f"{old['year']:04d}-{old['month']:02d}"
    global_document = normalize_global_document({
        "schemaVersion": SCHEMA_VERSION,
        "revision": 1,
        "updatedAt": migrated_at,
        "selectedMonth": selected,
        "annualBudgetsByYear": old.get("annualBudgetsByYear") or {},
        "annualResultsByYear": old.get("annualResultsByYear") or {},
        "assetPortfoliosById": old.get("assetPortfoliosById") or {},
    })
    return months, global_document, summaries


def _document_hash(document: dict) -> str:
    canonical = json.dumps(document, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return _sha256_bytes(canonical.encode("utf-8"))


def _migration_pending_path(source_hash: str) -> Path:
    return LEGACY_DATA_DIR / f"migration-v1-to-v2-{source_hash[:16]}.pending.json"


def _write_migration_pending(*, source_hash: str, months: dict[str, dict],
                             global_document: dict, month_summaries: list[dict],
                             backup: Path | None,
                             post_checkpoint: Path | None) -> Path:
    """发布 v2 前记录事务证据，并只允许补充后续阶段的检查点。"""
    LEGACY_DATA_DIR.mkdir(parents=True, exist_ok=True)
    path = _migration_pending_path(source_hash)
    document = {
        "schemaVersion": 1,
        "migration": "app-state-v1-to-month-entities-v2",
        "sourceHash": source_hash,
        "archive": f"app-state.v1-{source_hash[:16]}.json",
        "preMigrationBackup": str(backup) if backup is not None else None,
        "postMigrationCheckpoint": (
            str(post_checkpoint) if post_checkpoint is not None else None
        ),
        "globalSha256": _document_hash(global_document),
        "monthSha256": {
            month: _document_hash(document) for month, document in sorted(months.items())
        },
        "monthSummaries": month_summaries,
    }
    if path.exists():
        existing = storage.read_json_file(path, strict=True)
        invariant_fields = {
            "schemaVersion", "migration", "sourceHash", "archive",
            "globalSha256", "monthSha256", "monthSummaries",
        }
        if any(existing.get(field) != document.get(field) for field in invariant_fields):
            raise ValueError(f"迁移待完成证据冲突：{path}")
        for field in ("preMigrationBackup", "postMigrationCheckpoint"):
            old_value = existing.get(field)
            new_value = document.get(field)
            if old_value and new_value and old_value != new_value:
                if field != "postMigrationCheckpoint" or Path(old_value).is_dir():
                    raise ValueError(f"迁移待完成证据 {field} 冲突：{path}")
            document[field] = old_value or new_value
        if existing != document:
            storage.atomic_write_text(path, _json_text(document))
        return path
    storage.atomic_write_text(path, _json_text(document))
    return path


def _ensure_post_migration_checkpoint(*, source_hash: str, months: dict[str, dict],
                                      global_document: dict,
                                      month_summaries: list[dict],
                                      backup: Path | None) -> Path:
    """中断重试时复用已记录的 v2 检查点，避免生成冲突的待完成证据。"""
    pending_path = _write_migration_pending(
        source_hash=source_hash, months=months, global_document=global_document,
        month_summaries=month_summaries, backup=backup, post_checkpoint=None,
    )
    pending = storage.read_json_file(pending_path, strict=True)
    checkpoint_value = pending.get("postMigrationCheckpoint")
    if isinstance(checkpoint_value, str) and Path(checkpoint_value).is_dir():
        return Path(checkpoint_value)
    from application import backups as app_backups
    checkpoint = app_backups.create_data_backup(
        reason="post-v1-to-v2-migration",
        state_lock=legacy._state_disk_lock,
        defaults_lock=app_defaults.defaults_disk_lock,
    )
    _write_migration_pending(
        source_hash=source_hash, months=months, global_document=global_document,
        month_summaries=month_summaries, backup=backup,
        post_checkpoint=checkpoint,
    )
    return checkpoint


def _pending_pre_migration_backup(source_hash: str) -> Path | None:
    path = _migration_pending_path(source_hash)
    if not path.exists():
        return None
    pending = storage.read_json_file(path, strict=True)
    value = pending.get("preMigrationBackup")
    if value is None:
        return None
    if not isinstance(value, str) or not Path(value).is_dir():
        raise ValueError(f"迁移待完成证据的迁移前备份不存在：{path}")
    return Path(value)


def _archive_legacy(source_bytes: bytes, source_hash: str) -> Path:
    LEGACY_DATA_DIR.mkdir(parents=True, exist_ok=True)
    target = LEGACY_DATA_DIR / f"app-state.v1-{source_hash[:16]}.json"
    if APP_STATE_FILE.exists() and APP_STATE_FILE.read_bytes() != source_bytes:
        raise ValueError("v1 源文件在迁移期间发生变化；拒绝归档或删除")
    if target.exists():
        if target.read_bytes() != source_bytes:
            raise ValueError(f"旧状态归档冲突：{target}")
    else:
        if not APP_STATE_FILE.exists():
            raise ValueError("v1 源文件与旧状态归档均不存在；无法证明原始字节已保留")
        # 直接原子移动源文件，保留 BOM、换行和所有其它原始字节。
        os.replace(APP_STATE_FILE, target)
    if target.read_bytes() != source_bytes:
        raise ValueError(f"旧状态归档字节校验失败：{target}")
    if APP_STATE_FILE.exists():
        APP_STATE_FILE.unlink()
    return target


def _write_migration_report(*, source_hash: str, archive: Path,
                            months: dict[str, dict], global_document: dict,
                            month_summaries: list[dict], backup: Path | None,
                            post_checkpoint: Path | None) -> Path:
    LEGACY_DATA_DIR.mkdir(parents=True, exist_ok=True)
    report_path = LEGACY_DATA_DIR / f"migration-v1-to-v2-{source_hash[:16]}.json"
    report = {
        "schemaVersion": 1,
        "migration": "app-state-v1-to-month-entities-v2",
        "completedAt": _utc_now(),
        "source": {"path": "data/app-state.json", "sha256": source_hash},
        "archive": archive.name,
        "preMigrationBackup": str(backup) if backup is not None else None,
        "postMigrationCheckpoint": (
            str(post_checkpoint) if post_checkpoint is not None else None
        ),
        "global": {"path": "data/global.json", "sha256": _document_hash(global_document)},
        "months": [
            {
                **next(item for item in month_summaries if item["month"] == month),
                "path": f"data/months/{month}.json",
                "sha256": _document_hash(document),
            }
            for month, document in sorted(months.items())
        ],
        "unmigrated": [],
        "runtimeLegacyRead": False,
        "dualWrite": False,
    }
    if report_path.exists():
        existing = storage.read_json_file(report_path, strict=True)
        if existing and existing.get("source", {}).get("sha256") == source_hash:
            return report_path
        raise ValueError(f"迁移报告冲突：{report_path}")
    storage.atomic_write_text(report_path, _json_text(report))
    return report_path


def _finalize_migration_evidence(*, source_bytes: bytes, source_hash: str,
                                 months: dict[str, dict], global_document: dict,
                                 month_summaries: list[dict], backup: Path | None,
                                 post_checkpoint: Path) -> tuple[Path, Path]:
    pending = _write_migration_pending(
        source_hash=source_hash, months=months, global_document=global_document,
        month_summaries=month_summaries, backup=backup,
        post_checkpoint=post_checkpoint,
    )
    archive = _archive_legacy(source_bytes, source_hash)
    report = _write_migration_report(
        source_hash=source_hash, archive=archive, months=months,
        global_document=global_document, month_summaries=month_summaries,
        backup=backup, post_checkpoint=post_checkpoint,
    )
    pending.unlink(missing_ok=True)
    return archive, report


def _resume_pending_migration_report(*, months: dict[str, dict],
                                     global_document: dict) -> dict | None:
    """若进程在归档后、报告发布前退出，用待完成证据补齐报告。"""
    if not LEGACY_DATA_DIR.is_dir():
        return None
    pending_paths = sorted(LEGACY_DATA_DIR.glob("migration-v1-to-v2-*.pending.json"))
    if not pending_paths:
        return None
    if len(pending_paths) != 1:
        raise ValueError("发现多个待完成迁移证据；拒绝自动选择")
    pending_path = pending_paths[0]
    pending = storage.read_json_file(pending_path, strict=True)
    source_hash = pending.get("sourceHash")
    if not isinstance(source_hash, str) or not re.fullmatch(r"[0-9a-f]{64}", source_hash):
        raise ValueError(f"迁移待完成证据 sourceHash 无效：{pending_path}")
    expected_archive = f"app-state.v1-{source_hash[:16]}.json"
    if pending.get("archive") != expected_archive:
        raise ValueError(f"迁移待完成证据 archive 无效：{pending_path}")
    archive = LEGACY_DATA_DIR / expected_archive
    if not archive.is_file() or _sha256_bytes(archive.read_bytes()) != source_hash:
        raise ValueError("迁移待完成证据缺少匹配的原始 v1 归档")
    expected_month_hashes = pending.get("monthSha256")
    actual_month_hashes = {
        month: _document_hash(document) for month, document in sorted(months.items())
    }
    if expected_month_hashes != actual_month_hashes \
            or pending.get("globalSha256") != _document_hash(global_document):
        raise ValueError("当前 v2 与迁移待完成证据不一致；拒绝补写报告")
    summaries = pending.get("monthSummaries")
    if not isinstance(summaries, list) or len(summaries) != len(months):
        raise ValueError("迁移待完成证据缺少逐月来源摘要")
    post_checkpoint_value = pending.get("postMigrationCheckpoint")
    if not isinstance(post_checkpoint_value, str) or not post_checkpoint_value:
        raise ValueError("迁移待完成证据缺少迁移后检查点")
    post_checkpoint = Path(post_checkpoint_value)
    if not post_checkpoint.is_dir():
        from application import backups as app_backups
        post_checkpoint = app_backups.create_data_backup(
            reason="post-v1-to-v2-migration-recovery",
            state_lock=legacy._state_disk_lock,
            defaults_lock=app_defaults.defaults_disk_lock,
        )
    backup_value = pending.get("preMigrationBackup")
    backup = Path(backup_value) if isinstance(backup_value, str) and backup_value else None
    report = _write_migration_report(
        source_hash=source_hash, archive=archive, months=months,
        global_document=global_document, month_summaries=summaries,
        backup=backup, post_checkpoint=post_checkpoint,
    )
    pending_path.unlink(missing_ok=True)
    return {
        "migrated": False, "status": "report-completed",
        "report": str(report), "checkpoint": str(post_checkpoint),
    }


def validate_v2_store() -> tuple[dict[str, dict], dict]:
    months = list_months()
    global_document = load_global()
    if not GLOBAL_STATE_FILE.exists():
        raise ValueError("v2 存储缺少 data/global.json 完成标记")
    return months, global_document


def migrate_v1_to_v2() -> dict:
    """幂等执行一次性 v1 → v2 迁移；不会在普通 API 中读取 v1。"""
    with legacy._state_disk_lock:
        if GLOBAL_STATE_FILE.exists():
            global_document = load_global()
            months, month_errors = scan_months()
            if not APP_STATE_FILE.exists():
                resumed = _resume_pending_migration_report(
                    months=months, global_document=global_document,
                )
                if resumed is not None:
                    return resumed
                return {
                    "migrated": False,
                    "status": "v2-ready",
                    "months": len(months),
                    "monthErrors": month_errors,
                }
            if month_errors:
                raise ValueError("v2 月份文件损坏且 v1 尚未归档；拒绝结束迁移")
            if app_defaults.defaults_load_error():
                raise ValueError(
                    "data/defaults.json 已损坏；无法证明残留 v1 与已发布 v2 同源"
                )
            source_bytes = APP_STATE_FILE.read_bytes()
            source_hash = _sha256_bytes(source_bytes)
            raw_v1 = storage.read_json_file(APP_STATE_FILE, strict=True)
            expected_months, expected_global, month_summaries = _build_migration_documents(raw_v1)
            months_match = set(months) == set(expected_months) and all(
                _document_hash(months[key]) == _document_hash(expected_months[key])
                for key in expected_months
            )
            global_matches = _document_hash(global_document) == _document_hash(expected_global)
            if not months_match or not global_matches:
                raise ValueError(
                    "残留 v1 与已发布 v2 不一致；拒绝归档 v1。"
                    "请保留双方并从迁移报告或人工核对恢复"
                )
            backup = _pending_pre_migration_backup(source_hash)
            if backup is None:
                from application import backups as app_backups
                backup = app_backups.create_data_backup(
                    reason="resume-v1-to-v2-migration",
                    state_lock=legacy._state_disk_lock,
                    defaults_lock=app_defaults.defaults_disk_lock,
                    legacy_v1_only=True,
                )
            post_checkpoint = _ensure_post_migration_checkpoint(
                source_hash=source_hash, months=months,
                global_document=global_document,
                month_summaries=month_summaries, backup=backup,
            )
            _, report = _finalize_migration_evidence(
                source_bytes=source_bytes, source_hash=source_hash,
                months=months, global_document=global_document,
                month_summaries=month_summaries, backup=backup,
                post_checkpoint=post_checkpoint,
            )
            return {
                "migrated": False, "status": "archive-completed",
                "report": str(report), "checkpoint": str(post_checkpoint),
            }

        if not APP_STATE_FILE.exists():
            if MONTHS_DIR.exists() and any(MONTHS_DIR.iterdir()):
                raise ValueError("发现未完成的 v2 月份目录，但缺少 global.json 与 v1 源文件，无法安全恢复")
            return {"migrated": False, "status": "empty"}

        if app_defaults.defaults_load_error():
            raise ValueError(
                "data/defaults.json 已损坏；v1 → v2 迁移已中止，未用出厂值替代用户默认配置"
            )

        source_bytes = APP_STATE_FILE.read_bytes()
        source_hash = _sha256_bytes(source_bytes)
        raw_v1 = storage.read_json_file(APP_STATE_FILE, strict=True)
        months, global_document, month_summaries = _build_migration_documents(raw_v1)
        backup = _pending_pre_migration_backup(source_hash)

        # 若上次在发布月份目录后中断，只接受与本次确定性重建完全一致的目录。
        if MONTHS_DIR.exists():
            existing = list_months()
            if set(existing) != set(months) or any(
                    _document_hash(existing[key]) != _document_hash(months[key]) for key in months):
                raise ValueError("发现与 v1 源文件不一致的未完成月份迁移；拒绝覆盖")
            # 上次可能已原子发布 months/，但在发布 global.json 提交标记前中断。
            # v1 源文件仍在，故可再次备份并只发布确定性重建出的 global。
            if backup is None:
                from application import backups as app_backups
                backup = app_backups.create_data_backup(
                    reason="resume-v1-to-v2-migration",
                    state_lock=legacy._state_disk_lock,
                    defaults_lock=app_defaults.defaults_disk_lock,
                )
            _write_migration_pending(
                source_hash=source_hash, months=months,
                global_document=global_document, month_summaries=month_summaries,
                backup=backup, post_checkpoint=None,
            )
            storage.atomic_write_text(GLOBAL_STATE_FILE, _json_text(global_document))
            normalize_global_document(storage.read_json_file(GLOBAL_STATE_FILE, strict=True))
        else:
            if backup is None:
                from application import backups as app_backups
                backup = app_backups.create_data_backup(
                    reason="pre-v1-to-v2-migration",
                    state_lock=legacy._state_disk_lock,
                    defaults_lock=app_defaults.defaults_disk_lock,
                )
            _write_migration_pending(
                source_hash=source_hash, months=months,
                global_document=global_document, month_summaries=month_summaries,
                backup=backup, post_checkpoint=None,
            )
            staging = app_config.DATA_DIR / f".v2-migration-{uuid.uuid4().hex}"
            staging_months = staging / "months"
            staging_months.mkdir(parents=True, exist_ok=False)
            try:
                for month, document in months.items():
                    storage.atomic_write_text(staging_months / f"{month}.json", _json_text(document))
                    reread = storage.read_json_file(staging_months / f"{month}.json", strict=True)
                    normalize_month_document(reread, expected_month=month)
                storage.atomic_write_text(staging / "global.json", _json_text(global_document))
                normalize_global_document(storage.read_json_file(staging / "global.json", strict=True))
                os.replace(staging_months, MONTHS_DIR)
                # global.json 最后发布，是整个 v2 存储的提交标记。
                os.replace(staging / "global.json", GLOBAL_STATE_FILE)
            finally:
                if staging.exists():
                    shutil.rmtree(staging)
        verified_months, verified_global = validate_v2_store()
        if set(verified_months) != set(months):
            raise ValueError("v2 迁移发布后月份集合校验失败")
        post_checkpoint = _ensure_post_migration_checkpoint(
            source_hash=source_hash, months=verified_months,
            global_document=verified_global,
            month_summaries=month_summaries, backup=backup,
        )
        _, report = _finalize_migration_evidence(
            source_bytes=source_bytes, source_hash=source_hash,
            months=verified_months, global_document=verified_global,
            month_summaries=month_summaries, backup=backup,
            post_checkpoint=post_checkpoint,
        )
        return {
            "migrated": True, "status": "completed", "months": len(months),
            "report": str(report), "checkpoint": str(post_checkpoint),
        }


def clear_all(*, user_confirmed: bool, global_revision: int,
              month_revisions: dict[str, int]) -> dict:
    if user_confirmed is not True:
        raise ValueError("清空全部数据前必须取得用户明确确认")
    with legacy._state_disk_lock:
        current_global = _read_global_unlocked()
        current_months = list_months()
        normalized_revisions = {_month_key(key): value for key, value in month_revisions.items()}
        if current_global["revision"] != global_revision:
            raise app_contracts.StateConflictError("全局数据已更新，清空请求未执行")
        actual = {month: document["revision"] for month, document in current_months.items()}
        if actual != normalized_revisions:
            raise app_contracts.StateConflictError("月份数据已更新，清空请求未执行")
        from application import backups as app_backups
        backup = app_backups.create_data_backup(
            reason="pre-user-clear-all",
            state_lock=legacy._state_disk_lock,
            defaults_lock=app_defaults.defaults_disk_lock,
        )
        tombstone = app_config.DATA_DIR / f".cleared-{uuid.uuid4().hex}"
        tombstone.mkdir(parents=False, exist_ok=False)
        moved_months = False
        moved_global = False
        try:
            if MONTHS_DIR.exists():
                os.replace(MONTHS_DIR, tombstone / "months")
                moved_months = True
            if GLOBAL_STATE_FILE.exists():
                os.replace(GLOBAL_STATE_FILE, tombstone / "global.json")
                moved_global = True
        except Exception:
            if moved_global:
                os.replace(tombstone / "global.json", GLOBAL_STATE_FILE)
            if moved_months:
                os.replace(tombstone / "months", MONTHS_DIR)
            shutil.rmtree(tombstone, ignore_errors=True)
            raise
        shutil.rmtree(tombstone)
        return {"cleared": True, "backup": str(backup)}


def list_backups() -> dict:
    """在权威文件锁内列出可恢复快照及当前原始字节令牌。"""
    from application import backups as app_backups

    with legacy._state_disk_lock, app_defaults.defaults_disk_lock:
        return app_backups.list_data_backups()


def restore_backup(*, backup_id: str, base_token: str, user_confirmed: bool) -> dict:
    """显式恢复一个完整 v2 快照；先校验、再发布，且不读取备份参与计算。"""
    if user_confirmed is not True:
        raise ValueError("恢复备份前必须取得用户明确确认")
    if not isinstance(base_token, str) or not re.fullmatch(r"[0-9a-f]{64}", base_token):
        raise ValueError("恢复请求的当前数据令牌无效")

    from application import backups as app_backups

    defaults_file = app_config.DATA_DIR / "defaults.json"
    with legacy._state_disk_lock, app_defaults.defaults_disk_lock:
        if app_backups.current_data_token() != base_token:
            raise app_contracts.StateConflictError("权威数据已在备份列表打开后发生变化；请刷新列表后重试")

        snapshot = app_backups.load_restore_snapshot(backup_id)
        source_documents = snapshot["documents"]
        restored_months: dict[str, dict] = {}
        for relative, raw in source_documents.items():
            if not relative.startswith("data/months/"):
                continue
            month = Path(relative).stem
            restored_months[month] = normalize_month_document(raw, expected_month=month)
        restored_global = normalize_global_document(source_documents["data/global.json"])
        restored_defaults = None
        if "data/defaults.json" in source_documents:
            restored_defaults = app_defaults.normalize_defaults_document(
                source_documents["data/defaults.json"],
            )

        # 恢复也是一次新的权威写入。使用毫秒时间戳抬高 revision，确保所有
        # 仍持有恢复前基线的标签页都会 409，而不会碰巧覆盖恢复结果。
        revision_floor = int(dt.datetime.now(dt.timezone.utc).timestamp() * 1000)
        try:
            current_global_revision = _read_global_unlocked()["revision"]
        except (OSError, ValueError):
            current_global_revision = 0
        current_months, _ = scan_months()
        restored_at = _utc_now()
        for month, document in restored_months.items():
            current_revision = current_months.get(month, {}).get("revision", 0)
            document["revision"] = max(document["revision"], current_revision, revision_floor) + 1
            document["updatedAt"] = restored_at
            if document["result"] is not None:
                document["result"]["stale"] = True
                document["result"]["staleReason"] = "数据已从备份恢复，请重新计算以确认当前行情"
                document["result"]["inputRevision"] = document["revision"]
            restored_months[month] = normalize_month_document(document, expected_month=month)
        restored_global["revision"] = max(
            restored_global["revision"], current_global_revision, revision_floor,
        ) + 1
        restored_global["updatedAt"] = restored_at
        if restored_global["selectedMonth"] not in restored_months:
            restored_global["selectedMonth"] = None
        restored_global = normalize_global_document(restored_global)

        pre_restore_backup = None
        backup_validation_error = None
        try:
            pre_restore_backup = app_backups.create_data_backup(
                reason=f"pre-restore-{backup_id}",
                state_lock=legacy._state_disk_lock,
                defaults_lock=app_defaults.defaults_disk_lock,
            )
        except ValueError as exc:
            # 损坏的当前 JSON 正是恢复入口需要处理的场景；它不能冒充有效快照，
            # 但原始字节会在发布成功后移入 data/legacy/recovery-* 保存。
            backup_validation_error = str(exc)

        token = uuid.uuid4().hex
        staging = app_config.DATA_DIR / f".restore-{token}"
        staging_months = staging / "months"
        tombstone = app_config.DATA_DIR / f".restore-old-{token}"
        staging_months.mkdir(parents=True, exist_ok=False)
        tombstone.mkdir(parents=False, exist_ok=False)
        old_paths = (
            (MONTHS_DIR, tombstone / "months"),
            (GLOBAL_STATE_FILE, tombstone / "global.json"),
            (defaults_file, tombstone / "defaults.json"),
            (APP_STATE_FILE, tombstone / "app-state.json"),
        )
        moved_old: list[tuple[Path, Path]] = []
        published_months = False
        published_global = False
        published_defaults = False
        try:
            for month, document in sorted(restored_months.items()):
                storage.atomic_write_text(staging_months / f"{month}.json", _json_text(document))
            storage.atomic_write_text(staging / "global.json", _json_text(restored_global))
            if restored_defaults is not None:
                storage.atomic_write_text(staging / "defaults.json", _json_text(restored_defaults))

            for source, destination in old_paths:
                if source.exists():
                    os.replace(source, destination)
                    moved_old.append((source, destination))

            os.replace(staging_months, MONTHS_DIR)
            published_months = True
            if restored_defaults is not None:
                os.replace(staging / "defaults.json", defaults_file)
                published_defaults = True
            # global.json 最后发布，作为整套恢复完成标记。
            os.replace(staging / "global.json", GLOBAL_STATE_FILE)
            published_global = True
            validate_v2_store()
            if restored_defaults is None:
                app_defaults.restore_builtin_defaults()
            elif not app_defaults.load_saved_defaults():
                raise ValueError(app_defaults.defaults_load_error() or "恢复后的默认配置无法加载")
        except Exception:
            # 删除的都是本次 staging 发布物，随后把精确移动到 tombstone 的旧文件放回。
            if published_months and MONTHS_DIR.exists():
                shutil.rmtree(MONTHS_DIR)
            if published_global and GLOBAL_STATE_FILE.exists():
                GLOBAL_STATE_FILE.unlink()
            if published_defaults and defaults_file.exists():
                defaults_file.unlink()
            for original, saved_old in reversed(moved_old):
                if saved_old.exists():
                    os.replace(saved_old, original)
            if defaults_file.exists():
                app_defaults.load_saved_defaults()
            else:
                app_defaults.restore_builtin_defaults()
            shutil.rmtree(staging, ignore_errors=True)
            shutil.rmtree(tombstone, ignore_errors=True)
            raise

        shutil.rmtree(staging, ignore_errors=True)
        recovery_archive = None
        preserve_raw_old = backup_validation_error is not None or (tombstone / "app-state.json").exists()
        if not preserve_raw_old:
            shutil.rmtree(tombstone)
        else:
            LEGACY_DATA_DIR.mkdir(parents=True, exist_ok=True)
            recovery_archive = LEGACY_DATA_DIR / f"recovery-before-restore-{token}"
            os.replace(tombstone, recovery_archive)
        return {
            "restored": True,
            "backupId": backup_id,
            "months": len(restored_months),
            "preRestoreBackup": str(pre_restore_backup) if pre_restore_backup else None,
            "recoveryArchive": str(recovery_archive) if recovery_archive else None,
            "currentToken": app_backups.current_data_token(),
        }


def save_final_bundle(bundle: dict, *, allow_partial_conflicts: bool = True) -> dict:
    """保存关闭页附带的 v2 脏实体；冲突实体不会覆盖其它标签页。"""
    if not isinstance(bundle, dict) or bundle.get("schemaVersion") != SCHEMA_VERSION:
        raise ValueError("关闭页面状态必须是 schemaVersion=2 的实体包")
    conflicts: list[str] = []
    saved: list[str] = []
    global_write = bundle.get("global")
    if isinstance(global_write, dict):
        try:
            save_global(global_write.get("data") or {}, base_revision=global_write.get("base_revision"))
            saved.append("global")
        except app_contracts.StateConflictError:
            conflicts.append("global")
    for item in bundle.get("months") or []:
        if not isinstance(item, dict):
            raise ValueError("关闭页面 months 项必须是对象")
        month = _month_key(item.get("month"))
        try:
            save_month(month, item.get("data") or {}, base_revision=item.get("base_revision"))
            saved.append(month)
        except app_contracts.StateConflictError:
            conflicts.append(month)
    if conflicts and not allow_partial_conflicts:
        raise app_contracts.StateConflictError(f"关闭页面状态冲突：{', '.join(conflicts)}")
    return {"saved": saved, "conflicts": conflicts}


def api_get_months():
    months, errors = scan_months()
    return {"schemaVersion": SCHEMA_VERSION, "months": months, "errors": errors}


def api_get_month(month: str):
    document = load_month(month)
    if document is None:
        raise app_contracts.ResourceNotFoundError(f"月份 {_month_key(month)} 不存在")
    return document


def api_ensure_month(month: str, body: app_contracts.MonthEnsureIn):
    document, created = ensure_month(
        month, expected_defaults_revision=body.defaults_revision,
    )
    return {"created": created, "month": document}


def api_put_month(month: str, body: app_contracts.MonthStateWriteIn):
    payload = body.model_dump() if hasattr(body, "model_dump") else body.dict()
    return save_month(month, payload["data"], base_revision=payload["base_revision"])


def api_delete_month(month: str, body: app_contracts.MonthDeleteIn):
    delete_month(month, base_revision=body.base_revision)
    return {"deleted": True, "month": _month_key(month)}


def api_get_global():
    return load_global()


def api_put_global(body: app_contracts.GlobalStateWriteIn):
    payload = body.model_dump() if hasattr(body, "model_dump") else body.dict()
    return save_global(payload["data"], base_revision=payload["base_revision"])


def api_put_selection(body: app_contracts.MonthSelectionIn):
    return save_selection(body.month)


def api_clear_all(body: app_contracts.StateClearIn):
    payload = body.model_dump() if hasattr(body, "model_dump") else body.dict()
    return clear_all(**payload)


def api_list_backups():
    return list_backups()


def api_restore_backup(body: app_contracts.BackupRestoreIn):
    payload = body.model_dump() if hasattr(body, "model_dump") else body.dict()
    return restore_backup(**payload)


__all__ = [
    "SCHEMA_VERSION", "APP_STATE_FILE", "GLOBAL_STATE_FILE", "MONTHS_DIR", "LEGACY_DATA_DIR",
    "normalize_month_standards", "default_month_standards", "normalize_itinerary",
    "normalize_options", "normalize_subscriptions", "normalize_result",
    "normalize_month_document", "normalize_global_document", "load_month", "load_global",
    "scan_months", "list_months", "ensure_month", "save_month", "save_month_result", "delete_month",
    "save_global", "save_selection", "migrate_v1_to_v2", "validate_v2_store",
    "clear_all", "list_backups", "restore_backup", "save_final_bundle", "api_get_months", "api_get_month",
    "api_ensure_month", "api_put_month", "api_delete_month", "api_get_global",
    "api_put_global", "api_put_selection", "api_clear_all", "api_list_backups",
    "api_restore_backup",
]
