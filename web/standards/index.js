/* 当月标准快照、默认值合并及旧状态迁移。
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

      /** 把旧版差异或已有快照合并到指定默认标准，供状态迁移/固化使用。 */
      function mergeStandardsInto(base, saved) {
        const out = sharedModule.deepClone(base);
        const incoming = saved && typeof saved === 'object' ? saved : {};
        for (const cat of ['variable', 'fixed', 'travel']) {
          for (const [group, values] of Object.entries(incoming[cat] || {})) {
            if (!out[cat][group]) out[cat][group] = {};
            for (const [curr, value] of Object.entries(values || {})) {
              out[cat][group][curr] = (cat === 'travel' && value && typeof value === 'object')
                ? { daily: Number(value.daily), once: Number(value.once) }
                : Number(value);
            }
          }
        }
        out.extra = { ...(out.extra || {}) };
        for (const [curr, value] of Object.entries(incoming.extra || {})) out.extra[curr] = Number(value);
        return out;
      }

      function standardsSnapshot(defaults, saved) {
        if (saved && saved._snapshot) return sharedModule.deepClone(saved);
        const customs = saved && Array.isArray(saved.custom_locations) ? sharedModule.deepClone(saved.custom_locations) : [];
        const locations = sharedModule.deepClone((state.meta && state.meta.locations) || []);
        for (const loc of customs) {
          if (!locations.some((item) => item.key === loc.key)) locations.push(sharedModule.deepClone(loc));
        }
        return {
          _snapshot: true,
          ...service.mergeStandardsInto(defaults, saved),
          custom_locations: customs,
          custom_currencies: sharedModule.deepClone(saved && saved.custom_currencies || {}),
          _locations: locations,
          _location_names: sharedModule.deepClone(state.meta && state.meta.location_names || {}),
          _currency_names: sharedModule.deepClone(state.meta && state.meta.currency_names || {}),
        };
      }

      function currentStandardsSnapshot() {
        return {
          _snapshot: true,
          variable: sharedModule.deepClone(state.standards.variable),
          fixed: sharedModule.deepClone(state.standards.fixed),
          travel: sharedModule.deepClone(state.standards.travel),
          extra: sharedModule.deepClone(state.standards.extra || {}),
          custom_locations: sharedModule.deepClone(state.customLocations || []),
          custom_currencies: sharedModule.deepClone(state.customCurrencies || {}),
          _locations: sharedModule.deepClone(locationsModule.allLocations()),
          _location_names: standardsEditorModule.snapshotLocationNames(),
          _currency_names: standardsEditorModule.snapshotCurrencyNames(),
        };
      }

      function preserveExistingMonthsBeforeDefaultChange() {
        const currentKey = monthlyModule.monthKey();
        const keys = new Set([
          ...Object.keys(state.itineraryByMonth || {}),
          ...Object.keys(state.optionsByMonth || {}),
          ...Object.keys(state.overridesByMonth || {}),
          ...Object.keys(state.resultsByMonth || {}),
        ]);
        const map = service.loadOverridesMap();
        for (const key of keys) {
          if (key === currentKey) continue;
          map[key] = service.standardsSnapshot(state.meta.default_standards, map[key]);
        }
        // 当月数值可能完全等于旧默认值，因而没有 overrides 记录。
        // 必须直接固化当前内存值，否则默认值 POST 成功后异常退出，
        // 下次加载会把新默认值误当作当月数值。
        map[currentKey] = service.currentStandardsSnapshot();
        state.overridesByMonth = map;
        state.monthStandardsSnapshot = true;
      }

      function activeStandardsOverride() {
        // 计算请求必须携带用户刚刚确认的完整标准快照。只发送相对默认值的差异，
        // 会让另一标签页恰好保存的新默认值改变本页已经确认过的计算输入。
        return service.currentStandardsSnapshot();
      }

      /** 读取 overrides 的月份映射表 { 'YYYY-MM': {variable,fixed,travel} } */
      function loadOverridesMap() {
        return state.overridesByMonth && typeof state.overridesByMonth === 'object'
          ? state.overridesByMonth
          : {};
      }

      function snapshotOverridesIntoState() {
        if (!state.meta || !state.year || !state.month || !state.standards) return;
        const map = service.loadOverridesMap();
        const key = monthlyModule.monthKey();
        const existing = map[key];
        // 删除当前月份时，空对象是发给后端的显式墓碑；不能在同一笔 persist 中复活它。
        if (Object.prototype.hasOwnProperty.call(map, key)
            && existing && typeof existing === 'object'
            && !Object.keys(existing).length) return;
        map[key] = service.currentStandardsSnapshot();
        state.overridesByMonth = map;
        state.monthStandardsSnapshot = true;
      }

      /** 把当月完整标准快照写入统一状态；实际落盘只由 saveState/persist 负责。 */
      function saveOverrides() {
        service.snapshotOverridesIntoState();
      }

      /** 读取当前月份的预算标准修改并合并到默认标准 */
      function loadOverrides() {
        const map = service.loadOverridesMap();
        const monthOv = map[monthlyModule.monthKey()];
        if (monthOv && typeof monthOv === 'object') {
          if (monthOv._snapshot) {
            state.standards = sharedModule.deepClone({
              variable: monthOv.variable || {},
              fixed: monthOv.fixed || {},
              travel: monthOv.travel || {},
              extra: monthOv.extra || {},
            });
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
        // 固定：默认币种 + 覆盖中新增的自定义币种
        for (const reg of Object.keys(defs.fixed)) {
          const savedReg = saved.fixed && saved.fixed[reg];
          const currs = new Set([
            ...Object.keys(defs.fixed[reg]),
            ...(savedReg && typeof savedReg === 'object' ? Object.keys(savedReg) : []),
          ]);
          for (const curr of currs) {
            const v = pick(saved.fixed, reg, curr);
            if (v !== null) state.standards.fixed[reg][curr] = v;
          }
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
        // 额外预算：缺失则保持默认 0
        service.ensureExtraStandards();
        const savedExtra = saved.extra;
        if (savedExtra && typeof savedExtra === 'object') {
          for (const curr of sharedModule.EXTRA_CURRENCIES) {
            const v = num(savedExtra[curr]);
            if (v !== null) state.standards.extra[curr] = v;
          }
        }
      }

      /** 保证额外预算三项存在（默认 0），兼容旧存档没有 extra 的情况 */
      function ensureExtraStandards() {
        const defs = (state.meta && state.meta.default_standards && state.meta.default_standards.extra) || {};
        if (!state.standards.extra || typeof state.standards.extra !== 'object') state.standards.extra = {};
        for (const curr of sharedModule.EXTRA_CURRENCIES) {
          if (state.standards.extra[curr] == null) {
            const n = Number(defs[curr]);
            state.standards.extra[curr] = Number.isFinite(n) && n >= 0 ? n : 0;
          }
        }
      }

      Object.assign(service, {
        resetStandardsToDefault,
        mergeStandardsInto,
        standardsSnapshot,
        currentStandardsSnapshot,
        preserveExistingMonthsBeforeDefaultChange,
        activeStandardsOverride,
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
