"""目录与依赖约束属于产品架构，防止后续修改重新回到平铺巨型文件。"""

import asyncio
from html.parser import HTMLParser
from pathlib import Path
import unittest
from urllib.parse import urlsplit

from tests.architecture.boundaries import (
    compatibility_violations,
    python_dependency_violations,
    python_layout_violations,
    python_sources,
)


ROOT = Path(__file__).resolve().parents[1]


class ProductionArchitectureTests(unittest.TestCase):
    def test_python_modules_have_public_directories(self):
        self.assertEqual(python_layout_violations(ROOT), [])

    def test_python_dependencies_follow_layer_and_public_entry_boundaries(self):
        violations = python_dependency_violations(python_sources(ROOT))
        self.assertEqual(violations, [], "\n".join(violations))

    def test_legacy_entries_delegate_without_regaining_implementation(self):
        violations = []
        for name in ("functions.py", "main_web.py"):
            violations.extend(compatibility_violations(name, (ROOT / name).read_text(encoding="utf-8-sig")))
        self.assertEqual(violations, [], "\n".join(violations))

    def test_launch_entry_serves_actual_html_and_every_frontend_script(self):
        # GET only: no lifespan startup, writes, live rates, repository or real
        # state API. Exercising the ASGI app catches __file__ relocation errors.
        import main_web
        from application import api, config

        self.assertIs(main_web.app, api.app)
        self.assertEqual(config.BASE_DIR, ROOT)
        self.assertEqual(config.WEB_DIR, ROOT / "web")

        class ScriptParser(HTMLParser):
            def __init__(self):
                super().__init__()
                self.sources = []

            def handle_starttag(self, tag, attrs):
                if tag == "script" and dict(attrs).get("src"):
                    self.sources.append(dict(attrs)["src"])

        async def request(path):
            messages = []
            sent = False

            async def receive():
                nonlocal sent
                if not sent:
                    sent = True
                    return {"type": "http.request", "body": b"", "more_body": False}
                await asyncio.Event().wait()

            async def send(message):
                messages.append(message)

            await api.app({
                "type": "http", "asgi": {"version": "3.0", "spec_version": "2.4"},
                "http_version": "1.1", "method": "GET", "scheme": "http",
                "path": path, "raw_path": path.encode("utf-8"),
                "query_string": b"", "root_path": "",
                "headers": [(b"host", b"127.0.0.1:8123")],
                "client": ("127.0.0.1", 1234), "server": ("127.0.0.1", 8123),
            }, receive, send)
            start = next(message for message in messages if message["type"] == "http.response.start")
            body = b"".join(message.get("body", b"") for message in messages
                            if message["type"] == "http.response.body")
            return start["status"], body

        async def verify():
            status, body = await request("/")
            self.assertEqual(status, 200)
            self.assertEqual(body, (ROOT / "web" / "index.html").read_bytes())
            parser = ScriptParser()
            parser.feed(body.decode("utf-8-sig"))
            self.assertIn("js/app.js", [urlsplit(src).path.lstrip("/") for src in parser.sources])
            for source in parser.sources:
                url = urlsplit(source)
                self.assertFalse(url.scheme or url.netloc, "前端脚本必须使用本地静态资源")
                path = "/" + url.path.lstrip("/")
                status, body = await request(path)
                with self.subTest(script=source):
                    self.assertEqual(status, 200)
                    self.assertEqual(body, (ROOT / "web" / url.path.lstrip("/")).read_bytes())

        asyncio.run(verify())


class ArchitectureGuardRegressionTests(unittest.TestCase):
    def test_relative_import_cannot_hide_cross_module_internal_access(self):
        violations = python_dependency_violations({
            "application/budget/service.py": "from ..rates.service import fetch\n",
        })
        self.assertTrue(any("跨模块只能使用公开入口" in value for value in violations))

    def test_own_module_internal_import_and_public_dependencies_are_allowed(self):
        self.assertEqual(python_dependency_violations({
            "application/budget/__init__.py": "from .service import calculate\n",
            "application/budget/service.py": "from core import budget\nfrom .. import rates\n",
        }), [])

    def test_imported_child_module_cannot_masquerade_as_public_symbol(self):
        violations = python_dependency_violations({
            "application/budget/service.py": "from application.rates import service\n",
            "application/rates/service.py": "def fetch(): pass\n",
        })
        self.assertTrue(any("跨模块只能使用公开入口" in value for value in violations))

    def test_core_reverse_import_and_legacy_facades_are_rejected(self):
        violations = python_dependency_violations({
            "core/budget/implementation.py": (
                "from application import rates\nimport fastapi\nimport functions\n"
            ),
            "application/api/service.py": "import main_web\n",
        })
        self.assertEqual(sum("底层不得反向依赖" in value for value in violations), 2)
        self.assertEqual(sum("不得依赖兼容入口" in value for value in violations), 2)

    def test_calculation_io_is_rejected_but_infrastructure_io_is_allowed(self):
        violations = python_dependency_violations({
            "core/budget/monthly.py": "import yfinance\nopen('state.json')\n",
            "core/storage/files.py": "from pathlib import Path\n",
            "core/rates/provider.py": "import yfinance\n",
        })
        self.assertEqual(sum("纯计算模块不得直接" in value for value in violations), 2)

    def test_static_module_cycle_is_rejected(self):
        violations = python_dependency_violations({
            "application/budget/service.py": "from application import rates\n",
            "application/rates/service.py": "from application.budget import calculate\n",
        })
        self.assertTrue(any("Python 模块循环依赖" in value for value in violations))

    def test_compatibility_entry_rejects_reintroduced_formula(self):
        violations = compatibility_violations("functions.py", "def total(a, b): return a * b\n")
        self.assertTrue(any("不能承载计算" in value for value in violations))


if __name__ == "__main__":
    unittest.main()
