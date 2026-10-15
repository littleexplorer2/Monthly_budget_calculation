/* 通知及加载状态展示。
 * 跨模块调用由 web/js/app.js 显式注入；模块只导出本职责的接口。
 */
(function register(registry) {
  'use strict';
  registry.feedback = Object.freeze({
    dependencies: Object.freeze(["shared"]),
    create({ shared: sharedModule }, service = {}) {
      const runtime = {
        toastTimer: null,
      };

      function toast(msg, type = 'info') {
        const el = sharedModule.$('#toast');
        el.textContent = msg;
        el.className = `toast show ${type}`;
        clearTimeout(runtime.toastTimer);
        runtime.toastTimer = setTimeout(() => { el.className = 'toast'; }, 3600);
      }

      function setElVisible(el, on) {
        if (!el) return;
        el.classList.toggle('hidden', !on);
        if (on) el.removeAttribute('hidden');
        else el.setAttribute('hidden', '');
      }

      function setLoading(on, text) {
        service.setElVisible(sharedModule.$('#loading-overlay'), !!on);
        const label = sharedModule.$('#loading-text');
        if (text && label) label.textContent = text;
        if (!on && label) label.textContent = '加载中…';
      }

      Object.assign(service, {
        runtime,
        toast,
        setElVisible,
        setLoading,
      });

      return service;
    },
  });
})(window.BudgetModules || (window.BudgetModules = Object.create(null)));
