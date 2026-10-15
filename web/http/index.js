/* HTTP 请求、超时及中文错误边界。
 * 跨模块调用由 web/js/app.js 显式注入；模块只导出本职责的接口。
 */
(function register(registry) {
  'use strict';
  registry.http = Object.freeze({
    dependencies: Object.freeze([]),
    create({  }, service = {}) {

      /* --------------------------------------------------------------------------
       * API 封装（统一错误处理与超时）
       * ------------------------------------------------------------------------ */
      async function api(path, options = {}) {
        const controller = new AbortController();
        const timeoutMs = options.timeout || 120000;
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const resp = await fetch(path, {
            method: options.method || 'GET',
            headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
            body: options.body ? JSON.stringify(options.body) : undefined,
            signal: controller.signal,
          });
          let data = null;
          try { data = await resp.json(); } catch (_) { /* 非 JSON 响应 */ }
          if (!resp.ok) {
            const msg = (data && data.error && data.error.message) || `请求失败（HTTP ${resp.status}）`;
            const error = new Error(msg);
            error.code = data && data.error && data.error.code;
            error.status = resp.status;
            throw error;
          }
          return data;
        } catch (err) {
          if (err.name === 'AbortError') throw new Error('请求超时，请稍后重试');
          throw err;
        } finally {
          clearTimeout(timer);
        }
      }

      Object.assign(service, {
        api,
      });

      return service;
    },
  });
})(window.BudgetModules || (window.BudgetModules = Object.create(null)));
