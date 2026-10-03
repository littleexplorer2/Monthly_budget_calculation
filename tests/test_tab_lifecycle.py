# -*- coding: utf-8 -*-
"""浏览器关闭信号丢失时的标签页租约回归测试。"""
import unittest
from unittest import mock

import main_web


class TabLeaseTests(unittest.TestCase):
    def test_register_and_heartbeat_refresh_the_tab_lease(self):
        tabs = {}
        body = main_web.TabRegisterIn(tab_id="safari-tab")
        with (
            mock.patch.object(main_web, "_open_tabs", tabs),
            mock.patch.object(main_web, "_schedule_tab_expiry_check_locked") as schedule,
            mock.patch.object(main_web, "_cancel_shutdown_timer") as cancel_shutdown,
            mock.patch.object(main_web.time, "monotonic", side_effect=[10.0, 16.0]),
        ):
            self.assertEqual(main_web.api_tabs_register(body), {"open_tabs": 1})
            self.assertEqual(tabs, {"safari-tab": 10.0})
            self.assertEqual(main_web.api_tabs_heartbeat(body), {"open_tabs": 1})
            self.assertEqual(tabs, {"safari-tab": 16.0})

        self.assertEqual(schedule.call_count, 2)
        self.assertEqual(cancel_shutdown.call_count, 2)

    def test_stale_last_tab_is_expired_and_arms_shutdown(self):
        tabs = {"lost-safari-tab": 0.0}
        now = main_web._TAB_LEASE_SECONDS + 0.01
        with (
            mock.patch.object(main_web, "_open_tabs", tabs),
            mock.patch.object(main_web, "AUTO_SHUTDOWN_ENABLED", True),
            mock.patch.object(main_web, "_cancel_tab_expiry_timer_locked") as cancel_expiry,
            mock.patch.object(main_web, "_arm_shutdown_timer") as arm_shutdown,
        ):
            main_web._expire_stale_tabs(now=now)

        self.assertEqual(tabs, {})
        cancel_expiry.assert_called_once_with()
        arm_shutdown.assert_called_once_with()

    def test_fresh_tab_is_kept_and_next_expiry_check_is_scheduled(self):
        now = 100.0
        tabs = {"active-tab": now - main_web._TAB_LEASE_SECONDS + 1.0}
        with (
            mock.patch.object(main_web, "_open_tabs", tabs),
            mock.patch.object(main_web, "_schedule_tab_expiry_check_locked") as schedule,
            mock.patch.object(main_web, "_arm_shutdown_timer") as arm_shutdown,
        ):
            main_web._expire_stale_tabs(now=now)

        self.assertIn("active-tab", tabs)
        schedule.assert_called_once_with()
        arm_shutdown.assert_not_called()


if __name__ == "__main__":
    unittest.main()
