"""年度预算计算：各币种全年金额乘以该币种平均 Close。"""

import math
import re

from core.standards import validate_amount

def calculate_annual_budget(amounts, average_rates):
    """按“各币种全年金额 × 年初至截止日平均收盘汇率”计算人民币总额。

    ``average_rates`` 只接收上层根据实际交易日 Close 算出的算术平均；
    本函数不读取行情，便于用固定向量独立验证全年预算算法。
    """
    if not isinstance(amounts, dict):
        raise ValueError("全年预算金额必须是「币种: 金额」对象")
    if not isinstance(average_rates, dict):
        raise ValueError("年平均汇率必须是「币种: 汇率」对象")

    normalized_amounts = {}
    for raw_currency, raw_amount in amounts.items():
        currency = str(raw_currency).strip().upper()
        if not re.fullmatch(r"[A-Z]{2,6}", currency):
            raise ValueError(f"全年预算币种代码无效：{raw_currency}")
        if currency in normalized_amounts:
            raise ValueError(f"全年预算币种重复：{currency}")
        validate_amount(raw_amount, f"全年预算.{currency}")
        normalized_amounts[currency] = float(raw_amount)

    details = []
    total_cny = 0.0
    for currency, amount in sorted(normalized_amounts.items()):
        raw_rate = average_rates.get(currency)
        if raw_rate is None and amount == 0:
            average_rate = None
            cny_amount = 0.0
        else:
            if isinstance(raw_rate, bool) or not isinstance(raw_rate, (int, float)):
                raise ValueError(f"缺少 {currency} 的有效年平均收盘汇率")
            average_rate = float(raw_rate)
            if not math.isfinite(average_rate) or average_rate <= 0:
                raise ValueError(f"{currency} 的年平均收盘汇率必须是正有限数")
            raw_cny_amount = amount * average_rate
            if not math.isfinite(raw_cny_amount):
                raise ValueError(f"{currency} 的全年金额换算结果超出有限数范围")
            cny_amount = round(raw_cny_amount, 2)
        next_total = total_cny + cny_amount
        if not math.isfinite(next_total):
            raise ValueError("全年预算合计超出有限数范围")
        total_cny = next_total
        details.append({
            "currency": currency,
            "amount": amount,
            # 保留参与计算的真实均值；展示层可自行格式化小数位，避免已保存
            # 结果里的汇率与人民币金额无法互相复算。
            "average_rate": average_rate,
            "cny_amount": cny_amount,
        })
    return {
        "summary": {"全年预算合计(人民币)": round(total_cny, 2)},
        "details": details,
    }
