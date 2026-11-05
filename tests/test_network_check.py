"""Yahoo Finance 连通性探测契约；全部下载调用均使用固定桩。"""

from __future__ import annotations

import json
import time
import unittest
from unittest import mock

import pandas as pd
from fastapi.responses import JSONResponse

from application.rates import service as rates_service


def response_body(response) -> dict:
    if isinstance(response, JSONResponse):
        return json.loads(response.body.decode("utf-8"))
    return response


class NetworkCheckTests(unittest.TestCase):
    def test_probe_budget_covers_yfinance_primary_and_fallback_attempts(self):
        # yfinance 的主下载和 history 备援各可能等待约 10 秒，中间还有重试间隔。
        # 外层探测若更短，会在底层仍可能成功时先误报失败。
        self.assertGreaterEqual(rates_service.NETWORK_CHECK_TIMEOUT, 22.0)

    def test_success_requires_non_empty_rate_series(self):
        series = pd.Series(
            [0.92, 0.93],
            index=pd.to_datetime(["2026-10-30", "2026-11-02"]),
        )
        with mock.patch.object(
                rates_service.rates_core,
                "get_historical_rates",
                return_value={"HKD": series},
        ):
            body = response_body(rates_service.api_network_check())

        self.assertTrue(body["ok"])
        self.assertEqual(body["source"], "Yahoo Finance")

    def test_timeout_reports_slow_source_without_claiming_vpn_failure(self):
        def slow_download(*_args, **_kwargs):
            time.sleep(0.03)
            return {"HKD": pd.Series([0.92], index=pd.to_datetime(["2026-11-02"]))}

        with mock.patch.object(rates_service, "NETWORK_CHECK_TIMEOUT", 0.001), \
                mock.patch.object(
                    rates_service.rates_core,
                    "get_historical_rates",
                    side_effect=slow_download,
                ):
            body = response_body(rates_service.api_network_check())

        self.assertFalse(body["ok"])
        self.assertEqual(body["reason"], "timeout")
        self.assertIn("响应超时", body["hint"])
        self.assertNotIn("VPN", body["hint"])
        self.assertNotIn("网络异常", body["hint"])

    def test_download_error_is_source_failure_not_a_categorical_network_diagnosis(self):
        with mock.patch.object(
                rates_service.rates_core,
                "get_historical_rates",
                side_effect=ValueError("fixture failure"),
        ):
            body = response_body(rates_service.api_network_check())

        self.assertFalse(body["ok"])
        self.assertEqual(body["reason"], "source_unavailable")
        self.assertIn("Yahoo Finance", body["hint"])
        self.assertNotIn("网络异常", body["hint"])


if __name__ == "__main__":
    unittest.main()
