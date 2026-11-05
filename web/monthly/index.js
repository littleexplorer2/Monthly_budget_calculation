/* 月份选项、切换及月度计算请求。
 * 跨模块调用由 web/js/app.js 显式注入；模块只导出本职责的接口。
 */
(function register(registry) {
  'use strict';
  registry.monthly = Object.freeze({
    dependencies: Object.freeze(["http","calendar","feedback","itinerary","locations","navigation","network","persistence","results","shared","standards","standardsView","state","subscriptions","travel"]),
    create({ http: apiModule, calendar: calendarModule, feedback: feedbackModule, itinerary: itineraryModule, locations: locationsModule, navigation: navigationModule, network: networkModule, persistence: persistenceModule, results: resultsModule, shared: sharedModule, standards: standardsModule, standardsView: standardsViewModule, state: stateModule, subscriptions: subscriptionsModule, travel: travelModule }, service = {}) {
      const { state } = stateModule;

      function monthKey() { return `${state.year}-${sharedModule.pad2(state.month)}`; }

      function defaultMonthOptions() {
        return { region: 'Mainland', includeTravel: false, travelSelected: null };
      }

      /** 把当前页的居住区域 / 是否旅居 / 旅居地点勾选快照到当月数据集 */
      function snapshotMonthOptions(markSaved) {
        const o = {
          region: state.region === 'Overseas' ? 'Overseas' : 'Mainland',
          includeTravel: !!state.includeTravel,
          travelSelected: state.travelSelected === null ? null : Array.from(state.travelSelected),
        };
        const entity = state.monthsByKey[service.monthKey()];
        const prev = entity && entity.options;
        if (markSaved) o.savedAt = new Date().toISOString();
        else if (prev && prev.savedAt) o.savedAt = prev.savedAt;
        return o;
      }

      function saveMonthOptions(markSaved) {
        if (!state.year || !state.month) return;
        const entity = persistenceModule.ensureLocalMonthDraft(service.monthKey());
        entity.options = service.snapshotMonthOptions(markSaved);
      }

      /** 从当月数据集恢复居住区域与旅居勾选；该月没有记录则用默认值 */
      function applyMonthOptions(key) {
        const entity = state.monthsByKey[key];
        const saved = entity && entity.options;
        const opt = (saved && typeof saved === 'object') ? saved : service.defaultMonthOptions();
        state.region = opt.region === 'Overseas' ? 'Overseas' : 'Mainland';
        state.includeTravel = !!opt.includeTravel;
        if (opt.travelSelected == null || !Array.isArray(opt.travelSelected)) {
          state.travelSelected = null;
        } else {
          state.travelSelected = new Set(opt.travelSelected);
        }
      }

      function syncOptionsUI() {
        sharedModule.$$('#region-seg .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.region === state.region));
        const chk = sharedModule.$('#chk-include-travel');
        if (chk) chk.checked = !!state.includeTravel;
        service.updateTravelUiVisibility();
      }

      function hasMonthData(key) {
        return !!(state.monthsByKey && state.monthsByKey[key]);
      }

      function confirmMonthCreation(year, month) {
        return window.confirm(`是否要新增${year}年${sharedModule.pad2(month)}月的预算数据？`);
      }

      /** 仅勾选「包含旅居」时：创建旅居预算栏目；关闭时从 DOM 删除（不只是 CSS 隐藏） */
      function updateTravelUiVisibility() {
        const on = !!state.includeTravel;
        const chk = sharedModule.$('#chk-include-travel');
        if (chk) chk.checked = on;

        const picker = sharedModule.$('#travel-picker-wrap');
        if (picker) picker.hidden = !on;
        if (!on) {
          const menu = sharedModule.$('#travel-picker-menu');
          if (menu) menu.hidden = true;
          const list = sharedModule.$('#tp-list');
          if (list) list.innerHTML = '';
        }

        const travelGroup = sharedModule.$('#loc-group-travel');
        feedbackModule.setElVisible(travelGroup, on);

        if (!on && state.activeLocation && locationsModule.locationCategory(state.activeLocation) === 'travel') {
          const firstSettle = locationsModule.allLocations().find((l) => l.category !== 'travel');
          if (firstSettle) state.activeLocation = firstSettle.key;
        }

        standardsViewModule.renderTravelStandardsBlock();
      }

      /* --------------------------------------------------------------------------
       * 计算
       * ------------------------------------------------------------------------ */
      async function calculate(options = {}) {
        const automatic = !!(options && options.automatic);
        if (state.busy) return false;
        const requestMonthKey = service.monthKey();
        const entity = state.monthsByKey[requestMonthKey];
        if (!entity || !Object.values(entity.itinerary || {}).some((ranges) => ranges.length)) {
          if (!automatic) {
            feedbackModule.toast('请先在「行程安排」中添加行程', 'warn');
            navigationModule.openBudgetTab('itinerary');
          }
          return false;
        }

        state.busy = true;
        if (!automatic) {
          feedbackModule.setLoading(true, '正在更新预算（需获取当月汇率，首次拉取可能需要数秒）…');
        }
        try {
          // 计算只消费已落盘实体。先把本标签页修改写入同一 revision，随后后端
          // 在取汇率结束时再次 CAS；计算期间的任何编辑都会使旧结果无法落盘。
          const inputsSaved = await persistenceModule.persist('now');
          if (!inputsSaved) throw new Error('月份输入尚未可靠保存，请检查冲突提示后重试');
          const stored = state.monthsByKey[requestMonthKey];
          const response = await apiModule.api(`/api/months/${encodeURIComponent(requestMonthKey)}/calculate`, {
            method: 'POST',
            body: { base_revision: stored.revision },
            timeout: 180000,
          });
          persistenceModule.acceptSavedMonth(response.month);
          if (service.monthKey() === requestMonthKey) {
            state.calcResult = response.month.result;
            resultsModule.renderResult();
            if (!automatic) navigationModule.openBudgetTab('result');
          }
          if (!automatic) feedbackModule.toast('预算已按当前月份修订计算并保存', 'success');
          return true;
        } catch (err) {
          const message = err.code === 'STATE_CONFLICT'
            ? '计算期间月份输入发生变化，旧结果未保存；请重新计算'
            : err.message;
          feedbackModule.toast(automatic ? `自动更新月度预算失败：${message}` : message, 'error');
          networkModule.maybeShowNetworkWarning(err.message); // 计算中的汇率拉取失败 → 同步提示 Yahoo 数据源请求失败
          return false;
        } finally {
          state.busy = false;
          if (!automatic) feedbackModule.setLoading(false);
        }
      }

      /** 切换月份时同步切换当月全部页面数据：预算标准、行程、计算结果，
       *  以及该月保存的居住区域 / 是否包含旅居 / 旅居地点勾选。 */
      function switchMonthData() {
        service.applyMonthOptions(service.monthKey());
        service.syncOptionsUI();

        // 注意：默认标准编辑区是独立区域，换月时保持展开状态与草稿，且不会碰当月覆盖
        standardsModule.resetStandardsToDefault();
        state.customLocations = [];
        state.customCurrencies = {};
        standardsModule.loadOverrides();                                  // 该月保存的标准修改（含自定义地点/币种）
        subscriptionsModule.syncCurrentMonth();
        state.calcResult = resultsModule.loadResultForMonth(service.monthKey()); // 该月保存的计算结果
        standardsViewModule.renderStandards();
        subscriptionsModule.render();
        calendarModule.renderLocChips();
        travelModule.renderTravelPicker();
        if (state.calcResult) resultsModule.renderResult();
        else resultsModule.clearResult();
        service.renderMonthContext();
      }

      /** 重绘所有随月份变化的界面；外壳初始化和月份导航共用这一入口。 */
      function renderMonthContext() {
        sharedModule.$('#month-label').textContent = `${state.year}年${sharedModule.pad2(state.month)}月`;
        subscriptionsModule.render();
        service.syncOptionsUI();
        sharedModule.$('#itinerary-month').textContent = `${state.year}年${state.month}月`;
        calendarModule.renderCalendar();
        itineraryModule.renderItinerary();
        calendarModule.updateManualDefaults();
        navigationModule.refreshDashboard();
      }

      async function navigateToMonth(year, month) {
        if (year < 2000 || year > 2100) {
          feedbackModule.toast('超出支持年份范围（2000-2100）', 'warn');
          return false;
        }
        if (year === state.year && month === state.month) return true;

        const targetKey = `${year}-${sharedModule.pad2(month)}`;
        const createsMonth = !service.hasMonthData(targetKey);
        if (createsMonth && !service.confirmMonthCreation(year, month)) return false;

        // 只有用户确认后才调用显式 ensure；渲染和初始化永远不会创建月份。
        const sourceKey = service.monthKey();
        if (service.hasMonthData(sourceKey)) {
          // 所有输入事件已即时进入实体并标记脏字段；切月只排空既有队列，
          // 不因“离开页面”制造一个无业务变化的新 revision。
          if (!(await persistenceModule.persist('now'))) return false;
        }
        if (createsMonth) {
          try {
            const ensured = await apiModule.api(`/api/months/${encodeURIComponent(targetKey)}/ensure`, {
              method: 'POST', body: { defaults_revision: state.meta.defaults_revision }, timeout: 15000,
            });
            persistenceModule.acceptSavedMonth(ensured.month);
          } catch (err) {
            feedbackModule.toast(`新增月份失败：${err.message}`, 'error');
            return false;
          }
        }
        state.year = year;
        state.month = month;
        state.calSel = { start: null, end: null };
        service.switchMonthData();
        persistenceModule.saveSelection(targetKey);
        return true;
      }

      function changeMonth(delta) {
        let month = state.month + delta;
        let year = state.year;
        if (month < 1) { month = 12; year -= 1; }
        if (month > 12) { month = 1; year += 1; }
        return service.navigateToMonth(year, month);
      }

      function goThisMonth() {
        const now = new Date();
        return service.navigateToMonth(now.getFullYear(), now.getMonth() + 1);
      }

      Object.assign(service, {
        monthKey,
        defaultMonthOptions,
        snapshotMonthOptions,
        saveMonthOptions,
        applyMonthOptions,
        syncOptionsUI,
        hasMonthData,
        confirmMonthCreation,
        updateTravelUiVisibility,
        calculate,
        switchMonthData,
        renderMonthContext,
        navigateToMonth,
        changeMonth,
        goThisMonth,
      });

      return service;
    },
  });
})(window.BudgetModules || (window.BudgetModules = Object.create(null)));
