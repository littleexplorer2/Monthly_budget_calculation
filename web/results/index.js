/* 月度结果快照、过期状态和明细表格。
 * 跨模块调用由 web/js/app.js 显式注入；模块只导出本职责的接口。
 */
(function register(registry) {
  'use strict';
  registry.results = Object.freeze({
    dependencies: Object.freeze(["locations","monthly","persistence","shared","state"]),
    create({ locations: locationsModule, monthly: monthlyModule, persistence: persistenceModule, shared: sharedModule, state: stateModule }, service = {}) {
      const { state } = stateModule;
      const BUDGET_MODEL = 'subscription-fixed-monthly-equivalent-v2';

      /** 从 v2 月份实体派生只读结果索引，供分析页消费。 */
      function loadResultsMap() {
        return Object.fromEntries(Object.entries(state.monthsByKey || {})
          .filter(([, entity]) => entity && entity.result)
          .map(([key, entity]) => [key, entity.result]));
      }

      function writeResultsMap(map, mode = 'debounce') {
        const values = persistenceModule.compactResultsMap(map);
        for (const [key, entity] of Object.entries(state.monthsByKey || {})) {
          const next = Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null;
          if (persistenceModule.sameValue(entity.result, next)) continue;
          entity.result = next;
          persistenceModule.markMonthDirty('result', key);
        }
        return persistenceModule.persist(mode);
      }

      function saveResult(result, mode = 'debounce', context = {}) {
        const targetMonth = context.monthKey || monthlyModule.monthKey();
        const entity = persistenceModule.ensureLocalMonthDraft(targetMonth);
        const resultRegion = context.region == null ? state.region : context.region;
        const saved = Object.assign({}, persistenceModule.compactResult(result), {
          savedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
          region: resultRegion === 'Overseas' ? 'Overseas' : 'Mainland',
          includeTravel: context.includeTravel == null
            ? !!state.includeTravel : !!context.includeTravel,
          budgetModel: BUDGET_MODEL,
          stale: context.stale === true,
        });
        if (saved.stale && context.staleReason) {
          saved.staleReason = context.staleReason;
          saved.staleAt = new Date().toISOString();
        }
        entity.result = saved;
        persistenceModule.markMonthDirty('result', targetMonth);
        if (targetMonth === monthlyModule.monthKey()) state.calcResult = saved;
        return persistenceModule.persist(mode);
      }

      /** 预算输入变化后保留旧结果供追溯，但明确标为过期，避免分析页误用。 */
      function markCurrentResultStale(reason = '预算标准、行程或计算选项已更改') {
        const entity = state.monthsByKey[monthlyModule.monthKey()];
        const result = entity && entity.result;
        if (!result || typeof result !== 'object' || !result.summary) return false;
        if (result.stale) return false;
        result.stale = true;
        result.staleReason = reason;
        result.staleAt = new Date().toISOString();
        if (state.calcResult) state.calcResult = result;
        return true;
      }

      function loadResultForMonth(key) {
        const result = service.loadResultsMap()[key] || null;
        if (result && result.budgetModel !== BUDGET_MODEL) {
          result.stale = true;
          result.staleReason = '固定预算来源已改为订阅月均汇总';
        }
        return result;
      }

      /* --------------------------------------------------------------------------
       * 计算结果
       * ------------------------------------------------------------------------ */
      const DAILY_DETAIL_HEADERS = ['地点', '类型', '币种', '每日预算(当地)', '天数', '当地金额', '折合人民币'];

      const FIXED_DETAIL_HEADERS = ['区域/地点', '类型', '币种', '当地月额', '平均汇率', '折合人民币'];

      const EXTRA_DETAIL_HEADERS = ['币种', '当地月额', '平均汇率', '折合人民币'];

      function buildTable(container, headers, rows, numericCols = [], options = {}) {
        if (!container) return;
        if (!rows.length) {
          container.innerHTML = `<p class="empty">${sharedModule.esc(options.empty || '无数据')}</p>`;
          return;
        }
        const th = headers.map((h, i) =>
          `<th class="${numericCols.includes(i) ? 'num' : ''}">${sharedModule.esc(h)}</th>`).join('');
        const trs = rows.map((row) => `<tr>${row.map((cell, i) =>
          `<td class="${numericCols.includes(i) ? 'num' : ''}">${sharedModule.esc(cell)}</td>`).join('')}</tr>`).join('');
        container.innerHTML = `<table class="detail-table"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
      }

      /** 明细里的地点名：居住区域显示中文（内地/境外），其余走地点名 */
      function detailPlaceName(key) {
        return (key === 'Mainland' || key === 'Overseas') ? locationsModule.regionName(key) : locationsModule.locName(key);
      }

      /** 每日预算（定居可变 + 旅居每日，按当日汇率逐日折算）明细行 → 表格单元格。
       *  金额只写数字，币种由「币种」列给出，避免每格重复币种代码。 */
      function dailyDetailRow(d) {
        return [
          service.detailPlaceName(d.location), d.type, d.currency,
          sharedModule.fmtMoney(d.daily_standard_local),
          d.day_count,
          sharedModule.fmtMoney(d.variable_cost_local),
          `¥ ${sharedModule.fmtMoney(d.variable_cost_rmb)}`,
        ];
      }

      /** 固定预算 / 旅居一次性费用明细行 → 表格单元格 */
      function fixedDetailRow(d) {
        return [
          service.detailPlaceName(d.location), d.type, d.currency,
          sharedModule.fmtMoney(d.local_cost),
          (d.avg_rate == null ? '-' : Number(d.avg_rate).toFixed(4)),
          `¥ ${sharedModule.fmtMoney(d.rmb_cost)}`,
        ];
      }

      /** 额外预算明细行 → 表格单元格（每行一个币种，卡片标题已说明是额外预算） */
      function extraDetailRow(d) {
        return [
          d.currency,
          sharedModule.fmtMoney(d.local_cost),
          (d.avg_rate == null ? '-' : Number(d.avg_rate).toFixed(4)),
          `¥ ${sharedModule.fmtMoney(d.rmb_cost)}`,
        ];
      }

      /** 是否为额外预算明细行（旧存档只有 fixed_details，用它把额外预算行认出来） */
      function isExtraDetail(d) {
        return !!d && (d.type === '额外预算' || d.location === 'Extra');
      }

      /** 把计算结果拆成固定预算明细与额外预算明细两组；旧存档没有 extra_details 时按行类型兜底 */
      function splitFixedExtraDetails(r) {
        const all = Array.isArray(r && r.fixed_details) ? r.fixed_details : [];
        const declared = Array.isArray(r && r.extra_details) ? r.extra_details : [];
        return {
          fixed: all.filter((d) => !service.isExtraDetail(d)),
          extra: declared.length ? declared : all.filter((d) => service.isExtraDetail(d)),
        };
      }

      function renderResult() {
        const r = state.calcResult;
        if (!r) return;
        const s = r.summary;
        const total = Number(s['总预算(人民币)']);

        // 新预算模型只有可变 + 固定两类；旧结果若带额外预算，只作为过期兼容提示。
        const split = service.splitFixedExtraDetails(r);
        const sumRmb = (rows) => rows.reduce((acc, d) => acc + (Number(d.rmb_cost) || 0), 0);
        const numOrNull = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
        const round2 = (v) => Math.round(Number(v) * 100) / 100;

        const onceRmb = numOrNull(s['固定费用合计(人民币)']);       // 固定 + 额外 + 旅居一次性
        const declaredExtraRmb = numOrNull(s['额外预算合计(人民币)']);
        const extraRmb = split.extra.length
          ? (declaredExtraRmb === null ? sumRmb(split.extra) : declaredExtraRmb)
          : 0;
        // 固定 + 额外 必须正好等于「固定费用合计」，三个数字相加才等于总预算
        const fixedRmb = onceRmb === null ? sumRmb(split.fixed) : round2(onceRmb - extraRmb);
        const variableRmb = (() => {
          const fromSummary = numOrNull(s['可变费用合计(人民币)']);
          return fromSummary === null ? sumRmb(r.daily_details || []) : fromSummary;
        })();

        sharedModule.$('#result-title').textContent = `计算结果：${sharedModule.esc(s['计算月份'] || '')}`;
        sharedModule.$('#result-summary').innerHTML = `
          <div class="hero">
            <div class="hero-label">本月总预算</div>
            <div class="hero-amount">¥ ${sharedModule.fmtMoney(total)}</div>
            <div class="hero-pills">
              <span>可变 ¥ ${sharedModule.fmtMoney(variableRmb)}</span>
              <span>固定 ¥ ${sharedModule.fmtMoney(fixedRmb)}</span>
              ${extraRmb > 0 ? `<span>旧额外 ¥ ${sharedModule.fmtMoney(extraRmb)}</span>` : ''}
              <span>${sharedModule.esc(locationsModule.regionName(s['居住区域']))} · ${sharedModule.esc(s['计算月份'] || '')}</span>
            </div>
          </div>`;

        const warns = sharedModule.$('#result-warnings');
        const resultWarnings = r.stale
          ? [`旧结果：${r.staleReason || '预算输入已更改'}，请重新计算后再用于月度比较。`, ...(r.warnings || [])]
          : (r.warnings || []);
        warns.innerHTML = resultWarnings.map((w) =>
          `<div class="warn-item">⚠ ${sharedModule.esc(w)}</div>`).join('');

        // 过期结果仍保留供追溯，但不能伪装成当前输入的有效计算结果。
        const meta = sharedModule.$('#result-meta');
        if (meta) {
          if (r.stale) {
            meta.textContent = `⚠ 这是输入变更前保存的旧结果${r.savedAt ? `（${r.savedAt}）` : ''}`;
          } else {
            meta.textContent = r.savedAt
              ? `✓ 该月计算结果已保存到项目数据（${r.savedAt}）`
              : '✓ 该月计算结果已保存到项目数据';
          }
        }

        // 两张明细表：每日预算与订阅月均固定预算（含旅居一次性费用）。
        service.buildTable(
          sharedModule.$('#daily-details-table'),
          DAILY_DETAIL_HEADERS,
          (Array.isArray(r.daily_details) ? r.daily_details : []).map(service.dailyDetailRow),
          [3, 4, 5, 6],
          { empty: '本月还没有行程明细，请先在「行程安排」里添加行程' }
        );

        service.buildTable(
          sharedModule.$('#fixed-details-table'),
          FIXED_DETAIL_HEADERS,
          split.fixed.map(service.fixedDetailRow),
          [3, 4, 5],
          { empty: '本月没有固定预算明细' }
        );

        service.buildTable(
          sharedModule.$('#extra-details-table'),
          EXTRA_DETAIL_HEADERS,
          split.extra.map(service.extraDetailRow),
          [1, 2, 3],
          { empty: '本月没有额外预算（默认均为 0）' }
        );

        service.setDetailTotal('#daily-details-total', variableRmb);
        service.setDetailTotal('#fixed-details-total', fixedRmb);
        service.setDetailTotal('#extra-details-total', extraRmb);
      }

      /** 把某张明细表的合计写到卡片标题右侧 */
      function setDetailTotal(selector, amount) {
        const el = sharedModule.$(selector);
        if (el) el.textContent = `¥ ${sharedModule.fmtMoney(amount)}`;
      }

      /** 清空结果区（无结果时的占位提示） */
      function clearResult() {
        state.calcResult = null;
        const title = sharedModule.$('#result-title');
        if (title) title.textContent = '计算结果';
        const meta = sharedModule.$('#result-meta');
        if (meta) meta.textContent = '';
        const summary = sharedModule.$('#result-summary');
        if (summary) summary.innerHTML = `<div class="empty-card">
          <div class="empty-title">还没有计算结果</div>
          <p>请先添加行程；系统会自动更新预算，也可使用上方「更新预算」按钮手动刷新。</p>
        </div>`;
        const warns = sharedModule.$('#result-warnings');
        if (warns) warns.innerHTML = '';
        const d = sharedModule.$('#daily-details-table');
        if (d) d.innerHTML = '';
        const f = sharedModule.$('#fixed-details-table');
        if (f) f.innerHTML = '';
        const x = sharedModule.$('#extra-details-table');
        if (x) x.innerHTML = '';
        ['#daily-details-total', '#fixed-details-total', '#extra-details-total'].forEach((sel) => {
          const el = sharedModule.$(sel);
          if (el) el.textContent = '';
        });
      }

      Object.assign(service, {
        BUDGET_MODEL,
        DAILY_DETAIL_HEADERS,
        FIXED_DETAIL_HEADERS,
        EXTRA_DETAIL_HEADERS,
        loadResultsMap,
        writeResultsMap,
        saveResult,
        markCurrentResultStale,
        loadResultForMonth,
        buildTable,
        detailPlaceName,
        dailyDetailRow,
        fixedDetailRow,
        extraDetailRow,
        isExtraDetail,
        splitFixedExtraDetails,
        renderResult,
        setDetailTotal,
        clearResult,
      });

      return service;
    },
  });
})(window.BudgetModules || (window.BudgetModules = Object.create(null)));
