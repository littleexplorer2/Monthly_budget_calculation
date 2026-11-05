"""HTTP 边界、错误映射和静态服务装配。"""

from __future__ import annotations

from fastapi import Query
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware
from urllib.parse import urlsplit
from application import budget as app_budget
from application import config as app_config
from application import contracts as app_contracts
from application import defaults as app_defaults
from application import lifecycle as app_lifecycle
from application import metadata as app_metadata
from application import rates as app_rates
from application import repository as app_repository
from application import state as app_state
import logging

logger = logging.getLogger("budget-web")
from fastapi import FastAPI

app = FastAPI(title="多币种旅行预算计算器", docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(
    TrustedHostMiddleware,
    allowed_hosts=["127.0.0.1", "localhost", "[::1]", "testserver"],
)


def _same_local_origin(origin: str, request) -> bool:
    """浏览器写请求只能来自当前回环地址与端口；无 Origin 的本机脚本仍可用。"""
    try:
        parsed = urlsplit(origin)
        request_host = request.url.hostname
        request_port = request.url.port
        origin_port = parsed.port
    except (TypeError, ValueError):
        return False
    return (
        parsed.scheme in ("http", "https")
        and parsed.hostname in ("127.0.0.1", "localhost", "::1")
        and parsed.hostname == request_host
        and origin_port == request_port
    )


@app.middleware("http")
async def _guard_local_write_origin(request, call_next):
    if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
        origin = request.headers.get("origin")
        if origin and not _same_local_origin(origin, request):
            return JSONResponse(status_code=403, content={
                "error": {"code": "ORIGIN_REJECTED", "message": "拒绝非本机同源写请求"},
            })
    return await call_next(request)


@app.middleware("http")
async def _no_cache_web_assets(request, call_next):
    """本地开发时禁止缓存 HTML/CSS/JS，避免改完页面仍看到旧遮罩/旧脚本。"""
    response = await call_next(request)
    path = request.url.path
    if not path.startswith("/api"):
        response.headers["Cache-Control"] = "no-store, max-age=0"
        response.headers["Pragma"] = "no-cache"
    return response



@app.exception_handler(ValueError)
async def _value_error_handler(request, exc: ValueError):
    """业务参数错误 → 400（含清晰的中文提示）。"""
    return JSONResponse(status_code=400, content={"error": {"code": "BAD_REQUEST", "message": str(exc)}})



@app.exception_handler(RequestValidationError)
async def _validation_error_handler(request, exc: RequestValidationError):
    """请求体结构错误 → 422（附字段级详情）。"""
    return JSONResponse(status_code=422, content={
        "error": {"code": "VALIDATION_ERROR", "message": "请求参数校验失败", "detail": exc.errors()},
    })



@app.exception_handler(app_contracts.RateFetchError)
async def _rate_fetch_error_handler(request, exc: app_contracts.RateFetchError):
    return JSONResponse(status_code=502, content={
        "error": {"code": "RATE_FETCH_FAILED", "message": f"汇率数据获取失败：{exc}"},
    })



@app.exception_handler(app_contracts.RepositoryUploadError)
async def _repository_upload_error_handler(request, exc: app_contracts.RepositoryUploadError):
    return JSONResponse(status_code=409, content={
        "error": {"code": "DATA_UPLOAD_FAILED", "message": str(exc)},
    })



@app.exception_handler(app_contracts.StateConflictError)
async def _state_conflict_error_handler(request, exc: app_contracts.StateConflictError):
    return JSONResponse(status_code=409, content={
        "error": {"code": "STATE_CONFLICT", "message": str(exc)},
    })


@app.exception_handler(app_contracts.StateSaveError)
async def _state_save_error_handler(request, exc: app_contracts.StateSaveError):
    return JSONResponse(status_code=500, content={
        "error": {"code": "STATE_SAVE_FAILED", "message": str(exc)},
    })


@app.exception_handler(app_contracts.ResourceNotFoundError)
async def _not_found_error_handler(request, exc: app_contracts.ResourceNotFoundError):
    return JSONResponse(status_code=404, content={
        "error": {"code": "NOT_FOUND", "message": str(exc)},
    })



@app.exception_handler(app_defaults.DefaultsRevisionConflict)
async def _defaults_conflict_error_handler(request, exc: app_defaults.DefaultsRevisionConflict):
    return JSONResponse(status_code=409, content={
        "error": {"code": "DEFAULTS_CONFLICT", "message": str(exc)},
    })



@app.exception_handler(Exception)
async def _unhandled_error_handler(request, exc: Exception):
    logger.exception("未处理异常：%s %s", request.method, request.url.path)
    return JSONResponse(status_code=500, content={
        "error": {"code": "INTERNAL_ERROR", "message": "服务器内部错误，请查看服务端日志"},
    })



@app.get("/api/health")
def api_health():
    return {"status": "ok"}



@app.post('/api/tabs/register')
def api_tabs_register(body: app_contracts.TabRegisterIn):
    return app_lifecycle.tabs_register(body)


@app.post('/api/tabs/heartbeat')
def api_tabs_heartbeat(body: app_contracts.TabRegisterIn):
    return app_lifecycle.tabs_heartbeat(body)


@app.post('/api/tabs/unregister')
def api_tabs_unregister(body: app_contracts.TabRegisterIn):
    return app_lifecycle.tabs_unregister(body)


@app.get('/api/network-check')
def api_network_check():
    return app_rates.network_check()


@app.get('/api/data/rates')
def api_data_rates_list():
    return app_rates.data_rates_list()


@app.post('/api/data/rates/delete')
def api_data_rates_delete(body: app_contracts.MonthListIn):
    return app_rates.data_rates_delete(body)


@app.post('/api/data/upload')
def api_data_upload(body: app_contracts.DataUploadRequest):
    return app_repository.data_upload(body)


@app.get('/api/months')
def api_get_months():
    return app_state.get_months()


@app.get('/api/months/{month}')
def api_get_month(month: str):
    return app_state.get_month(month)


@app.post('/api/months/{month}/ensure')
def api_ensure_month(month: str, body: app_contracts.MonthEnsureIn):
    return app_state.ensure_month(month, body)


@app.put('/api/months/{month}')
def api_put_month(month: str, body: app_contracts.MonthStateWriteIn):
    return app_state.put_month(month, body)


@app.delete('/api/months/{month}')
def api_delete_month(month: str, body: app_contracts.MonthDeleteIn):
    return app_state.delete_month(month, body)


@app.post('/api/months/{month}/calculate')
def api_calculate_month(month: str, body: app_contracts.StoredMonthCalculateIn):
    return app_budget.calculate_stored_month(month, body)


@app.get('/api/global')
def api_get_global():
    return app_state.get_global()


@app.put('/api/global')
def api_put_global(body: app_contracts.GlobalStateWriteIn):
    return app_state.put_global(body)


@app.put('/api/global/selection')
def api_put_global_selection(body: app_contracts.MonthSelectionIn):
    return app_state.put_selection(body)


@app.post('/api/state/clear')
def api_clear_state(body: app_contracts.StateClearIn):
    return app_state.clear_all(body)


@app.get('/api/backups')
def api_list_backups():
    return app_state.list_backups()


@app.post('/api/backups/restore')
def api_restore_backup(body: app_contracts.BackupRestoreIn):
    return app_state.restore_backup(body)


@app.get('/api/meta')
def api_meta():
    return app_metadata.meta()


@app.post('/api/defaults')
def api_save_defaults(body: app_contracts.DefaultsPayload):
    return app_metadata.save_defaults(body)


@app.post('/api/defaults/reset')
def api_reset_defaults(body: app_contracts.DefaultsResetIn):
    return app_metadata.reset_defaults(body)


@app.get('/api/annual-rates')
def api_annual_rates(year: int, currencies: str | None=Query(default=None, description='逗号分隔的币种列表，缺省为全部'), refresh: bool=Query(default=False, description='为 true 时跳过年度 Close 进程内缓存')):
    return app_rates.annual_rates(year, currencies, refresh)


@app.get('/api/asset-rates')
def api_asset_rates(currencies: str | None=Query(default='HKD,USD', description='资产换算币种，缺省为 HKD、USD'), refresh: bool=Query(default=False, description='为 true 时跳过实际交易日 Close 进程内缓存')):
    return app_rates.asset_rates(currencies, refresh)


@app.post('/api/annual-budget')
def api_annual_budget(req: app_contracts.AnnualBudgetRequest):
    return app_budget.annual_budget(req)


# 静态挂载最后注册，避免遮挡 API。
app.mount("/", StaticFiles(directory=app_config.WEB_DIR, html=True), name="web")
