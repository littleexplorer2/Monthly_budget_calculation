/* 旅居选项及地点选择。
 * 跨模块调用由 web/js/app.js 显式注入；模块只导出本职责的接口。
 */
(function register(registry) {
  'use strict';
  registry.travel = Object.freeze({
    dependencies: Object.freeze(["calendar","locations","persistence","shared","standardsView","state"]),
    create({ calendar: calendarModule, locations: locationsModule, persistence: persistenceModule, shared: sharedModule, standardsView: standardsViewModule, state: stateModule }, service = {}) {
      const { state } = stateModule;

      /* --------------------------------------------------------------------------
       * 旅居开关与旅居地点选择（本次计算选项）
       * includeTravel=false → 不包含任何旅居；true 时 travelSelected=null 表示全部，
       * 否则为选中的旅居地点 key 集合。
       * ------------------------------------------------------------------------ */
      function travelLocations() {
        const defs = state.monthStandardsSnapshot ? state.standards : state.meta.default_standards;
        const keys = new Set([
          ...Object.keys(defs.travel),
          ...locationsModule.activeCustomLocations().filter((c) => c.category === 'travel').map((c) => c.key),
        ]);
        return Array.from(keys);
      }

      /** 该旅居地点是否在本次计算中被勾选（未勾选「包含旅居」时一律为 false） */
      function isTravelLocationSelected(loc) {
        if (!state.includeTravel) return false;
        if (state.travelSelected === null) return true;
        return state.travelSelected.has(loc);
      }

      /** 本次计算实际包含的旅居地点：null=全部；数组=仅这些 */
      function selectedTravelList() {
        if (!state.includeTravel) return [];
        if (state.travelSelected === null) return null;
        return service.travelLocations().filter((k) => state.travelSelected.has(k));
      }

      function renderTravelPicker() {
        const wrap = sharedModule.$('#travel-picker-wrap');
        const btn = sharedModule.$('#travel-picker-btn');
        const list = sharedModule.$('#tp-list');
        if (!wrap || !btn || !list) return;
        if (!state.includeTravel) return;

        const locs = service.travelLocations();
        const sel = state.travelSelected;
        const count = sel === null ? locs.length : locs.filter((k) => sel.has(k)).length;
        if (!locs.length) {
          btn.textContent = '旅居地点：无';
        } else if (sel === null || count === locs.length) {
          btn.textContent = `旅居地点：全部（${locs.length}）▾`;
        } else if (count === 0) {
          btn.textContent = '旅居地点：无 ▾';
        } else {
          btn.textContent = `旅居地点：部分（${count}/${locs.length}）▾`;
        }

        list.innerHTML = locs.map((k) => {
          const sub = state.standards.travel[k];
          const curr = locationsModule.locationCurrency(k);
          const amt = sub && sub[curr]
            ? `每日 ${sub[curr].daily} · 单次 ${sub[curr].once} ${curr}`
            : curr;
          const checked = sel === null || sel.has(k);
          return `<label class="tp-item"><input type="checkbox" data-tp-loc="${sharedModule.esc(k)}" ${checked ? 'checked' : ''}>
            <span>${sharedModule.esc(locationsModule.locName(k))}</span><span class="tp-amt">${sharedModule.esc(amt)}</span></label>`;
        }).join('');
      }

      function toggleTravelLocation(key, on) {
        if (state.travelSelected === null) {
          state.travelSelected = new Set(service.travelLocations());
        }
        if (on) state.travelSelected.add(key);
        else state.travelSelected.delete(key);
        persistenceModule.saveState(true);
        service.renderTravelPicker();
        standardsViewModule.renderStandards();
        calendarModule.renderLocChips();
        standardsViewModule.invalidateConfirmation();
      }

      function selectAllTravel(on) {
        state.travelSelected = on ? null : new Set();
        persistenceModule.saveState(true);
        service.renderTravelPicker();
        standardsViewModule.renderStandards();
        calendarModule.renderLocChips();
        standardsViewModule.invalidateConfirmation();
      }

      function toggleTravelPicker(show) {
        const menu = sharedModule.$('#travel-picker-menu');
        if (menu) menu.hidden = !show;
      }

      Object.assign(service, {
        travelLocations,
        isTravelLocationSelected,
        selectedTravelList,
        renderTravelPicker,
        toggleTravelLocation,
        selectAllTravel,
        toggleTravelPicker,
      });

      return service;
    },
  });
})(window.BudgetModules || (window.BudgetModules = Object.create(null)));
