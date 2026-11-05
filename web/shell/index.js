/* 界面组装、事件绑定及初始化流程。
 * 跨模块调用由 web/js/app.js 显式注入；模块只导出本职责的接口。
 */
(function register(registry) {
  'use strict';
  registry.shell = Object.freeze({
    dependencies: Object.freeze(["analysis","annual","assets","http","calendar","data","feedback","itinerary","locations","monthly","navigation","network","persistence","results","shared","standards","standardsEditor","standardsView","state","subscriptions","travel"]),
    create({ analysis: analysisModule, annual: annualModule, assets: assetsModule, http: apiModule, calendar: calendarModule, data: dataModule, feedback: feedbackModule, itinerary: itineraryModule, locations: locationsModule, monthly: monthlyModule, navigation: navigationModule, network: networkModule, persistence: persistenceModule, results: resultsModule, shared: sharedModule, standards: standardsModule, standardsEditor: standardsEditorModule, standardsView: standardsViewModule, state: stateModule, subscriptions: subscriptionsModule, travel: travelModule }, service = {}) {
      const { state } = stateModule;

      /* --------------------------------------------------------------------------
       * 页签与月份切换
       * ------------------------------------------------------------------------ */
      function switchTab(name) {
        return navigationModule.switchTab(name);
      }

      function renderAll() {
        monthlyModule.renderMonthContext();
      }

      /* --------------------------------------------------------------------------
       * 事件绑定
       * ------------------------------------------------------------------------ */
      function bindEvents() {
        sharedModule.$$('.primary-nav-item').forEach((button) => {
          button.addEventListener('click', () => navigationModule.openSection(button.dataset.section));
        });
        sharedModule.$$('.section-nav-item').forEach((button) => {
          button.addEventListener('click', () => navigationModule.openBudgetTab(button.dataset.tab));
        });
        sharedModule.$$('.dashboard-nav-item').forEach((button) => {
          button.addEventListener('click', () => navigationModule.openDashboardTab(button.dataset.dashboardTab));
        });

        // 月份导航
        sharedModule.$('#btn-prev-month').addEventListener('click', () => monthlyModule.changeMonth(-1));
        sharedModule.$('#btn-next-month').addEventListener('click', () => monthlyModule.changeMonth(1));
        sharedModule.$('#btn-this-month').addEventListener('click', monthlyModule.goThisMonth);

        // 区域选择同时决定当前可见订阅及该区域的固定预算汇总。
        sharedModule.$('#region-seg').addEventListener('click', (ev) => {
          const btn = ev.target.closest('.seg-btn[data-region]');
          if (!btn || btn.dataset.region === state.region) return;
          state.region = btn.dataset.region;
          persistenceModule.saveState(true);
          // 分段高亮即时更新
          sharedModule.$$('#region-seg .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.region === state.region));
          subscriptionsModule.render();
          standardsViewModule.renderStandards();
        });

        // 计算
        sharedModule.$('#btn-calculate').addEventListener('click', monthlyModule.calculate);
        sharedModule.$('#btn-recalc').addEventListener('click', monthlyModule.calculate);

        // 当月预算标准输入（默认配置弹窗已移为独立顶层区域）。
        sharedModule.$('#tab-standards').addEventListener('input', (ev) => {
          const el = ev.target;
          if (!el.matches('input[data-cat]')) return;
          const { cat, loc, curr, field } = el.dataset;
          const v = Number(el.value);
          if (!Number.isFinite(v) || v < 0) {
            el.classList.add('invalid');
            return;
          }
          el.classList.remove('invalid');
          standardsEditorModule.applyMonthInput(cat, loc, curr, field, v);
          standardsEditorModule.refreshRowChip(cat, loc, curr, field, el); // 「与默认值不同」标记即时出现/消失
        });

        // 新建 / 删除自定义标准；差异标记上的「存入默认 / 还原」；默认标准区的「＋ 新建」
        sharedModule.$('#tab-standards').addEventListener('click', (ev) => {
          const addBtn = ev.target.closest('[data-action="add-std"]');
          if (addBtn) { standardsEditorModule.openAddStandard(addBtn.dataset.cat, addBtn.dataset.region); return; }
          if (ev.target.closest('#btn-add-variable')) { standardsEditorModule.openAddStandard('variable'); return; }
          if (ev.target.closest('#btn-add-travel')) { standardsEditorModule.openAddStandard('travel'); return; }
          const rowBtn = ev.target.closest('button[data-action="revert-row"]');
          if (rowBtn) {
            const holder = rowBtn.closest('.chip-diff');
            const ds = (holder && holder.dataset) || rowBtn.dataset;
            standardsEditorModule.restoreDefaultEntry(ds.cat, ds.loc, ds.curr, ds.field || null);
            return;
          }
          const btn = ev.target.closest('button[data-action="del-custom"]');
          if (btn && btn.dataset.loc) standardsEditorModule.deleteCustomStandard(btn.dataset.loc);
        });

        // 订阅项目：每月独立快照，勾选项目的月均币种合计直接驱动固定预算。
        sharedModule.$('#subscription-list').addEventListener('input', (ev) => {
          const field = ev.target.closest('input[data-subscription-field="name"], input[data-subscription-field="amount"]');
          if (field) subscriptionsModule.updateField(field, { renderList: false });
        });
        sharedModule.$('#subscription-list').addEventListener('change', (ev) => {
          const field = ev.target.closest('[data-subscription-field]');
          if (field && !field.matches('input[data-subscription-field="name"], input[data-subscription-field="amount"]')) {
            subscriptionsModule.updateField(field);
          }
        });
        sharedModule.$('#subscription-list').addEventListener('click', (ev) => {
          const addButton = ev.target.closest('button[data-action="add-subscription"]');
          if (addButton) {
            subscriptionsModule.addItem(addButton.dataset.currency);
            return;
          }
          const button = ev.target.closest('button[data-action="delete-subscription"]');
          const row = button && button.closest('.subscription-row');
          if (row) subscriptionsModule.deleteItem(row.dataset.subscriptionId);
        });

        // 默认配置弹窗：预算金额与订阅默认值共用一份草稿，统一显式保存。
        sharedModule.$('#btn-defaults-modal').addEventListener('click', standardsEditorModule.openDefaultsModal);
        sharedModule.$('#btn-defaults-close').addEventListener('click', standardsEditorModule.requestCloseDefaultsModal);
        const defaultsModal = sharedModule.$('#defaults-modal');
        defaultsModal.addEventListener('input', (ev) => {
          const el = ev.target;
          if (el.matches('input[data-cat]')) {
            const { cat, loc, curr, field } = el.dataset;
            const v = Number(el.value);
            if (!Number.isFinite(v) || v < 0) { el.classList.add('invalid'); return; }
            el.classList.remove('invalid');
            standardsEditorModule.applyDefaultsInput(cat, loc, curr, field, v);
            standardsEditorModule.refreshRowChip(cat, loc, curr, field, el);
            return;
          }
          const subscriptionField = el.closest(
            'input[data-default-subscription-field="name"], input[data-default-subscription-field="amount"]',
          );
          if (subscriptionField && subscriptionsModule.updateDefaultField(subscriptionField)) {
            standardsEditorModule.updateDefaultsHint();
          }
        });
        defaultsModal.addEventListener('change', (ev) => {
          const field = ev.target.closest('[data-default-subscription-field]');
          if (field && !field.matches(
            'input[data-default-subscription-field="name"], input[data-default-subscription-field="amount"]',
          ) && subscriptionsModule.updateDefaultField(field)) standardsEditorModule.updateDefaultsHint();
        });
        defaultsModal.addEventListener('click', (ev) => {
          if (ev.target === ev.currentTarget) { standardsEditorModule.requestCloseDefaultsModal(); return; }
          const addSubscription = ev.target.closest('[data-action="add-default-subscription"]');
          if (addSubscription) {
            subscriptionsModule.addDefaultItem();
            standardsEditorModule.updateDefaultsHint();
            return;
          }
          const deleteSubscription = ev.target.closest('[data-action="delete-default-subscription"]');
          if (deleteSubscription) {
            const row = deleteSubscription.closest('.subscription-default-row');
            if (row && subscriptionsModule.deleteDefaultItem(row.dataset.defaultSubscriptionId)) {
              standardsEditorModule.updateDefaultsHint();
            }
            return;
          }
          const addBtn = ev.target.closest('[data-action="add-std"]');
          if (addBtn) { standardsEditorModule.openAddStandard(addBtn.dataset.cat, addBtn.dataset.region); return; }
          const rowBtn = ev.target.closest('button[data-action="revert-row"]');
          if (rowBtn) {
            const holder = rowBtn.closest('.chip-diff');
            const ds = (holder && holder.dataset) || rowBtn.dataset;
            standardsEditorModule.restoreDefaultEntry(ds.cat, ds.loc, ds.curr, ds.field || null);
            return;
          }
          const deleteStandard = ev.target.closest('button[data-action="del-custom"]');
          if (deleteStandard && deleteStandard.dataset.loc) standardsEditorModule.deleteCustomStandard(deleteStandard.dataset.loc);
        });
        sharedModule.$('#btn-save-defaults').addEventListener('click', standardsEditorModule.saveDefaultStandardsToServer);
        // 默认标准弹窗的显示范围开关：纯界面过滤，只重绘弹窗，绝不触发持久化
        sharedModule.$('#chk-defaults-show-all').addEventListener('change', (ev) => {
          state.defaultsShowAll = !!ev.target.checked;
          standardsViewModule.renderDefaultsPanel();
          standardsViewModule.updateDefaultsScopeHint();
        });
        sharedModule.$('#btn-discard-defaults').addEventListener('click', () => {
          if (!standardsEditorModule.defaultsDraftDirty()) { feedbackModule.toast('默认标准没有未保存的改动', 'info'); return; }
          if (!confirm('放弃对默认标准的未保存修改，恢复为服务器上已保存的默认值？')) return;
          standardsEditorModule.reconstructDefaultsDraft();
          standardsViewModule.renderStandards();
          calendarModule.renderLocChips();
          travelModule.renderTravelPicker();
          feedbackModule.toast('已放弃未保存的默认标准修改', 'info');
        });
        sharedModule.$('#btn-add-ok').addEventListener('click', standardsEditorModule.confirmAddStandard);
        sharedModule.$('#btn-add-cancel').addEventListener('click', standardsEditorModule.closeAddStandard);
        sharedModule.$('#btn-add-close').addEventListener('click', standardsEditorModule.closeAddStandard);
        sharedModule.$('#add-std-modal').addEventListener('click', (ev) => {
          if (ev.target === ev.currentTarget) standardsEditorModule.closeAddStandard();
        });
        sharedModule.$('#add-std-form').addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') standardsEditorModule.confirmAddStandard();
        });

        // 「恢复默认」只作用于本月；「恢复出厂默认」只改服务器默认标准
        sharedModule.$('#btn-reset-standards').addEventListener('click', standardsEditorModule.resetMonthToDefaults);
        sharedModule.$('#btn-reset-factory').addEventListener('click', standardsEditorModule.restoreFactoryDefaults);

        // 旅居开关与选择
        sharedModule.$('#chk-include-travel').addEventListener('change', (ev) => {
          state.includeTravel = !!ev.target.checked;
          persistenceModule.saveState(true);
          monthlyModule.updateTravelUiVisibility();
          travelModule.renderTravelPicker();
          calendarModule.renderLocChips();
        });
        sharedModule.$('#travel-picker-btn').addEventListener('click', (ev) => {
          ev.stopPropagation();
          const menu = sharedModule.$('#travel-picker-menu');
          travelModule.toggleTravelPicker(!!(menu && menu.hidden));
        });
        sharedModule.$('#tp-all').addEventListener('click', () => travelModule.selectAllTravel(true));
        sharedModule.$('#tp-none').addEventListener('click', () => travelModule.selectAllTravel(false));
        sharedModule.$('#tp-list').addEventListener('change', (ev) => {
          const chk = ev.target.closest('input[data-tp-loc]');
          if (chk) travelModule.toggleTravelLocation(chk.dataset.tpLoc, chk.checked);
        });
        document.addEventListener('click', (ev) => {
          const picker = sharedModule.$('#travel-picker-wrap');
          if (picker && !picker.contains(ev.target)) travelModule.toggleTravelPicker(false);
        });

        // 地点 chips（事件委托）
        sharedModule.$('#tab-itinerary').addEventListener('click', (ev) => {
          const chip = ev.target.closest('.chip');
          if (chip) calendarModule.selectLocation(chip.dataset.location);
        });

        // 日历选段
        sharedModule.$('#cal-grid').addEventListener('click', (ev) => {
          const cell = ev.target.closest('.cal-cell:not(.empty)');
          if (!cell) return;
          if (!state.activeLocation) { feedbackModule.toast('请先选择地点', 'warn'); return; }
          const ds = cell.dataset.date;
          if (!state.calSel.start) {
            state.calSel = { start: ds, end: null };
          } else if (!state.calSel.end) {
            const [a, b] = state.calSel.start <= ds ? [state.calSel.start, ds] : [ds, state.calSel.start];
            itineraryModule.addRange(state.activeLocation, a, b);
            state.calSel = { start: null, end: null };
          } else {
            state.calSel = { start: ds, end: null };
          }
          calendarModule.renderCalendar();
        });

        // 日历悬停预览（选中开始日期后预览区间）
        sharedModule.$('#cal-grid').addEventListener('mouseover', (ev) => {
          const cell = ev.target.closest('.cal-cell:not(.empty)');
          if (!cell || !state.calSel.start || state.calSel.end) return;
          sharedModule.$$('#cal-grid .cal-cell.preview').forEach((c) => c.classList.remove('preview'));
          const s = state.calSel.start;
          const e = cell.dataset.date;
          const [a, b] = s <= e ? [s, e] : [e, s];
          sharedModule.$$('#cal-grid .cal-cell').forEach((c) => {
            const ds = c.dataset.date;
            if (ds && ds >= a && ds <= b) c.classList.add('preview');
          });
        });
        sharedModule.$('#cal-grid').addEventListener('mouseleave', () => {
          sharedModule.$$('#cal-grid .cal-cell.preview').forEach((c) => c.classList.remove('preview'));
        });

        // 手动输入时间段
        sharedModule.$('#btn-add-range').addEventListener('click', () => {
          if (!state.activeLocation) { feedbackModule.toast('请先选择地点', 'warn'); return; }
          const s = sharedModule.$('#cal-manual-start').value;
          const e = sharedModule.$('#cal-manual-end').value;
          if (!s || !e) { feedbackModule.toast('请填写开始与结束日期', 'warn'); return; }
          if (s > e) { feedbackModule.toast('开始日期不能晚于结束日期', 'warn'); return; }
          if (!s.startsWith(monthlyModule.monthKey()) || !e.startsWith(monthlyModule.monthKey())) {
            feedbackModule.toast(`日期必须属于当前计算月份（${state.year}年${state.month}月）`, 'warn');
            return;
          }
          itineraryModule.addRange(state.activeLocation, s, e);
        });

        // 行程清单操作（删除区间 / 清空地点）
        sharedModule.$('#itinerary-list').addEventListener('click', (ev) => {
          const btn = ev.target.closest('button[data-action]');
          if (!btn) return;
          const { action, loc, idx } = btn.dataset;
          const itin = itineraryModule.currentItinerary();
          if (action === 'del-range') {
            itin[loc].splice(Number(idx), 1);
            if (!itin[loc].length) delete itin[loc];
            feedbackModule.toast('已删除时间段', 'info');
          } else if (action === 'clear-loc') {
            delete itin[loc];
            feedbackModule.toast(`已清空 ${locationsModule.locName(loc)} 的行程`, 'info');
          }
          persistenceModule.saveState();
          calendarModule.renderCalendar();
          itineraryModule.renderItinerary();
        });

        // 清空本月全部行程
        sharedModule.$('#btn-clear-all').addEventListener('click', () => {
          const itin = itineraryModule.currentItinerary();
          const count = Object.values(itin).reduce((a, r) => a + r.length, 0);
          if (!count) { feedbackModule.toast('本月暂无行程', 'warn'); return; }
          if (!window.confirm(`确定清空 ${state.year}年${state.month}月 的全部 ${count} 条时间段吗？`)) return;
          const entity = persistenceModule.ensureLocalMonthDraft(monthlyModule.monthKey());
          entity.itinerary = {};
          persistenceModule.saveState();
          calendarModule.renderCalendar();
          itineraryModule.renderItinerary();
          feedbackModule.toast('已清空本月行程', 'success');
        });

        window.addEventListener('resize', () => {
          analysisModule.resizeAnalysisChart();
        });
        sharedModule.$('#btn-network-retry').addEventListener('click', () => networkModule.runNetworkCheck(true));

        // 全年预算：年份/行情与月度页独立，金额仍走唯一状态持久化管线。
        sharedModule.$('#annual-year').addEventListener('change', async (ev) => {
          state.annualYear = Number(ev.target.value);
          state.annualRatesData = null;
          state.annualRatesYear = null;
          annualModule.renderAnnualBudget();
          await annualModule.loadAnnualRates();
          await annualModule.calculateAnnualBudget({ automatic: true });
        });
        sharedModule.$('#btn-calculate-annual').addEventListener('click', annualModule.calculateAnnualBudget);
        sharedModule.$('#annual-budget-rows').addEventListener('input', (ev) => {
          const input = ev.target.closest('input[data-annual-currency]');
          if (!input) return;
          const amount = Number(input.value);
          if (!Number.isFinite(amount) || amount < 0) {
            input.classList.add('invalid');
            return;
          }
          input.classList.remove('invalid');
          annualModule.annualBudgetAmounts()[input.dataset.annualCurrency] = amount;
          annualModule.invalidateAnnualResult();
          persistenceModule.persist('debounce', 'annual');
        });

        const analysisToolbar = sharedModule.$('.analysis-toolbar');
        if (analysisToolbar) {
          analysisToolbar.addEventListener('change', (ev) => {
            if (ev.target.closest('.tag-check, select')) analysisModule.renderAnalysis();
          });
        }

        // 资产管理：计算基数和资产条目进入统一状态管线；最近一年汇率只读获取。
        const assetsPanel = sharedModule.$('#tab-assets');
        if (assetsPanel) {
          assetsPanel.addEventListener('click', (ev) => {
            const refreshRates = ev.target.closest('#btn-refresh-asset-rates');
            if (refreshRates) { void assetsModule.loadRates(true); return; }
            const add = ev.target.closest('button[data-action="add-asset"]');
            if (add) { assetsModule.addItem(add.dataset.assetKind); return; }
            const remove = ev.target.closest('button[data-action="delete-asset"]');
            const row = remove && remove.closest('.asset-row');
            if (row) assetsModule.deleteItem(row.dataset.assetId);
          });
          assetsPanel.addEventListener('change', (ev) => {
            const setting = ev.target.closest('[data-asset-base-currency]');
            if (setting) { assetsModule.updateSetting(setting); return; }
            const field = ev.target.closest('[data-asset-field]');
            if (field) assetsModule.updateField(field);
          });
        }

        // 数据管理弹窗
        sharedModule.$('#btn-data-manager').addEventListener('click', dataModule.openDataManager);
        const dataTop = sharedModule.$('#btn-data-manager-top');
        if (dataTop) dataTop.addEventListener('click', dataModule.openDataManager);
        sharedModule.$('#btn-data-close').addEventListener('click', dataModule.closeDataManager);
        sharedModule.$('#btn-data-close2').addEventListener('click', dataModule.closeDataManager);
        sharedModule.$('#data-modal').addEventListener('click', (ev) => {
          if (ev.target === ev.currentTarget) dataModule.closeDataManager(); // 点击遮罩关闭
        });
        sharedModule.$('#data-modal-list').addEventListener('click', (ev) => {
          const btn = ev.target.closest('button[data-action="del-month"]');
          if (btn && btn.dataset.month) {
            dataModule.deleteMonthData(btn.dataset.month);
            return;
          }
          const restore = ev.target.closest('button[data-action="restore-backup"]');
          if (restore && restore.dataset.backupId) dataModule.restoreBackup(restore.dataset.backupId);
        });
        sharedModule.$('#btn-data-clear-all').addEventListener('click', dataModule.clearAllData);
        sharedModule.$('#btn-data-upload').addEventListener('click', dataModule.uploadAllData);
      }

      /* --------------------------------------------------------------------------
       * 初始化
       * ------------------------------------------------------------------------ */
      async function init(options = {}) {
        feedbackModule.setLoading(false);
        feedbackModule.setElVisible(sharedModule.$('#data-modal'), false);
        feedbackModule.setElVisible(sharedModule.$('#add-std-modal'), false);
        feedbackModule.setElVisible(sharedModule.$('#defaults-modal'), false);
        service.bindEvents();
        // 打开网页时自动检测 Yahoo Finance 连通性（不阻塞页面初始化，并行执行）
        networkModule.runNetworkCheck();
        try {
          state.meta = await apiModule.api('/api/meta', { timeout: 30000 });
        } catch (err) {
          feedbackModule.toast(`无法连接后端服务：${err.message}`, 'error');
          sharedModule.$('#month-label').textContent = '连接失败';
          return;
        }

        standardsModule.resetStandardsToDefault();
        state.customLocations = [];
        state.customCurrencies = {};
        state.editingDefaults = false;
        state.defaultsDraft = null;
        standardsEditorModule.syncStandardsModeUI();
        const now = new Date();
        state.year = now.getFullYear();
        state.month = now.getMonth() + 1;

        let monthBundle = null;
        let globalDocument = null;
        try {
          [monthBundle, globalDocument] = await Promise.all([
            apiModule.api('/api/months', { timeout: 15000 }),
            apiModule.api('/api/global', { timeout: 15000 }),
          ]);
        } catch (err) {
          persistenceModule.runtime.serverStateReady = false;
          console.warn('读取服务器 v2 实体失败，回退到本机缓存', err);
          feedbackModule.toast(`读取项目状态失败：${err.message}。已回退到浏览器缓存；服务器恢复前无法安全保存。`, 'error');
        }
        let recoverLocalChanges = false;
        let selectedMonth = null;
        if (monthBundle && globalDocument) {
          selectedMonth = persistenceModule.applyServerData(monthBundle, globalDocument);
          const damagedMonths = Object.entries(monthBundle.errors || {});
          if (damagedMonths.length) {
            feedbackModule.toast(
              `${damagedMonths.length} 个月份文件损坏，已从页面隔离；请在 backups/ 中核对可恢复快照。`,
              'error',
            );
          }
          if (persistenceModule.hasUnsyncedLocalChanges() && window.confirm(
            '检测到上次服务器不可用期间保存在本浏览器的修改。是否以本机版本恢复并重新同步？\n'
            + '选择“取消”将使用服务器版本。',
          )) {
            recoverLocalChanges = persistenceModule.applyLocalRecovery(persistenceModule.readLocalBundle());
          } else {
            persistenceModule.clearUnsyncedLocalChanges();
            persistenceModule.writeLocalCache(persistenceModule.snapshotBundle());
          }
        } else {
          persistenceModule.runtime.serverStateReady = false;
          selectedMonth = persistenceModule.applyOfflineBundle(persistenceModule.readLocalBundle());
        }
        if (selectedMonth && /^\d{4}-\d{2}$/.test(selectedMonth)) {
          const [selectedYear, selectedNumber] = selectedMonth.split('-').map(Number);
          if (selectedYear >= 2000 && selectedYear <= 2100 && selectedNumber >= 1 && selectedNumber <= 12) {
            state.year = selectedYear;
            state.month = selectedNumber;
          }
        }
        state.annualYear = new Date().getFullYear();

        monthlyModule.applyMonthOptions(monthlyModule.monthKey());
        monthlyModule.syncOptionsUI();
        const restoredOverrides = standardsModule.loadOverrides();
        subscriptionsModule.syncCurrentMonth();
        state.calcResult = resultsModule.loadResultForMonth(monthlyModule.monthKey());

        standardsViewModule.renderStandards();
        subscriptionsModule.render();
        assetsModule.render();
        calendarModule.renderLocChips();
        travelModule.renderTravelPicker();
        navigationModule.renderNavigation();
        service.renderAll();
        if (state.calcResult) resultsModule.renderResult();
        else resultsModule.clearResult();
        if (recoverLocalChanges) {
          const recovered = await persistenceModule.persist('now');
          feedbackModule.toast(
            recovered ? '已恢复并同步本浏览器的未上传修改' : '已恢复本机修改，但同步服务器失败，请稍后再次保存',
            recovered ? 'success' : 'warn',
          );
        }
        // 默认选中第一个地点，方便直接开始添加行程
        if (state.meta.locations.length) calendarModule.selectLocation(state.meta.locations[0].key);

        // 提示：恢复本地保存的行程 / 标准修改 / 结果，方便快速回到这个月的数据
        const itin = itineraryModule.currentItinerary();
        const hasItinerary = Object.values(itin).some((ranges) => ranges.length > 0);
        if (restoredOverrides || hasItinerary || state.calcResult) {
          feedbackModule.toast(
            `已恢复${state.year}年${state.month}月数据（行程/标准修改/计算选项/结果）`,
            'info'
          );
        }
        if (Array.isArray(state.meta.warnings) && state.meta.warnings.length) {
          feedbackModule.toast(state.meta.warnings[0], 'error');
        }

        if (!options.skipAutomaticUpdates) {
          // 启动后以真实行情自动更新两类预算；没有行程的月份会安静跳过月度计算。
          // 自动流程不会切换当前页签，手动「更新」按钮仍保留。
          annualModule.renderAnnualBudget();
          await annualModule.loadAnnualRates();
          await annualModule.calculateAnnualBudget({ automatic: true });
          await monthlyModule.calculate({ automatic: true });
        }
      }

      Object.assign(service, {
        switchTab,
        renderAll,
        bindEvents,
        init,
      });

      return service;
    },
  });
})(window.BudgetModules || (window.BudgetModules = Object.create(null)));
