"""用户默认标准的读取、修订校验、原子保存及运行时快照。"""

from __future__ import annotations

import copy
import hashlib
import json
import math
import re
import threading

from application.config import DATA_DIR
from core.standards import builtin_standards_snapshot, normalize_defaults_payload
from core.standards import resolve_standards as _resolve_standards
from core.storage import atomic_write_text, read_json_file

_builtin = builtin_standards_snapshot()
_BUILTIN_VARIABLE_BUDGET_STANDARDS = _builtin["variable"]
_BUILTIN_FIXED_BUDGET_STANDARDS = _builtin["fixed"]
_BUILTIN_EXTRA_BUDGET_STANDARDS = _builtin["extra"]
_BUILTIN_TRAVEL_BUDGET_STANDARDS = _builtin["travel"]
VARIABLE_BUDGET_STANDARDS = copy.deepcopy(_BUILTIN_VARIABLE_BUDGET_STANDARDS)
FIXED_BUDGET_STANDARDS = copy.deepcopy(_BUILTIN_FIXED_BUDGET_STANDARDS)
EXTRA_BUDGET_STANDARDS = copy.deepcopy(_BUILTIN_EXTRA_BUDGET_STANDARDS)
TRAVEL_BUDGET_STANDARDS = copy.deepcopy(_BUILTIN_TRAVEL_BUDGET_STANDARDS)
ALL_BUDGET_LOCATIONS = {**VARIABLE_BUDGET_STANDARDS, **TRAVEL_BUDGET_STANDARDS}
_DEFAULTS_FILE = DATA_DIR / "defaults.json"
_DEFAULTS_LOCK = threading.RLock()
_SAVED_LOCATION_NAMES: dict[str, str] = {}
_SAVED_CURRENCY_NAMES: dict[str, str] = {}
_DEFAULT_SUBSCRIPTIONS: list[dict] = []
_SUBSCRIPTIONS_CONFIGURED = False
_DEFAULTS_LOADED_FROM_FILE = False
_DEFAULTS_LOAD_ERROR: str | None = None


class DefaultsRevisionConflict(Exception):
    """保存默认标准时，调用方读取的版本已被另一标签页更新。"""


def _replace_mapping(target: dict, source: dict) -> None:
    target.clear()
    target.update(copy.deepcopy(source))


def _refresh_all_budget_locations() -> None:
    ALL_BUDGET_LOCATIONS.clear()
    ALL_BUDGET_LOCATIONS.update({**VARIABLE_BUDGET_STANDARDS, **TRAVEL_BUDGET_STANDARDS})


def saved_location_names() -> dict[str, str]:
    with _DEFAULTS_LOCK:
        return dict(_SAVED_LOCATION_NAMES)


def saved_currency_names() -> dict[str, str]:
    with _DEFAULTS_LOCK:
        return dict(_SAVED_CURRENCY_NAMES)


def defaults_are_customized() -> bool:
    """只有用户默认值文件已成功校验并加载时才返回 True。

    单纯以文件存在为准会把损坏的 defaults.json 误报为“已自定义”。
    """
    with _DEFAULTS_LOCK:
        return _DEFAULTS_LOADED_FROM_FILE


def defaults_load_error() -> str | None:
    """返回启动时用户默认值文件的校验错误，供 Web 端明确提示。"""
    with _DEFAULTS_LOCK:
        return _DEFAULTS_LOAD_ERROR


def default_standards_snapshot() -> dict:
    """在同一把锁下返回当前默认标准及其元数据的完整快照。"""
    with _DEFAULTS_LOCK:
        snapshot = {
            "variable": copy.deepcopy(VARIABLE_BUDGET_STANDARDS),
            "fixed": copy.deepcopy(FIXED_BUDGET_STANDARDS),
            "extra": copy.deepcopy(EXTRA_BUDGET_STANDARDS),
            "travel": copy.deepcopy(TRAVEL_BUDGET_STANDARDS),
            "subscriptions": copy.deepcopy(_DEFAULT_SUBSCRIPTIONS),
            "subscriptions_configured": _SUBSCRIPTIONS_CONFIGURED,
            "location_names": dict(_SAVED_LOCATION_NAMES),
            "currency_names": dict(_SAVED_CURRENCY_NAMES),
            "customized": _DEFAULTS_LOADED_FROM_FILE,
            "load_error": _DEFAULTS_LOAD_ERROR,
        }
        revision_payload = {
            key: snapshot[key]
            for key in ("variable", "fixed", "extra", "travel", "subscriptions",
                        "subscriptions_configured",
                        "location_names", "currency_names")
        }
        snapshot["revision"] = hashlib.sha256(json.dumps(
            revision_payload,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")).hexdigest()
        return snapshot


def _read_defaults_file() -> dict | None:
    if not _DEFAULTS_FILE.exists():
        return None
    with _DEFAULTS_LOCK:
        return read_json_file(_DEFAULTS_FILE, strict=True)


def _write_defaults_file(data: dict) -> None:
    text = json.dumps(data, ensure_ascii=False, indent=2)
    with _DEFAULTS_LOCK:
        atomic_write_text(_DEFAULTS_FILE, text)


def _normalize_subscription_defaults(raw) -> list[dict]:
    """校验默认订阅目录；它属于应用默认配置，不参与底层预算公式。"""
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ValueError("默认订阅项目必须是数组")
    normalized = []
    seen_ids = set()
    for index, item in enumerate(raw):
        path = f"默认订阅[{index}]"
        if not isinstance(item, dict):
            raise ValueError(f"{path} 必须是对象")
        item_id = str(item.get("id", "")).strip()
        if not item_id or len(item_id) > 64 or not re.fullmatch(r"[A-Za-z0-9._:-]+", item_id):
            raise ValueError(f"{path}.id 必须是 1-64 位字母、数字或 ._:-")
        if item_id in seen_ids:
            raise ValueError(f"默认订阅项目 id 重复：{item_id}")
        seen_ids.add(item_id)
        name = str(item.get("name", "")).strip()
        if not name or len(name) > 120:
            raise ValueError(f"{path}.name 必须是 1-120 个字符")
        currency = str(item.get("currency", "")).strip().upper()
        if currency not in ("CNY", "HKD", "USD"):
            raise ValueError(f"{path}.currency 只支持 CNY、HKD、USD")
        cycle = str(item.get("cycle", "")).strip().lower()
        if cycle not in ("monthly", "yearly"):
            raise ValueError(f"{path}.cycle 只支持 monthly 或 yearly")
        amount = item.get("amount")
        if isinstance(amount, bool) or not isinstance(amount, (int, float)) \
                or not math.isfinite(float(amount)) or amount < 0:
            raise ValueError(f"{path}.amount 必须是非负有限数字")
        include_by_default = item.get("includeByDefault", True)
        if not isinstance(include_by_default, bool):
            raise ValueError(f"{path}.includeByDefault 必须是布尔值")
        normalized.append({
            "id": item_id,
            "name": name,
            "currency": currency,
            "cycle": cycle,
            "amount": float(amount),
            "includeByDefault": include_by_default,
        })
    return normalized


def _normalize_complete_defaults_payload(payload: dict) -> dict:
    normalized = normalize_defaults_payload(
        payload, default_extra=EXTRA_BUDGET_STANDARDS,
    )
    normalized["subscriptions"] = _normalize_subscription_defaults(
        payload.get("subscriptions") if isinstance(payload, dict) else None,
    )
    return normalized


def _apply_defaults_dict(data: dict, *, subscriptions_configured: bool | None = None) -> None:
    global _SUBSCRIPTIONS_CONFIGURED
    _replace_mapping(VARIABLE_BUDGET_STANDARDS, data["variable"])
    _replace_mapping(FIXED_BUDGET_STANDARDS, data["fixed"])
    _replace_mapping(EXTRA_BUDGET_STANDARDS, data["extra"])
    _replace_mapping(TRAVEL_BUDGET_STANDARDS, data["travel"])
    _SAVED_LOCATION_NAMES.clear()
    _SAVED_LOCATION_NAMES.update(data.get("location_names") or {})
    _SAVED_CURRENCY_NAMES.clear()
    _SAVED_CURRENCY_NAMES.update(data.get("currency_names") or {})
    _DEFAULT_SUBSCRIPTIONS.clear()
    _DEFAULT_SUBSCRIPTIONS.extend(copy.deepcopy(data.get("subscriptions") or []))
    _SUBSCRIPTIONS_CONFIGURED = (
        "subscriptions" in data if subscriptions_configured is None else bool(subscriptions_configured)
    )
    _refresh_all_budget_locations()


def save_default_standards(payload: dict, expected_revision: str | None = None) -> dict:
    """把完整标准快照校验后写入 data/defaults.json，并立即作为模块默认值生效。"""
    global _DEFAULTS_LOADED_FROM_FILE, _DEFAULTS_LOAD_ERROR
    with _DEFAULTS_LOCK:
        current_revision = default_standards_snapshot()["revision"]
        if expected_revision is not None and expected_revision != current_revision:
            raise DefaultsRevisionConflict(
                "服务器默认标准已被另一个标签页修改；请刷新页面后重新编辑"
            )
        normalized = _normalize_complete_defaults_payload(payload)
        _write_defaults_file(normalized)
        _apply_defaults_dict(normalized, subscriptions_configured=True)
        _DEFAULTS_LOADED_FROM_FILE = True
        _DEFAULTS_LOAD_ERROR = None
        return normalized


def restore_builtin_defaults(expected_revision: str | None = None) -> None:
    """删除已保存的默认标准文件，恢复 core.standards.builtin 内建值。"""
    global _DEFAULTS_LOADED_FROM_FILE, _DEFAULTS_LOAD_ERROR, _SUBSCRIPTIONS_CONFIGURED
    with _DEFAULTS_LOCK:
        current_revision = default_standards_snapshot()["revision"]
        if expected_revision is not None and expected_revision != current_revision:
            raise DefaultsRevisionConflict(
                "服务器默认标准已被另一个标签页修改；请刷新页面后再恢复出厂默认"
            )
        if _DEFAULTS_FILE.exists():
            try:
                _DEFAULTS_FILE.unlink()
            except OSError as exc:
                raise ValueError(f"删除默认标准文件失败：{exc}") from exc
        _replace_mapping(VARIABLE_BUDGET_STANDARDS, _BUILTIN_VARIABLE_BUDGET_STANDARDS)
        _replace_mapping(FIXED_BUDGET_STANDARDS, _BUILTIN_FIXED_BUDGET_STANDARDS)
        _replace_mapping(EXTRA_BUDGET_STANDARDS, _BUILTIN_EXTRA_BUDGET_STANDARDS)
        _replace_mapping(TRAVEL_BUDGET_STANDARDS, _BUILTIN_TRAVEL_BUDGET_STANDARDS)
        _SAVED_LOCATION_NAMES.clear()
        _SAVED_CURRENCY_NAMES.clear()
        _DEFAULT_SUBSCRIPTIONS.clear()
        _SUBSCRIPTIONS_CONFIGURED = False
        _refresh_all_budget_locations()
        _DEFAULTS_LOADED_FROM_FILE = False
        _DEFAULTS_LOAD_ERROR = None


def load_saved_defaults() -> bool:
    """启动时校验并加载 data/defaults.json；损坏时保留出厂值并记录错误。"""
    global _DEFAULTS_LOADED_FROM_FILE, _DEFAULTS_LOAD_ERROR
    with _DEFAULTS_LOCK:
        try:
            data = _read_defaults_file()
        except ValueError as exc:
            _DEFAULTS_LOADED_FROM_FILE = False
            _DEFAULTS_LOAD_ERROR = str(exc)
            return False
        if not data:
            _DEFAULTS_LOADED_FROM_FILE = False
            _DEFAULTS_LOAD_ERROR = None
            return False
        try:
            configured = "subscriptions" in data
            normalized = _normalize_complete_defaults_payload(data)
        except ValueError as exc:
            _DEFAULTS_LOADED_FROM_FILE = False
            _DEFAULTS_LOAD_ERROR = f"默认预算标准校验失败：{exc}"
            return False
        _apply_defaults_dict(normalized, subscriptions_configured=configured)
        _DEFAULTS_LOADED_FROM_FILE = True
        _DEFAULTS_LOAD_ERROR = None
        return True



def resolve_standards(overrides=None):
    """从同一版本的默认值快照调用底层纯解析器。"""
    return _resolve_standards(overrides, defaults_snapshot=default_standards_snapshot())


# 应用模块初始化只读取用户默认值；校验失败时保留出厂值并记录错误。
load_saved_defaults()
