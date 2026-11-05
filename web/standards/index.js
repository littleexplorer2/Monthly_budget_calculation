/* 当月完整标准快照的读取、编辑与渲染同步。
 * 跨模块调用由 web/js/app.js 显式注入；模块只导出本职责的接口。
 */
(function register(registry) {
  'use strict';
  registry.standards = Object.freeze({
    dependencies: Object.freeze(["locations","monthly","shared","standardsEditor","state"]),
    create({ locations: locationsModule, monthly: monthlyModule, shared: sharedModule, standardsEditor: standardsEditorModule, state: stateModule }, service = {}) {
      const { state } = stateModule;

      function resetStandardsToDefault() {
        state.standards = sharedModule.deepClone(state.meta.default_standards);
        state.monthLocations = null;
        state.monthLocationNames = null;
        state.monthCurrencyNames = null;
        state.monthStandardsSnapshot = false;
      }

      function currentStandardsSnapshot() {
        return {
          _snapshot: true,
          variable: sharedModule.deepClone(state.standards.variable),
          travel: sharedModule.deepClone(state.standards.travel),
          custom_locations: sharedModule.deepClone(state.customLocations || []),
          custom_currencies: sharedModule.deepClone(state.customCurrencies || {}),
          _locations: sharedModule.deepClone(locationsModule.allLocations()),
          _location_names: standardsEditorModule.snapshotLocationNames(),
          _currency_names: standardsEditorModule.snapshotCurrencyNames(),
        };
      }

      /** 读取 overrides 的月份映射表 { 'YYYY-MM': {variable,fixed,travel} } */
      function loadOverridesMap() {
        return Object.fromEntries(Object.entries(state.monthsByKey || {})
          .filter(([, entity]) => entity && entity.standards)
          .map(([key, entity]) => [key, entity.standards]));
      }

      function snapshotOverridesIntoState() {
        if (!state.meta || !state.year || !state.month || !state.standards) return;
        const key = monthlyModule.monthKey();
        const entity = state.monthsByKey[key];
        if (!entity) return;
        entity.standards = service.currentStandardsSnapshot();
        state.monthStandardsSnapshot = true;
      }

      /** 把当月完整标准快照写入统一状态；实际落盘只由 saveState/persist 负责。 */
      function saveOverrides() {
        service.snapshotOverridesIntoState();
      }

      /** 读取当前月份的预算标准修改并合并到默认标准 */
      function loadOverrides() {
        const entity = state.monthsByKey[monthlyModule.monthKey()];
        const monthOv = entity && entity.standards;
        if (monthOv && typeof monthOv === 'object') {
          if (monthOv._snapshot) {
            state.monthLocations = sharedModule.deepClone(monthOv._locations || []);
            state.monthLocationNames = sharedModule.deepClone(monthOv._location_names || {});
            state.monthCurrencyNames = sharedModule.deepClone(monthOv._currency_names || {});
            state.monthStandardsSnapshot = true;
          }
          service.applyStandards(monthOv);
          return true;
        }
        return false;
      }

      /** 载入当月「新建预算标准」产生的自定义地点与币种名，并初始化标准容器 */
      function applyCustoms(saved) {
        const defaultKeys = new Set((state.meta && state.meta.locations || []).map((l) => l.key));
        const customs = (saved && Array.isArray(saved.custom_locations))
          ? saved.custom_locations.filter((c) => c && c.key && (c.category === 'variable' || c.category === 'travel') && c.currency && !defaultKeys.has(c.key))
          : [];
        state.customLocations = customs;
        const knownCurr = new Set((state.meta && state.meta.currencies) || []);
        const rawCurr = (saved && saved.custom_currencies && typeof saved.custom_currencies === 'object')
          ? saved.custom_currencies
          : {};
        state.customCurrencies = {};
        for (const [k, v] of Object.entries(rawCurr)) {
          if (!knownCurr.has(k)) state.customCurrencies[k] = v;
        }
        for (const c of customs) {
          if (c.category === 'variable') {
            if (!state.standards.variable[c.key]) state.standards.variable[c.key] = {};
            if (!(c.currency in state.standards.variable[c.key])) {
              state.standards.variable[c.key][c.currency] = 0;
            }
          } else {
            if (!state.standards.travel[c.key]) state.standards.travel[c.key] = {};
            if (!(c.currency in state.standards.travel[c.key])) {
              state.standards.travel[c.key][c.currency] = { daily: 0, once: 0 };
            }
          }
        }
      }

      /** 读取当月完整快照或兼容旧版差异（含当月新建地点/币种）。
       *  对旧版差异，缺失项必须保留默认值；null/undefined 不能覆盖有效默认值。 */
      function applyStandards(saved) {
        service.applyCustoms(saved);
        const defs = state.meta.default_standards;
        const num = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; };
        // 取覆盖值：路径任一环节缺失 → 返回 null（表示"使用默认值"）
        const pick = (holder, loc, curr) => {
          const entry = holder && holder[loc];
          return entry && entry[curr] != null ? num(entry[curr]) : null;
        };

        // 可变：默认地点 + 自定义定居地点
        const varLocs = new Set([
          ...Object.keys(defs.variable),
          ...locationsModule.activeCustomLocations().filter((c) => c.category === 'variable').map((c) => c.key),
        ]);
        for (const loc of varLocs) {
          const curr = locationsModule.locationCurrency(loc);
          const v = pick(saved.variable, loc, curr);
          if (v !== null) state.standards.variable[loc][curr] = v;
        }
        // 旅居：默认地点 + 自定义旅居地点
        const trLocs = new Set([
          ...Object.keys(defs.travel),
          ...locationsModule.activeCustomLocations().filter((c) => c.category === 'travel').map((c) => c.key),
        ]);
        for (const loc of trLocs) {
          const curr = locationsModule.locationCurrency(loc);
          const sub = saved.travel && saved.travel[loc] && saved.travel[loc][curr];
          if (sub && typeof sub === 'object') {
            for (const f of ['daily', 'once']) {
              const v = num(sub[f]);
              if (v !== null) state.standards.travel[loc][curr][f] = v;
            }
          }
        }
        service.ensureExtraStandards();
      }

      /** 额外预算旧合同保持为显式零值，不能形成订阅以外的第二套金额来源。 */
      function ensureExtraStandards() {
        if (!state.standards.extra || typeof state.standards.extra !== 'object') state.standards.extra = {};
        for (const curr of sharedModule.EXTRA_CURRENCIES) {
          state.standards.extra[curr] = 0;
        }
      }

      Object.assign(service, {
        resetStandardsToDefault,
        currentStandardsSnapshot,
        loadOverridesMap,
        snapshotOverridesIntoState,
        saveOverrides,
        loadOverrides,
        applyCustoms,
        applyStandards,
        ensureExtraStandards,
      });

      return service;
    },
  });
})(window.BudgetModules || (window.BudgetModules = Object.create(null)));
