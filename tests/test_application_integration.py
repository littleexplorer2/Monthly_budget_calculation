"""HTTP 装配集成测试：固定行情、临时项目数据树，禁止真实网络。

直接运行 ASGI 应用，不要求额外安装 httpx，也不启动 HTTP 服务。所有可写路径都指向
项目 .scratch 下的临时副本；不读取真实用户数据来构造断言。
"""

import asyncio
import copy
import json
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest import mock
from urllib.parse import urlsplit

import pandas as pd

import functions
from application.api import app
from application.defaults import service as defaults_service
from application.rates import service as rates_service
from application.state import service as state_service
from core.rates import cache as rates_cache
from core.rates import provider
from core.standards import builtin_standards_snapshot


SCRATCH = Path(__file__).resolve().parents[1] / ".scratch"
STANDARDS = {
    "variable": {"Shenzhen": {"CNY": 100.0}},
    "fixed": {"Mainland": {"CNY": 50.0, "USD": 10.0}, "Overseas": {"CNY": 1.0}},
    "travel": {"Shanghai": {"CNY": {"daily": 20.0, "once": 30.0}}},
    "extra": {"CNY": 0.0, "USD": 5.0, "HKD": 0.0},
    "location_names": {"Shenzhen": "定居甲", "Shanghai": "旅居乙"},
    "currency_names": {"USD": "测试美元"},
}


async def _request_asgi(method, target, payload=None):
    """执行真实路由、请求模型、错误映射及 JSON 编码，无网络传输。"""
    parsed = urlsplit(target)
    request_body = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else b""
    messages = []
    response_finished = asyncio.Event()
    delivered = False

    async def receive():
        nonlocal delivered
        if not delivered:
            delivered = True
            return {"type": "http.request", "body": request_body, "more_body": False}
        await response_finished.wait()
        return {"type": "http.disconnect"}

    async def send(message):
        messages.append(message)
        if message["type"] == "http.response.body" and not message.get("more_body", False):
            response_finished.set()

    scope = {
        "type": "http", "asgi": {"version": "3.0", "spec_version": "2.4"},
        "http_version": "1.1", "method": method, "scheme": "http",
        "path": parsed.path, "raw_path": parsed.path.encode("ascii"),
        "query_string": parsed.query.encode("ascii"), "root_path": "",
        "headers": [(b"host", b"test.local"), (b"content-type", b"application/json")],
        "server": ("test.local", 80), "client": ("127.0.0.1", 12345),
    }
    await asyncio.wait_for(app(scope, receive, send), timeout=10)
    start = next(item for item in messages if item["type"] == "http.response.start")
    body = b"".join(item.get("body", b"") for item in messages if item["type"] == "http.response.body")
    return start["status"], json.loads(body)


class ApplicationIntegrationTests(unittest.TestCase):
    def setUp(self):
        SCRATCH.mkdir(exist_ok=True)
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        temp = self.stack.enter_context(tempfile.TemporaryDirectory(prefix="application-integration-", dir=SCRATCH))
        self.project = Path(temp)
        self.data = self.project / "data"
        self.data.mkdir()
        self.state_path = self.data / "app-state.json"
        self.defaults_path = self.data / "defaults.json"
        self.rates_dir = self.data / "rates"

        self.stack.enter_context(mock.patch.object(defaults_service, "_DEFAULTS_FILE", self.defaults_path))
        self.stack.enter_context(mock.patch.object(state_service, "APP_STATE_FILE", self.state_path))
        self.stack.enter_context(mock.patch.object(rates_service, "RATES_DATA_DIR", self.rates_dir))
        self.stack.enter_context(mock.patch.object(state_service, "_state_write_sequences", {}))
        for name in ("_RATES_CACHE", "_RATES_CACHE_KEY_LOCKS", "_RATES_CACHE_REFRESHING"):
            self.stack.enter_context(mock.patch.object(rates_cache, name, {}))

        before = defaults_service.default_standards_snapshot()

        def restore_defaults():
            with defaults_service._DEFAULTS_LOCK:
                defaults_service._apply_defaults_dict(
                    before,
                    subscriptions_configured=before["subscriptions_configured"],
                )
                defaults_service._DEFAULTS_LOADED_FROM_FILE = before["customized"]
                defaults_service._DEFAULTS_LOAD_ERROR = before["load_error"]

        self.stack.callback(restore_defaults)
        with defaults_service._DEFAULTS_LOCK:
            defaults_service._apply_defaults_dict(copy.deepcopy(STANDARDS))
            defaults_service._DEFAULTS_LOADED_FROM_FILE = False
            defaults_service._DEFAULTS_LOAD_ERROR = None

        self.download = self.stack.enter_context(mock.patch.object(
            provider.yf, "download", side_effect=self._fixture_download,
        ))
        self.stack.enter_context(mock.patch.object(
            provider.yf, "Ticker", side_effect=AssertionError("测试不得使用 Yahoo 备援网络"),
        ))
        # Windows asyncio 创建内部唤醒 socketpair；先创建事件循环，之后所有请求
        # 的 socket.connect 都被拒绝，不需要给外部 HTTP 留网络例外。
        self.loop = asyncio.new_event_loop()
        self.stack.callback(self.loop.close)
        self.stack.enter_context(mock.patch("socket.create_connection", side_effect=AssertionError("测试禁止网络")))
        self.stack.enter_context(mock.patch("socket.socket.connect", side_effect=AssertionError("测试禁止网络")))

    @staticmethod
    def _fixture_download(ticker, **kwargs):
        if ticker != "USDCNY=X":
            raise AssertionError(f"未声明的行情依赖：{ticker}")
        # 两个不同年份的哨兵记录必须被排除。有效交易日是周四和下周一，
        # 月度使用 4 / 9 的开收盘均值，年度只使用 6 / 8 的 Close。
        return pd.DataFrame(
            {"Open": [999.0, 2.0, 10.0, 999.0], "Close": [999.0, 6.0, 8.0, 999.0]},
            index=pd.to_datetime(["2024-12-31", "2025-01-02", "2025-01-06", "2026-01-01"]),
        )

    def request(self, method, path, payload=None, *, status=200):
        actual_status, body = self.loop.run_until_complete(_request_asgi(method, path, payload))
        self.assertEqual(actual_status, status, body)
        return body

    def test_monthly_route_reaches_defaults_rates_core_and_legacy_facade(self):
        result = self.request("POST", "/api/calculate", {
            "year": 2025, "month": 1, "region": "Mainland", "include_travel": True,
            "itinerary": [
                {"location": "Shenzhen", "ranges": [{"start": "2025-01-01", "end": "2025-01-03"}]},
                {"location": "Shanghai", "ranges": [{"start": "2025-01-10", "end": "2025-01-12"}]},
            ],
        })
        monthly_average = (4.0 * 5 + 9.0 * 26) / 31
        self.assertEqual(result["summary"]["可变费用合计(人民币)"], 360.0)
        self.assertEqual(result["summary"]["总预算(人民币)"], round(440.0 + 15 * monthly_average, 2))
        self.assertEqual(result["extra_details"][0]["rmb_cost"], round(5 * monthly_average, 2))
        self.assertNotIn("rates", result, "月度计算响应不再携带已删除图表模块的原始序列")
        self.assertEqual(result["rate_source"], {
            "kind": "current_month",
            "requested_month": "2025-01",
            "fallback": False,
        })
        cny_fixed = next(row for row in result["fixed_details"] if row["currency"] == "CNY")
        self.assertEqual(cny_fixed["avg_rate"], 1.0)
        self.assertEqual(result["warnings"], [])
        self.assertEqual(result["deduped_entries"], 0)
        self.download.assert_called_once()
        self.assertEqual(self.download.call_args.args[0], "USDCNY=X")

        cache = json.loads((self.rates_dir / "2025-01.json").read_text(encoding="utf-8"))
        self.assertEqual(cache["_meta"]["rate_kind"], "monthly_open_close_estimate")
        self.assertEqual(len(cache["USD"]), 31)
        self.assertEqual(len(cache["CNY"]), 31)

        itinerary = [
            {"location": "Shenzhen", "date": f"2025-01-{day:02d}", "is_travel": False}
            for day in (1, 2, 3)
        ] + [
            {"location": "Shanghai", "date": f"2025-01-{day:02d}", "is_travel": True}
            for day in (10, 11, 12)
        ]
        dates = pd.date_range("2025-01-01", "2025-01-31")
        rates = {
            "CNY": pd.Series(1.0, index=dates),
            "USD": pd.Series([4.0] * 5 + [9.0] * 26, index=dates),
        }
        explicit = functions.calculate_travel_budget(itinerary, "Mainland", 2025, 1, rates_dict=rates)
        automatic = functions.calculate_travel_budget(itinerary, "Mainland", 2025, 1)
        for field in ("summary", "daily_details", "fixed_details", "extra_details"):
            self.assertEqual(explicit[field], result[field])
            self.assertEqual(automatic[field], result[field])
        for label, rows in (("iterator", iter(itinerary)), ("dataframe", pd.DataFrame(itinerary))):
            with self.subTest(itinerary=label):
                compatible = functions.calculate_travel_budget(rows, "Mainland", 2025, 1)
                for field in ("summary", "daily_details", "fixed_details", "extra_details"):
                    self.assertEqual(compatible[field], result[field])
        self.assertEqual(self.download.call_count, 1)  # facade 下载编排复用本次测试的内存缓存。

    def test_annual_routes_use_only_actual_close_and_never_monthly_disk_cache(self):
        annual_rates = self.request("GET", "/api/annual-rates?year=2025&currencies=USD,CNY")
        self.assertEqual(annual_rates["stats"]["USD"], {
            "average": 7.0, "observation_count": 2,
            "first_date": "2025-01-02", "last_date": "2025-01-06",
        })
        self.assertEqual(annual_rates["observed_through"], "2025-01-06")
        self.assertEqual(annual_rates["requested_through"], "2025-12-31")
        result = self.request("POST", "/api/annual-budget", {
            "year": 2025, "amounts": {"USD": 100.0, "CNY": 50.0},
        })
        self.assertEqual(result["summary"]["全年预算合计(人民币)"], 750.0)
        usd = next(row for row in result["details"] if row["currency"] == "USD")
        self.assertEqual((usd["average_rate"], usd["observation_count"]), (7.0, 2))
        self.assertEqual(result["price_field"], "Close")
        self.assertEqual(result["non_trading_days"], "excluded")
        self.assertEqual(result["errors"], {})
        self.assertFalse(self.rates_dir.exists())
        self.download.assert_called_once()

    def test_asset_rates_route_uses_trailing_close_window(self):
        rates = {
            "HKD": pd.Series([0.90, 0.94], index=pd.to_datetime(["2025-09-29", "2026-09-25"])),
            "USD": pd.Series([7.0, 7.2], index=pd.to_datetime(["2025-09-29", "2026-09-25"])),
        }
        with mock.patch.object(
            rates_service.app_contracts,
            "trailing_year_bounds",
            return_value=("2025-09-29", "2026-09-28"),
        ), mock.patch.object(
            rates_service,
            "_fetch_annual_close_rates",
            return_value=(rates, {}),
        ) as fetch:
            payload = self.request("GET", "/api/asset-rates?currencies=HKD,USD")

        self.assertEqual(payload["kind"], "trailing_365_day_close_average")
        self.assertEqual(payload["window_days"], 365)
        self.assertEqual(payload["start_date"], "2025-09-29")
        self.assertEqual(payload["requested_through"], "2026-09-28")
        self.assertEqual(payload["observed_through"], "2026-09-25")
        self.assertEqual(payload["price_field"], "Close")
        self.assertEqual(payload["non_trading_days"], "excluded")
        self.assertAlmostEqual(payload["stats"]["HKD"]["average"], 0.92)
        self.assertEqual(payload["stats"]["USD"]["observation_count"], 2)
        fetch.assert_called_once_with(
            ["HKD", "USD"], "2025-09-29", "2026-09-28", refresh=False,
        )

    def test_defaults_save_meta_conflict_and_reset_share_one_service(self):
        initial = self.request("GET", "/api/meta")
        self.assertEqual(initial["currency_priority"], ["CNY", "HKD", "USD"])
        self.assertEqual(initial["currencies"][:3], ["CNY", "HKD", "USD"])
        mainland = next(region for region in initial["regions"] if region["key"] == "Mainland")
        self.assertEqual(list(mainland["currencies"]), ["CNY", "USD"])
        payload = copy.deepcopy(STANDARDS)
        payload["location_names"]["Shenzhen"] = "更新后的定居地"
        payload["base_revision"] = initial["defaults_revision"]
        saved = self.request("POST", "/api/defaults", payload)
        self.assertTrue(saved["defaults_customized"])
        self.assertNotEqual(saved["defaults_revision"], initial["defaults_revision"])
        self.assertEqual(self.request("GET", "/api/meta"), saved)
        location = next(row for row in saved["locations"] if row["key"] == "Shenzhen")
        self.assertEqual(location["name"], "更新后的定居地")
        self.assertEqual(saved["currency_names"]["USD"], "测试美元")
        persisted = self.defaults_path.read_bytes()
        conflict = self.request("POST", "/api/defaults", payload, status=409)
        self.assertEqual(conflict["error"]["code"], "DEFAULTS_CONFLICT")
        self.assertEqual(self.defaults_path.read_bytes(), persisted)

        reset = self.request("POST", "/api/defaults/reset", {"base_revision": saved["defaults_revision"]})
        self.assertFalse(reset["defaults_customized"])
        self.assertEqual(reset["default_standards"], builtin_standards_snapshot())
        self.assertFalse(self.defaults_path.exists())

    def test_state_http_roundtrip_and_corrupt_file_is_never_overwritten(self):
        empty = self.request("GET", "/api/state")
        self.assertEqual(empty["annualBudgetsByYear"], {})
        self.assertFalse(self.state_path.exists())
        saved = self.request("PUT", "/api/state", {
            "year": 2025, "month": 1,
            "annualBudgetsByYear": {"2025": {"USD": 100.0}},
            "itineraryByMonth": {"2025-01": {"Shenzhen": [{"start": "2025-01-01", "end": "2025-01-03"}]}},
        })
        self.assertEqual(saved["annualBudgetsByYear"], {"2025": {"USD": 100.0}})
        self.assertEqual(self.request("GET", "/api/state"), saved)
        self.assertEqual(json.loads(self.state_path.read_text(encoding="utf-8")), saved)

        broken = b"{not-json"
        self.state_path.write_bytes(broken)
        for method, payload in (("GET", None), ("PUT", {"year": 2025, "month": 1})):
            with self.subTest(method=method):
                failure = self.request(method, "/api/state", payload, status=400)
                self.assertEqual(failure["error"]["code"], "BAD_REQUEST")
                self.assertIn("JSON 文件无法读取或已损坏", failure["error"]["message"])
                self.assertEqual(self.state_path.read_bytes(), broken)


if __name__ == "__main__":
    unittest.main()
