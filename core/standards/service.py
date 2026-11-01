"""纯标准校验与覆盖合并；每次调用显式接收默认标准快照。"""

import math
import re

def normalize_defaults_payload(payload: dict, *, default_extra: dict) -> dict:
    """校验并规范化「保存为默认」的完整标准快照。"""
    if not isinstance(payload, dict):
        raise ValueError("默认标准必须是对象")

    def _one_currency_amount(holder, path):
        if not isinstance(holder, dict) or len(holder) != 1:
            raise ValueError(f"{path} 必须是「单一币种: 金额」对象")
        curr = next(iter(holder))
        if not isinstance(curr, str) or not re.fullmatch(r"[A-Z]{2,6}", curr):
            raise ValueError(f"{path} 币种代码无效：{curr}")
        validate_amount(holder[curr], f"{path}.{curr}")
        return {curr: float(holder[curr])}

    variable_in = payload.get("variable")
    if not isinstance(variable_in, dict) or not variable_in:
        raise ValueError("可变预算至少需要一个定居地点")
    variable = {}
    for loc, std in variable_in.items():
        loc_key = str(loc).strip()
        if not loc_key:
            raise ValueError("可变预算地点名称不能为空")
        variable[loc_key] = _one_currency_amount(std, f"可变预算.{loc_key}")

    fixed_in = payload.get("fixed")
    if not isinstance(fixed_in, dict):
        raise ValueError("固定预算必须是对象")
    fixed = {}
    for region in ("Mainland", "Overseas"):
        if region not in fixed_in or not isinstance(fixed_in[region], dict) or not fixed_in[region]:
            raise ValueError(f"固定预算缺少区域 {region} 的币种金额")
        region_std = {}
        for curr, amount in fixed_in[region].items():
            if not isinstance(curr, str) or not re.fullmatch(r"[A-Z]{2,6}", curr):
                raise ValueError(f"固定预算.{region} 币种代码无效：{curr}")
            validate_amount(amount, f"固定预算.{region}.{curr}")
            region_std[curr] = float(amount)
        fixed[region] = region_std
    extra_in = payload.get("extra") or {}
    if not isinstance(extra_in, dict):
        raise ValueError("额外预算必须是对象")
    extra = {}
    for curr in ("CNY", "USD", "HKD"):
        amount = extra_in[curr] if curr in extra_in else default_extra.get(curr, 0)
        validate_amount(amount, f"额外预算.{curr}")
        extra[curr] = float(amount)

    travel_in = payload.get("travel") or {}
    if not isinstance(travel_in, dict):
        raise ValueError("旅居预算必须是对象")
    travel = {}
    for loc, std in travel_in.items():
        loc_key = str(loc).strip()
        if not loc_key:
            raise ValueError("旅居预算地点名称不能为空")
        if not isinstance(std, dict) or len(std) != 1:
            raise ValueError(f"旅居预算.{loc_key} 必须是「单一币种: {{daily, once}}」对象")
        curr = next(iter(std))
        if not isinstance(curr, str) or not re.fullmatch(r"[A-Z]{2,6}", curr):
            raise ValueError(f"旅居预算.{loc_key} 币种代码无效：{curr}")
        sub = std[curr]
        if not isinstance(sub, dict) or "daily" not in sub or "once" not in sub:
            raise ValueError(f"旅居预算.{loc_key} 需同时提供 daily 与 once")
        validate_amount(sub["daily"], f"旅居预算.{loc_key}.{curr}.daily")
        validate_amount(sub["once"], f"旅居预算.{loc_key}.{curr}.once")
        travel[loc_key] = {curr: {"daily": float(sub["daily"]), "once": float(sub["once"])}}

    overlap = sorted(set(variable).intersection(travel))
    if overlap:
        raise ValueError(f"定居与旅居地点不能使用同一标识：{', '.join(overlap)}")

    def _name_map(raw, label):
        raw = raw or {}
        if not isinstance(raw, dict):
            raise ValueError(f"{label} 必须是对象")
        out = {}
        for key, name in raw.items():
            k, n = str(key).strip(), str(name).strip()
            if k and n:
                out[k] = n
        return out

    return {
        "variable": variable,
        "fixed": fixed,
        "extra": extra,
        "travel": travel,
        "location_names": _name_map(payload.get("location_names"), "location_names"),
        "currency_names": _name_map(payload.get("currency_names"), "currency_names"),
    }


def validate_amount(value, path):
    """校验预算标准金额为非负有限数字，否则抛出带定位路径的 ValueError。"""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"预算标准 {path} 必须是数字，当前为 {value!r}")
    if not math.isfinite(float(value)) or value < 0:
        raise ValueError(f"预算标准 {path} 必须是非负有限数字，当前为 {value!r}")


def _parse_custom_locations(raw, defaults_snapshot):
    """校验并规范化「新建预算标准」中的自定义地点列表。

    结构：[{key, name, category(variable|travel), currency}]。
    返回 {key: {name, category, currency}}；任何一项非法即抛 ValueError。
    """
    customs = {}
    if not raw:
        return customs
    if not isinstance(raw, list):
        raise ValueError("custom_locations 必须是列表")
    for item in raw:
        if not isinstance(item, dict):
            raise ValueError("自定义地点格式错误")
        key = str(item.get("key", "")).strip()
        name = str(item.get("name", "")).strip()
        category = str(item.get("category", "")).strip()
        currency = str(item.get("currency", "")).strip().upper()
        if not key or not name:
            raise ValueError(f"自定义地点缺少名称：{item}")
        if category not in ("variable", "travel"):
            raise ValueError(f"自定义地点类别无效：{category}（应为 variable/travel）")
        if not re.fullmatch(r"[A-Z]{2,6}", currency):
            raise ValueError(f"币种代码无效：{currency}（应为 2-6 位字母，如 EUR）")
        if key in defaults_snapshot["variable"] or key in defaults_snapshot["travel"]:
            # 该地点已被保存为默认标准时，忽略过期的 custom_locations 记录
            continue
        if key in customs:
            raise ValueError(f"自定义地点重复：{key}")
        customs[key] = {"name": name, "category": category, "currency": currency}
    return customs


def _build_location_registry(customs, defaults_snapshot):
    """构建地点注册表 {loc: {type: variable|travel, currency}}（默认 + 自定义）。"""
    registry = {}
    for loc, currency_std in defaults_snapshot["variable"].items():
        registry[loc] = {"type": "variable", "currency": next(iter(currency_std))}
    for loc, currency_std in defaults_snapshot["travel"].items():
        registry[loc] = {"type": "travel", "currency": next(iter(currency_std))}
    for key, meta in customs.items():
        registry[key] = {"type": meta["category"], "currency": meta["currency"]}
    return registry


def resolve_standards(overrides=None, *, defaults_snapshot):
    """将「本次计算」的覆盖标准合并到默认标准。

    返回 5 元组：(variable, fixed, travel, location_registry, extra)。
    - 覆盖仅作用于单次计算；本函数不修改传入的默认标准快照。
    - 支持通过 custom_locations 新建旅居/定居地点（自定义币种），
      以及通过 fixed 覆盖为某区域新增币种。
    - extra 为额外预算 {CNY/USD/HKD: 月额}，与固定预算同样每月只计算一次。
    - 未知地点 / 非法金额 / 非法币种时抛出 ValueError，由调用方转成 400 响应。
    """
    overrides = overrides or {}
    if overrides.get("_snapshot"):
        snapshot = normalize_defaults_payload({
            "variable": overrides.get("variable"),
            "fixed": overrides.get("fixed"),
            "travel": overrides.get("travel"),
            "extra": overrides.get("extra"),
            "location_names": overrides.get("_location_names") or {},
            "currency_names": overrides.get("_currency_names") or {},
        }, default_extra=defaults_snapshot["extra"])
        variable = snapshot["variable"]
        fixed = snapshot["fixed"]
        travel = snapshot["travel"]
        extra = snapshot["extra"]
        registry = {}
        for loc, currency_std in variable.items():
            registry[loc] = {"type": "variable", "currency": next(iter(currency_std))}
        for loc, currency_std in travel.items():
            registry[loc] = {"type": "travel", "currency": next(iter(currency_std))}
        return variable, fixed, travel, registry, extra

    customs = _parse_custom_locations(overrides.get("custom_locations"), defaults_snapshot)
    variable = _merge_variable_standards(overrides.get("variable"), customs, defaults_snapshot)
    fixed = _merge_fixed_standards(overrides.get("fixed"), defaults_snapshot)
    travel = _merge_travel_standards(overrides.get("travel"), customs, defaults_snapshot)
    extra = _merge_extra_standards(overrides.get("extra"), defaults_snapshot)
    registry = _build_location_registry(customs, defaults_snapshot)
    return variable, fixed, travel, registry, extra


def _merge_variable_standards(override, customs, defaults_snapshot):
    if override is None:
        override = {}
    if not isinstance(override, dict):
        raise ValueError("可变预算覆盖必须是字典")
    merged = {}
    # 默认定居地点
    for loc, currency_std in defaults_snapshot["variable"].items():
        curr = next(iter(currency_std))
        amount = currency_std[curr]
        if loc in override:
            ov = override[loc]
            if not isinstance(ov, dict) or curr not in ov:
                raise ValueError(f"可变预算覆盖 '{loc}' 缺少币种 {curr} 的金额")
            amount = ov[curr]
        validate_amount(amount, f"可变预算.{loc}.{curr}")
        merged[loc] = {curr: float(amount)}
    # 自定义定居地点（金额必须由覆盖提供）
    for loc, meta in customs.items():
        if meta["category"] != "variable":
            continue
        curr = meta["currency"]
        if loc not in override or not isinstance(override[loc], dict) or curr not in override[loc]:
            raise ValueError(f"新增定居地点 '{loc}' 缺少每日预算金额")
        validate_amount(override[loc][curr], f"可变预算.{loc}.{curr}")
        merged[loc] = {curr: float(override[loc][curr])}
    # 覆盖中出现、既非默认也非自定义的地点 → 提示先新建
    for loc in override:
        if loc not in merged:
            raise ValueError(f"未知的可变预算地点：{loc}（可先在页面「新建预算标准」中添加）")
    return merged


def _merge_fixed_standards(override, defaults_snapshot):
    if override is None:
        override = {}
    if not isinstance(override, dict):
        raise ValueError("固定预算覆盖必须是字典")
    merged = {}
    for region, currency_std in defaults_snapshot["fixed"].items():
        merged_region = {}
        for curr, amount in currency_std.items():
            if region in override and isinstance(override[region], dict) and curr in override[region]:
                amount = override[region][curr]
            validate_amount(amount, f"固定预算.{region}.{curr}")
            merged_region[curr] = float(amount)
        # 该区域新增的自定义币种
        if region in override and isinstance(override[region], dict):
            for curr, amount in override[region].items():
                if curr in merged_region:
                    continue
                if not isinstance(curr, str) or not re.fullmatch(r"[A-Z]{2,6}", curr):
                    raise ValueError(f"固定预算币种代码无效：{curr}（应为 2-6 位字母）")
                validate_amount(amount, f"固定预算.{region}.{curr}")
                merged_region[curr] = float(amount)
        merged[region] = merged_region
    for region in override:
        if region not in merged:
            raise ValueError(f"未知的固定预算区域：{region}")
    return merged


def _merge_extra_standards(override, defaults_snapshot):
    """合并额外预算覆盖。仅允许 CNY / HKD / USD 三个币种。"""
    override = override or {}
    if not isinstance(override, dict):
        raise ValueError("额外预算覆盖必须是字典")
    merged = {}
    for curr, amount in defaults_snapshot["extra"].items():
        if curr in override:
            amount = override[curr]
        validate_amount(amount, f"额外预算.{curr}")
        merged[curr] = float(amount)
    for curr in override:
        if curr not in merged:
            raise ValueError(f"未知的额外预算币种：{curr}（仅支持 CNY / HKD / USD）")
    return merged


def _merge_travel_standards(override, customs, defaults_snapshot):
    if override is None:
        override = {}
    if not isinstance(override, dict):
        raise ValueError("旅居预算覆盖必须是字典")
    merged = {}
    # 默认旅居地点
    for loc, currency_std in defaults_snapshot["travel"].items():
        curr = next(iter(currency_std))
        daily = currency_std[curr]["daily"]
        once = currency_std[curr]["once"]
        if loc in override:
            ov = override[loc]
            if not isinstance(ov, dict) or curr not in ov:
                raise ValueError(f"旅居预算覆盖 '{loc}' 缺少币种 {curr} 的金额")
            sub = ov[curr]
            if not isinstance(sub, dict) or "daily" not in sub or "once" not in sub:
                raise ValueError(f"旅居预算覆盖 '{loc}' 需同时提供 daily 与 once 金额")
            daily = sub["daily"]
            once = sub["once"]
        validate_amount(daily, f"旅居预算.{loc}.{curr}.daily")
        validate_amount(once, f"旅居预算.{loc}.{curr}.once")
        merged[loc] = {curr: {"daily": float(daily), "once": float(once)}}
    # 自定义旅居地点
    for loc, meta in customs.items():
        if meta["category"] != "travel":
            continue
        curr = meta["currency"]
        if loc not in override or not isinstance(override[loc], dict) or curr not in override[loc]:
            raise ValueError(f"新增旅居地点 '{loc}' 缺少预算金额")
        sub = override[loc][curr]
        if not isinstance(sub, dict) or "daily" not in sub or "once" not in sub:
            raise ValueError(f"旅居预算覆盖 '{loc}' 需同时提供 daily 与 once 金额")
        validate_amount(sub["daily"], f"旅居预算.{loc}.{curr}.daily")
        validate_amount(sub["once"], f"旅居预算.{loc}.{curr}.once")
        merged[loc] = {curr: {"daily": float(sub["daily"]), "once": float(sub["once"])}}
    # 覆盖中出现、既非默认也非自定义的地点 → 提示先新建
    for loc in override:
        if loc not in merged:
            raise ValueError(f"未知的旅居预算地点：{loc}（可先在页面「新建预算标准」中添加）")
    return merged
