"""HTTP 边界、错误映射和静态服务装配。"""

from __future__ import annotations

from fastapi import Query
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
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
def api_data_upload():
    return app_repository.data_upload()


@app.get('/api/state')
def api_get_state():
    return app_state.get_state()


@app.put('/api/state')
def api_put_state(body: app_contracts.AppStateIn):
    return app_state.put_state(body)


@app.get('/api/meta')
def api_meta():
    return app_metadata.meta()


@app.post('/api/defaults')
def api_save_defaults(body: app_contracts.DefaultsPayload):
    return app_metadata.save_defaults(body)


@app.post('/api/defaults/reset')
def api_reset_defaults(body: app_contracts.DefaultsResetIn):
    return app_metadata.reset_defaults(body)


@app.get('/api/rates')
def api_rates(year: int, month: int, currencies: str | None=Query(default=None, description='逗号分隔的币种列表，缺省为全部'), refresh: bool=Query(default=False, description='为 true 时忽略内存/磁盘缓存，重新向 Yahoo Finance 下载')):
    return app_rates.rates(year, month, currencies, refresh)


@app.get('/api/annual-rates')
def api_annual_rates(year: int, currencies: str | None=Query(default=None, description='逗号分隔的币种列表，缺省为全部'), refresh: bool=Query(default=False, description='为 true 时跳过年度 Close 进程内缓存')):
    return app_rates.annual_rates(year, currencies, refresh)


@app.get('/api/asset-rates')
def api_asset_rates(currencies: str | None=Query(default='HKD,USD', description='资产换算币种，缺省为 HKD、USD'), refresh: bool=Query(default=False, description='为 true 时跳过实际交易日 Close 进程内缓存')):
    return app_rates.asset_rates(currencies, refresh)


@app.post('/api/annual-budget')
def api_annual_budget(req: app_contracts.AnnualBudgetRequest):
    return app_budget.annual_budget(req)


@app.post('/api/calculate')
def api_calculate(req: app_contracts.CalculateRequest):
    return app_budget.calculate(req)


# 静态挂载最后注册，避免遮挡 API。
app.mount("/", StaticFiles(directory=app_config.WEB_DIR, html=True), name="web")
