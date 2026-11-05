/* 预算标准表格和确认状态展示。
 * 跨模块调用由 web/js/app.js 显式注入；模块只导出本职责的接口。
 */
(function register(registry) {
  'use strict';
  registry.standardsView = Object.freeze({
    dependencies: Object.freeze(["locations","monthly","shared","standards","standardsEditor","state","travel"]),
    create({ locations: locationsModule, monthly: monthlyModule, shared: sharedModule, standards: standardsModule, standardsEditor: standardsEditorModule, state: stateModule, travel: travelModule }, service = {}) {
      const { state } = stateModule;

      /* --------------------------------------------------------------------------
       * 预算标准编辑区
       * - 「当月预算」面板（#tab-standards 顶部三张表）：只编辑 state.standards，
       *   差异只写当月覆盖，不影响服务器默认标准；
       * - 「服务器默认预算标准」面板（.defaults-editor，弹窗内）：只编辑
       *   state.defaultsDraft，点「保存默认标准」才写 data/defaults.json。
       * 两个面板互不影响：保存默认标准不会改动当月数值。
       * ------------------------------------------------------------------------ */
      function rowInputHtml(cat, loc, curr, field, value) {
        return `<input type="number" min="0" step="0.01" inputmode="decimal"
          data-cat="${sharedModule.esc(cat)}" data-loc="${sharedModule.esc(loc)}" data-curr="${sharedModule.esc(curr)}" data-field="${sharedModule.esc(field || '')}"
          value="${Number(value)}">`;
      }

      function delCustomBtnHtml(loc) {
        return `<button type="button" class="link danger" data-action="del-custom" data-loc="${sharedModule.esc(loc)}">删除</button>`;
      }

      /** 旅居预算小节（两个区域共用）
       *  - 默认（不传 locs）：只显示本次勾选的旅居地点，供「当月预算」面板使用；
       *  - 传 locs：按给定的地点列表渲染（默认标准弹窗用它显示全部或本月对应的部分）。
       *  customs 为自定义旅居地点（当月或草稿），同样按 locs / 勾选状态过滤。 */
      function renderTravelStandardsBlocks({
        values, chipFor, customs, locs, emptyText, ruleText, showRule = true,
      }) {
        const all = Object.keys(values.travel || {});
        const explicit = Array.isArray(locs);
        const wanted = explicit ? locs.filter((loc) => all.includes(loc)) : all.filter(travelModule.isTravelLocationSelected);
        let rows = '';
        for (const loc of wanted) {
          const curr = service.findStdCurrency(values.travel[loc], loc);
          const sub = values.travel[loc][curr] || { daily: 0, once: 0 };
          rows += sharedModule.budgetRowHtml({
            color: locationsModule.locColor(loc),
            letter: sharedModule.catLetter(locationsModule.locName(loc)),
            title: sharedModule.esc(locationsModule.locName(loc)),
            sub: `${sharedModule.esc(curr)} · 每日 / 单次`,
            chip: chipFor('travel', loc, curr, 'daily') + chipFor('travel', loc, curr, 'once'),
            inputs: `<label class="amt-lab">每日${service.rowInputHtml('travel', loc, curr, 'daily', sub.daily)}</label>
              <label class="amt-lab">单次${service.rowInputHtml('travel', loc, curr, 'once', sub.once)}</label>`,
          });
        }
        for (const c of (customs || []).filter((x) => x.category === 'travel')) {
          if (explicit ? !locs.includes(c.key) : !travelModule.isTravelLocationSelected(c.key)) continue;
          const sub = ((values.travel[c.key] || {})[c.currency]);
          if (!sub) continue;
          rows += sharedModule.budgetRowHtml({
            color: locationsModule.locColor(c.key),
            letter: sharedModule.catLetter(c.name),
            title: `${sharedModule.esc(c.name)} <span class="muted">新建</span>`,
            sub: `${sharedModule.esc(c.currency)} · 每日 / 单次`,
            inputs: `<label class="amt-lab">每日${service.rowInputHtml('travel', c.key, c.currency, 'daily', sub.daily)}</label>
              <label class="amt-lab">单次${service.rowInputHtml('travel', c.key, c.currency, 'once', sub.once)}</label>`
              + service.delCustomBtnHtml(c.key),
          });
        }
        if (!rows) rows = `<p class="empty">${sharedModule.esc(emptyText || '请先在上方勾选本次包含的旅居地点')}</p>`;
        return `<div class="sheet-head"><h2>旅居预算</h2>
            <button type="button" class="text-btn" data-action="add-std" data-cat="travel">＋ 新建旅居地点</button></div>
          ${showRule ? `<p class="sheet-rule">${sharedModule.esc(ruleText || '每日预算 × 旅游天数 + 单次预算 × 月均汇率。仅显示已勾选地点。')}</p>` : ''}
          <div class="row-list" data-table="travel">${rows}</div>`;
      }

      /** 渲染当月预算面板（页面固定的三张表 + 旅居小节） */
      function renderMonthStandardsPanel() {
        const defs = state.meta.default_standards;
        const values = state.standards;
        standardsModule.ensureExtraStandards();
        const extraColor = { CNY: '#00805f', USD: '#265fce', HKD: '#b45309' };

        let html = '';
        for (const loc of Object.keys(state.monthStandardsSnapshot ? values.variable : defs.variable)) {
          const curr = service.findStdCurrency(values.variable[loc], loc);
          html += sharedModule.budgetRowHtml({
            color: locationsModule.locColor(loc),
            letter: sharedModule.catLetter(locationsModule.locName(loc)),
            title: sharedModule.esc(locationsModule.locName(loc)),
            sub: `${sharedModule.esc(curr)} · 每日`,
            chip: standardsEditorModule.monthDiffChip('variable', loc, curr, ''),
            inputs: service.rowInputHtml('variable', loc, curr, '', values.variable[loc][curr]),
          });
        }
        const customsVar = state.monthStandardsSnapshot
          ? []
          : locationsModule.activeCustomLocations().filter((c) => c.category === 'variable');
        for (const c of customsVar) {
          const val = ((values.variable[c.key] || {})[c.currency]);
          if (val == null) continue;
          html += sharedModule.budgetRowHtml({
            color: locationsModule.locColor(c.key),
            letter: sharedModule.catLetter(c.name),
            title: `${sharedModule.esc(c.name)} <span class="muted">新建</span>`,
            sub: `${sharedModule.esc(c.currency)} · 每日`,
            inputs: service.rowInputHtml('variable', c.key, c.currency, '', val) + service.delCustomBtnHtml(c.key),
          });
        }
        sharedModule.$('#variable-standards-table').innerHTML = html || '<p class="empty">暂无定居地点</p>';

        html = '';
        const derivedFixed = (values.fixed && (values.fixed.Mainland || values.fixed.Overseas)) || {};
        for (const curr of sharedModule.EXTRA_CURRENCIES) {
          html += sharedModule.budgetRowHtml({
            color: extraColor[curr] || '#6d28d9',
            letter: curr.slice(0, 1),
            title: `${sharedModule.esc(curr)}（${sharedModule.esc(locationsModule.currencyName(curr))}）`,
            sub: '本月已勾选订阅的月均合计',
            chip: '<span class="chip-diff chip-linked">订阅汇总</span>',
            inputs: `<strong class="linked-fixed-amount">${sharedModule.fmtMoney(derivedFixed[curr] || 0)} ${sharedModule.esc(curr)}</strong>`,
          });
        }
        sharedModule.$('#fixed-standards-table').innerHTML = html;

        service.renderTravelStandardsBlock();
      }

      /** 当月面板里的旅居小节（按「包含旅居」开关创建/销毁） */
      function renderTravelStandardsBlock() {
        const host = sharedModule.$('#travel-standards-host');
        if (!host) return;
        if (!state.includeTravel || !state.meta) {
          host.innerHTML = '';
          return;
        }
        const body = service.renderTravelStandardsBlocks({
          values: state.standards,
          chipFor: standardsEditorModule.monthDiffChip,
          customs: state.monthStandardsSnapshot ? [] : locationsModule.activeCustomLocations(),
        });
        host.innerHTML = `<article class="sheet" id="card-travel-standards">${body}</article>`;
      }

      /** 渲染默认预算标准面板（收起时清空） */
      function renderDefaultsPanel() {
        const host = sharedModule.$('.defaults-editor');
        if (!host) return;
        if (!state.editingDefaults || !state.defaultsDraft) {
          host.innerHTML = '';
          return;
        }
        const values = state.defaultsDraft.standards;
        const scope = service.defaultsScope();

        let html = '';
        for (const loc of Object.keys(values.variable || {})) {
          const curr = service.findStdCurrency(values.variable[loc], loc);
          html += sharedModule.budgetRowHtml({
            color: locationsModule.locColor(loc),
            letter: sharedModule.catLetter(locationsModule.locName(loc)),
            title: sharedModule.esc(locationsModule.locName(loc)),
            sub: `${sharedModule.esc(curr)} · 每日`,
            chip: standardsEditorModule.defaultsDiffChip('variable', loc, curr, ''),
            inputs: service.rowInputHtml('variable', loc, curr, '', values.variable[loc][curr]),
          });
        }
        const budgetBlocks = [];
        budgetBlocks.push(`<div class="row-list" data-table="variable">${html || '<p class="empty">暂无定居地点</p>'}</div>`);

        // 旅居预算：默认标准弹窗里始终显示（不再依赖「包含旅居」开关），
        // 未勾选「显示全部旅居预算」时只列本月行程里出现过的旅居地点。
        budgetBlocks.push(`<div class="defaults-travel-block">${service.renderTravelStandardsBlocks({
          values,
          chipFor: standardsEditorModule.defaultsDiffChip,
          customs: [],
          locs: scope.travelLocs,
          emptyText: state.defaultsShowAll
            ? '暂无旅居地点'
            : '本月行程里还没有旅居地点；勾选上方「显示全部旅居预算」可查看全部。',
          showRule: false,
        })}</div>`);
        host.innerHTML = `<section class="defaults-section defaults-budget-section">
          <div class="defaults-section-head">
            <div><span class="eyebrow">01 · DAILY & TRAVEL</span><h2>每日与旅居预算标准</h2></div>
            <button type="button" class="text-btn" data-action="add-std" data-cat="variable">＋ 新建定居地点</button>
          </div>
          <div class="defaults-section-body">${budgetBlocks.join('')}</div>
        </section>${standardsEditorModule.defaultSubscriptionsHtml()}`;
      }

      /** 本月行程里出现过的旅居地点（按行程表里的先后顺序；只认有旅居标准的地点） */
      function monthItineraryTravelLocations(values) {
        const entity = state.monthsByKey && state.monthsByKey[monthlyModule.monthKey()];
        const map = (entity && entity.itinerary) || {};
        const known = new Set(Object.keys((values && values.travel) || {}));
        const out = [];
        for (const key of Object.keys(map)) {
          if (!known.has(key)) continue;
          if (!Array.isArray(map[key]) || !map[key].length) continue;
          out.push(key);
        }
        return out;
      }

      /** 默认标准弹窗的显示范围（纯展示过滤，不改动任何数值）
       *  - 勾选「显示全部旅居预算」：显示全部旅居地点；
       *  - 未勾选：只显示本月行程里的旅居地点
       *    （本月/草稿里新建的旅居地点始终保留，避免刚建完就看不见）。
       *  注意：`defaultsDraft.locations` 是**整份地点注册表**（含全部默认旅居地点），
       *  判断「新建」必须与服务器已保存默认标准比较，不能拿它当自定义列表。 */
      function defaultsScope() {
        const values = (state.defaultsDraft && state.defaultsDraft.standards) || {};
        const travel = values.travel || {};
        const savedTravel = Object.keys((((state.meta || {}).default_standards || {}).travel) || {});
        const customTravel = Object.keys(travel).filter((k) => !savedTravel.includes(k));

        const allTravel = Object.keys(travel);
        for (const k of customTravel) if (!allTravel.includes(k)) allTravel.push(k);

        if (state.defaultsShowAll) {
          return { travelLocs: allTravel };
        }

        const travelLocs = service.monthItineraryTravelLocations(values);
        for (const k of customTravel) if (!travelLocs.includes(k)) travelLocs.push(k);
        return { travelLocs };
      }

      /** 默认标准弹窗里「显示全部旅居预算」开关旁的说明文字 */
      function updateDefaultsScopeHint() {
        const hint = sharedModule.$('#defaults-scope-hint');
        if (!hint) return;
        if (!state.editingDefaults || !state.defaultsDraft) {
          hint.textContent = '';
          return;
        }
        if (state.defaultsShowAll) {
          hint.textContent = '正在显示全部每日预算与旅居地点。';
          return;
        }
        const scope = service.defaultsScope();
        const n = scope.travelLocs.length;
        hint.textContent = n
          ? `正在显示全部每日预算及本月行程中的 ${n} 个旅居地点。`
          : '正在显示全部每日预算；本月行程里暂无旅居地点。';
      }

      function renderStandards() {
        service.renderMonthStandardsPanel();
        service.renderDefaultsPanel();
        const fixedRegionLabel = sharedModule.$('#fixed-region-label');
        if (fixedRegionLabel) fixedRegionLabel.textContent = '· 订阅月均汇总';
        const monthLabel = sharedModule.$('#standards-month-label');
        if (monthLabel) monthLabel.textContent = `${state.year}年${state.month}月`;
        standardsEditorModule.syncStandardsModeUI();
      }

      /** 取标准组里的币种代码；优先当前生效标准，缺失时回退到首个键 */
      function findStdCurrency(stdHolder, loc) {
        const holder = stdHolder || {};
        const keys = Object.keys(holder);
        if (!keys.length) return locationsModule.locationCurrency(loc);
        const current = locationsModule.locationCurrency(loc);
        return holder[current] != null ? current : keys[0];
      }

      Object.assign(service, {
        rowInputHtml,
        delCustomBtnHtml,
        renderTravelStandardsBlocks,
        renderMonthStandardsPanel,
        renderTravelStandardsBlock,
        renderDefaultsPanel,
        monthItineraryTravelLocations,
        defaultsScope,
        updateDefaultsScopeHint,
        renderStandards,
        findStdCurrency,
      });

      return service;
    },
  });
})(window.BudgetModules || (window.BudgetModules = Object.create(null)));
