/* 唯一状态写入队列、本地镜像与服务端读取基线。
 * 跨模块调用由 web/js/app.js 显式注入；模块只导出本职责的接口。
 */
(function register(registry) {
  'use strict';
  registry.persistence = Object.freeze({
    dependencies: Object.freeze(["http","feedback","itinerary","lifecycle","monthly","results","shared","standards","state"]),
    create({ http: apiModule, feedback: feedbackModule, itinerary: itineraryModule, lifecycle: lifecycleModule, monthly: monthlyModule, results: resultsModule, shared: sharedModule, standards: standardsModule, state: stateModule }, service = {}) {
      const { state } = stateModule;

      // 可信服务器读取基线建立前禁止写入；所有状态更新共用一个持久化队列。
      const runtime = {
        persistTimer: null,
        persistChain: Promise.resolve(),
        pendingPersistScope: null,
        serverBaseline: null,
        serverStateReady: false,
        activeStateWritePayload: null,
        uncertainStateWritePayloads: [],
        nextStateWriteSequence: 1,
        sessionMonthlyTouched: false,
        sessionAnnualTouched: false,
      };

      /* --------------------------------------------------------------------------
       * 持久化键名与浏览器镜像上限
       * ------------------------------------------------------------------------ */
      const STORE_KEY = 'budget-web-state-v1';

      // 月份/行程/当月选项（区域+旅居，按月份）
      const OVERRIDES_KEY = 'budget-web-overrides-v1';

      // 旧版独立缓存 key（只用于兼容迁移）
      const RESULTS_KEY = 'budget-web-results-v1';

      // 每月计算结果（按月索引）
      const MAX_KEPT_MONTHS = 60;

      const STATE_MAP_FIELDS = [
        'itineraryByMonth', 'optionsByMonth', 'overridesByMonth', 'resultsByMonth',
        'subscriptionsByMonth', 'annualBudgetsByYear', 'annualResultsByYear',
        'assetPortfoliosById',
      ];

      function emptyBundle() {
        return {
          version: 1,
          updatedAt: null,
          year: null,
          month: null,
          itineraryByMonth: {},
          optionsByMonth: {},
          overridesByMonth: {},
          resultsByMonth: {},
          subscriptionsByMonth: {},
          annualBudgetsByYear: {},
          annualResultsByYear: {},
          assetPortfoliosById: {},
        };
      }

      function compactResult(result) {
        if (!result || typeof result !== 'object') return result;
        const out = {};
        for (const [k, v] of Object.entries(result)) {
          if (k === 'rates' || k === 'rates_dict') continue;
          out[k] = v;
        }
        return out;
      }

      function compactResultsMap(map) {
        const compact = {};
        for (const [k, v] of Object.entries(map && typeof map === 'object' ? map : {})) {
          compact[k] = service.compactResult(v);
        }
        return compact;
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
          const clean = {};
          for (const [key, value] of Object.entries(result)) {
            if (key === 'rates' || key === 'rates_dict' || key === 'series') continue;
            clean[key] = value;
          }
          if (Object.keys(clean).length) out[year] = clean;
        }
        return out;
      }

      function snapshotBundle() {
        return {
          version: 1,
          updatedAt: new Date().toISOString(),
          year: state.year,
          month: state.month,
          itineraryByMonth: itineraryModule.exclusiveAllMonths(state.itineraryByMonth),
          optionsByMonth: sharedModule.deepClone(state.optionsByMonth),
          overridesByMonth: sharedModule.deepClone(state.overridesByMonth),
          resultsByMonth: service.compactResultsMap(state.resultsByMonth),
          subscriptionsByMonth: sharedModule.deepClone(state.subscriptionsByMonth || {}),
          annualBudgetsByYear: service.cleanAnnualBudgetsMap(state.annualBudgetsByYear),
          annualResultsByYear: service.compactAnnualResultsMap(state.annualResultsByYear),
          assetPortfoliosById: sharedModule.deepClone(state.assetPortfoliosById || {}),
        };
      }

      function sameStateValue(left, right) {
        return JSON.stringify(left) === JSON.stringify(right);
      }

      function stateValueMarker(container, key) {
        if (container && Object.prototype.hasOwnProperty.call(container, key)) {
          return { exists: true, value: sharedModule.deepClone(container[key]) };
        }
        return { exists: false };
      }

      /**
       * 把完整内存快照压成相对本标签页读取基线的逐键补丁。这样旧标签页关闭时
       * 不会重发自己从未修改的月份；baseValues 让后端原子拒绝同一键的并发覆盖。
       */
      function buildStateWrite(bundle) {
        const snap = sharedModule.deepClone(bundle || service.snapshotBundle());
        if (!runtime.serverBaseline || snap.replace) {
          return { payload: snap, touched: null };
        }
        const payload = {
          version: snap.version || 1,
          updatedAt: snap.updatedAt || new Date().toISOString(),
          baseValues: {},
        };
        const selectionChanged = !service.sameStateValue(snap.year, runtime.serverBaseline.year)
          || !service.sameStateValue(snap.month, runtime.serverBaseline.month);
        if (selectionChanged) {
          // 年/月构成一个选择值，必须成对比较和提交，避免只改月份时后端静默忽略。
          for (const field of ['year', 'month']) {
            payload[field] = snap[field];
            payload.baseValues[field] = service.stateValueMarker(runtime.serverBaseline, field);
          }
        }
        for (const field of STATE_MAP_FIELDS) {
          const current = snap[field] && typeof snap[field] === 'object' ? snap[field] : {};
          const baseline = runtime.serverBaseline[field] && typeof runtime.serverBaseline[field] === 'object'
            ? runtime.serverBaseline[field] : {};
          const keys = new Set([...Object.keys(current), ...Object.keys(baseline)]);
          for (const key of keys) {
            const currentHas = Object.prototype.hasOwnProperty.call(current, key);
            const baselineHas = Object.prototype.hasOwnProperty.call(baseline, key);
            if (currentHas === baselineHas
                && (!currentHas || service.sameStateValue(current[key], baseline[key]))) continue;
            if (!payload[field]) payload[field] = {};
            if (!payload.baseValues[field]) payload.baseValues[field] = {};
            payload[field][key] = currentHas ? sharedModule.deepClone(current[key]) : {};
            payload.baseValues[field][key] = service.stateValueMarker(baseline, key);
          }
        }
        return { payload, touched: payload.baseValues };
      }

      function mergePersistScope(left, right) {
        if (left === 'all' || right === 'all') return 'all';
        if (!left) return right || 'all';
        if (!right) return left;
        return left === right ? left : 'all';
      }

      function restrictStateWriteScope(writeRequest, scope) {
        if (scope === 'all') return writeRequest;
        const remove = scope === 'annual'
          ? ['year', 'month', 'itineraryByMonth', 'optionsByMonth', 'overridesByMonth',
            'resultsByMonth', 'subscriptionsByMonth', 'assetPortfoliosById']
          : ['year', 'month', 'itineraryByMonth', 'optionsByMonth', 'overridesByMonth',
            'resultsByMonth', 'subscriptionsByMonth', 'annualBudgetsByYear',
            'annualResultsByYear'];
        for (const field of remove) {
          delete writeRequest.payload[field];
          if (writeRequest.payload.baseValues) delete writeRequest.payload.baseValues[field];
        }
        return writeRequest;
      }

      function payloadTouchesMonthlyState(payload) {
        if (!payload || typeof payload !== 'object') return false;
        return ['year', 'month', 'itineraryByMonth', 'optionsByMonth',
          'overridesByMonth', 'resultsByMonth', 'subscriptionsByMonth'].some((field) => (
          Object.prototype.hasOwnProperty.call(payload, field)
          && (typeof payload[field] !== 'object' || payload[field] === null
            || Object.keys(payload[field]).length > 0)
        ));
      }

      /** 只推进本次成功写入的键；未触及键仍保留旧基线，后续不会误发旧标签快照。 */
      function advanceServerBaseline(saved, payload, touched) {
        if (!runtime.serverBaseline || !touched) {
          runtime.serverBaseline = sharedModule.deepClone(saved && typeof saved === 'object' && Object.keys(saved).length
            ? saved : payload);
          return;
        }
        const response = saved && typeof saved === 'object' ? saved : {};
        for (const field of ['year', 'month']) {
          if (!Object.prototype.hasOwnProperty.call(touched, field)) continue;
          runtime.serverBaseline[field] = Object.prototype.hasOwnProperty.call(response, field)
            ? sharedModule.deepClone(response[field]) : sharedModule.deepClone(payload[field]);
        }
        for (const field of STATE_MAP_FIELDS) {
          if (!touched[field] || typeof touched[field] !== 'object') continue;
          if (!runtime.serverBaseline[field] || typeof runtime.serverBaseline[field] !== 'object') runtime.serverBaseline[field] = {};
          const responseMap = response[field] && typeof response[field] === 'object' ? response[field] : null;
          for (const key of Object.keys(touched[field])) {
            if (responseMap && Object.prototype.hasOwnProperty.call(responseMap, key)) {
              runtime.serverBaseline[field][key] = sharedModule.deepClone(responseMap[key]);
            } else if (payload[field] && payload[field][key]
                       && Object.keys(payload[field][key]).length) {
              runtime.serverBaseline[field][key] = sharedModule.deepClone(payload[field][key]);
            } else {
              delete runtime.serverBaseline[field][key];
            }
          }
        }
        if (response.updatedAt) runtime.serverBaseline.updatedAt = response.updatedAt;
      }

      function payloadTargetMarker(payload, field, key = null) {
        if (!payload || typeof payload !== 'object') return null;
        if (key === null) {
          return Object.prototype.hasOwnProperty.call(payload, field)
            ? { exists: true, value: sharedModule.deepClone(payload[field]) } : null;
        }
        const map = payload[field];
        if (!map || typeof map !== 'object' || !Object.prototype.hasOwnProperty.call(map, key)) return null;
        const value = map[key];
        return value && typeof value === 'object' && Object.keys(value).length
          ? { exists: true, value: sharedModule.deepClone(value) }
          : { exists: false };
      }

      /**
       * 关闭页可能与本标签页上一笔在途 PUT 竞速。最终 beacon 允许后端把“旧基线”
       * 或“上一笔 PUT 的目标值”都视为合法前置状态，但不会接受其它标签页的任意值。
       */
      function addOutstandingWriteAlternatives(payload) {
        if (!payload || !payload.baseValues) return payload;
        const candidates = [runtime.activeStateWritePayload, ...runtime.uncertainStateWritePayloads.slice(-3)].filter(Boolean);
        const appendAlternative = (marker, alternative) => {
          if (!alternative || service.sameStateValue(alternative, marker)) return;
          const existing = marker.alternatives || [];
          if (existing.some((item) => service.sameStateValue(item, alternative))) return;
          marker.alternatives = [...existing, alternative].slice(-4);
        };
        for (const source of candidates) {
          for (const field of ['year', 'month']) {
            const marker = payload.baseValues[field];
            if (!marker) continue;
            appendAlternative(marker, service.payloadTargetMarker(source, field));
          }
          for (const field of STATE_MAP_FIELDS) {
            const bases = payload.baseValues[field];
            if (!bases || typeof bases !== 'object') continue;
            for (const [key, marker] of Object.entries(bases)) {
              appendAlternative(marker, service.payloadTargetMarker(source, field, key));
            }
          }
        }
        return payload;
      }

      function includeOutstandingTouchedKeys(payload, bundle) {
        if (!payload || !payload.baseValues || !runtime.serverBaseline) return payload;
        const sources = [runtime.activeStateWritePayload, ...runtime.uncertainStateWritePayloads].filter(Boolean);
        const forceSelection = sources.some((source) => source.baseValues
          && (source.baseValues.year || source.baseValues.month));
        if (forceSelection && !payload.baseValues.year && !payload.baseValues.month) {
          for (const field of ['year', 'month']) {
            payload[field] = bundle[field];
            payload.baseValues[field] = service.stateValueMarker(runtime.serverBaseline, field);
          }
        }
        for (const source of sources) {
          for (const field of STATE_MAP_FIELDS) {
            const touched = source.baseValues && source.baseValues[field];
            if (!touched || typeof touched !== 'object') continue;
            const current = bundle[field] && typeof bundle[field] === 'object' ? bundle[field] : {};
            if (!payload[field]) payload[field] = {};
            if (!payload.baseValues[field]) payload.baseValues[field] = {};
            for (const key of Object.keys(touched)) {
              if (!Object.prototype.hasOwnProperty.call(payload[field], key)) {
                payload[field][key] = Object.prototype.hasOwnProperty.call(current, key)
                  ? sharedModule.deepClone(current[key]) : {};
                payload.baseValues[field][key] = service.stateValueMarker(runtime.serverBaseline[field] || {}, key);
              }
            }
          }
        }
        return payload;
      }

      function addStateWriteIdentity(payload) {
        payload.tabId = lifecycleModule.TAB_ID;
        payload.sequence = runtime.nextStateWriteSequence;
        runtime.nextStateWriteSequence += 1;
        return payload;
      }

      function writeLocalCache(bundle) {
        try {
          const snap = sharedModule.deepClone(bundle || service.snapshotBundle());
          snap.itineraryByMonth = service.trimLocalMonthMap(snap.itineraryByMonth);
          snap.optionsByMonth = service.trimLocalMonthMap(snap.optionsByMonth);
          snap.subscriptionsByMonth = service.trimLocalMonthMap(snap.subscriptionsByMonth);
          localStorage.setItem(STORE_KEY, JSON.stringify(snap));
          localStorage.removeItem(OVERRIDES_KEY);
          localStorage.removeItem(RESULTS_KEY);
        } catch (err) {
          console.warn('本机缓存写入失败', err);
        }
      }

      function readLocalBundle() {
        const bundle = service.emptyBundle();
        try {
          const raw = localStorage.getItem(STORE_KEY);
          if (raw) {
            const data = JSON.parse(raw);
            if (data && typeof data === 'object') {
              if (data.year && data.month) { bundle.year = data.year; bundle.month = data.month; }
              if (data.updatedAt) bundle.updatedAt = data.updatedAt;
              if (data.itineraryByMonth && typeof data.itineraryByMonth === 'object') {
                bundle.itineraryByMonth = data.itineraryByMonth;
              }
              if (data.optionsByMonth && typeof data.optionsByMonth === 'object') {
                bundle.optionsByMonth = data.optionsByMonth;
              } else if (data.region === 'Mainland' || data.region === 'Overseas') {
                bundle.optionsByMonth = {
                  [`${data.year}-${String(data.month).padStart(2, '0')}`]: {
                    region: data.region,
                    includeTravel: false,
                    travelSelected: null,
                  },
                };
              }
              if (data.overridesByMonth && typeof data.overridesByMonth === 'object') {
                bundle.overridesByMonth = data.overridesByMonth;
              } else if (data.standards && !localStorage.getItem(OVERRIDES_KEY)) {
                bundle.overridesByMonth = { [`${data.year}-${String(data.month).padStart(2, '0')}`]: data.standards };
              }
              if (data.resultsByMonth && typeof data.resultsByMonth === 'object') {
                bundle.resultsByMonth = service.compactResultsMap(data.resultsByMonth);
              }
              if (data.subscriptionsByMonth && typeof data.subscriptionsByMonth === 'object') {
                bundle.subscriptionsByMonth = data.subscriptionsByMonth;
              }
              if (data.annualBudgetsByYear && typeof data.annualBudgetsByYear === 'object') {
                bundle.annualBudgetsByYear = service.cleanAnnualBudgetsMap(data.annualBudgetsByYear);
              }
              if (data.annualResultsByYear && typeof data.annualResultsByYear === 'object') {
                bundle.annualResultsByYear = service.compactAnnualResultsMap(data.annualResultsByYear);
              }
              if (data.assetPortfoliosById && typeof data.assetPortfoliosById === 'object') {
                bundle.assetPortfoliosById = data.assetPortfoliosById;
              }
            }
          }
        } catch (err) {
          console.warn('本机行程缓存读取失败', err);
        }
        if (!Object.keys(bundle.overridesByMonth).length) {
          try {
            const raw = localStorage.getItem(OVERRIDES_KEY);
            if (raw) {
              const parsed = JSON.parse(raw);
              if (parsed && typeof parsed === 'object') {
                if ('variable' in parsed || 'fixed' in parsed || 'travel' in parsed) {
                  bundle.overridesByMonth = { [`${bundle.year}-${String(bundle.month).padStart(2, '0')}`]: parsed };
                } else {
                  bundle.overridesByMonth = parsed;
                }
              }
            }
          } catch (err) {
            console.warn('本机标准缓存读取失败', err);
          }
        }
        if (!Object.keys(bundle.resultsByMonth).length) {
          try {
            const raw = localStorage.getItem(RESULTS_KEY);
            if (raw) {
              const parsed = JSON.parse(raw);
              if (parsed && typeof parsed === 'object') bundle.resultsByMonth = service.compactResultsMap(parsed);
            }
          } catch (err) {
            console.warn('本机结果缓存读取失败', err);
          }
        }
        return bundle;
      }

      function applyBundle(data) {
        const bundle = data && typeof data === 'object' ? data : service.emptyBundle();
        if (bundle.year && bundle.month) {
          state.year = bundle.year;
          state.month = bundle.month;
        }
        state.itineraryByMonth = itineraryModule.exclusiveAllMonths(bundle.itineraryByMonth || {});
        state.optionsByMonth = bundle.optionsByMonth || {};
        state.overridesByMonth = bundle.overridesByMonth || {};
        state.resultsByMonth = service.compactResultsMap(bundle.resultsByMonth || {});
        state.subscriptionsByMonth = bundle.subscriptionsByMonth || {};
        state.annualBudgetsByYear = service.cleanAnnualBudgetsMap(bundle.annualBudgetsByYear || {});
        state.annualResultsByYear = service.compactAnnualResultsMap(bundle.annualResultsByYear || {});
        state.assetPortfoliosById = bundle.assetPortfoliosById || {};
        monthlyModule.applyMonthOptions(monthlyModule.monthKey());
      }

      function schedulePersist(scope = 'all') {
        runtime.pendingPersistScope = service.mergePersistScope(runtime.pendingPersistScope, scope);
        clearTimeout(runtime.persistTimer);
        runtime.persistTimer = setTimeout(() => {
          const scheduledScope = runtime.pendingPersistScope || 'all';
          runtime.pendingPersistScope = null;
          service.flushPersist(undefined, true, scheduledScope);
        }, 280);
      }

      function flushPersist(bundle = service.snapshotBundle(), notifyFailure = false, scope = 'all') {
        if (lifecycleModule.runtime.tabUnregistered) return Promise.resolve(false);
        if (!runtime.serverStateReady) {
          if (notifyFailure && !state.persistFailureNotified) {
            state.persistFailureNotified = true;
            feedbackModule.toast('服务器状态尚未成功读取；修改仅保存在浏览器缓存中，请刷新页面后再保存。', 'warn');
          }
          return Promise.resolve(false);
        }
        const write = runtime.persistChain.then(async () => {
          // 页面已注销时由 unregister 携带的最终快照负责写盘，跳过排队中的旧快照。
          if (lifecycleModule.runtime.tabUnregistered) return false;
          const writeRequest = service.restrictStateWriteScope(service.buildStateWrite(bundle), scope);
          service.addStateWriteIdentity(writeRequest.payload);
          runtime.activeStateWritePayload = writeRequest.payload;
          try {
            const saved = await apiModule.api('/api/state', {
              method: 'PUT', body: writeRequest.payload, timeout: 20000,
            });
            service.advanceServerBaseline(saved, writeRequest.payload, writeRequest.touched);
            state.persistFailureNotified = false;
            return true;
          } catch (err) {
            console.warn('同步到 data/app-state.json 失败', err);
            const definitelyRejected = err.code === 'STATE_CONFLICT'
              || (Number.isFinite(err.status) && err.status >= 400 && err.status < 500 && err.status !== 408);
            if (!definitelyRejected) {
              runtime.uncertainStateWritePayloads = [...runtime.uncertainStateWritePayloads, writeRequest.payload].slice(-4);
            }
            if (notifyFailure && !state.persistFailureNotified) {
              state.persistFailureNotified = true;
              feedbackModule.toast(
                err.code === 'STATE_CONFLICT'
                  ? '另一个标签页已修改同一月份或年份；本标签页未覆盖它，请刷新后再重试。'
                  : '项目状态暂时无法写入服务器；本次修改仍保存在浏览器缓存中。',
                'warn',
              );
            }
            return false;
          } finally {
            if (runtime.activeStateWritePayload === writeRequest.payload) runtime.activeStateWritePayload = null;
          }
        });
        // 保持队列可继续使用；单次失败不会让后续写入永远跳过。
        runtime.persistChain = write.then(() => undefined);
        return write;
      }

      /** 唯一写入口。unload 只落本地缓存并返回 bundle，由注销请求带去服务端。 */
      function persist(mode, scope = 'all') {
        if (lifecycleModule.runtime.tabUnregistered && mode !== 'unload') return null;
        if (scope === 'all') {
          standardsModule.snapshotOverridesIntoState();
          runtime.sessionMonthlyTouched = true;
        } else if (scope === 'annual') {
          runtime.sessionAnnualTouched = true;
        }
        const bundle = service.snapshotBundle();
        service.writeLocalCache(bundle);
        if (mode === 'unload') return bundle;
        if (mode === 'now') {
          clearTimeout(runtime.persistTimer);
          const effectiveScope = service.mergePersistScope(runtime.pendingPersistScope, scope);
          runtime.pendingPersistScope = null;
          return service.flushPersist(bundle, false, effectiveScope);
        }
        service.schedulePersist(scope);
        return null;
      }

      function saveState(markSaved) {
        monthlyModule.saveMonthOptions(markSaved);
        resultsModule.markCurrentResultStale();
        service.persist('debounce');
      }

      function trimLocalMonthMap(map) {
        const out = sharedModule.deepClone(map && typeof map === 'object' ? map : {});
        const keys = Object.keys(out).sort();
        const current = monthlyModule.monthKey();
        while (keys.length > MAX_KEPT_MONTHS) {
          const removableIndex = keys.findIndex((key) => key !== current);
          const index = removableIndex >= 0 ? removableIndex : 0;
          delete out[keys[index]];
          keys.splice(index, 1);
        }
        return out;
      }

      Object.assign(service, {
        runtime,
        STORE_KEY,
        OVERRIDES_KEY,
        RESULTS_KEY,
        MAX_KEPT_MONTHS,
        STATE_MAP_FIELDS,
        emptyBundle,
        compactResult,
        compactResultsMap,
        cleanAnnualBudgetsMap,
        compactAnnualResultsMap,
        snapshotBundle,
        sameStateValue,
        stateValueMarker,
        buildStateWrite,
        mergePersistScope,
        restrictStateWriteScope,
        payloadTouchesMonthlyState,
        advanceServerBaseline,
        payloadTargetMarker,
        addOutstandingWriteAlternatives,
        includeOutstandingTouchedKeys,
        addStateWriteIdentity,
        writeLocalCache,
        readLocalBundle,
        applyBundle,
        schedulePersist,
        flushPersist,
        persist,
        saveState,
        trimLocalMonthMap,
      });

      return service;
    },
  });
})(window.BudgetModules || (window.BudgetModules = Object.create(null)));
