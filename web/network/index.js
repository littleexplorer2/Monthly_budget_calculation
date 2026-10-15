/* 行情网络连接提示。
 * 跨模块调用由 web/js/app.js 显式注入；模块只导出本职责的接口。
 */
(function register(registry) {
  'use strict';
  registry.network = Object.freeze({
    dependencies: Object.freeze(["http","feedback","shared"]),
    create({ http: apiModule, feedback: feedbackModule, shared: sharedModule }, service = {}) {

      /* --------------------------------------------------------------------------
       * Yahoo Finance 连通性检测（打开页面时自动执行，失败时提示打开 VPN）
       * ------------------------------------------------------------------------ */
      function showNetworkWarning(message) {
        const banner = sharedModule.$('#network-banner');
        if (!banner) return;
        sharedModule.$('#network-banner-text').textContent = message
          || '网络异常：无法连接 Yahoo Finance 获取汇率数据，请打开 VPN 后重试。';
        feedbackModule.setElVisible(banner, true);
      }

      function hideNetworkWarning() {
        feedbackModule.setElVisible(sharedModule.$('#network-banner'), false);
      }

      async function runNetworkCheck(manual = false) {
        try {
          const data = await apiModule.api('/api/network-check', { timeout: 20000 });
          if (data && data.ok === true) {
            service.hideNetworkWarning();
            if (manual) feedbackModule.toast('网络正常：Yahoo Finance 可正常访问', 'success');
          } else {
            const msg = (data && data.hint)
              || '网络异常：无法连接 Yahoo Finance 获取汇率数据，请打开 VPN 后重试。';
            service.showNetworkWarning(msg);
            if (manual) feedbackModule.toast(msg, 'error');
          }
        } catch (err) {
          // 本地后端本身不可达（连不上 127.0.0.1）时不在页面上弹 VPN 提示
          if (manual) feedbackModule.toast(`检测失败：${err.message}`, 'error');
        }
      }

      /** 汇率相关请求失败（502/下载异常）时，同步点亮网络横幅 */
      function maybeShowNetworkWarning(errorMessage) {
        if (/汇率|下载|Yahoo/i.test(String(errorMessage))) {
          service.showNetworkWarning();
        }
      }

      Object.assign(service, {
        showNetworkWarning,
        hideNetworkWarning,
        runNetworkCheck,
        maybeShowNetworkWarning,
      });

      return service;
    },
  });
})(window.BudgetModules || (window.BudgetModules = Object.create(null)));
