"""默认预算标准及展示元数据用例。"""

from __future__ import annotations

import re
from application import contracts as app_contracts
from application import defaults as app_defaults


LOCATION_NAMES = {
    "Shenzhen": "深圳", "Hong_Kong": "香港", "Chengdu": "成都",
    "Shanghai": "上海", "Taipei": "台北", "Bangkok": "曼谷",
    "Extra": "额外预算",
}



REGION_NAMES = {"Mainland": "内地", "Overseas": "境外"}



CURRENCY_NAMES = {
    "CNY": "人民币", "HKD": "港币", "USD": "美元",
    "TWD": "新台币", "THB": "泰铢",
}


CURRENCY_PRIORITY = ("CNY", "HKD", "USD")


def _currency_sort_key(currency: str) -> tuple[int, str]:
    code = str(currency).strip().upper()
    try:
        return CURRENCY_PRIORITY.index(code), code
    except ValueError:
        return len(CURRENCY_PRIORITY), code


def _sort_currencies(currencies) -> list[str]:
    """CNY, HKD, USD first; remaining ISO-like codes alphabetically."""
    return sorted({str(currency).strip().upper() for currency in currencies}, key=_currency_sort_key)



def _all_currencies(defaults_snapshot: dict | None = None) -> list[str]:
    """当前生效默认标准涉及的全部币种（按统一展示顺序）。"""
    snapshot = defaults_snapshot or app_defaults.default_standards_snapshot()
    curr = set(snapshot["extra"].keys())
    for std in (snapshot["variable"], snapshot["fixed"]):
        for inner in std.values():
            curr.update(inner.keys())
    # 旅居标准结构为 {地点: {币种: {"daily":.., "once":..}}}，币种名在最内层字典的键
    for inner in snapshot["travel"].values():
        curr.update(inner.keys())
    return _sort_currencies(curr)



def _location_names(saved_names: dict | None = None) -> dict[str, str]:
    names = dict(LOCATION_NAMES)
    names.update(app_defaults.saved_location_names() if saved_names is None else saved_names)
    return names



def _currency_names(saved_names: dict | None = None) -> dict[str, str]:
    names = dict(CURRENCY_NAMES)
    names.update(app_defaults.saved_currency_names() if saved_names is None else saved_names)
    return names



def _meta_payload() -> dict:
    """当前生效的默认标准与展示元数据（含用户保存的地点/币种中文名）。"""
    defaults = app_defaults.default_standards_snapshot()
    loc_names = _location_names(defaults["location_names"])
    curr_names = _currency_names(defaults["currency_names"])
    locations = []
    for loc, std in defaults["variable"].items():
        curr = next(iter(std))
        locations.append({
            "key": loc, "name": loc_names.get(loc, loc), "category": "variable",
            "currency": curr, "currency_name": curr_names.get(curr, curr),
            "default": std[curr],
        })
    for loc, std in defaults["travel"].items():
        curr = next(iter(std))
        locations.append({
            "key": loc, "name": loc_names.get(loc, loc), "category": "travel",
            "currency": curr, "currency_name": curr_names.get(curr, curr),
            "daily": std[curr]["daily"], "once": std[curr]["once"],
        })
    regions = [
        {"key": r, "name": REGION_NAMES.get(r, r),
         "currencies": {c: curr_names.get(c, c) for c in _sort_currencies(std)}}
        for r, std in defaults["fixed"].items()
    ]
    warnings = []
    if defaults["load_error"]:
        warnings.append(defaults["load_error"])
    return {
        "default_standards": {
            "variable": defaults["variable"],
            "fixed": defaults["fixed"],
            "travel": defaults["travel"],
            "extra": defaults["extra"],
        },
        "default_subscriptions": defaults["subscriptions"],
        "default_subscriptions_configured": defaults["subscriptions_configured"],
        "locations": locations,
        "regions": regions,
        "currencies": _all_currencies(defaults),
        "currency_priority": list(CURRENCY_PRIORITY),
        "currency_names": curr_names,
        "location_names": loc_names,
        "defaults_customized": defaults["customized"],
        "defaults_revision": defaults["revision"],
        "warnings": warnings,
    }



def api_meta():
    """返回当前生效的默认预算标准、地点/区域元数据（前端据此渲染编辑界面）。"""
    return _meta_payload()



def api_save_defaults(body: app_contracts.DefaultsPayload):
    """把当前预算标准保存为服务器默认值（data/defaults.json），立即对后续月份生效。"""
    payload = body.model_dump() if hasattr(body, "model_dump") else body.dict()
    base_revision = payload.pop("base_revision")
    app_defaults.save_default_standards(payload, expected_revision=base_revision)
    return _meta_payload()



def api_reset_defaults(body: app_contracts.DefaultsResetIn):
    """删除 data/defaults.json，恢复 core/standards/builtin.py 出厂默认标准。"""
    app_defaults.restore_builtin_defaults(expected_revision=body.base_revision)
    return _meta_payload()



def _parse_currencies(currencies: str | None) -> list[str]:
    if currencies is None:
        return _all_currencies()
    parts = [c.strip().upper() for c in currencies.split(",") if c.strip()]
    # 支持自定义币种（新建预算标准产生）：仅校验格式，实际可下载性由 Yahoo 决定
    bad = [c for c in parts if not re.fullmatch(r"[A-Z]{2,6}", c)]
    if bad:
        raise ValueError(f"币种代码无效：{', '.join(bad)}（应为 2-6 位字母，如 EUR）")
    # 去重且保持稳定顺序
    return _sort_currencies(parts)
