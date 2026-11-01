/* 月份选项、切换及月度计算请求。
 * 跨模块调用由 web/js/app.js 显式注入；模块只导出本职责的接口。
 */
(function register(registry) {
  'use strict';
  registry.monthly = Object.freeze({
    dependencies: Object.freeze(["http","calendar","feedback","itinerary","locations","navigation","network","persistence","rates","results","shared","standards","standardsView","state","travel"]),
    create({ http: apiModule, calendar: calendarModule, feedback: feedbackModule, itinerary: itineraryModule, locations: locationsModule, navigation: navigationModule, network: networkModule, persistence: persistenceModule, rates: ratesModule, results: resultsModule, shared: sharedModule, standards: standardsModule, standardsView: standardsViewModule, state: stateModule, travel: travelModule }, service = {}) {
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
        const prev = state.optionsByMonth && state.optionsByMonth[service.monthKey()];
        if (markSaved) o.savedAt = new Date().toISOString();
        else if (prev && prev.savedAt) o.savedAt = prev.savedAt;
        return o;
      }

      function saveMonthOptions(markSaved) {
        if (!state.year || !state.month) return;
        if (!state.optionsByMonth || typeof state.optionsByMonth !== 'object') state.optionsByMonth = {};
        state.optionsByMonth[service.monthKey()] = service.snapshotMonthOptions(markSaved);
      }

      /** 从当月数据集恢复居住区域与旅居勾选；该月没有记录则用默认值 */
      function applyMonthOptions(key) {
        const saved = state.optionsByMonth && state.optionsByMonth[key];
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

      function monthMapHasData(map, key) {
        if (!map || typeof map !== 'object' || !Object.prototype.hasOwnProperty.call(map, key)) return false;
        const value = map[key];
        if (!value || typeof value !== 'object') return !!value;
        return Object.keys(value).length > 0;
      }

      function hasMonthData(key) {
        return [
          state.itineraryByMonth,
          state.optionsByMonth,
          state.overridesByMonth,
          state.resultsByMonth,
        ].some((map) => service.monthMapHasData(map, key));
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

        // 从发起请求的月份捕获完整计算上下文。等待后端响应期间用户可以切月，
        // 结果必须仍归档到原月份，且不能覆盖新月份当前展示的结果/汇率。
        const requestYear = state.year;
        const requestMonth = state.month;
        const requestMonthKey = service.monthKey();
        const requestRegion = state.region === 'Overseas' ? 'Overseas' : 'Mainland';
        const requestIncludeTravel = !!state.includeTravel;
        const requestTravelLocations = requestIncludeTravel ? travelModule.selectedTravelList() : [];
        const requestStandards = standardsModule.activeStandardsOverride();
        const itin = itineraryModule.currentItinerary();
        const entries = Object.keys(itin)
          .filter((loc) => itin[loc].length)
          .map((loc) => ({ location: loc, ranges: itin[loc] }));

        if (!entries.length) {
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
          const result = await apiModule.api('/api/calculate', {
            method: 'POST',
            body: {
              year: requestYear,
              month: requestMonth,
              region: requestRegion,
              itinerary: entries,
              // 发送当前页面的完整标准快照（含当月新建地点/币种元数据），
              // 避免并发默认值变更改变本次计算输入。
              standards_override: requestStandards,
              include_travel: requestIncludeTravel,
              travel_locations: requestTravelLocations,
            },
            timeout: 180000,
          });
          const saved = await resultsModule.saveResult(result, 'now', {
            monthKey: requestMonthKey,
            region: requestRegion,
            includeTravel: requestIncludeTravel,
          }); // 先确认项目状态是否真正落盘
          if (service.monthKey() === requestMonthKey) {
            // 统计面板只展示本次计算实际使用的行情，不再另设月度拉取操作。
            state.ratesData = result.rates;
            state.ratesMonth = requestMonthKey;
            state.ratesSource = result.rate_source || null;
            resultsModule.renderResult();
            if (!automatic) navigationModule.openBudgetTab('result');
          }
          const stayedOnMonth = service.monthKey() === requestMonthKey;
          const calculatedMonth = `${requestYear}年${sharedModule.pad2(requestMonth)}月`;
          if (!automatic || !saved) {
            feedbackModule.toast(
              saved
                ? (stayedOnMonth ? '预算已更新并保存' : `${calculatedMonth}预算已更新并保存`)
                : (stayedOnMonth ? '预算已更新，但保存到服务器失败' : `${calculatedMonth}预算已更新，但保存到服务器失败`),
              saved ? 'success' : 'warn',
            );
          }
          return true;
        } catch (err) {
          feedbackModule.toast(automatic ? `自动更新月度预算失败：${err.message}` : err.message, 'error');
          networkModule.maybeShowNetworkWarning(err.message); // 计算中的汇率拉取失败 → 同步提示网络异常/VPN
          return false;
        } finally {
          state.busy = false;
          if (!automatic) feedbackModule.setLoading(false);
        }
      }

      /** 切换月份时同步切换当月全部页面数据：预算标准、行程、汇率、计算结果，
       *  以及该月保存的居住区域 / 是否包含旅居 / 旅居地点勾选。 */
      function switchMonthData() {
        service.applyMonthOptions(service.monthKey());
        service.syncOptionsUI();

        // 注意：默认标准编辑区是独立区域，换月时保持展开状态与草稿，且不会碰当月覆盖
        standardsModule.resetStandardsToDefault();
        state.customLocations = [];
        state.customCurrencies = {};
        standardsModule.loadOverrides();                                  // 该月保存的标准修改（含自定义地点/币种）
        state.calcResult = resultsModule.loadResultForMonth(service.monthKey()); // 该月保存的计算结果
        standardsViewModule.renderStandards();
        calendarModule.renderLocChips();
        travelModule.renderTravelPicker();
        if (state.calcResult) resultsModule.renderResult();
        else resultsModule.clearResult();
        service.renderMonthContext();
      }

      /** 重绘所有随月份变化的界面；外壳初始化和月份导航共用这一入口。 */
      function renderMonthContext() {
        sharedModule.$('#month-label').textContent = `${state.year}年${sharedModule.pad2(state.month)}月`;
        service.syncOptionsUI();
        sharedModule.$('#itinerary-month').textContent = `${state.year}年${state.month}月`;
        sharedModule.$('#rates-title').textContent = `${state.year}年${state.month}月 汇率走势（兑人民币）`;
        if (state.ratesMonth !== service.monthKey()) {
          state.ratesData = null;
          state.ratesSource = null;
          ratesModule.destroyRateCharts();
          const charts = sharedModule.$('#rates-charts');
          if (charts) charts.innerHTML = '';
          const stats = sharedModule.$('#rates-stats-table');
          if (stats) stats.innerHTML = '';
        }
        calendarModule.renderCalendar();
        itineraryModule.renderItinerary();
        calendarModule.updateManualDefaults();
        navigationModule.refreshDashboard();
      }

      function navigateToMonth(year, month) {
        if (year < 2000 || year > 2100) {
          feedbackModule.toast('超出支持年份范围（2000-2100）', 'warn');
          return false;
        }
        if (year === state.year && month === state.month) return true;

        const targetKey = `${year}-${sharedModule.pad2(month)}`;
        const createsMonth = !service.hasMonthData(targetKey);
        if (createsMonth && !service.confirmMonthCreation(year, month)) return false;

        // 只有确认导航后才保存已有当前月；空白来源月也不能因离开而被自动创建。
        const sourceKey = service.monthKey();
        if (service.hasMonthData(sourceKey)) {
          service.saveMonthOptions();
          standardsModule.snapshotOverridesIntoState();
        }
        state.year = year;
        state.month = month;
        state.calSel = { start: null, end: null };
        service.switchMonthData();

        if (createsMonth) {
          // 用户已明确同意新增：建立默认计算选项与标准快照，之后才进入唯一持久化管线。
          service.saveMonthOptions(true);
          standardsModule.snapshotOverridesIntoState();
        }
        persistenceModule.persist('debounce');
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
        monthMapHasData,
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
