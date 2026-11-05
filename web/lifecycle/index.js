/* 标签页注册、心跳、离开页面时最终保存。
 * 跨模块调用由 web/js/app.js 显式注入；模块只导出本职责的接口。
 */
(function register(registry) {
  'use strict';
  registry.lifecycle = Object.freeze({
    dependencies: Object.freeze(["http","persistence"]),
    create({ http: apiModule, persistence: persistenceModule }, service = {}) {
      const runtime = {
        tabUnregistered: false,
        tabHeartbeatTimer: null,
      };

      // localStorage 镜像的行程/选项月份上限（服务器真源不裁剪）
      const TAB_HEARTBEAT_INTERVAL_MS = 5000;
      const KEEPALIVE_PAYLOAD_LIMIT_BYTES = 60 * 1024;

      /* --------------------------------------------------------------------------
       * 浏览器标签页生命周期（配合后端「关闭页面立即停止服务并释放端口」）
       * - 页面加载 → 注册 tab；普通 pagehide（关闭/刷新/导航）→ 先保存再注销 tab；
       *   后端在最后一个 tab 注销后保留短宽限期再退出进程。
       * - 进入 bfcache 的 pagehide 不注销；普通刷新和多标签会按各自生命周期注册。
       * - 每 5 秒刷新一次服务器租约；后台节流时服务端保留 5 分钟租约。
       * - 关闭前做最后一次保存（行程 + 当月选项 + 标准修改均已落盘）。
       * ------------------------------------------------------------------------ */
      const TAB_ID = (window.crypto && typeof window.crypto.randomUUID === 'function')
        ? window.crypto.randomUUID()
        : `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      function scheduleTabHeartbeat() {
        clearTimeout(runtime.tabHeartbeatTimer);
        if (runtime.tabUnregistered) return;
        runtime.tabHeartbeatTimer = setTimeout(service.heartbeatTab, TAB_HEARTBEAT_INTERVAL_MS);
        // Node 测试环境不要让后台心跳阻止进程结束；浏览器的数字 timer 无此方法。
        if (runtime.tabHeartbeatTimer && typeof runtime.tabHeartbeatTimer.unref === 'function') {
          runtime.tabHeartbeatTimer.unref();
        }
      }

      async function heartbeatTab() {
        if (runtime.tabUnregistered) return;
        try {
          await apiModule.api('/api/tabs/heartbeat', {
            method: 'POST', body: { tab_id: TAB_ID }, timeout: 8000,
          });
        } catch (_) { /* 短暂失败由下一次心跳或服务端租约处理 */ }
        service.scheduleTabHeartbeat();
      }

      function registerTab() {
        apiModule.api('/api/tabs/register', { method: 'POST', body: { tab_id: TAB_ID }, timeout: 10000 })
          .catch(() => { /* 服务尚未就绪等场景忽略 */ });
        service.scheduleTabHeartbeat();
      }

      function unregisterTab() {
        if (runtime.tabUnregistered) return;
        runtime.tabUnregistered = true;
        clearTimeout(runtime.tabHeartbeatTimer);
        runtime.tabHeartbeatTimer = null;
        clearTimeout(persistenceModule.runtime.persistTimer);
        persistenceModule.runtime.pendingPersistScope = null;
        const localBundle = persistenceModule.snapshotBundle();
        persistenceModule.writeLocalCache(localBundle);
        const unregisterPayload = { tab_id: TAB_ID };
        if (persistenceModule.runtime.serverStateReady) {
          const finalWrite = persistenceModule.finalWriteBundle();
          if (finalWrite.months.length || finalWrite.global) unregisterPayload.state = finalWrite;
          const dirtyMonthCount = Object.values(persistenceModule.runtime.dirtyMonthFields)
            .filter((fields) => fields && fields.size).length;
          // revision=0 草稿必须先走 ensure；keepalive 不能替它绕过显式建月。
          if (dirtyMonthCount > finalWrite.months.length) unregisterPayload.state_omitted = true;
        }
        let payload = JSON.stringify(unregisterPayload);
        if (new Blob([payload]).size > KEEPALIVE_PAYLOAD_LIMIT_BYTES) {
          // 浏览器通常拒绝超过约 64 KiB 的 sendBeacon/keepalive 请求。状态已先写入
          // localStorage；显式通知服务端不要自动退出，避免把未传输数据当成已保存。
          payload = JSON.stringify({ tab_id: TAB_ID, state_omitted: true });
        }
        const fallbackFetch = () => fetch('/api/tabs/unregister', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
          keepalive: true,
        }).catch(() => { /* 忽略 */ });
        let queued = false;
        try {
          if (typeof navigator.sendBeacon === 'function') {
            queued = navigator.sendBeacon(
              '/api/tabs/unregister', new Blob([payload], { type: 'application/json' }),
            );
          }
        } catch (_) { /* 忽略 */ }
        if (!queued) {
          try { fallbackFetch(); } catch (_) { /* 忽略 */ }
        }
      }

      function start() {
        // pagehide 同时覆盖普通导航、刷新和关闭；进入 bfcache 时页面仍然存活，
        // 不能注销最后一个标签页并触发后端退出。
        window.addEventListener('pagehide', (ev) => {
          if (ev.persisted) return;
          service.unregisterTab();
        });
        window.addEventListener('pageshow', (ev) => {
          if (!ev.persisted || !runtime.tabUnregistered) return;
          runtime.tabUnregistered = false;
          service.registerTab();
        });
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible' && !runtime.tabUnregistered) {
            service.heartbeatTab();
          }
        });
        // 立即注册（无需等待 DOM，避免关闭倒计时期间页面加载完成前服务退出）
        service.registerTab();
      }

      Object.assign(service, {
        runtime,
        TAB_HEARTBEAT_INTERVAL_MS,
        KEEPALIVE_PAYLOAD_LIMIT_BYTES,
        TAB_ID,
        scheduleTabHeartbeat,
        heartbeatTab,
        registerTab,
        unregisterTab,
        start,
      });

      return service;
    },
  });
})(window.BudgetModules || (window.BudgetModules = Object.create(null)));
