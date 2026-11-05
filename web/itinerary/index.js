/* 行程区间归一化、编辑与列表。
 * 跨模块调用由 web/js/app.js 显式注入；模块只导出本职责的接口。
 */
(function register(registry) {
  'use strict';
  registry.itinerary = Object.freeze({
    dependencies: Object.freeze(["calendar","feedback","locations","monthly","persistence","shared","state"]),
    create({ calendar: calendarModule, feedback: feedbackModule, locations: locationsModule, monthly: monthlyModule, persistence: persistenceModule, shared: sharedModule, state: stateModule }, service = {}) {
      const { state } = stateModule;

      /** 同一天只属于一个地点：更短的日期段优先，避免香港大段盖住深圳空隙 */
      function exclusiveItineraryMonth(month) {
        if (!month || typeof month !== 'object') return {};
        const owners = new Map();
        for (const [loc, ranges] of Object.entries(month)) {
          if (!Array.isArray(ranges)) continue;
          for (const r of ranges) {
            if (!r || !r.start || !r.end) continue;
            const days = sharedModule.iterDays(r.start, r.end);
            const length = days.length;
            if (!length) continue;
            for (const day of days) {
              const prev = owners.get(day);
              if (!prev || length < prev.len) owners.set(day, { loc, len: length });
            }
          }
        }
        const byLoc = {};
        for (const [day, info] of owners) {
          if (!byLoc[info.loc]) byLoc[info.loc] = [];
          byLoc[info.loc].push(day);
        }
        const out = {};
        for (const loc of Object.keys(month)) {
          if (byLoc[loc] && byLoc[loc].length) {
            out[loc] = sharedModule.rangesFromDays(byLoc[loc]);
            delete byLoc[loc];
          }
        }
        for (const [loc, days] of Object.entries(byLoc)) {
          if (days.length) out[loc] = sharedModule.rangesFromDays(days);
        }
        return out;
      }

      function exclusiveAllMonths(map) {
        const out = {};
        for (const [month, itin] of Object.entries(map && typeof map === 'object' ? map : {})) {
          out[month] = service.exclusiveItineraryMonth(itin);
        }
        return out;
      }

      function daysOwnedByOthers(exceptLoc) {
        const days = new Set();
        const itin = service.currentItinerary();
        for (const [loc, ranges] of Object.entries(itin)) {
          if (loc === exceptLoc || !Array.isArray(ranges)) continue;
          for (const r of ranges) {
            for (const day of sharedModule.iterDays(r.start, r.end)) days.add(day);
          }
        }
        return days;
      }

      /* --------------------------------------------------------------------------
       * 行程访问（按月份索引）
       * ------------------------------------------------------------------------ */
      function currentItinerary() {
        const entity = state.monthsByKey[monthlyModule.monthKey()];
        return entity && entity.itinerary ? entity.itinerary : {};
      }

      function ensureCurrentItinerary() {
        const entity = persistenceModule.ensureLocalMonthDraft(monthlyModule.monthKey());
        if (!entity.itinerary || typeof entity.itinerary !== 'object') entity.itinerary = {};
        return entity.itinerary;
      }

      function addRange(location, start, end) {
        const wanted = sharedModule.iterDays(start, end);
        if (!wanted.length) { feedbackModule.toast('日期无效', 'warn'); return; }
        const blocked = service.daysOwnedByOthers(location);
        const free = wanted.filter((day) => !blocked.has(day));
        if (!free.length) {
          feedbackModule.toast('这些日期已属于其他地点，请先删除原行程再改', 'warn');
          return;
        }
        const pieces = sharedModule.rangesFromDays(free);
        const itin = service.ensureCurrentItinerary();
        if (!itin[location]) itin[location] = [];
        let added = 0;
        for (const piece of pieces) {
          const dup = itin[location].some((r) => r.start === piece.start && r.end === piece.end);
          if (dup) continue;
          itin[location].push(piece);
          added += 1;
        }
        if (!added) { feedbackModule.toast('该时间段已存在', 'warn'); return; }
        const skipped = wanted.length - free.length;
        persistenceModule.saveState();
        calendarModule.renderCalendar();
        service.renderItinerary();
        const label = pieces.map((p) => `${p.start} ~ ${p.end}`).join('，');
        feedbackModule.toast(
          skipped
            ? `已添加 ${locationsModule.locName(location)}：${label}（已跳过 ${skipped} 天，那些日期属于其他地点）`
            : `已添加 ${locationsModule.locName(location)}：${label}`,
          'success'
        );
      }

      /* --------------------------------------------------------------------------
       * 行程清单
       * ------------------------------------------------------------------------ */
      function renderItinerary() {
        const itin = service.currentItinerary();
        const container = sharedModule.$('#itinerary-list');
        const locs = Object.keys(itin).filter((loc) => itin[loc].length);

        if (!locs.length) {
          container.innerHTML = '<p class="empty">本月暂无行程。请在左侧选择地点，然后在日历上点击两个日期添加时间段（也可使用下方的日期输入框）。</p>';
        } else {
          let html = '';
          for (const loc of locs) {
            const meta = state.meta.locations.find((l) => l.key === loc) || {};
            const ranges = itin[loc];
            const totalDays = ranges.reduce((acc, r) => acc + sharedModule.daysBetween(r.start, r.end), 0);
            const typeLabel = (meta.category === 'travel') ? '旅居' : '定居';
            html += `<div class="itin-group" data-loc="${sharedModule.esc(loc)}" style="${locationsModule.locColorVars(loc)}">
              <div class="itin-head">
                <i class="chip-dot"></i>
                <span class="itin-name">${sharedModule.esc(meta.name || loc)}</span>
                <span class="itin-sub">${sharedModule.esc(loc)} · ${sharedModule.esc(meta.currency || '')} · ${typeLabel}</span>
                <span class="itin-days">共 ${totalDays} 天</span>
                <button class="link danger" data-action="clear-loc" data-loc="${sharedModule.esc(loc)}">清空</button>
              </div>
              <ul class="itin-ranges">`;
            ranges.forEach((r, idx) => {
              html += `<li>
                <span>${sharedModule.esc(r.start)} ~ ${sharedModule.esc(r.end)}</span>
                <span class="range-days">${sharedModule.daysBetween(r.start, r.end)} 天</span>
                <button class="link danger" data-action="del-range" data-loc="${sharedModule.esc(loc)}" data-idx="${idx}">删除</button>
              </li>`;
            });
            html += '</ul></div>';
          }
          container.innerHTML = html;
        }

        const totalDays = locs.reduce(
          (acc, loc) => acc + itin[loc].reduce((a, r) => a + sharedModule.daysBetween(r.start, r.end), 0), 0
        );
        sharedModule.$('#itinerary-summary').innerHTML = locs.length
          ? `本月共 <b>${totalDays}</b> 天行程，覆盖 <b>${locs.length}</b> 个地点`
          : '';
      }

      Object.assign(service, {
        exclusiveItineraryMonth,
        exclusiveAllMonths,
        daysOwnedByOthers,
        currentItinerary,
        ensureCurrentItinerary,
        addRange,
        renderItinerary,
      });

      return service;
    },
  });
})(window.BudgetModules || (window.BudgetModules = Object.create(null)));
