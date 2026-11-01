/* 独立年度输入、汇率请求和年度结果展示。
 * 跨模块调用由 web/js/app.js 显式注入；模块只导出本职责的接口。
 */
(function register(registry) {
  'use strict';
  registry.annual = Object.freeze({
    dependencies: Object.freeze(["http","feedback","locations","network","persistence","shared","state"]),
    create({ http: apiModule, feedback: feedbackModule, locations: locationsModule, network: networkModule, persistence: persistenceModule, shared: sharedModule, state: stateModule }, service = {}) {
      const { state } = stateModule;

      /* --------------------------------------------------------------------------
       * 全年预算：年初至截止日的实际交易日 Close 算术平均
       * 全年金额与紧凑结果复用唯一 app-state 持久化管线；原始行情不进状态。
       * ------------------------------------------------------------------------ */
      function annualYearKey() { return String(state.annualYear || new Date().getFullYear()); }

      function annualBudgetAmounts() {
        const year = service.annualYearKey();
        if (!state.annualBudgetsByYear || typeof state.annualBudgetsByYear !== 'object') {
          state.annualBudgetsByYear = {};
        }
        if (!state.annualBudgetsByYear[year] || typeof state.annualBudgetsByYear[year] !== 'object') {
          state.annualBudgetsByYear[year] = {};
        }
        return state.annualBudgetsByYear[year];
      }

      function annualCurrencies() {
        return locationsModule.orderedCurrencies(['CNY', 'HKD', 'USD']);
      }

      function availableAnnualYears() {
        const nowYear = new Date().getFullYear();
        return Array.from({ length: nowYear - 1999 }, (_, index) => nowYear - index);
      }

      function fillAnnualYearSelect() {
        const select = sharedModule.$('#annual-year');
        if (!select) return;
        const years = service.availableAnnualYears();
        if (!years.includes(Number(state.annualYear))) state.annualYear = years[0];
        select.innerHTML = years.map((year) => `<option value="${year}">${year}年</option>`).join('');
        select.value = String(state.annualYear);
      }

      function annualRateStat(currency) {
        if (!state.annualRatesData || state.annualRatesYear !== service.annualYearKey()) return null;
        return (state.annualRatesData.stats || {})[currency] || null;
      }

      function annualResultForYear() {
        const result = (state.annualResultsByYear && state.annualResultsByYear[service.annualYearKey()]) || null;
        return result && !result.stale ? result : null;
      }

      function renderAnnualBudget() {
        service.fillAnnualYearSelect();
        const rowsHost = sharedModule.$('#annual-budget-rows');
        if (!rowsHost) return;
        const year = service.annualYearKey();
        const amounts = service.annualBudgetAmounts();
        const storedResult = (state.annualResultsByYear && state.annualResultsByYear[year]) || null;
        const result = service.annualResultForYear();
        const resultRows = new Map(((result && result.details) || []).map((row) => [row.currency, row]));
        const liveRates = state.annualRatesData && state.annualRatesYear === year
          ? state.annualRatesData
          : null;
        // 有有效计算结果时，汇率/样本/覆盖日期必须与生成该总额的同一快照一致。
        // 页面后台加载到的更新行情只在结果失效后用于下一次计算提示。
        const rateContext = result || liveRates;
        const errors = (rateContext && rateContext.errors) || {};

        sharedModule.$('#annual-budget-title').textContent = `${year}年 全年预算计算`;
        const range = sharedModule.$('#annual-budget-range');
        if (rateContext && rateContext.start_date && rateContext.requested_through) {
          const d = rateContext;
          range.textContent = `${d.start_date} 至 ${d.requested_through}；最新可用收盘日 ${d.observed_through || '暂无'}`;
        } else {
          range.textContent = `将读取 ${year} 年实际交易日收盘汇率`;
        }

        rowsHost.innerHTML = service.annualCurrencies().map((currency) => {
          const row = resultRows.get(currency);
          const stat = (row && row.average_rate != null ? {
            average: row.average_rate,
            observation_count: row.observation_count || 0,
          } : null) || service.annualRateStat(currency);
          const error = errors[currency];
          const rateText = stat ? Number(stat.average).toFixed(6) : (error ? '获取失败' : '—');
          const sampleText = stat ? `${stat.observation_count} 日` : '—';
          const cnyText = row ? `¥ ${sharedModule.fmtMoney(row.cny_amount)}` : '待计算';
          const amount = Number(amounts[currency]);
          return `<tr data-annual-row="${sharedModule.esc(currency)}">
            <td><strong>${sharedModule.esc(locationsModule.currencyName(currency))}</strong> <span class="muted">${sharedModule.esc(currency)}</span></td>
            <td class="num"><input type="number" min="0" step="any" inputmode="decimal"
              data-annual-currency="${sharedModule.esc(currency)}" aria-label="${sharedModule.esc(currency)} 全年当地金额"
              value="${Number.isFinite(amount) ? amount : 0}"></td>
            <td class="num ${error ? 'rate-missing' : ''}" data-annual-rate>${sharedModule.esc(rateText)}</td>
            <td class="num">${sharedModule.esc(sampleText)}</td>
            <td class="num" data-annual-cny>${sharedModule.esc(cnyText)}</td>
          </tr>`;
        }).join('');

        const total = result && result.summary ? Number(result.summary['全年预算合计(人民币)']) : NaN;
        sharedModule.$('#annual-budget-total').textContent = Number.isFinite(total) ? `¥ ${sharedModule.fmtMoney(total)}` : '¥ —';
        const meta = sharedModule.$('#annual-budget-meta');
        meta.textContent = result
          ? `已计算至 ${result.observed_through || result.requested_through || '最新收盘日'}${result.calculatedAt ? ` · ${result.calculatedAt}` : ''}`
          : (storedResult && storedResult.stale
            ? `${storedResult.staleReason || '全年输入或汇率已变化'}，请重新计算`
            : '输入各币种全年金额后计算');

        const errorCurrencies = Object.keys(errors);
        const note = sharedModule.$('#annual-budget-note');
        if (errorCurrencies.length) {
          note.textContent = `以下币种暂时缺少收盘汇率：${errorCurrencies.join(', ')}。其金额为 0 时不影响总额；非 0 时将拒绝计算。`;
          note.classList.add('is-warning');
        } else {
          note.textContent = '非交易日不填充；年平均按 Yahoo Finance 实际 Close 观测直接求算术平均。';
          note.classList.remove('is-warning');
        }
        const status = sharedModule.$('#annual-budget-status');
        status.textContent = state.annualLoading
          ? '正在获取汇率…'
          : (result ? '已计算' : (storedResult && storedResult.stale ? '待重新计算' : '待计算'));
        status.classList.toggle('dirty', !result && !state.annualLoading);
        const calculateButton = sharedModule.$('#btn-calculate-annual');
        if (calculateButton) calculateButton.disabled = !!state.annualLoading;
      }

      function invalidateAnnualResult(reason = '全年金额已修改') {
        const year = service.annualYearKey();
        const existing = state.annualResultsByYear && state.annualResultsByYear[year];
        // 年度映射与月度映射一样采用“未提交的 key 保留磁盘值”的合并语义。
        // 不能直接 delete 唯一结果，否则空映射会被解释为“没有更新”，旧总额会在重载时复活。
        if (existing && typeof existing === 'object') {
          existing.stale = true;
          existing.staleReason = reason;
          existing.staleAt = new Date().toISOString();
        }
        sharedModule.$$('#annual-budget-rows [data-annual-cny]').forEach((cell) => { cell.textContent = '待计算'; });
        const total = sharedModule.$('#annual-budget-total');
        if (total) total.textContent = '¥ —';
        const meta = sharedModule.$('#annual-budget-meta');
        if (meta) meta.textContent = '金额已修改，请重新计算';
        const status = sharedModule.$('#annual-budget-status');
        if (status) { status.textContent = '待重新计算'; status.classList.add('dirty'); }
      }

      function annualRatesDifferFromResult(rates, result) {
        if (!rates || !result) return false;
        if ((rates.requested_through || null) !== (result.requested_through || null)) return true;
        if ((rates.observed_through || null) !== (result.observed_through || null)) return true;
        const resultRows = new Map((result.details || []).map((row) => [row.currency, row]));
        for (const [currency, row] of resultRows) {
          const stat = (rates.stats || {})[currency];
          if (!stat && Number(row.amount) > 0) return true;
          if (!stat) continue;
          if (Math.abs(Number(stat.average) - Number(row.average_rate)) > 1e-12) return true;
          if (Number(stat.observation_count) !== Number(row.observation_count || 0)) return true;
        }
        return false;
      }

      async function loadAnnualRates(force = false) {
        const year = service.annualYearKey();
        if (state.annualLoading && state.annualLoadingYear === year) return;
        if (!force && state.annualRatesData && state.annualRatesYear === year) {
          service.renderAnnualBudget();
          return;
        }
        const requestId = state.annualRateRequestId + 1;
        state.annualRateRequestId = requestId;
        state.annualLoading = true;
        state.annualLoadingYear = year;
        service.renderAnnualBudget();
        const button = sharedModule.$('#btn-refresh-annual-rates');
        if (button) button.disabled = true;
        try {
          const query = service.annualCurrencies().join(',');
          const refresh = force ? '&refresh=true' : '';
          const data = await apiModule.api(`/api/annual-rates?year=${year}&currencies=${encodeURIComponent(query)}${refresh}`, { timeout: 180000 });
          if (state.annualRateRequestId !== requestId || service.annualYearKey() !== year) return;
          const priorResult = service.annualResultForYear();
          state.annualRatesData = data;
          state.annualRatesYear = year;
          const failedCurrencies = Object.keys((data && data.errors) || {});
          const refreshComplete = !!data && data.complete !== false && failedCurrencies.length === 0;
          const invalidated = !!priorResult && refreshComplete
            && (force || service.annualRatesDifferFromResult(data, priorResult));
          if (invalidated) {
            service.invalidateAnnualResult(force ? '全年收盘汇率已手动刷新' : '全年收盘汇率覆盖范围已更新');
            persistenceModule.persist('debounce', 'annual');
          }
          if (force) {
            if (!refreshComplete) {
              feedbackModule.toast(`全年收盘汇率刷新不完整（${failedCurrencies.join(', ') || '未知币种'}），已保留原计算结果`, 'warn');
            } else {
              feedbackModule.toast(invalidated ? '已刷新全年收盘汇率，请重新计算全年预算' : '已刷新全年收盘汇率', 'success');
            }
          }
        } catch (err) {
          if (state.annualRateRequestId === requestId && service.annualYearKey() === year) {
            state.annualRatesData = null;
            state.annualRatesYear = null;
            feedbackModule.toast(err.message, 'error');
            networkModule.maybeShowNetworkWarning(err.message);
          }
        } finally {
          if (state.annualRateRequestId === requestId) {
            state.annualLoading = false;
            state.annualLoadingYear = null;
            if (button) button.disabled = false;
            service.renderAnnualBudget();
          }
        }
      }

      async function calculateAnnualBudget(options = {}) {
        const automatic = !!(options && options.automatic);
        if (state.busy) return false;
        if (state.annualLoading) {
          if (!automatic) feedbackModule.toast('全年收盘汇率仍在刷新，请完成后再计算', 'warn');
          return false;
        }
        const year = service.annualYearKey();
        const amounts = {};
        let invalid = false;
        sharedModule.$$('#annual-budget-rows input[data-annual-currency]').forEach((input) => {
          const amount = Number(input.value);
          if (!Number.isFinite(amount) || amount < 0) {
            input.classList.add('invalid');
            invalid = true;
          } else {
            input.classList.remove('invalid');
            amounts[input.dataset.annualCurrency] = amount;
          }
        });
        if (invalid) {
          if (!automatic) feedbackModule.toast('全年金额必须是非负有限数', 'warn');
          return false;
        }

        state.busy = true;
        if (!automatic) feedbackModule.setLoading(true, `正在更新 ${year} 年全年预算…`);
        try {
          const result = await apiModule.api('/api/annual-budget', {
            method: 'POST', body: { year: Number(year), amounts }, timeout: 180000,
          });
          result.calculatedAt = new Date().toLocaleString('zh-CN', { hour12: false });
          state.annualBudgetsByYear[year] = amounts;
          state.annualResultsByYear[year] = persistenceModule.compactAnnualResultsMap({ [year]: result })[year];
          const saved = await persistenceModule.persist('now', 'annual');
          service.renderAnnualBudget();
          if (!automatic || !saved) {
            feedbackModule.toast(saved ? '全年预算已更新并保存' : '全年预算已更新，但保存到服务器失败', saved ? 'success' : 'warn');
          }
          return true;
        } catch (err) {
          feedbackModule.toast(automatic ? `自动更新全年预算失败：${err.message}` : err.message, 'error');
          networkModule.maybeShowNetworkWarning(err.message);
          return false;
        } finally {
          state.busy = false;
          if (!automatic) feedbackModule.setLoading(false);
        }
      }

      Object.assign(service, {
        annualYearKey,
        annualBudgetAmounts,
        annualCurrencies,
        availableAnnualYears,
        fillAnnualYearSelect,
        annualRateStat,
        annualResultForYear,
        renderAnnualBudget,
        invalidateAnnualResult,
        annualRatesDifferFromResult,
        loadAnnualRates,
        calculateAnnualBudget,
      });

      return service;
    },
  });
})(window.BudgetModules || (window.BudgetModules = Object.create(null)));
