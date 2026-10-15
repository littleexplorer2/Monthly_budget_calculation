"""请求模型、应用错误与日期边界。"""

from __future__ import annotations

from pydantic import BaseModel
from pydantic import Field
from typing import Literal
import datetime as dt
import pandas as pd


class RateFetchError(Exception):
    """汇率拉取失败（网络/数据源问题），映射为 502。"""



class RepositoryUploadError(Exception):
    """数据提交或推送失败，向页面返回可操作的错误提示。"""



class StateConflictError(Exception):
    """另一个标签页已修改同一状态键；拒绝用旧基线覆盖。"""



def _month_bounds(year: int, month: int) -> tuple[str, str]:
    """返回该月首日 / 月末日（含）的 'YYYY-MM-DD' 字符串。"""
    first = pd.Timestamp(year=year, month=month, day=1)
    last = first + pd.offsets.MonthEnd(1)
    return first.strftime("%Y-%m-%d"), last.strftime("%Y-%m-%d")



def _validate_supported_year(year: int) -> None:
    if not (2000 <= year <= 2100):
        raise ValueError(f"年份超出支持范围：{year}（支持 2000-2100）")



def _validate_year_month(year: int, month: int) -> None:
    _validate_supported_year(year)
    if not (1 <= month <= 12):
        raise ValueError(f"月份无效：{month}（应为 1-12）")
    # 未来月份没有历史汇率数据，提前给出清晰提示
    today = dt.date.today()
    if (year, month) > (today.year, today.month):
        raise ValueError(f"{year}年{month}月是未来月份，尚无汇率数据，请选择当月或历史月份")



def _parse_ymd(text: str, location: str) -> dt.date:
    try:
        return dt.date.fromisoformat(text.strip())
    except (ValueError, AttributeError):
        raise ValueError(f"地点 {location} 的日期格式无效：{text!r}（应为 YYYY-MM-DD）")



def _annual_bounds(year: int) -> tuple[str, str]:
    """全年汇率区间：当年截至今日，历史年截至 12 月 31 日。"""
    today = dt.date.today()
    if not (2000 <= year <= today.year):
        if year > today.year:
            raise ValueError(f"{year}年是未来年份，尚无可用的收盘汇率")
        raise ValueError(f"年份超出支持范围：{year}（支持 2000-{today.year}）")
    end = today if year == today.year else dt.date(year, 12, 31)
    return dt.date(year, 1, 1).isoformat(), end.isoformat()



class RangeIn(BaseModel):
    start: str = Field(description="开始日期，YYYY-MM-DD")
    end: str = Field(description="结束日期，YYYY-MM-DD（含当日）")



class ItineraryEntryIn(BaseModel):
    location: str = Field(description="地点 key，如 Shenzhen")
    ranges: list[RangeIn] = Field(default_factory=list, description="该地点的日期区间列表")



class CalculateRequest(BaseModel):
    year: int = Field(ge=2000, le=2100, description="计算年份")
    month: int = Field(ge=1, le=12, description="计算月份")
    region: Literal["Mainland", "Overseas"] = Field(description="主要居住区域")
    itinerary: list[ItineraryEntryIn] = Field(min_length=1, description="行程（按地点索引）")
    standards_override: dict | None = Field(default=None, description="本次计算使用的预算标准覆盖")
    include_travel: bool = Field(default=False, description="是否包含旅居预算")
    travel_locations: list[str] | None = Field(default=None, description="勾选包含旅居时生效的旅居地点列表；null=全部，[]=不包含任何旅居地点")



class AnnualBudgetRequest(BaseModel):
    year: int = Field(ge=2000, le=2100, description="全年预算年份")
    amounts: dict = Field(default_factory=dict, description="各币种全年当地金额")



class DefaultsPayload(BaseModel):
    base_revision: str = Field(min_length=64, max_length=64)
    variable: dict
    fixed: dict
    extra: dict = Field(default_factory=dict)
    travel: dict = Field(default_factory=dict)
    location_names: dict[str, str] = Field(default_factory=dict)
    currency_names: dict[str, str] = Field(default_factory=dict)



class DefaultsResetIn(BaseModel):
    base_revision: str = Field(min_length=64, max_length=64)



class AppStateIn(BaseModel):
    version: int | None = 1
    updatedAt: str | None = None
    year: int | None = None
    month: int | None = None
    itineraryByMonth: dict = Field(default_factory=dict)
    optionsByMonth: dict = Field(default_factory=dict)
    overridesByMonth: dict = Field(default_factory=dict)
    resultsByMonth: dict = Field(default_factory=dict)
    annualBudgetsByYear: dict = Field(default_factory=dict)
    annualResultsByYear: dict = Field(default_factory=dict)
    baseValues: dict | None = Field(
        default=None,
        description="本次实际修改键的读取基线，用于阻止旧标签页覆盖并发更新",
    )
    tabId: str | None = Field(
        default=None, min_length=1, max_length=64,
        description="发起状态写入的浏览器标签页标识；与 sequence 成对提交",
    )
    sequence: int | None = Field(
        default=None, ge=1,
        description="同一标签页内单调递增的状态写入序号；与 tabId 成对提交",
    )
    replace: bool = Field(default=False, description="为 true 时整份覆盖（数据管理「清空全部」）")



class TabRegisterIn(BaseModel):
    tab_id: str = Field(min_length=1, max_length=64, description="浏览器页面唯一标识")
    state: dict | None = Field(default=None, description="关闭页面前附带的完整行程状态，先落盘再退出")



class MonthListIn(BaseModel):
    months: list[str] = Field(default_factory=list, description="YYYY-MM 月份列表")
