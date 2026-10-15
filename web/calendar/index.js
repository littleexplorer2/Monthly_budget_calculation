/* 地点选择及日历交互展示。
 * 跨模块调用由 web/js/app.js 显式注入；模块只导出本职责的接口。
 */
(function register(registry) {
  'use strict';
  registry.calendar = Object.freeze({
    dependencies: Object.freeze(["feedback","itinerary","locations","shared","state","travel"]),
    create({ feedback: feedbackModule, itinerary: itineraryModule, locations: locationsModule, shared: sharedModule, state: stateModule, travel: travelModule }, service = {}) {
      const { state } = stateModule;

      /* --------------------------------------------------------------------------
       * 地点选择 chips
       * ------------------------------------------------------------------------ */
      function renderLocChips() {
        const settleBox = sharedModule.$('#loc-chips-settle');
        const travelBox = sharedModule.$('#loc-chips-travel');
        const travelGroup = sharedModule.$('#loc-group-travel');
        if (!settleBox || !travelBox) return;
        settleBox.innerHTML = '';
        travelBox.innerHTML = '';

        const showTravel = !!state.includeTravel;
        if (state.activeLocation && locationsModule.locationCategory(state.activeLocation) === 'travel'
            && (!showTravel || !travelModule.isTravelLocationSelected(state.activeLocation))) {
          const firstSettle = locationsModule.allLocations().find((l) => l.category !== 'travel');
          if (firstSettle) state.activeLocation = firstSettle.key;
        }

        let travelCount = 0;
        for (const loc of locationsModule.allLocations()) {
          if (loc.category === 'travel') {
            if (!showTravel || !travelModule.isTravelLocationSelected(loc.key)) continue;
            travelCount += 1;
          }
          const el = document.createElement('button');
          el.type = 'button';
          el.className = 'chip' + (state.activeLocation === loc.key ? ' active' : '');
          el.dataset.location = loc.key;
          el.style.cssText = locationsModule.locColorVars(loc.key);
          const isCustom = locationsModule.activeCustomLocations().some((c) => c.key === loc.key);
          let sub;
          if (loc.category === 'travel') {
            const st = state.standards.travel[loc.key] && state.standards.travel[loc.key][loc.currency];
            sub = `每日 ${st ? st.daily : loc.daily} · 单次 ${st ? st.once : loc.once}`;
          } else {
            const v = state.standards.variable[loc.key] && state.standards.variable[loc.key][loc.currency];
            sub = `每日 ${v != null ? v : loc.default}`;
          }
          if (isCustom) sub += ' · 新建';
          el.innerHTML = `<i class="chip-dot"></i>${sharedModule.esc(loc.name)}<span class="chip-sub">${sharedModule.esc(sub)} ${sharedModule.esc(loc.currency)}</span>`;
          (loc.category === 'travel' ? travelBox : settleBox).appendChild(el);
        }

        if (showTravel && travelCount === 0) {
          travelBox.innerHTML = '<p class="empty">请先在上方选择旅居地点</p>';
        }
        feedbackModule.setElVisible(travelGroup, showTravel);
      }

      function selectLocation(key) {
        state.activeLocation = key;
        state.calSel = { start: null, end: null };
        service.renderLocChips();
        service.renderCalendar();
      }

      /* --------------------------------------------------------------------------
       * 日历组件（周一开头，点击两个日期选时间段）
       * ------------------------------------------------------------------------ */
      function buildBookedMap() {
        const map = new Map();
        const itin = itineraryModule.currentItinerary();
        const locs = Object.keys(itin);
        const ordered = [
          ...locs.filter((l) => l !== state.activeLocation),
          ...locs.filter((l) => l === state.activeLocation),
        ];
        for (const loc of ordered) {
          for (const r of itin[loc] || []) {
            for (const ds of sharedModule.iterDays(r.start, r.end)) map.set(ds, loc);
          }
        }
        return map;
      }

      function renderCalendar() {
        const y = state.year;
        const m = state.month;
        sharedModule.$('#cal-title').textContent = `${y}年${m}月`;

        const first = new Date(y, m - 1, 1);
        const daysInMonth = new Date(y, m, 0).getDate();
        const offset = (first.getDay() + 6) % 7; // 周一开头
        const booked = service.buildBookedMap();
        const now = new Date();
        const todayStr = sharedModule.dateStr(now.getFullYear(), now.getMonth() + 1, now.getDate());
        const { start: selStart, end: selEnd } = state.calSel;

        let html = '';
        for (const w of ['一', '二', '三', '四', '五', '六', '日']) {
          html += `<div class="cal-dow">${w}</div>`;
        }
        for (let i = 0; i < offset; i++) html += '<div class="cal-cell empty"></div>';

        for (let d = 1; d <= daysInMonth; d++) {
          const ds = sharedModule.dateStr(y, m, d);
          const dow = new Date(y, m - 1, d).getDay();
          let cls = 'cal-cell';
          if (ds === todayStr) cls += ' today';
          if (dow === 0 || dow === 6) cls += ' weekend';

          let styleAttr = '';
          if (booked.has(ds)) {
            const loc = booked.get(ds);
            cls += ' booked' + (loc === state.activeLocation ? ' booked-active' : '');
            styleAttr = ` style="${locationsModule.locColorVars(loc)}"`; // 按地点颜色标注
          }
          if (selStart) {
            if (selEnd) {
              const [a, b] = selStart <= selEnd ? [selStart, selEnd] : [selEnd, selStart];
              if (ds >= a && ds <= b) cls += ' sel-range';
            }
            if (ds === selStart) cls += ' sel-start';
            if (selEnd && ds === selEnd) cls += ' sel-end';
          }
          html += `<div class="${cls}" data-date="${ds}"${styleAttr}>${d}</div>`;
        }
        sharedModule.$('#cal-grid').innerHTML = html;
      }

      function updateManualDefaults() {
        const last = new Date(state.year, state.month, 0).getDate();
        sharedModule.$('#cal-manual-start').value = sharedModule.dateStr(state.year, state.month, 1);
        sharedModule.$('#cal-manual-end').value = sharedModule.dateStr(state.year, state.month, last);
      }

      Object.assign(service, {
        renderLocChips,
        selectLocation,
        buildBookedMap,
        renderCalendar,
        updateManualDefaults,
      });

      return service;
    },
  });
})(window.BudgetModules || (window.BudgetModules = Object.create(null)));
