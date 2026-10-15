"""只读架构门禁：通过 AST 检查真实导入路径，不执行生产代码。"""

from __future__ import annotations

import ast
from pathlib import Path, PurePosixPath

from .manifest import PYTHON_MODULES


def _module_name(path: str) -> str:
    parts = list(PurePosixPath(path).with_suffix("").parts)
    if parts[-1] == "__init__":
        parts.pop()
    return ".".join(parts)


def _owner(name: str) -> str | None:
    parts = name.split(".")
    if len(parts) >= 2 and parts[0] in PYTHON_MODULES:
        return ".".join(parts[:2])
    return None


def _import_targets(node: ast.Import | ast.ImportFrom, module: str, package: bool,
                    source_modules: set[str]):
    if isinstance(node, ast.Import):
        return [alias.name for alias in node.names]
    prefix = node.module or ""
    if node.level:
        parent = module.split(".") if package else module.split(".")[:-1]
        parent = parent[:len(parent) - node.level + 1]
        prefix = ".".join(parent + ([prefix] if prefix else []))
    # `from core import rates` names the public module in the imported names;
    # `from core.rates import fn` names a symbol, not another package level.
    if prefix in PYTHON_MODULES:
        return [f"{prefix}.{alias.name}" for alias in node.names]
    submodules = [f"{prefix}.{alias.name}" for alias in node.names
                  if f"{prefix}.{alias.name}" in source_modules]
    if submodules:
        return [prefix, *submodules]
    return [prefix] if prefix else []


def _cycles(graph: dict[str, set[str]]) -> list[str]:
    visited: set[str] = set()
    active: list[str] = []
    result: list[str] = []

    def visit(module: str) -> None:
        if module in active:
            result.append(" -> ".join(active[active.index(module):] + [module]))
            return
        if module in visited:
            return
        visited.add(module)
        active.append(module)
        for dependency in sorted(graph.get(module, ())):
            visit(dependency)
        active.pop()

    for module in sorted(graph):
        visit(module)
    return result


def python_dependency_violations(sources: dict[str, str]) -> list[str]:
    """检查所有静态 import（含函数体内），同模块内部引用不构成越界。"""
    violations: list[str] = []
    graph: dict[str, set[str]] = {}
    known = {
        f"{layer}.{module}"
        for layer, modules in PYTHON_MODULES.items()
        for module in modules
    }
    source_modules = {_module_name(path) for path in sources}
    for path, source in sorted(sources.items()):
        module = _module_name(path)
        owner = _owner(module)
        layer = module.split(".")[0]
        if owner:
            graph.setdefault(owner, set())
        try:
            tree = ast.parse(source, filename=path)
        except SyntaxError as error:
            violations.append(f"{path}:{error.lineno}: Python 语法错误：{error.msg}")
            continue
        for node in ast.walk(tree):
            if (owner in {"core.budget", "core.standards"}
                    and isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
                    and node.func.id == "open"):
                violations.append(f"{path}:{node.lineno}: 纯计算模块不得直接读写文件")
            if not isinstance(node, (ast.Import, ast.ImportFrom)):
                continue
            for target in _import_targets(node, module, path.endswith("/__init__.py"), source_modules):
                root = target.split(".")[0]
                location = f"{path}:{node.lineno}"
                if root in {"functions", "main_web"}:
                    violations.append(f"{location}: 生产模块不得依赖兼容入口 {target}")
                if layer == "core" and root in {"application", "web", "fastapi"}:
                    violations.append(f"{location}: 底层不得反向依赖 {target}")
                if layer == "application" and root == "web":
                    violations.append(f"{location}: 应用层不得依赖前端 {target}")
                if owner in {"core.budget", "core.standards"} and root in {
                    "os", "pathlib", "requests", "yfinance", "urllib", "http",
                    "socket", "subprocess", "shutil", "tempfile",
                }:
                    violations.append(f"{location}: 纯计算模块不得直接依赖 I/O 库 {target}")
                dependency = _owner(target)
                if dependency and dependency not in known:
                    violations.append(f"{location}: 引用了未登记的模块 {dependency}")
                if dependency and dependency != owner:
                    if len(target.split(".")) > 2:
                        violations.append(f"{location}: 跨模块只能使用公开入口，不能导入 {target}")
                    if owner:
                        graph[owner].add(dependency)
    violations.extend(f"Python 模块循环依赖：{cycle}" for cycle in _cycles(graph))
    return violations


def python_layout_violations(root: Path) -> list[str]:
    violations: list[str] = []
    for layer, modules in PYTHON_MODULES.items():
        directory = root / layer
        if not (directory / "__init__.py").is_file():
            violations.append(f"{layer}/ 缺少包入口 __init__.py")
        if not directory.is_dir():
            continue
        for path in sorted(directory.glob("*.py")):
            if path.name != "__init__.py":
                violations.append(f"{path.relative_to(root)}: 实现必须放入独立模块目录")
        discovered = {
            path.name for path in directory.iterdir()
            if path.is_dir() and path.name != "__pycache__" and any(path.rglob("*.py"))
        }
        for extra in sorted(discovered - set(modules)):
            violations.append(f"{layer}/{extra}/ 未登记在模块清单中")
        for module in modules:
            if not (directory / module / "__init__.py").is_file():
                violations.append(f"{layer}/{module}/ 缺少公开入口 __init__.py")
    return violations


def python_sources(root: Path) -> dict[str, str]:
    return {
        path.relative_to(root).as_posix(): path.read_text(encoding="utf-8-sig")
        for layer in PYTHON_MODULES
        for path in (root / layer).rglob("*.py")
    }


def compatibility_violations(path: str, source: str) -> list[str]:
    """兼容入口可以导入与委托，不能重新持有实现、状态或计算公式。"""
    tree = ast.parse(source, filename=path)
    violations: list[str] = []
    implementation_nodes = (
        ast.ClassDef, ast.For, ast.AsyncFor, ast.While, ast.With, ast.AsyncWith,
        ast.BinOp, ast.AugAssign, ast.ListComp, ast.SetComp, ast.DictComp,
        ast.GeneratorExp,
    )
    for node in ast.walk(tree):
        if isinstance(node, implementation_nodes):
            violations.append(f"{path}:{node.lineno}: 兼容入口不能承载计算、循环或资源操作")
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if path == "main_web.py" or node.decorator_list:
                violations.append(f"{path}:{node.lineno}: 启动或路由实现必须位于应用模块")
        if isinstance(node, ast.Return) and not isinstance(node.value, ast.Call):
            violations.append(f"{path}:{node.lineno}: 兼容函数必须返回被委托接口的结果")
        if isinstance(node, ast.Import):
            targets = [name.name for name in node.names]
        elif isinstance(node, ast.ImportFrom):
            targets = [node.module or ""]
        else:
            targets = []
        for target in targets:
            parts = target.split(".")
            if len(parts) != 2 or parts[0] not in PYTHON_MODULES:
                violations.append(f"{path}:{node.lineno}: 兼容入口只能引用分层模块公开入口 {target}")
    for node in tree.body:
        if isinstance(node, (ast.Assign, ast.AnnAssign)):
            names = node.targets if isinstance(node, ast.Assign) else [node.target]
            if any(not isinstance(name, ast.Name) or name.id != "__all__" for name in names):
                violations.append(f"{path}:{node.lineno}: 兼容入口不得保存运行时状态")
    return violations
