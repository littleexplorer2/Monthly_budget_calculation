/* v2 数据管理、显式删除/清空与用户发起的仓库上传。 */
(function register(registry) {
  'use strict';
  registry.data = Object.freeze({
    dependencies: Object.freeze(["analysis","annual","assets","http","calendar","feedback","itinerary","monthly","persistence","results","shared","standards","standardsView","state","subscriptions","travel"]),
    create({ analysis: analysisModule, annual: annualModule, assets: assetsModule, http: apiModule, calendar: calendarModule, feedback: feedbackModule, itinerary: itineraryModule, monthly: monthlyModule, persistence: persistenceModule, results: resultsModule, shared: sharedModule, standards: standardsModule, standardsView: standardsViewModule, state: stateModule, subscriptions: subscriptionsModule, travel: travelModule }, service = {}) {
      const { state } = stateModule;
      let currentBackupToken = null;

      function hasItineraryMonth(month) {
        const entity = state.monthsByKey[month];
        return !!(entity && entity.itinerary
          && Object.values(entity.itinerary).some((ranges) => Array.isArray(ranges) && ranges.length));
      }

      async function openDataManager() {
        feedbackModule.setElVisible(sharedModule.$('#data-modal'), true);
        const listBox = sharedModule.$('#data-modal-list');
        if (listBox) listBox.innerHTML = '<p class="empty">正在读取已保存数据…</p>';
        const months = new Set(Object.keys(state.monthsByKey || {}));
        let rateMonths = [];
        let backups = [];
        try {
          const data = await apiModule.api('/api/data/rates', { timeout: 10000 });
          rateMonths = (data && data.months) || [];
          rateMonths.forEach((month) => months.add(month));
        } catch (_) { /* 后端不可达时仍展示内存实体 */ }
        try {
          const catalog = await apiModule.api('/api/backups', { timeout: 10000 });
          backups = Array.isArray(catalog && catalog.backups) ? catalog.backups : [];
          currentBackupToken = catalog && catalog.currentToken || null;
        } catch (_) {
          currentBackupToken = null;
        }

        const annualYears = Array.from(new Set([
          ...Object.keys(state.annualBudgetsByYear || {}),
          ...Object.keys(state.annualResultsByYear || {}),
        ])).sort();
        const assetPortfolio = state.assetPortfoliosById && state.assetPortfoliosById.current;
        const list = Array.from(months).sort();
        if (!listBox) return;
        if (!list.length && !annualYears.length && !assetPortfolio && !backups.length) {
          listBox.innerHTML = '<p class="empty">暂无已保存的数据</p>';
          return;
        }
        const backupHtml = `<div class="data-section-title">不可变备份</div>${backups.length
          ? backups.map((backup) => {
            const created = backup.createdAt ? String(backup.createdAt).replace('T', ' ') : '时间未知';
            const summary = backup.restorable
              ? `${backup.monthCount || 0} 个月 · ${backup.reason || '未注明原因'} · 恢复时验真`
              : (backup.kind === 'legacy-v1'
                ? `旧版 v1 · 仅供人工回滚 · ${backup.reason || '未注明原因'}`
                : `不可恢复 · ${backup.error || '清单损坏或属于未知存储格式'}`);
            const action = backup.restorable
              ? `<button class="link" data-action="restore-backup" data-backup-id="${sharedModule.esc(backup.id)}">恢复此备份</button>`
              : '';
            return `<div class="data-row data-backup-row" data-backup-id="${sharedModule.esc(backup.id)}">
              <span class="data-month">${sharedModule.esc(created)}</span>
              <span class="data-tags"><i class="tag">${sharedModule.esc(summary)}</i></span>
              ${action}
            </div>`;
          }).join('')
          : '<p class="empty data-backup-empty">暂无可用备份</p>'}`;
        const assetCount = assetPortfolio && Array.isArray(assetPortfolio.items) ? assetPortfolio.items.length : 0;
        const assetHtml = assetPortfolio ? `<div class="data-row" data-portfolio="current">
          <span class="data-month">资产管理</span>
          <span class="data-tags"><i class="tag">${assetCount} 个资产条目</i><i class="tag">计算基数</i></span>
          <span class="data-mark">当前资产</span>
        </div>` : '';
        const annualHtml = annualYears.map((year) => {
          const tags = [];
          if (state.annualBudgetsByYear[year]) tags.push('全年金额');
          if (state.annualResultsByYear[year]) tags.push(state.annualResultsByYear[year].stale ? '全年结果待重算' : '全年结果');
          return `<div class="data-row" data-year="${sharedModule.esc(year)}">
            <span class="data-month">${sharedModule.esc(year)} 年</span>
            <span class="data-tags">${tags.map((tag) => `<i class="tag">${sharedModule.esc(tag)}</i>`).join('')}</span>
            <span class="data-mark">全年预算</span>
          </div>`;
        }).join('');
        const monthlyHtml = list.map((month) => {
          const entity = state.monthsByKey[month];
          const tags = [];
          if (service.hasItineraryMonth(month)) tags.push('行程');
          if (entity) tags.push('计算选项', '标准快照');
          if (entity && entity.result) tags.push(entity.result.stale ? '结果待重算' : '计算结果');
          if (entity && entity.subscriptions && entity.subscriptions.items.length) tags.push('订阅项目');
          if (rateMonths.includes(month)) tags.push('汇率数据');
          const current = month === monthlyModule.monthKey() ? '<span class="data-mark">（当前月）</span>' : '';
          const remove = entity
            ? `<button class="link danger" data-action="del-month" data-month="${sharedModule.esc(month)}">删除该月</button>`
            : '';
          return `<div class="data-row" data-month="${sharedModule.esc(month)}">
            <span class="data-month">${sharedModule.esc(month)}</span>
            <span class="data-tags">${tags.map((tag) => `<i class="tag">${sharedModule.esc(tag)}</i>`).join('')}</span>
            ${current}${remove}
          </div>`;
        }).join('');
        const currentHtml = assetHtml + annualHtml + monthlyHtml;
        listBox.innerHTML = `${currentHtml ? '<div class="data-section-title">当前权威数据</div>' + currentHtml : ''}${backupHtml}`;
      }

      function closeDataManager() {
        feedbackModule.setElVisible(sharedModule.$('#data-modal'), false);
      }

      async function uploadAllData() {
        if (!window.confirm('确定保存并上传权威用户数据吗？\n\n将上传 global.json、months/*.json 与 defaults.json；不会上传汇率缓存或本机迁移归档。')) return;
        const button = sharedModule.$('#btn-data-upload');
        const status = sharedModule.$('#data-upload-status');
        if (button) button.disabled = true;
        feedbackModule.setLoading(true, '正在保存并上传预算数据…');
        try {
          if (state.monthsByKey[monthlyModule.monthKey()]) {
            monthlyModule.saveMonthOptions();
            standardsModule.snapshotOverridesIntoState();
            persistenceModule.markMonthDirty('options');
            persistenceModule.markMonthDirty('standards');
          }
          if (!(await persistenceModule.persist('now'))) throw new Error('本地实体尚未可靠保存');
          if (status) status.textContent = '本地数据已保存，正在提交并推送…';
          const result = await apiModule.api('/api/data/upload', {
            method: 'POST', body: { user_confirmed: true }, timeout: 180000,
          });
          const message = `${result.message}（${result.remote}/${result.branch}，${result.commit}）`;
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

      async function restoreBackup(backupId) {
        if (!currentBackupToken) {
          feedbackModule.toast('无法取得当前数据令牌，请重新打开数据管理后再试', 'error');
          return;
        }
        if (!window.confirm(
          '确定用这个不可变备份替换当前全部月份、年度、资产与默认配置吗？\n\n'
          + '当前有效数据会先建立新的恢复前备份；尚未保存的页面修改会被放弃。恢复后页面将重新加载。',
        )) return;
        feedbackModule.setLoading(true, '正在校验并恢复备份…');
        try {
          const result = await apiModule.api('/api/backups/restore', {
            method: 'POST',
            body: {
              backup_id: backupId,
              base_token: currentBackupToken,
              user_confirmed: true,
            },
            timeout: 30000,
          });
          feedbackModule.toast(`已恢复 ${result.months || 0} 个月份，正在重新加载`, 'success');
          window.location.reload();
        } catch (err) {
          feedbackModule.toast(`恢复失败：${err.message}；当前权威数据未被替换`, 'error');
          await service.openDataManager();
        } finally {
          feedbackModule.setLoading(false);
        }
      }

      function resetCurrentMonthView() {
        monthlyModule.applyMonthOptions(monthlyModule.monthKey());
        monthlyModule.syncOptionsUI();
        standardsModule.resetStandardsToDefault();
        state.customLocations = [];
        state.customCurrencies = {};
        subscriptionsModule.syncCurrentMonth();
        state.calcResult = resultsModule.loadResultForMonth(monthlyModule.monthKey());
        standardsViewModule.renderStandards();
        subscriptionsModule.render();
        calendarModule.renderLocChips();
        travelModule.renderTravelPicker();
        if (state.calcResult) resultsModule.renderResult(); else resultsModule.clearResult();
        calendarModule.renderCalendar();
        itineraryModule.renderItinerary();
      }

      async function deleteMonthData(month) {
        if (!state.monthsByKey[month]) return;
        if (!window.confirm(`确定删除 ${month} 的完整月份实体吗？删除前服务端会通过修订号确认没有并发修改。`)) return;
        try {
          await persistenceModule.deleteMonth(month);
        } catch (err) {
          feedbackModule.toast(`删除 ${month} 失败：${err.message}`, 'error');
          return;
        }
        let ratesDeleted = true;
        try {
          await apiModule.api('/api/data/rates/delete', {
            method: 'POST', body: { months: [month] }, timeout: 10000,
          });
        } catch (_) { ratesDeleted = false; }
        if (month === monthlyModule.monthKey()) service.resetCurrentMonthView();
        await service.openDataManager();
        feedbackModule.toast(
          ratesDeleted ? `已删除 ${month} 的完整月份实体` : `${month} 已删除，但汇率缓存删除失败`,
          ratesDeleted ? 'success' : 'warn',
        );
      }

      async function clearAllData() {
        if (!window.confirm('确定清空所有保存的数据吗？服务端会先创建不可变备份，再原子移除全部月份、年度与资产状态。')) return;
        try {
          clearTimeout(persistenceModule.runtime.persistTimer);
          await persistenceModule.clearAll();
        } catch (err) {
          feedbackModule.toast(`清空失败：${err.message}；服务器与页面数据均未改动`, 'error');
          return;
        }
        let ratesError = null;
        try {
          const data = await apiModule.api('/api/data/rates', { timeout: 10000 });
          const months = (data && data.months) || [];
          if (months.length) await apiModule.api('/api/data/rates/delete', {
            method: 'POST', body: { months }, timeout: 15000,
          });
        } catch (err) { ratesError = err; }
        service.resetCurrentMonthView();
        assetsModule.render();
        annualModule.renderAnnualBudget();
        analysisModule.renderAnalysis();
        service.closeDataManager();
        feedbackModule.toast(
          ratesError ? `权威状态已清空，但汇率缓存删除失败：${ratesError.message}` : '已备份并清空全部保存数据',
          ratesError ? 'warn' : 'success',
        );
      }

      Object.assign(service, {
        hasItineraryMonth,
        openDataManager,
        closeDataManager,
        uploadAllData,
        restoreBackup,
        resetCurrentMonthView,
        deleteMonthData,
        clearAllData,
      });
      return service;
    },
  });
})(window.BudgetModules || (window.BudgetModules = Object.create(null)));
