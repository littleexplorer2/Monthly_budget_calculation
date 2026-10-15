/* 月份选项、切换及月度计算请求。
 * 跨模块调用由 web/js/app.js 显式注入；模块只导出本职责的接口。
 */
(function register(registry) {
  'use strict';
  registry.monthly = Object.freeze({
    dependencies: Object.freeze(["http","calendar","feedback","itinerary","locations","network","persistence","results","shared","shell","standards","standardsView","state","travel"]),
    create({ http: apiModule, calendar: calendarModule, feedback: feedbackModule, itinerary: itineraryModule, locations: locationsModule, network: networkModule, persistence: persistenceModule, results: resultsModule, shared: sharedModule, shell: shellModule, standards: standardsModule, standardsView: standardsViewModule, state: stateModule, travel: travelModule }, service = {}) {
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
      async function calculate() {
        if (state.busy) return;

        // 门禁 1：必须先确认预算标准无误（标准被修改/区域被切换后需重新确认）
        if (!state.standardsConfirmed) {
          feedbackModule.toast('请先确认预算标准无误', 'warn');
          shellModule.switchTab('standards');
          const panel = sharedModule.$('#options-panel');
          if (panel) {
            panel.classList.add('attention');
            if (typeof panel.scrollIntoView === 'function') {
              panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
          }
          return;
        }

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
          feedbackModule.toast('请先在「行程安排」中添加行程', 'warn');
          shellModule.switchTab('itinerary');
          return;
        }

        state.busy = true;
        feedbackModule.setLoading(true, '正在计算预算（需获取当月汇率，首次拉取可能需要数秒）…');
        try {
          const result = await apiModule.api('/api/calculate', {
            method: 'POST',
            body: {
              year: requestYear,
              month: requestMonth,
              region: requestRegion,
              itinerary: entries,
              // 发送用户已确认的完整标准快照（含当月新建地点/币种元数据），
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
            // 顺带缓存汇率数据（仅涉及币种子集，进入汇率页时会自动拉全量）
            state.ratesData = result.rates;
            state.ratesMonth = requestMonthKey;
            state.ratesFromCalc = true;
            resultsModule.renderResult();
            shellModule.switchTab('result');
          }
          const stayedOnMonth = service.monthKey() === requestMonthKey;
          const calculatedMonth = `${requestYear}年${sharedModule.pad2(requestMonth)}月`;
          feedbackModule.toast(
            saved
              ? (stayedOnMonth ? '计算完成，该月结果已保存' : `${calculatedMonth}预算计算完成并已保存`)
              : (stayedOnMonth ? '计算完成，但保存到服务器失败' : `${calculatedMonth}计算完成，但保存到服务器失败`),
            saved ? 'success' : 'warn',
          );
        } catch (err) {
          feedbackModule.toast(err.message, 'error');
          networkModule.maybeShowNetworkWarning(err.message); // 计算中的汇率拉取失败 → 同步提示网络异常/VPN
        } finally {
          state.busy = false;
          feedbackModule.setLoading(false);
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
        standardsViewModule.invalidateConfirmation(); // 该月标准可能不同，需重新确认
        shellModule.renderAll();
      }

      function changeMonth(delta) {
        let m = state.month + delta;
        let y = state.year;
        if (m < 1) { m = 12; y -= 1; }
        if (m > 12) { m = 1; y += 1; }
        if (y < 2000 || y > 2100) { feedbackModule.toast('超出支持年份范围（2000-2100）', 'warn'); return; }
        service.saveMonthOptions();
        standardsModule.snapshotOverridesIntoState();
        persistenceModule.persist('debounce');
        state.year = y;
        state.month = m;
        state.calSel = { start: null, end: null };
        service.switchMonthData();
      }

      function goThisMonth() {
        const now = new Date();
        service.saveMonthOptions();
        standardsModule.snapshotOverridesIntoState();
        persistenceModule.persist('debounce');
        state.year = now.getFullYear();
        state.month = now.getMonth() + 1;
        state.calSel = { start: null, end: null };
        service.switchMonthData();
      }

      Object.assign(service, {
        monthKey,
        defaultMonthOptions,
        snapshotMonthOptions,
        saveMonthOptions,
        applyMonthOptions,
        syncOptionsUI,
        updateTravelUiVisibility,
        calculate,
        switchMonthData,
        changeMonth,
        goThisMonth,
      });

      return service;
    },
  });
})(window.BudgetModules || (window.BudgetModules = Object.create(null)));
