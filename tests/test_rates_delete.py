# -*- coding: utf-8 -*-
"""汇率缓存删除接口的边界校验回归测试。

所有写入和删除都在 TemporaryDirectory 中完成；测试不依赖也不改动
项目 data/**/*.json。
"""
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import functions
import main_web


class RateCacheDeleteValidationTests(unittest.TestCase):
    def test_invalid_later_month_cannot_partially_delete_or_purge(self):
        invalid_months = (
            ("2026x09", "月份格式无效"),  # 切片解析曾会错误接受非连字符分隔符
            ("2026-9", "月份格式无效"),
            ("2026-09 ", "月份格式无效"),
            ("２０２６-09", "月份格式无效"),
            ("2026-00", "月份格式无效"),
            ("2026-13", "月份格式无效"),
            ("1999-09", "年份超出支持范围"),
            ("2101-09", "年份超出支持范围"),
        )
        for invalid, message in invalid_months:
            with self.subTest(invalid=invalid), tempfile.TemporaryDirectory() as temp:
                rates_dir = Path(temp) / "rates"
                rates_dir.mkdir()
                valid_file = rates_dir / "2026-08.json"
                valid_file.write_text("{}", encoding="utf-8")

                with (
                    mock.patch.object(main_web, "RATES_DATA_DIR", rates_dir),
                    mock.patch.object(functions, "purge_rates_cache") as purge,
                ):
                    with self.assertRaisesRegex(ValueError, message):
                        main_web.api_data_rates_delete(
                            main_web.MonthListIn(months=["2026-08", invalid])
                        )

                self.assertTrue(valid_file.exists())
                purge.assert_not_called()

    def test_supported_year_boundaries_are_deleted_after_validation(self):
        with tempfile.TemporaryDirectory() as temp:
            rates_dir = Path(temp) / "rates"
            rates_dir.mkdir()
            for month in ("2000-01", "2100-12"):
                (rates_dir / f"{month}.json").write_text("{}", encoding="utf-8")

            with (
                mock.patch.object(main_web, "RATES_DATA_DIR", rates_dir),
                mock.patch.object(functions, "purge_rates_cache") as purge,
            ):
                result = main_web.api_data_rates_delete(
                    main_web.MonthListIn(months=["2000-01", "2100-12"])
                )

            self.assertEqual(result, {"removed": ["2000-01", "2100-12"], "months": []})
            self.assertEqual(purge.call_count, 2)
            purge.assert_has_calls([
                mock.call("2000-01-01", "2000-01-31", rate_kind="monthly"),
                mock.call("2100-12-01", "2100-12-31", rate_kind="monthly"),
            ])


if __name__ == "__main__":
    unittest.main()
