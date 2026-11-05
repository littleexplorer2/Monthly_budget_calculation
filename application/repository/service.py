"""数据上传用例与 Git 适配。"""

from __future__ import annotations

from pathlib import Path
import datetime as dt
import os
import re
import subprocess
import threading
from application import config as app_config
from application import contracts as app_contracts
from application import defaults as app_defaults
from application import state as app_state


_repository_upload_lock = threading.Lock()



_GIT_COMMAND_TIMEOUT = 30



_GIT_PUSH_TIMEOUT = 120


UPLOAD_DATA_FILES = ("global.json", "months", "defaults.json", "app-state.json")



def _git_error_detail(result: subprocess.CompletedProcess[str]) -> str:
    """提取简短 Git 错误，并隐藏 URL 中可能存在的凭据。"""
    detail = (result.stderr or result.stdout or "").strip()
    detail = re.sub(r"(https?://)[^/@\s]+@", r"\1***@", detail)
    lines = [line.strip() for line in detail.splitlines() if line.strip()]
    return "；".join(lines[-4:])[:800]



def _run_git(args: list[str], cwd: Path, *, timeout: int = _GIT_COMMAND_TIMEOUT,
             allowed_codes: tuple[int, ...] = (0,)) -> subprocess.CompletedProcess[str]:
    """跨平台、非交互执行 Git；始终使用参数数组，避免 shell 注入。"""
    env = os.environ.copy()
    env["GIT_TERMINAL_PROMPT"] = "0"
    env["GCM_INTERACTIVE"] = "Never"
    try:
        result = subprocess.run(
            ["git", *args],
            cwd=str(cwd),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            env=env,
            check=False,
        )
    except FileNotFoundError as exc:
        raise app_contracts.RepositoryUploadError("未找到 Git，请先安装 Git 并重新启动程序") from exc
    except subprocess.TimeoutExpired as exc:
        raise app_contracts.RepositoryUploadError("Git 操作超时，请检查网络或远程仓库连接后重试") from exc
    if result.returncode not in allowed_codes:
        detail = _git_error_detail(result)
        hint = "请检查 Git 登录状态、远程仓库权限以及是否需要先手动拉取远端更新"
        raise app_contracts.RepositoryUploadError(f"{detail or 'Git 命令执行失败'}。{hint}")
    return result



def _repository_context(base_dir: Path) -> tuple[Path, str, str, str]:
    """返回仓库根目录、远程名、当前分支与 data/ 的仓库相对路径。"""
    root_text = _run_git(["rev-parse", "--show-toplevel"], base_dir).stdout.strip()
    root = Path(root_text).resolve()
    project = base_dir.resolve()
    try:
        data_relative = (project / "data").resolve().relative_to(root).as_posix()
    except ValueError as exc:
        raise app_contracts.RepositoryUploadError("当前项目的 data 目录不在 Git 仓库内，无法上传") from exc

    remotes = [name.strip() for name in _run_git(["remote"], root).stdout.splitlines() if name.strip()]
    if not remotes:
        raise app_contracts.RepositoryUploadError("尚未配置 Git 远程仓库，请先添加 origin")
    if "origin" in remotes:
        remote = "origin"
    elif len(remotes) == 1:
        remote = remotes[0]
    else:
        raise app_contracts.RepositoryUploadError("存在多个远程仓库但没有 origin，请先配置 origin")

    branch = _run_git(["branch", "--show-current"], root).stdout.strip()
    if not branch:
        raise app_contracts.RepositoryUploadError("当前处于 detached HEAD，请先切换到一个分支")
    return root, remote, branch, data_relative



def _upload_data_to_remote(base_dir: Path = app_config.BASE_DIR,
                           *, user_confirmed: bool = False) -> dict:
    """经本次用户确认后提交预算/行程状态与用户默认标准，再推送当前分支。

    ``data/rates`` 是可重建缓存，``data/legacy`` 是本机迁移证据；二者均不上传。
    ``app-state.json`` 只作为删除路径加入，以便远程仓库完成 v1 → v2 替换。
    """
    if user_confirmed is not True:
        raise app_contracts.RepositoryUploadError("上传用户数据前必须取得用户明确确认")
    with _repository_upload_lock:
        root, remote, branch, data_relative = _repository_context(base_dir)
        if not (base_dir / "data").is_dir():
            raise app_contracts.RepositoryUploadError("项目 data 目录不存在，无法上传")

        candidates = [f"{data_relative}/{name}" for name in UPLOAD_DATA_FILES]
        upload_paths = []
        for relative in candidates:
            absolute = root / Path(relative)
            tracked = bool(_run_git(["ls-files", "--", relative], root).stdout.strip())
            if absolute.exists() or tracked:
                upload_paths.append(relative)
        if not upload_paths:
            raise app_contracts.RepositoryUploadError("没有可上传的权威用户数据文件")
        # 等状态写盘完成，再截取 v2 全局/月份实体与默认配置；汇率缓存和
        # 本机 legacy 迁移归档均不参与上传。
        with app_state.state_disk_lock, app_defaults.defaults_disk_lock:
            _run_git(["add", "-A", "--", *upload_paths], root)
        changed = _run_git(
            ["diff", "--cached", "--quiet", "--", *upload_paths],
            root,
            allowed_codes=(0, 1),
        ).returncode == 1
        if changed:
            message = f"保存预算与行程数据 {dt.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"
            _run_git(["commit", "--only", "-m", message, "--", *upload_paths], root)

        commit = _run_git(["rev-parse", "--short", "HEAD"], root).stdout.strip()
        try:
            _run_git(
                ["push", remote, f"HEAD:refs/heads/{branch}"],
                root,
                timeout=_GIT_PUSH_TIMEOUT,
            )
        except app_contracts.RepositoryUploadError as exc:
            if changed:
                raise app_contracts.RepositoryUploadError(
                    f"数据已在本地提交为 {commit}，但上传失败：{exc}；修复后可直接再次点击上传"
                ) from exc
            raise
        return {
            "uploaded": True,
            "committed": changed,
            "remote": remote,
            "branch": branch,
            "commit": commit,
            "message": "预算与行程数据已提交并上传" if changed else "预算与行程数据没有新变化，远程仓库已同步",
        }



def api_data_upload(body: app_contracts.DataUploadRequest):
    """仅在用户明确确认本次操作后上传权威用户数据。"""
    if getattr(body, "user_confirmed", False) is not True:
        raise app_contracts.RepositoryUploadError("上传用户数据前必须取得用户明确确认")
    return _upload_data_to_remote(user_confirmed=True)
