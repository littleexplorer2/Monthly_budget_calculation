/* 数据管理面板、删除回滚和用户发起的上传。
 * 跨模块调用由 web/js/app.js 显式注入；模块只导出本职责的接口。
 */
(function register(registry) {
  'use strict';
  registry.data = Object.freeze({
    dependencies: Object.freeze(["analysis","annual","http","calendar","feedback","itinerary","monthly","persistence","results","shared","standards","standardsView","state","travel"]),
    create({ analysis: analysisModule, annual: annualModule, http: apiModule, calendar: calendarModule, feedback: feedbackModule, itinerary: itineraryModule, monthly: monthlyModule, persistence: persistenceModule, results: resultsModule, shared: sharedModule, standards: standardsModule, standardsView: standardsViewModule, state: stateModule, travel: travelModule }, service = {}) {
      const { state } = stateModule;

      /* --------------------------------------------------------------------------
       * 数据管理（批量查看/删除已保存的行程、标准修改、计算结果与汇率缓存）
       * ------------------------------------------------------------------------ */
      function hasItineraryMonth(m) {
        const itin = state.itineraryByMonth[m];
        return !!itin && Object.values(itin).some((ranges) => ranges.length > 0);
      }

      async function openDataManager() {
        feedbackModule.setElVisible(sharedModule.$('#data-modal'), true);
        const listBox = sharedModule.$('#data-modal-list');
        if (listBox) listBox.innerHTML = '<p class="empty">正在读取已保存数据…</p>';

        const months = new Set();
        Object.keys(state.itineraryByMonth).forEach((m) => months.add(m));
        Object.keys(state.optionsByMonth || {}).forEach((m) => months.add(m));
        Object.keys(standardsModule.loadOverridesMap()).forEach((m) => months.add(m));
        Object.keys(resultsModule.loadResultsMap()).forEach((m) => months.add(m));
        let rateMonths = [];
        try {
          const d = await apiModule.api('/api/data/rates', { timeout: 10000 });
          rateMonths = (d && d.months) || [];
          rateMonths.forEach((m) => months.add(m));
        } catch (_) { /* 后端不可达时仅展示本地数据 */ }

        const list = Array.from(months).sort();
        const annualYears = Array.from(new Set([
          ...Object.keys(state.annualBudgetsByYear || {}),
          ...Object.keys(state.annualResultsByYear || {}),
        ])).sort();
        if (!listBox) return;
        if (!list.length && !annualYears.length) {
          listBox.innerHTML = '<p class="empty">暂无已保存的数据</p>';
        } else {
          const annualHtml = annualYears.map((year) => {
            const tags = [];
            if (state.annualBudgetsByYear && state.annualBudgetsByYear[year]) tags.push('全年金额');
            if (state.annualResultsByYear && state.annualResultsByYear[year]) {
              tags.push(state.annualResultsByYear[year].stale ? '全年结果待重算' : '全年结果');
            }
            return `<div class="data-row" data-year="${sharedModule.esc(year)}">
              <span class="data-month">${sharedModule.esc(year)} 年</span>
              <span class="data-tags">${tags.map((t) => `<i class="tag">${sharedModule.esc(t)}</i>`).join('')}</span>
              <span class="data-mark">全年预算</span>
            </div>`;
          }).join('');
          const monthlyHtml = list.map((m) => {
            const tags = [];
            if (service.hasItineraryMonth(m)) tags.push('行程');
            if (state.optionsByMonth && state.optionsByMonth[m]) tags.push('计算选项');
            if (standardsModule.loadOverridesMap()[m]) tags.push('标准修改');
            if (resultsModule.loadResultsMap()[m]) tags.push('计算结果');
            if (rateMonths.includes(m)) tags.push('汇率数据');
            const cur = m === monthlyModule.monthKey() ? '<span class="data-mark">（当前月）</span>' : '';
            return `<div class="data-row" data-month="${sharedModule.esc(m)}">
              <span class="data-month">${sharedModule.esc(m)}</span>
              <span class="data-tags">${tags.map((t) => `<i class="tag">${sharedModule.esc(t)}</i>`).join('')}</span>
              ${cur}
              <button class="link danger" data-action="del-month" data-month="${sharedModule.esc(m)}">删除该月</button>
            </div>`;
          }).join('');
          listBox.innerHTML = annualHtml + monthlyHtml;
        }
        feedbackModule.setElVisible(sharedModule.$('#data-modal'), true);
      }

      function closeDataManager() {
        feedbackModule.setElVisible(sharedModule.$('#data-modal'), false);
      }

      /** 完整保存当前状态，再将 data/ 提交并推送到已配置的 Git 远程仓库。 */
      async function uploadAllData() {
        if (!window.confirm('确定保存当前全部数据，并提交、上传到远程仓库吗？\n\n上传仅包含项目 data/ 目录。')) return;
        const button = sharedModule.$('#btn-data-upload');
        const status = sharedModule.$('#data-upload-status');
        if (button) button.disabled = true;
        if (status) status.textContent = '正在保存本地数据…';
        feedbackModule.setLoading(true, '正在保存并上传全部数据…');
        try {
          monthlyModule.saveMonthOptions();
          standardsModule.snapshotOverridesIntoState();
          const saved = await persistenceModule.persist('now');
          if (!saved) throw new Error('本地数据保存失败，请确认后端服务正常');

          if (status) status.textContent = '本地数据已保存，正在提交并推送…';
          const result = await apiModule.api('/api/data/upload', { method: 'POST', timeout: 180000 });
          const target = `${result.remote}/${result.branch}`;
          const message = `${result.message}（${target}，${result.commit}）`;
          if (status) status.textContent = message;
          feedbackModule.toast(message, 'success');
        } catch (err) {
          const message = `上传失败：${err.message}`;
          if (status) status.textContent = message;
          feedbackModule.toast(message, 'error');
        } finally {
          feedbackModule.setLoading(false);
          if (button) button.disabled = false;
        }
      }

      /** 删除某个月的全部保存数据（行程/标准修改/结果 + 服务端汇率缓存） */
      async function deleteMonthData(m) {
        const backup = sharedModule.deepClone(persistenceModule.snapshotBundle());
        state.itineraryByMonth[m] = {};
        if (!state.optionsByMonth || typeof state.optionsByMonth !== 'object') state.optionsByMonth = {};
        state.optionsByMonth[m] = {};
        if (m === monthlyModule.monthKey()) {
          state.region = 'Mainland';
          state.includeTravel = false;
          state.travelSelected = null;
        }
        const ovMap = standardsModule.loadOverridesMap();
        ovMap[m] = {};
        state.overridesByMonth = ovMap;
        const resMap = resultsModule.loadResultsMap();
        resMap[m] = {};
        state.resultsByMonth = persistenceModule.compactResultsMap(resMap);
        const stateDeleted = await persistenceModule.persist('now');
        if (!stateDeleted) {
          persistenceModule.applyBundle(backup);
          persistenceModule.writeLocalCache(backup);
          monthlyModule.syncOptionsUI();
          standardsModule.resetStandardsToDefault();
          state.customLocations = [];
          state.customCurrencies = {};
          standardsModule.loadOverrides();
          state.calcResult = resultsModule.loadResultForMonth(monthlyModule.monthKey());
          standardsViewModule.renderStandards();
          calendarModule.renderLocChips();
          travelModule.renderTravelPicker();
          if (state.calcResult) resultsModule.renderResult(); else resultsModule.clearResult();
          calendarModule.renderCalendar();
          itineraryModule.renderItinerary();
          await service.openDataManager();
          feedbackModule.toast(`删除 ${m} 失败，页面数据已恢复；请确认后端服务正常后重试`, 'error');
          return;
        }

        // 空对象只用于向后端表达“删除该月”。写盘成功后移除本机墓碑，
        // 否则数据管理会继续把已删除月份显示成一行空数据。
        delete state.itineraryByMonth[m];
        delete state.optionsByMonth[m];
        delete state.overridesByMonth[m];
        delete state.resultsByMonth[m];
        persistenceModule.writeLocalCache(persistenceModule.snapshotBundle());

        let ratesDeleted = true;
        try {
          await apiModule.api('/api/data/rates/delete', { method: 'POST', body: { months: [m] }, timeout: 10000 });
        } catch (_) {
          ratesDeleted = false;
        }

        if (m === monthlyModule.monthKey()) {
          // 删除的是当前月：重置界面为默认状态
          monthlyModule.applyMonthOptions(monthlyModule.monthKey());
          monthlyModule.syncOptionsUI();
          standardsModule.resetStandardsToDefault();
          state.customLocations = [];
          state.customCurrencies = {};
          state.calcResult = null;
          standardsViewModule.renderStandards();
          calendarModule.renderLocChips();
          travelModule.renderTravelPicker();
          resultsModule.clearResult();
          calendarModule.renderCalendar();
          itineraryModule.renderItinerary();
          standardsViewModule.invalidateConfirmation();
        }
        await service.openDataManager();
        if (ratesDeleted) feedbackModule.toast(`已删除 ${m} 的保存数据`, 'success');
        else feedbackModule.toast(`${m} 的行程等数据已删除，但汇率缓存删除失败，请重试`, 'warn');
      }

      /** 清空全部保存数据（所有月份与全年预算状态 + 服务端全部汇率缓存） */
      async function clearAllData() {
        if (!window.confirm('确定清空所有保存的数据吗？包括全年预算、全部月份的行程、预算标准修改、计算结果与汇率缓存，删除后不可恢复。')) return;
        const backup = persistenceModule.snapshotBundle();
        state.itineraryByMonth = {};
        state.optionsByMonth = {};
        state.overridesByMonth = {};
        state.resultsByMonth = {};
        state.annualBudgetsByYear = {};
        state.annualResultsByYear = {};
        standardsModule.resetStandardsToDefault();
        state.customLocations = [];
        state.customCurrencies = {};
        state.calcResult = null;
        monthlyModule.applyMonthOptions(monthlyModule.monthKey());
        monthlyModule.syncOptionsUI();
        let stateCleared = false;
        try {
          clearTimeout(persistenceModule.runtime.persistTimer);
          const bundle = persistenceModule.snapshotBundle();
          stateCleared = await persistenceModule.flushPersist(Object.assign(bundle, { replace: true }));
          if (!stateCleared) throw new Error('清空服务器状态失败');
          localStorage.removeItem(persistenceModule.STORE_KEY);
          localStorage.removeItem(persistenceModule.OVERRIDES_KEY);
          localStorage.removeItem(persistenceModule.RESULTS_KEY);
          persistenceModule.writeLocalCache(bundle);
        } catch (err) {
          persistenceModule.applyBundle(backup);
          standardsModule.resetStandardsToDefault();
          standardsModule.loadOverrides();
          state.calcResult = resultsModule.loadResultForMonth(monthlyModule.monthKey());
          standardsViewModule.renderStandards();
          calendarModule.renderLocChips();
          travelModule.renderTravelPicker();
          if (state.calcResult) resultsModule.renderResult(); else resultsModule.clearResult();
          calendarModule.renderCalendar();
          itineraryModule.renderItinerary();
          feedbackModule.toast(`清空失败：${err.message}；已恢复页面数据`, 'error');
          return;
        }
        let ratesError = null;
        try {
          const d = await apiModule.api('/api/data/rates', { timeout: 10000 });
          const months = (d && d.months) || [];
          if (months.length) {
            await apiModule.api('/api/data/rates/delete', { method: 'POST', body: { months }, timeout: 15000 });
          }
        } catch (err) {
          ratesError = err;
        }
        standardsViewModule.renderStandards();
        calendarModule.renderLocChips();
        travelModule.renderTravelPicker();
        resultsModule.clearResult();
        calendarModule.renderCalendar();
        itineraryModule.renderItinerary();
        annualModule.renderAnnualBudget();
        analysisModule.renderAnalysis();
        standardsViewModule.invalidateConfirmation();
        service.closeDataManager();
        if (ratesError) {
          feedbackModule.toast(`状态已清空，但汇率缓存删除失败：${ratesError.message}`, 'warn');
        } else if (stateCleared) {
          feedbackModule.toast('已清空全部保存数据', 'success');
        }
      }

      Object.assign(service, {
        hasItineraryMonth,
        openDataManager,
        closeDataManager,
        uploadAllData,
        deleteMonthData,
        clearAllData,
      });

      return service;
    },
  });
})(window.BudgetModules || (window.BudgetModules = Object.create(null)));
