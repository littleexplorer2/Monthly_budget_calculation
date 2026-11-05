# -*- coding: utf-8 -*-
"""启动成功信息与浏览器打开前必须确认端口可监听。"""

import socket
import unittest

from application.startup.service import _assert_loopback_host, _assert_port_available


class StartupPreflightTests(unittest.TestCase):
    def test_non_loopback_bind_is_rejected(self):
        for host in ("0.0.0.0", "192.168.1.10", "example.test"):
            with self.subTest(host=host), self.assertRaisesRegex(RuntimeError, "只允许监听回环地址"):
                _assert_loopback_host(host)
        for host in ("127.0.0.1", "::1", "localhost"):
            with self.subTest(host=host):
                _assert_loopback_host(host)

    def test_occupied_port_is_rejected_before_server_start(self):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen(1)
            port = listener.getsockname()[1]
            with self.assertRaisesRegex(RuntimeError, "端口可能已被占用"):
                _assert_port_available("127.0.0.1", port)


if __name__ == "__main__":
    unittest.main()
