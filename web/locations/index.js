/* 地点、币种名称与颜色查询。
 * 跨模块调用由 web/js/app.js 显式注入；模块只导出本职责的接口。
 */
(function register(registry) {
  'use strict';
  registry.locations = Object.freeze({
    dependencies: Object.freeze(["shared","state"]),
    create({ shared: sharedModule, state: stateModule }, service = {}) {
      const { state } = stateModule;

      function locName(key) {
        if (key === 'Extra') return '额外预算';
        if (state.monthLocationNames && state.monthLocationNames[key]) {
          return state.monthLocationNames[key];
        }
        if (state.meta && state.meta.location_names && state.meta.location_names[key]) {
          return state.meta.location_names[key];
        }
        const onDefaults = state.editingDefaults && state.defaultsDraft;
        if (onDefaults && onDefaults.locationNames && onDefaults.locationNames[key]) {
          return onDefaults.locationNames[key];
        }
        const c = service.activeCustomLocations().find((x) => x.key === key);
        return c ? c.name : key;
      }

      /** 当前编辑目标下的自定义地点列表（默认标准草稿模式取草稿） */
      function activeCustomLocations() {
        if (state.editingDefaults && state.defaultsDraft) return state.defaultsDraft.locations || [];
        return state.customLocations || [];
      }

      /** 当前编辑目标下的自定义币种名（默认标准草稿模式取草稿） */
      function activeCustomCurrencies() {
        if (state.editingDefaults && state.defaultsDraft) return state.defaultsDraft.currencyNames || {};
        return state.customCurrencies || {};
      }

      /** 全部地点列表（默认 + 当月自定义），用于颜色索引与展示 */
      function allLocations() {
        const defaults = state.monthLocations || (state.meta && state.meta.locations) || [];
        const byKey = new Map(defaults.map((loc) => [loc.key, loc]));
        for (const loc of service.activeCustomLocations()) byKey.set(loc.key, loc);
        return Array.from(byKey.values());
      }

      /** 地点所属类别：variable（定居）| travel（旅居） */
      function locationCategory(loc) {
        const d = (state.monthLocations || state.meta && state.meta.locations || []).find((l) => l.key === loc);
        if (d) return d.category;
        const c = service.activeCustomLocations().find((x) => x.key === loc);
        return c ? c.category : null;
      }

      /** 地点币种：默认地点取默认，自定义地点取用户输入 */
      function locationCurrency(loc) {
        const d = (state.monthLocations || state.meta && state.meta.locations || []).find((l) => l.key === loc);
        if (d) return d.currency;
        const c = service.activeCustomLocations().find((x) => x.key === loc);
        return c ? c.currency : null;
      }

      function currencyName(key) {
        if (state.monthCurrencyNames && state.monthCurrencyNames[key]) {
          return state.monthCurrencyNames[key];
        }
        if (state.meta && state.meta.currency_names && state.meta.currency_names[key]) {
          return state.meta.currency_names[key];
        }
        const customs = service.activeCustomCurrencies();
        return (customs && customs[key]) || key;
      }

      function currencyPriority() {
        const configured = state.meta && state.meta.currency_priority;
        return Array.isArray(configured) && configured.length
          ? configured.map((currency) => String(currency).toUpperCase())
          : ['CNY', 'HKD', 'USD'];
      }

      function compareCurrencies(left, right) {
        const a = String(left).toUpperCase();
        const b = String(right).toUpperCase();
        const priority = service.currencyPriority();
        const aIndex = priority.indexOf(a);
        const bIndex = priority.indexOf(b);
        if (aIndex >= 0 || bIndex >= 0) {
          if (aIndex < 0) return 1;
          if (bIndex < 0) return -1;
          if (aIndex !== bIndex) return aIndex - bIndex;
        }
        return a.localeCompare(b, 'en');
      }

      function orderedCurrencies(currencies) {
        return Array.from(new Set(Array.from(currencies || [], (currency) => String(currency).toUpperCase())))
          .sort(service.compareCurrencies);
      }

      function regionName(key) {
        const r = (state.meta && state.meta.regions || []).find((x) => x.key === key);
        return r ? r.name : key;
      }

      /* ---------- 地点差异化配色 ---------- */
      function hexToRgba(hex, alpha) {
        const n = parseInt(hex.slice(1), 16);
        return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
      }

      function locColor(loc) {
        const idx = service.allLocations().findIndex((l) => l.key === loc);
        return sharedModule.LOC_COLORS[idx >= 0 ? idx % sharedModule.LOC_COLORS.length : 0];
      }

      /** 返回内联 CSS 变量（--lc 主色 / --lc-soft 浅色 / --lc-border 边框色），
       *  用于芯片、日历格子、行程分组的地点色标注 */
      function locColorVars(loc) {
        const c = service.locColor(loc);
        return `--lc:${c};--lc-soft:${service.hexToRgba(c, 0.16)};--lc-border:${service.hexToRgba(c, 0.55)}`;
      }

      Object.assign(service, {
        locName,
        activeCustomLocations,
        activeCustomCurrencies,
        allLocations,
        locationCategory,
        locationCurrency,
        currencyName,
        currencyPriority,
        compareCurrencies,
        orderedCurrencies,
        regionName,
        hexToRgba,
        locColor,
        locColorVars,
      });

      return service;
    },
  });
})(window.BudgetModules || (window.BudgetModules = Object.create(null)));
