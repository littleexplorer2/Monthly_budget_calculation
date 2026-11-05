/* v2 月份实体、全局实体的唯一写队列与本地未同步镜像。
 * 跨模块调用由 web/js/app.js 显式注入；模块只导出本职责的接口。
 */
(function register(registry) {
  'use strict';
  registry.persistence = Object.freeze({
    dependencies: Object.freeze(["http","feedback","itinerary","lifecycle","monthly","results","shared","standards","state"]),
    create({ http: apiModule, feedback: feedbackModule, itinerary: itineraryModule, lifecycle: lifecycleModule, monthly: monthlyModule, results: resultsModule, shared: sharedModule, standards: standardsModule, state: stateModule }, service = {}) {
      const { state } = stateModule;
      const MONTH_FIELDS = Object.freeze(['itinerary', 'options', 'standards', 'subscriptions', 'result']);
      const GLOBAL_FIELDS = Object.freeze(['annualBudgetsByYear', 'annualResultsByYear', 'assetPortfoliosById']);
      const STORE_KEY = 'budget-web-state-v2';
      const UNSYNCED_KEY = 'budget-web-state-v2-unsynced';
      const MAX_KEPT_MONTHS = 60;

      const runtime = {
        persistTimer: null,
        persistChain: Promise.resolve(),
        pendingPersistScope: null,
        serverStateReady: false,
        serverMonthBaselines: Object.create(null),
        globalBaseline: null,
        dirtyMonthFields: Object.create(null),
        dirtyGlobalFields: new Set(),
        activeMonthWrites: new Set(),
        activeGlobalWrite: false,
        sessionMonthlyTouched: false,
        sessionAnnualTouched: false,
      };

      function sameValue(left, right) {
        return JSON.stringify(left) === JSON.stringify(right);
      }

      function compactResult(result) {
        if (!result || typeof result !== 'object') return result == null ? null : {};
        return Object.fromEntries(Object.entries(result).filter(([key]) => !['rates', 'rates_dict'].includes(key)));
      }

      function compactResultsMap(map) {
        return Object.fromEntries(Object.entries(map || {}).map(([key, value]) => [key, service.compactResult(value)]));
      }

      function cleanAnnualBudgetsMap(map) {
        const out = {};
        for (const [year, amounts] of Object.entries(map && typeof map === 'object' ? map : {})) {
          if (!/^\d{4}$/.test(year) || !amounts || typeof amounts !== 'object') continue;
          const clean = {};
          for (const [rawCurrency, rawAmount] of Object.entries(amounts)) {
            const currency = String(rawCurrency).trim().toUpperCase();
            const amount = Number(rawAmount);
            if (/^[A-Z]{2,6}$/.test(currency) && Number.isFinite(amount) && amount >= 0) clean[currency] = amount;
          }
          if (Object.keys(clean).length) out[year] = clean;
        }
        return out;
      }

      function compactAnnualResultsMap(map) {
        const out = {};
        for (const [year, result] of Object.entries(map && typeof map === 'object' ? map : {})) {
          if (!/^\d{4}$/.test(year) || !result || typeof result !== 'object') continue;
          const clean = Object.fromEntries(Object.entries(result)
            .filter(([key]) => !['rates', 'rates_dict', 'series'].includes(key)));
          if (Object.keys(clean).length) out[year] = clean;
        }
        return out;
      }

      function monthData(entity) {
        const source = entity && typeof entity === 'object' ? entity : {};
        return {
          itinerary: itineraryModule.exclusiveItineraryMonth(source.itinerary || {}),
          options: sharedModule.deepClone(source.options || monthlyModule.defaultMonthOptions()),
          standards: sharedModule.deepClone(source.standards || service.defaultStandardsSnapshot()),
          subscriptions: sharedModule.deepClone(source.subscriptions || { items: [], retiredIds: [] }),
          result: service.compactResult(source.result),
        };
      }

      function defaultStandardsSnapshot() {
        const meta = state.meta || {};
        const defaults = meta.default_standards || { variable: {}, travel: {} };
        return {
          _snapshot: true,
          variable: sharedModule.deepClone(defaults.variable || {}),
          travel: sharedModule.deepClone(defaults.travel || {}),
          custom_locations: [],
          custom_currencies: {},
          _locations: sharedModule.deepClone(meta.locations || []),
          _location_names: sharedModule.deepClone(meta.location_names || {}),
          _currency_names: sharedModule.deepClone(meta.currency_names || {}),
        };
      }

      function ensureLocalMonthDraft(key = monthlyModule.monthKey()) {
        if (state.monthsByKey[key]) return state.monthsByKey[key];
        const entity = {
          schemaVersion: 2,
          month: key,
          revision: 0,
          updatedAt: new Date().toISOString(),
          itinerary: {},
          options: monthlyModule.defaultMonthOptions(),
          standards: service.defaultStandardsSnapshot(),
          subscriptions: { items: [], retiredIds: [] },
          result: null,
        };
        state.monthsByKey[key] = entity;
        return entity;
      }

      function currentMonthEntity({ create = false } = {}) {
        const key = monthlyModule.monthKey();
        return state.monthsByKey[key] || (create ? service.ensureLocalMonthDraft(key) : null);
      }

      function markMonthDirty(field, key = monthlyModule.monthKey()) {
        if (!MONTH_FIELDS.includes(field)) throw new Error(`未知月份字段：${field}`);
        service.ensureLocalMonthDraft(key);
        if (!runtime.dirtyMonthFields[key]) runtime.dirtyMonthFields[key] = new Set();
        runtime.dirtyMonthFields[key].add(field);
        runtime.sessionMonthlyTouched = true;
        service.writeLocalCache(service.snapshotBundle());
      }

      function markGlobalDirty(field) {
        if (!GLOBAL_FIELDS.includes(field)) throw new Error(`未知全局字段：${field}`);
        runtime.dirtyGlobalFields.add(field);
        runtime.sessionAnnualTouched = true;
        service.writeLocalCache(service.snapshotBundle());
      }

      function globalData() {
        return {
          annualBudgetsByYear: service.cleanAnnualBudgetsMap(state.annualBudgetsByYear),
          annualResultsByYear: service.compactAnnualResultsMap(state.annualResultsByYear),
          assetPortfoliosById: sharedModule.deepClone(state.assetPortfoliosById || {}),
        };
      }

      function snapshotBundle() {
        const dirtyMonths = {};
        for (const [key, fields] of Object.entries(runtime.dirtyMonthFields)) {
          if (fields && fields.size) dirtyMonths[key] = Array.from(fields);
        }
        return {
          schemaVersion: 2,
          updatedAt: new Date().toISOString(),
          months: sharedModule.deepClone(state.monthsByKey || {}),
          global: {
            schemaVersion: 2,
            revision: state.globalRevision || 0,
            selectedMonth: state.year && state.month ? monthlyModule.monthKey() : null,
            ...service.globalData(),
          },
          dirty: { months: dirtyMonths, global: Array.from(runtime.dirtyGlobalFields) },
        };
      }

      function writeLocalCache(bundle) {
        try {
          const snap = sharedModule.deepClone(bundle || service.snapshotBundle());
          const keys = Object.keys(snap.months || {}).sort();
          const current = state.year && state.month ? monthlyModule.monthKey() : null;
          while (keys.length > MAX_KEPT_MONTHS) {
            const index = keys.findIndex((key) => key !== current && !(snap.dirty.months[key] || []).length);
            if (index < 0) break;
            delete snap.months[keys[index]];
            keys.splice(index, 1);
          }
          localStorage.setItem(STORE_KEY, JSON.stringify(snap));
          const hasDirty = Object.keys(snap.dirty.months || {}).length || (snap.dirty.global || []).length;
          if (hasDirty) localStorage.setItem(UNSYNCED_KEY, '1');
          else localStorage.removeItem(UNSYNCED_KEY);
        } catch (err) {
          console.warn('本机 v2 状态镜像写入失败', err);
        }
      }

      function readLocalBundle() {
        try {
          const raw = localStorage.getItem(STORE_KEY);
          if (!raw) return null;
          const parsed = JSON.parse(raw);
          return parsed && parsed.schemaVersion === 2 ? parsed : null;
        } catch (err) {
          console.warn('本机 v2 状态镜像读取失败', err);
          return null;
        }
      }

      function applyServerData(monthBundle, globalDocument) {
        const months = monthBundle && monthBundle.months && typeof monthBundle.months === 'object'
          ? monthBundle.months : {};
        const globalState = globalDocument && typeof globalDocument === 'object' ? globalDocument : {};
        state.monthsByKey = sharedModule.deepClone(months);
        state.globalRevision = Number.isInteger(globalState.revision) ? globalState.revision : 0;
        state.annualBudgetsByYear = service.cleanAnnualBudgetsMap(globalState.annualBudgetsByYear || {});
        state.annualResultsByYear = service.compactAnnualResultsMap(globalState.annualResultsByYear || {});
        state.assetPortfoliosById = sharedModule.deepClone(globalState.assetPortfoliosById || {});
        runtime.serverMonthBaselines = sharedModule.deepClone(months);
        runtime.globalBaseline = sharedModule.deepClone(globalState);
        runtime.serverStateReady = true;
        runtime.dirtyMonthFields = Object.create(null);
        runtime.dirtyGlobalFields = new Set();
        return globalState.selectedMonth || null;
      }

      function acceptSavedMonth(document) {
        if (!document || document.schemaVersion !== 2 || !document.month) return;
        state.monthsByKey[document.month] = sharedModule.deepClone(document);
        runtime.serverMonthBaselines[document.month] = sharedModule.deepClone(document);
        delete runtime.dirtyMonthFields[document.month];
        service.writeLocalCache(service.snapshotBundle());
      }

      function applyLocalRecovery(bundle) {
        if (!bundle || bundle.schemaVersion !== 2 || !bundle.dirty) return false;
        let recovered = false;
        for (const [key, fields] of Object.entries(bundle.dirty.months || {})) {
          const cached = bundle.months && bundle.months[key];
          if (!cached || !Array.isArray(fields) || !fields.length) continue;
          const target = state.monthsByKey[key] || service.ensureLocalMonthDraft(key);
          for (const field of fields) {
            if (!MONTH_FIELDS.includes(field)) continue;
            target[field] = sharedModule.deepClone(cached[field]);
            if (!runtime.dirtyMonthFields[key]) runtime.dirtyMonthFields[key] = new Set();
            runtime.dirtyMonthFields[key].add(field);
          }
          recovered = true;
        }
        for (const field of bundle.dirty.global || []) {
          if (!GLOBAL_FIELDS.includes(field)) continue;
          state[field] = sharedModule.deepClone((bundle.global || {})[field] || {});
          runtime.dirtyGlobalFields.add(field);
          recovered = true;
        }
        return recovered;
      }

      function applyOfflineBundle(bundle) {
        if (!bundle || bundle.schemaVersion !== 2) return null;
        state.monthsByKey = sharedModule.deepClone(bundle.months || {});
        const globalState = bundle.global || {};
        state.globalRevision = Number.isInteger(globalState.revision) ? globalState.revision : 0;
        state.annualBudgetsByYear = service.cleanAnnualBudgetsMap(globalState.annualBudgetsByYear || {});
        state.annualResultsByYear = service.compactAnnualResultsMap(globalState.annualResultsByYear || {});
        state.assetPortfoliosById = sharedModule.deepClone(globalState.assetPortfoliosById || {});
        runtime.dirtyMonthFields = Object.create(null);
        for (const [key, fields] of Object.entries((bundle.dirty && bundle.dirty.months) || {})) {
          runtime.dirtyMonthFields[key] = new Set(fields.filter((field) => MONTH_FIELDS.includes(field)));
        }
        runtime.dirtyGlobalFields = new Set(((bundle.dirty && bundle.dirty.global) || [])
          .filter((field) => GLOBAL_FIELDS.includes(field)));
        return globalState.selectedMonth || null;
      }

      function mergeMonthAfterConflict(key, latest) {
        const baseline = runtime.serverMonthBaselines[key] || {};
        const local = state.monthsByKey[key] || {};
        const dirty = runtime.dirtyMonthFields[key] || new Set();
        const merged = sharedModule.deepClone(latest);
        const conflicts = [];
        for (const field of Array.from(dirty)) {
          const baseValue = baseline[field];
          const localValue = local[field];
          const latestValue = latest[field];
          if (service.sameValue(latestValue, baseValue)) {
            merged[field] = sharedModule.deepClone(localValue);
          } else if (service.sameValue(localValue, baseValue) || service.sameValue(localValue, latestValue)) {
            dirty.delete(field);
          } else {
            merged[field] = sharedModule.deepClone(localValue);
            conflicts.push(field);
          }
        }
        state.monthsByKey[key] = merged;
        runtime.serverMonthBaselines[key] = sharedModule.deepClone(latest);
        return conflicts;
      }

      async function flushMonth(key, notifyFailure) {
        const dirty = runtime.dirtyMonthFields[key];
        if (!dirty || !dirty.size) return true;
        runtime.activeMonthWrites.add(key);
        try {
          let entity = state.monthsByKey[key];
          let baseline = runtime.serverMonthBaselines[key];
          if (!baseline || entity.revision === 0) {
            if (!baseline && entity.revision === 0) {
              const [year, month] = key.split('-').map(Number);
              if (!monthlyModule.confirmMonthCreation(year, month)) {
                // 当前空白月上的第一次编辑也不能绕过新增确认。取消时丢弃
                // 尚未落盘的 revision=0 草稿，并恢复纯只读默认视图。
                delete state.monthsByKey[key];
                delete runtime.dirtyMonthFields[key];
                if (monthlyModule.monthKey() === key) monthlyModule.switchMonthData();
                service.writeLocalCache(service.snapshotBundle());
                return true;
              }
            }
            const ensured = await apiModule.api(`/api/months/${encodeURIComponent(key)}/ensure`, {
              method: 'POST', body: { defaults_revision: state.meta.defaults_revision }, timeout: 15000,
            });
            baseline = ensured.month;
            const merged = sharedModule.deepClone(baseline);
            for (const field of dirty) merged[field] = sharedModule.deepClone(entity[field]);
            state.monthsByKey[key] = merged;
            runtime.serverMonthBaselines[key] = sharedModule.deepClone(baseline);
            entity = merged;
          }
          for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
              const saved = await apiModule.api(`/api/months/${encodeURIComponent(key)}`, {
                method: 'PUT',
                body: { base_revision: baseline.revision, data: service.monthData(entity) },
                timeout: 20000,
              });
              state.monthsByKey[key] = sharedModule.deepClone(saved);
              runtime.serverMonthBaselines[key] = sharedModule.deepClone(saved);
              delete runtime.dirtyMonthFields[key];
              return true;
            } catch (err) {
              if (err.code !== 'STATE_CONFLICT') throw err;
              const latest = await apiModule.api(`/api/months/${encodeURIComponent(key)}`, { timeout: 15000 });
              const conflicts = service.mergeMonthAfterConflict(key, latest);
              baseline = runtime.serverMonthBaselines[key];
              entity = state.monthsByKey[key];
              if (conflicts.length) {
                if (notifyFailure) feedbackModule.toast(
                  `${key} 的 ${conflicts.join('、')} 已在另一标签页修改；本机内容仍保留，请核对后再次保存。`,
                  'warn',
                );
                return false;
              }
            }
          }
          return false;
        } catch (err) {
          console.warn(`同步月份实体 ${key} 失败`, err);
          if (notifyFailure && !state.persistFailureNotified) {
            state.persistFailureNotified = true;
            feedbackModule.toast('月份数据暂时无法写入服务器；本次修改仍保存在浏览器镜像中。', 'warn');
          }
          return false;
        } finally {
          runtime.activeMonthWrites.delete(key);
        }
      }

      function mergeGlobalAfterConflict(latest) {
        const baseline = runtime.globalBaseline || {};
        const local = service.globalData();
        const conflicts = [];
        for (const field of Array.from(runtime.dirtyGlobalFields)) {
          if (service.sameValue(latest[field], baseline[field])) continue;
          if (service.sameValue(local[field], baseline[field]) || service.sameValue(local[field], latest[field])) {
            state[field] = sharedModule.deepClone(latest[field] || {});
            runtime.dirtyGlobalFields.delete(field);
          } else {
            conflicts.push(field);
          }
        }
        runtime.globalBaseline = sharedModule.deepClone(latest);
        state.globalRevision = latest.revision || 0;
        return conflicts;
      }

      async function flushGlobal(notifyFailure) {
        if (!runtime.dirtyGlobalFields.size) return true;
        runtime.activeGlobalWrite = true;
        try {
          let baseline = runtime.globalBaseline || { revision: 0 };
          for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
              const saved = await apiModule.api('/api/global', {
                method: 'PUT',
                body: { base_revision: baseline.revision || 0, data: service.globalData() },
                timeout: 20000,
              });
              state.globalRevision = saved.revision;
              state.annualBudgetsByYear = sharedModule.deepClone(saved.annualBudgetsByYear || {});
              state.annualResultsByYear = sharedModule.deepClone(saved.annualResultsByYear || {});
              state.assetPortfoliosById = sharedModule.deepClone(saved.assetPortfoliosById || {});
              runtime.globalBaseline = sharedModule.deepClone(saved);
              runtime.dirtyGlobalFields.clear();
              return true;
            } catch (err) {
              if (err.code !== 'STATE_CONFLICT') throw err;
              const latest = await apiModule.api('/api/global', { timeout: 15000 });
              const conflicts = service.mergeGlobalAfterConflict(latest);
              baseline = latest;
              if (conflicts.length) {
                if (notifyFailure) feedbackModule.toast('年度或资产数据已在另一标签页修改；本机内容仍保留，请核对后再次保存。', 'warn');
                return false;
              }
            }
          }
          return false;
        } catch (err) {
          console.warn('同步 global.json 失败', err);
          if (notifyFailure && !state.persistFailureNotified) {
            state.persistFailureNotified = true;
            feedbackModule.toast('年度或资产数据暂时无法写入服务器；本次修改仍保存在浏览器镜像中。', 'warn');
          }
          return false;
        } finally {
          runtime.activeGlobalWrite = false;
        }
      }

      async function flushPersist(_bundle = null, notifyFailure = true, _scope = 'all') {
        if (!runtime.serverStateReady) return false;
        const monthKeys = Object.keys(runtime.dirtyMonthFields).filter((key) => runtime.dirtyMonthFields[key].size);
        const monthResults = await Promise.all(monthKeys.map((key) => service.flushMonth(key, notifyFailure)));
        const globalSaved = await service.flushGlobal(notifyFailure);
        const saved = monthResults.every(Boolean) && globalSaved;
        if (saved) state.persistFailureNotified = false;
        service.writeLocalCache(service.snapshotBundle());
        return saved;
      }

      function schedulePersist(scope = 'all') {
        runtime.pendingPersistScope = scope;
        clearTimeout(runtime.persistTimer);
        runtime.persistTimer = setTimeout(() => {
          runtime.pendingPersistScope = null;
          const write = runtime.persistChain.then(() => service.flushPersist(null, true, scope));
          runtime.persistChain = write.then(() => undefined, () => undefined);
        }, 350);
      }

      function persist(mode, scope = 'all') {
        if (lifecycleModule.runtime.tabUnregistered && mode !== 'unload') return null;
        if (scope === 'annual') {
          service.markGlobalDirty('annualBudgetsByYear');
          service.markGlobalDirty('annualResultsByYear');
        } else if (scope === 'assets') {
          service.markGlobalDirty('assetPortfoliosById');
        }
        service.writeLocalCache(service.snapshotBundle());
        if (mode === 'unload') return service.finalWriteBundle();
        if (mode === 'now') {
          clearTimeout(runtime.persistTimer);
          runtime.pendingPersistScope = null;
          const write = runtime.persistChain.then(() => service.flushPersist(null, true, scope));
          runtime.persistChain = write.then(() => undefined, () => undefined);
          return write;
        }
        service.schedulePersist(scope);
        return null;
      }

      function saveState(markSaved) {
        const entity = service.ensureLocalMonthDraft();
        monthlyModule.saveMonthOptions(markSaved);
        standardsModule.snapshotOverridesIntoState();
        service.markMonthDirty('itinerary');
        service.markMonthDirty('options');
        service.markMonthDirty('standards');
        const staleChanged = resultsModule.markCurrentResultStale();
        if (staleChanged || entity.result) service.markMonthDirty('result');
        return service.persist(state.busy ? 'now' : 'debounce');
      }

      async function saveSelection(month) {
        try {
          const saved = await apiModule.api('/api/global/selection', {
            method: 'PUT', body: { month }, timeout: 10000,
          });
          if (runtime.globalBaseline) runtime.globalBaseline.selectedMonth = saved.selectedMonth;
          return true;
        } catch (err) {
          console.warn('保存当前月份选择失败', err);
          return false;
        }
      }

      async function deleteMonth(key) {
        const entity = state.monthsByKey[key];
        if (!entity || entity.revision < 1) {
          delete state.monthsByKey[key];
          delete runtime.dirtyMonthFields[key];
          delete runtime.serverMonthBaselines[key];
          service.writeLocalCache(service.snapshotBundle());
          return true;
        }
        await apiModule.api(`/api/months/${encodeURIComponent(key)}`, {
          method: 'DELETE', body: { base_revision: entity.revision }, timeout: 15000,
        });
        delete state.monthsByKey[key];
        delete runtime.dirtyMonthFields[key];
        delete runtime.serverMonthBaselines[key];
        service.writeLocalCache(service.snapshotBundle());
        return true;
      }

      async function clearAll() {
        const revisions = Object.fromEntries(Object.entries(state.monthsByKey || {})
          .filter(([, entity]) => entity && entity.revision > 0)
          .map(([key, entity]) => [key, entity.revision]));
        const result = await apiModule.api('/api/state/clear', {
          method: 'POST',
          body: { user_confirmed: true, global_revision: state.globalRevision || 0, month_revisions: revisions },
          timeout: 30000,
        });
        state.monthsByKey = {};
        state.globalRevision = 0;
        state.annualBudgetsByYear = {};
        state.annualResultsByYear = {};
        state.assetPortfoliosById = {};
        runtime.serverMonthBaselines = Object.create(null);
        runtime.globalBaseline = { schemaVersion: 2, revision: 0, selectedMonth: null,
          annualBudgetsByYear: {}, annualResultsByYear: {}, assetPortfoliosById: {} };
        runtime.dirtyMonthFields = Object.create(null);
        runtime.dirtyGlobalFields.clear();
        service.writeLocalCache(service.snapshotBundle());
        return result;
      }

      function finalWriteBundle() {
        const months = [];
        for (const [key, fields] of Object.entries(runtime.dirtyMonthFields)) {
          if (!fields.size) continue;
          const baseline = runtime.serverMonthBaselines[key];
          const entity = state.monthsByKey[key];
          // 未完成 ensure 的 revision=0 草稿不能在 unload 时绕过“显式建立月份”。
          if (!baseline || !entity || entity.revision < 1) continue;
          months.push({ month: key, base_revision: baseline.revision, data: service.monthData(entity) });
        }
        const bundle = { schemaVersion: 2, months };
        if (runtime.dirtyGlobalFields.size && runtime.globalBaseline) {
          bundle.global = {
            base_revision: runtime.globalBaseline.revision || 0,
            data: service.globalData(),
          };
        }
        return bundle;
      }

      function hasUnsyncedLocalChanges() {
        try { return localStorage.getItem(UNSYNCED_KEY) === '1'; }
        catch (_) { return false; }
      }

      function clearUnsyncedLocalChanges() {
        try { localStorage.removeItem(UNSYNCED_KEY); } catch (_) { /* 浏览器禁用存储 */ }
      }

      Object.assign(service, {
        runtime,
        STORE_KEY,
        UNSYNCED_KEY,
        MAX_KEPT_MONTHS,
        MONTH_FIELDS,
        GLOBAL_FIELDS,
        sameValue,
        compactResult,
        compactResultsMap,
        cleanAnnualBudgetsMap,
        compactAnnualResultsMap,
        monthData,
        defaultStandardsSnapshot,
        ensureLocalMonthDraft,
        currentMonthEntity,
        markMonthDirty,
        markGlobalDirty,
        globalData,
        snapshotBundle,
        writeLocalCache,
        readLocalBundle,
        applyServerData,
        acceptSavedMonth,
        applyLocalRecovery,
        applyOfflineBundle,
        mergeMonthAfterConflict,
        flushMonth,
        mergeGlobalAfterConflict,
        flushGlobal,
        flushPersist,
        schedulePersist,
        persist,
        saveState,
        saveSelection,
        deleteMonth,
        clearAll,
        finalWriteBundle,
        hasUnsyncedLocalChanges,
        clearUnsyncedLocalChanges,
      });

      return service;
    },
  });
})(window.BudgetModules || (window.BudgetModules = Object.create(null)));
