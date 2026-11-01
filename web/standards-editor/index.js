/* 默认标准草稿、输入、新建删除及显式保存。
 * 跨模块调用由 web/js/app.js 显式注入；模块只导出本职责的接口。
 */
(function register(registry) {
  'use strict';
  registry.standardsEditor = Object.freeze({
    dependencies: Object.freeze(["http","calendar","feedback","locations","persistence","shared","standards","standardsView","state","travel"]),
    create({ http: apiModule, calendar: calendarModule, feedback: feedbackModule, locations: locationsModule, persistence: persistenceModule, shared: sharedModule, standards: standardsModule, standardsView: standardsViewModule, state: stateModule, travel: travelModule }, service = {}) {
      const { state } = stateModule;

      const runtime = {
        defaultsSaveInFlight: false,
        addStdCategory: 'variable',
        addStdToDefaults: false,
        addStdRegion: 'Mainland',
      };

      /* --------------------------------------------------------------------------
       * 「服务器默认预算标准」独立区域
       * - 当月预算面板的输入只改 state.standards（写入 app-state.json 的当月覆盖）；
       * - 默认标准面板的输入只改 state.defaultsDraft，由「保存默认标准」写入
       *   data/defaults.json（影响之后的新月份），保存不改动当月数值。
       * ------------------------------------------------------------------------ */

      /** 进入「默认标准」编辑：以服务器默认标准为草稿，并入当月新建的地点/币种 */
      function beginDefaultsDraft() {
        const draft = sharedModule.deepClone(state.meta.default_standards || { variable: {}, fixed: {}, travel: {}, extra: {} });
        draft.variable = draft.variable || {};
        draft.fixed = draft.fixed || {};
        draft.travel = draft.travel || {};
        draft.extra = draft.extra || {};
        const draftLocs = sharedModule.deepClone((state.meta && state.meta.locations) || []);
        const draftLocNames = { ...((state.meta && state.meta.location_names) || {}) };
        const draftCurrNames = { ...((state.meta && state.meta.currency_names) || {}) };

        for (const c of state.customLocations || []) {
          if (c.category === 'variable') {
            const st = state.standards.variable[c.key];
            if (st && st[c.currency] != null && !draft.variable[c.key]) draft.variable[c.key] = { [c.currency]: st[c.currency] };
            if (!draftLocs.some((l) => l.key === c.key)) {
              draftLocs.push({ key: c.key, name: c.name, category: 'variable', currency: c.currency });
            }
          } else if (c.category === 'travel') {
            const st = state.standards.travel[c.key];
            if (st && st[c.currency] && !draft.travel[c.key]) {
              draft.travel[c.key] = { [c.currency]: { daily: st[c.currency].daily, once: st[c.currency].once } };
            }
            if (!draftLocs.some((l) => l.key === c.key)) {
              draftLocs.push({ key: c.key, name: c.name, category: 'travel', currency: c.currency });
            }
          }
          draftLocNames[c.key] = c.name;
        }
        // 当月新增的固定预算币种：并入草稿（该币种属于当时选中的区域）
        for (const [curr, name] of Object.entries(state.customCurrencies || {})) {
          draftCurrNames[curr] = name;
          const region = state.region === 'Overseas' ? 'Overseas' : 'Mainland';
          const st = state.standards.fixed[region] && state.standards.fixed[region][curr];
          if (st != null) {
            if (!draft.fixed[region]) draft.fixed[region] = {};
            if (draft.fixed[region][curr] == null) draft.fixed[region][curr] = st;
          }
        }
        state.defaultsDraft = {
          standards: draft, locations: draftLocs,
          locationNames: draftLocNames, currencyNames: draftCurrNames,
        };
      }

      /** 放弃未保存的默认标准草稿，重新以服务器已保存默认值构造草稿 */
      function reconstructDefaultsDraft() {
        const keepCustoms = state.customLocations;
        const keepCurrs = state.customCurrencies;
        const prevEditing = state.editingDefaults;
        state.customLocations = [];
        state.customCurrencies = {};
        state.editingDefaults = false;
        service.beginDefaultsDraft();
        state.customLocations = keepCustoms;
        state.customCurrencies = keepCurrs;
        state.editingDefaults = prevEditing;
      }

      /** 默认预算标准是否有未保存的改动（收起编辑区时一律视为没有） */
      function defaultsDraftDirty() {
        if (!state.editingDefaults || !state.defaultsDraft) return false;
        return service.countStandardsDiffs(state.defaultsDraft.standards, state.meta.default_standards) > 0;
      }

      /** 比较两套标准（variable/fixed/travel/extra）的差异处数 */
      function countStandardsDiffs(a, b) {
        const left = a || {};
        const right = b || {};
        let diffs = 0;
        const same = (x, y) => Number(x) === Number(y);
        for (const [loc, std] of Object.entries(left.variable || {})) {
          for (const [curr, val] of Object.entries(std || {})) {
            if (!right.variable || !right.variable[loc] || !same(val, right.variable[loc][curr])) diffs += 1;
          }
        }
        for (const [loc, std] of Object.entries(right.variable || {})) {
          if (!left.variable || !left.variable[loc]) diffs += 1;
        }
        for (const cat of ['fixed', 'extra']) {
          const groups = new Set([...Object.keys(left[cat] || {}), ...Object.keys(right[cat] || {})]);
          for (const g of groups) {
            const currs = new Set([
              ...Object.keys((left[cat] || {})[g] || {}),
              ...Object.keys((right[cat] || {})[g] || {}),
            ]);
            for (const curr of currs) {
              if (!same(((left[cat] || {})[g] || {})[curr], ((right[cat] || {})[g] || {})[curr])) diffs += 1;
            }
          }
        }
        for (const loc of new Set([...Object.keys(left.travel || {}), ...Object.keys(right.travel || {})])) {
          const aStd = (left.travel || {})[loc] || {};
          const bStd = (right.travel || {})[loc] || {};
          for (const curr of new Set([...Object.keys(aStd), ...Object.keys(bStd)])) {
            const aSub = aStd[curr] || {};
            const bSub = bStd[curr] || {};
            if (!same(aSub.daily, bSub.daily)) diffs += 1;
            if (!same(aSub.once, bSub.once)) diffs += 1;
          }
        }
        return diffs;
      }

      /** 生成「与默认值不同」标记；dir 决定行内动作指向哪一侧。
       *  当月侧提供「存入默认」（只写内存草稿，需再点保存）；默认标准侧提供「还原」。 */
      function diffChipHtml(cat, loc, curr, field, left, right, dir) {
        const fld = field || '';
        const a = left && right ? (fld ? (left[curr] || {})[fld] : left[curr]) : null;
        const b = left && right ? (fld ? (right[curr] || {})[fld] : right[curr]) : null;
        if (a == null || b == null || Number(a) === Number(b)) return '';
        const toDefaults = dir === 'to-defaults';
        let btn = '';
        if (toDefaults) {
          btn = `<button type="button" class="chip-diff-btn" data-action="revert-row"
               title="把该项恢复为已保存的默认值 ${Number(b)}">还原</button>`;
        }
        const where = toDefaults ? '与已保存默认值不同' : '与默认值不同';
        return `<span class="chip-diff" data-action="chip" data-cat="${sharedModule.esc(cat)}" data-loc="${sharedModule.esc(loc)}" data-curr="${sharedModule.esc(curr)}" data-field="${sharedModule.esc(fld)}">
          <span class="chip-diff-text">${where} · 默认 ${Number(b)}</span>${btn}</span>`;
      }

      /** 当月表格：只标记与服务器默认值不同的行（不会改动默认标准） */
      function monthDiffChip(cat, loc, curr, field) {
        if (state.monthStandardsSnapshot) return '';
        const defs = state.meta.default_standards;
        if (cat === 'extra') return service.diffChipHtml(cat, loc, curr, field, state.standards.extra, defs.extra, 'to-month');
        const defGroup = (defs[cat] || {})[loc];
        if (!defGroup || defGroup[curr] == null) return ''; // 当月新建（默认标准里没有）→ 已有「新建」标记
        return service.diffChipHtml(cat, loc, curr, field, state.standards[cat][loc], defGroup, 'to-month');
      }

      /** 默认标准区域：标记与已保存默认值不同的行 */
      function defaultsDiffChip(cat, loc, curr, field) {
        const draft = state.defaultsDraft;
        if (!draft) return '';
        const saved = state.meta.default_standards;
        if (cat === 'extra') return service.diffChipHtml(cat, loc, curr, field, draft.standards.extra, saved.extra, 'to-defaults');
        const draftGroup = (draft.standards[cat] || {})[loc];
        if (!draftGroup) return '';
        return service.diffChipHtml(cat, loc, curr, field, draftGroup, (saved[cat] || {})[loc] || {}, 'to-defaults');
      }

      /** 当月预算：只改本月（写入 app-state.json 的当月覆盖），不影响默认标准 */
      function applyMonthInput(cat, loc, curr, field, value) {
        if (cat === 'extra') {
          standardsModule.ensureExtraStandards();
          state.standards.extra[curr] = value;
        } else if (field) {
          state.standards[cat][loc][curr][field] = value;
        } else {
          state.standards[cat][loc][curr] = value;
        }
        standardsModule.saveOverrides();        // 先把标准差异写入统一状态快照
        persistenceModule.saveState();
        travelModule.renderTravelPicker();   // 旅居金额变化同步到选择菜单
      }

      /** 默认标准区域：只改内存草稿，由「保存默认标准」写入 data/defaults.json */
      function applyDefaultsInput(cat, loc, curr, field, value) {
        if (!state.defaultsDraft) return;
        const ds = state.defaultsDraft.standards;
        if (cat === 'extra') {
          if (!ds.extra) ds.extra = {};
          ds.extra[curr] = value;
        } else if (field) {
          if (!ds[cat][loc]) ds[cat][loc] = {};
          if (!ds[cat][loc][curr]) ds[cat][loc][curr] = { daily: 0, once: 0 };
          ds[cat][loc][curr][field] = value;
        } else {
          if (!ds[cat][loc]) ds[cat][loc] = {};
          ds[cat][loc][curr] = value;
        }
        service.updateDefaultsHint();
      }

      /** 输入后刷新那一行的「与默认值不同」标记。
       *  只替换该行的标记节点，**不重建输入框**：重建会让正在编辑的输入框被替换成新节点，
       *  后续按键落在旧节点上（表现为数字被拼接到旧值、光标错位、输入\"没反应\"）。
       *  el 是触发 input 事件的输入框本身，用它判断属于弹窗还是当月面板。 */
      function refreshRowChip(cat, loc, curr, field, el) {
        const fld = field || '';
        const input = el || document.querySelector(
          `input[data-cat="${cat}"][data-loc="${loc}"][data-curr="${curr}"][data-field="${fld}"]`
        );
        if (!input || typeof input.closest !== 'function') return;
        const row = input.closest('.budget-row');
        if (!row) return;
        const inDefaults = !!input.closest('.defaults-editor');
        const html = inDefaults ? service.defaultsDiffChip(cat, loc, curr, fld) : service.monthDiffChip(cat, loc, curr, fld);
        service.updateRowChip(row, html);
      }

      /** 在行内放置 / 更新 / 移除「与默认值不同」标记 */
      function updateRowChip(row, html) {
        const existing = row.querySelector('.chip-diff[data-action="chip"]');
        if (!html) {
          if (existing) existing.remove();
          return;
        }
        if (existing) {
          existing.outerHTML = html;
          return;
        }
        const title = row.querySelector('.budget-row-title') || row.querySelector('.budget-row-text');
        if (title) title.insertAdjacentHTML('beforeend', html);
      }

      /** 把默认标准草稿的某一项还原成已保存的默认值 */
      function restoreDefaultEntry(cat, loc, curr, field) {
        const draft = state.defaultsDraft;
        if (!draft) return;
        const saved = state.meta.default_standards;
        if (cat === 'extra') {
          draft.standards.extra[curr] = Number((saved.extra || {})[curr] != null ? saved.extra[curr] : 0);
        } else if (field) {
          const defSub = (((saved.travel || {})[loc] || {})[curr]) || {};
          if (!draft.standards.travel[loc]) draft.standards.travel[loc] = {};
          if (!draft.standards.travel[loc][curr]) draft.standards.travel[loc][curr] = { daily: 0, once: 0 };
          draft.standards.travel[loc][curr][field] = Number(defSub[field] != null ? defSub[field] : 0);
        } else {
          const defVal = (((saved[cat] || {})[loc] || {})[curr]);
          if (defVal == null) {
            // 已保存默认值里没有这一项（新增项）→ 从草稿中删除
            if (draft.standards[cat] && draft.standards[cat][loc]) {
              delete draft.standards[cat][loc][curr];
              if (!Object.keys(draft.standards[cat][loc]).length) delete draft.standards[cat][loc];
            }
          } else {
            if (!draft.standards[cat][loc]) draft.standards[cat][loc] = {};
            draft.standards[cat][loc][curr] = Number(defVal);
          }
        }
        standardsViewModule.renderStandards();
        feedbackModule.toast('已还原为已保存的默认值（尚未保存）', 'info');
      }

      /** 打开默认预算标准弹窗（进入编辑：以服务器默认标准构造草稿） */
      function openDefaultsModal() {
        state.editingDefaults = true;
        if (!state.defaultsDraft) service.beginDefaultsDraft();
        standardsViewModule.renderStandards();
        calendarModule.renderLocChips();
        travelModule.renderTravelPicker();
        const modal = sharedModule.$('#defaults-modal');
        if (modal && typeof modal.querySelector === 'function') {
          const first = modal.querySelector('.defaults-editor input[data-cat]');
          if (first && typeof first.focus === 'function') first.focus({ preventScroll: true });
        }
      }

      /** 关闭默认预算标准弹窗：丢弃未保存草稿 */
      function closeDefaultsModal() {
        state.editingDefaults = false;
        state.defaultsDraft = null;
        standardsViewModule.renderStandards();
        calendarModule.renderLocChips();
        travelModule.renderTravelPicker();
      }

      /** 关闭前询问：有未保存改动时让用户确认 */
      function requestCloseDefaultsModal() {
        if (service.defaultsDraftDirty() && !confirm('默认标准有未保存的修改，关闭将丢弃这些修改。是否继续？')) return;
        service.closeDefaultsModal();
      }

      /** 同步默认预算标准弹窗的按钮显隐与提示文字 */
      function syncStandardsModeUI() {
        const open = !!state.editingDefaults;
        feedbackModule.setElVisible(sharedModule.$('#defaults-modal'), open);
        feedbackModule.setElVisible(sharedModule.$('#btn-discard-defaults'), open);
        const showAllChk = sharedModule.$('#chk-defaults-show-all');
        if (showAllChk) showAllChk.checked = !!state.defaultsShowAll;
        standardsViewModule.updateDefaultsScopeHint();
        const saveBtn = sharedModule.$('#btn-save-defaults');
        if (saveBtn) {
          saveBtn.disabled = !open || runtime.defaultsSaveInFlight;
          saveBtn.title = '把默认预算标准写入服务器 data/defaults.json（不影响当月与已保存月份）';
        }
        service.updateDefaultsHint();
      }

      /** 默认标准区域的「已修改 N 处 / 尚未保存」提示 */
      function updateDefaultsHint() {
        const hint = sharedModule.$('#defaults-hint');
        if (!hint) return;
        const open = !!state.editingDefaults;
        if (open) {
          const diffs = service.defaultsDraftDirty()
            ? service.countStandardsDiffs(state.defaultsDraft.standards, state.meta.default_standards)
            : 0;
          if (diffs > 0) {
            hint.textContent = `默认标准已修改 ${diffs} 处（尚未保存）`;
            hint.classList.add('dirty');
          } else {
            hint.textContent = '默认标准与已保存值一致';
            hint.classList.remove('dirty');
          }
          return;
        }
        if (state.meta && state.meta.defaults_customized) {
          hint.textContent = '默认标准读取自 data/defaults.json';
        } else {
          hint.textContent = '默认标准读取自内置出厂值';
        }
        hint.classList.remove('dirty');
      }

      // 固定预算币种的目标区域（默认标准弹窗里按分组按钮决定）

      function openAddStandard(category, region) {
        runtime.addStdCategory = category;
        runtime.addStdToDefaults = !!state.editingDefaults && !!state.defaultsDraft;
        runtime.addStdRegion = (region === 'Overseas' || region === 'Mainland') ? region : state.region;
        const form = sharedModule.$('#add-std-form');
        const title = sharedModule.$('#add-std-title');
        const note = sharedModule.$('#add-std-note');
        const scopeNote = runtime.addStdToDefaults
          ? '（将加入服务器默认标准，点「保存默认标准」后生效，不影响当月）'
          : '（仅当月生效）';
        if (category === 'variable') {
          title.textContent = runtime.addStdToDefaults ? '新建默认标准 · 定居地点' : '新建定居地点（可变预算）';
          note.textContent = `新增一个定居地点及其每日预算（按日汇率折算人民币）${scopeNote}。`;
          form.innerHTML = `
            <div class="af-row"><label>地点名称</label><input type="text" id="af-name" placeholder="如：东京" maxlength="20"></div>
            <div class="af-row"><label>币种代码</label><input type="text" id="af-currency" placeholder="如：JPY" maxlength="6" style="text-transform:uppercase"></div>
            <div class="af-row"><label>每日预算</label><input type="number" id="af-daily" min="0" step="0.01" placeholder="当地货币金额"></div>
            <p class="af-hint">提示：币种为 2-6 位字母代码（如 JPY、EUR）；汇率将从 Yahoo Finance 按 币种CNY=X 获取。</p>`;
        } else if (category === 'travel') {
          title.textContent = runtime.addStdToDefaults ? '新建默认标准 · 旅居地点' : '新建旅居地点（旅游预算）';
          note.textContent = `新增一个旅居地点：每日预算 × 旅游天数 + 单次预算（每月一次）${scopeNote}。`;
          form.innerHTML = `
            <div class="af-row"><label>地点名称</label><input type="text" id="af-name" placeholder="如：巴黎" maxlength="20"></div>
            <div class="af-row"><label>币种代码</label><input type="text" id="af-currency" placeholder="如：EUR" maxlength="6" style="text-transform:uppercase"></div>
            <div class="af-row"><label>每日预算</label><input type="number" id="af-daily" min="0" step="0.01" placeholder="当地货币金额"></div>
            <div class="af-row"><label>单次预算</label><input type="number" id="af-once" min="0" step="0.01" placeholder="每月一次的费用"></div>
            <p class="af-hint">提示：币种为 2-6 位字母代码（如 EUR）；汇率将从 Yahoo Finance 按 币种CNY=X 获取。</p>`;
        } else {
          title.textContent = runtime.addStdToDefaults ? '新建默认标准 · 固定预算币种' : '新建固定预算币种';
          note.textContent = `为居住区域（${locationsModule.regionName(runtime.addStdRegion)}）新增一个固定预算币种：月额 × 当月平均汇率，每月只计算一次${scopeNote}。`;
          form.innerHTML = `
            <div class="af-row"><label>币种代码</label><input type="text" id="af-currency" placeholder="如：EUR" maxlength="6" style="text-transform:uppercase"></div>
            <div class="af-row"><label>币种名称</label><input type="text" id="af-name" placeholder="如：欧元（可留空）" maxlength="20"></div>
            <div class="af-row"><label>每月金额</label><input type="number" id="af-daily" min="0" step="0.01" placeholder="当地货币金额"></div>
            <p class="af-hint">提示：该币种仅添加到 ${locationsModule.regionName(runtime.addStdRegion)}；汇率将从 Yahoo Finance 按 币种CNY=X 获取。</p>`;
        }
        feedbackModule.setElVisible(sharedModule.$('#add-std-modal'), true);
        const first = form.querySelector('input');
        if (first) first.focus();
      }

      function closeAddStandard() {
        feedbackModule.setElVisible(sharedModule.$('#add-std-modal'), false);
      }

      function confirmAddStandard() {
        const val = (id) => (sharedModule.$(id) ? String(sharedModule.$(id).value).trim() : '');
        const name = val('#af-name');
        const currency = val('#af-currency').toUpperCase();
        const daily = Number(val('#af-daily'));
        const once = Number(val('#af-once') || 0);
        const currs = state.meta.currencies.concat(Object.keys(state.customCurrencies || {}));
        const currTaken = (c) => currs.some((x) => x === c);

        if (runtime.addStdCategory !== 'fixed' && !name) { feedbackModule.toast('请填写地点名称', 'warn'); return; }
        if (!/^[A-Z]{2,6}$/.test(currency)) { feedbackModule.toast('币种代码应为 2-6 位字母（如 EUR）', 'warn'); return; }
        if (!Number.isFinite(daily) || daily < 0) { feedbackModule.toast('请填写有效的非负金额', 'warn'); return; }

        if (runtime.addStdToDefaults && state.defaultsDraft) {
          // 目标在打开弹窗时已锁定，避免期间收起编辑区导致写错区域
          service.confirmAddDefaultStandard({ name, currency, daily, once });
          return;
        }

        if (runtime.addStdCategory === 'variable') {
          const key = service.uniqueLocationKey('var');
          state.customLocations.push({ key, name, category: 'variable', currency });
          if (!state.standards.variable[key]) state.standards.variable[key] = {};
          state.standards.variable[key][currency] = daily;
        } else if (runtime.addStdCategory === 'travel') {
          if (!Number.isFinite(once) || once < 0) { feedbackModule.toast('请填写有效的单次预算', 'warn'); return; }
          const key = service.uniqueLocationKey('trv');
          state.customLocations.push({ key, name, category: 'travel', currency });
          if (!state.standards.travel[key]) state.standards.travel[key] = {};
          state.standards.travel[key][currency] = { daily, once };
          // 已部分勾选时，新建地点默认纳入本次计算，以便立刻出现在旅居预算表中
          if (state.travelSelected instanceof Set) state.travelSelected.add(key);
        } else {
          if (!currTaken(currency) && !(state.standards.fixed[state.region] && currency in state.standards.fixed[state.region])) {
            if (!state.customCurrencies[currency]) state.customCurrencies[currency] = name || currency;
            if (!state.standards.fixed[state.region]) state.standards.fixed[state.region] = {};
            state.standards.fixed[state.region][currency] = daily;
          } else {
            feedbackModule.toast(`币种 ${currency} 已存在`, 'warn');
            return;
          }
        }

        standardsModule.saveOverrides();
        persistenceModule.saveState();
        standardsViewModule.renderStandards();
        calendarModule.renderLocChips();
        travelModule.renderTravelPicker();
        service.closeAddStandard();
        feedbackModule.toast('已新建预算标准（仅当月生效）', 'success');
      }

      /** 生成不与现有地点冲突的 key */
      function uniqueLocationKey(prefix) {
        const taken = new Set(locationsModule.allLocations().map((l) => l.key));
        let key = `${prefix}_${Date.now().toString(36)}`;
        let i = 1;
        while (taken.has(key)) key = `${prefix}_${Date.now().toString(36)}_${i++}`;
        return key;
      }

      /* ---------- 默认标准编辑模式下的新建 / 删除（改草稿，不落盘） ---------- */

      /** 在默认标准草稿中新建定居/旅居地点或固定预算币种 */
      function confirmAddDefaultStandard({ name, currency, daily, once }) {
        const draft = state.defaultsDraft;
        const ds = draft.standards;

        if (runtime.addStdCategory === 'variable') {
          const key = service.uniqueLocationKey('var');
          draft.locations.push({ key, name, category: 'variable', currency });
          ds.variable[key] = { [currency]: daily };
          draft.locationNames[key] = name;
        } else if (runtime.addStdCategory === 'travel') {
          if (!Number.isFinite(once) || once < 0) { feedbackModule.toast('请填写有效的单次预算', 'warn'); return; }
          const key = service.uniqueLocationKey('trv');
          draft.locations.push({ key, name, category: 'travel', currency });
          ds.travel[key] = { [currency]: { daily, once } };
          draft.locationNames[key] = name;
        } else {
          // 目标区域在打开新建弹窗时按分组按钮锁定；重复判断只看该区域，便于同一币种加到境内与境外
          const region = runtime.addStdRegion === 'Overseas' ? 'Overseas' : 'Mainland';
          if (!ds.fixed[region]) ds.fixed[region] = {};
          if (ds.fixed[region][currency] === undefined) {
            draft.currencyNames[currency] = name || currency;
            ds.fixed[region][currency] = daily;
          } else {
            feedbackModule.toast(`币种 ${currency} 已在${locationsModule.regionName(region)}固定预算中`, 'warn');
            return;
          }
        }
        standardsViewModule.renderStandards();
        calendarModule.renderLocChips();
        travelModule.renderTravelPicker();
        service.closeAddStandard();
        feedbackModule.toast('已加入默认标准（尚未保存，点「保存默认标准」生效）', 'success');
      }

      /** 从默认标准草稿中删除新建的地点/币种 */
      function deleteCustomDefaultStandard(locOrCurr) {
        const draft = state.defaultsDraft;
        if (!draft) return;
        const idx = draft.locations.findIndex((c) => c.key === locOrCurr);
        if (idx >= 0) {
          const c = draft.locations[idx];
          if (c.category === 'variable') delete draft.standards.variable[c.key];
          else {
            delete draft.standards.travel[c.key];
          }
          draft.locations.splice(idx, 1);
          delete draft.locationNames[c.key];
        } else {
          const region = state.region === 'Overseas' ? 'Overseas' : 'Mainland';
          if (draft.standards.fixed[region]) delete draft.standards.fixed[region][locOrCurr];
          delete draft.currencyNames[locOrCurr];
        }
        standardsViewModule.renderStandards();
        calendarModule.renderLocChips();
        travelModule.renderTravelPicker();
        feedbackModule.toast('已从默认标准草稿中删除（尚未保存）', 'info');
      }

      /** 删除当月新建的标准（自定义定居/旅居地点、自定义固定币种） */
      function deleteCustomStandard(locOrCurr) {
        if (state.editingDefaults && state.defaultsDraft) {
          service.deleteCustomDefaultStandard(locOrCurr);
          return;
        }
        const customs = state.customLocations;
        const idx = customs.findIndex((c) => c.key === locOrCurr);
        if (idx >= 0) {
          const c = customs[idx];
          if (c.category === 'variable') delete state.standards.variable[c.key];
          else {
            delete state.standards.travel[c.key];
            if (state.travelSelected instanceof Set) state.travelSelected.delete(c.key);
          }
          customs.splice(idx, 1);
        } else {
          // 固定预算自定义币种
          delete state.standards.fixed[state.region][locOrCurr];
          delete state.customCurrencies[locOrCurr];
        }
        standardsModule.saveOverrides();
        persistenceModule.saveState();
        standardsViewModule.renderStandards();
        calendarModule.renderLocChips();
        travelModule.renderTravelPicker();
        feedbackModule.toast('已删除该新建标准（仅当月）', 'info');
      }

      function snapshotLocationNames() {
        const names = { Extra: '额外预算', ...((state.meta && state.meta.location_names) || {}) };
        for (const loc of Object.keys(state.standards.variable || {})) names[loc] = locationsModule.locName(loc);
        for (const loc of Object.keys(state.standards.travel || {})) names[loc] = locationsModule.locName(loc);
        for (const c of state.customLocations || []) names[c.key] = c.name;
        return names;
      }

      function snapshotCurrencyNames() {
        const names = { ...((state.meta && state.meta.currency_names) || {}) };
        Object.assign(names, state.customCurrencies || {});
        return names;
      }

      /** 应用服务器返回的新默认标准：只刷新默认标准基准与草稿，绝不改动当月数值 */
      function refreshDefaultsAfterServerChange(meta) {
        state.meta = meta;
        const wasOpen = !!state.editingDefaults;
        state.defaultsDraft = null;
        state.editingDefaults = false;
        service.beginDefaultsDraft();
        state.editingDefaults = wasOpen;
        standardsViewModule.renderStandards();
        calendarModule.renderLocChips();
        travelModule.renderTravelPicker();
      }

      /** 把草稿里的默认标准提交到服务器（data/defaults.json），不影响当月与已保存月份 */
      async function saveDefaultStandardsToServer() {
        if (runtime.defaultsSaveInFlight) return;
        if (!state.editingDefaults || !state.defaultsDraft) {
          feedbackModule.toast('请先用上下文栏「⚙ 默认预算标准」按钮打开默认标准弹窗', 'warn');
          return;
        }
        const draft = state.defaultsDraft.standards;
        if (!Object.keys(draft.variable || {}).length) {
          feedbackModule.toast('默认标准至少需要一个定居地点', 'warn');
          return;
        }
        const diffs = service.countStandardsDiffs(draft, state.meta.default_standards);
        if (!diffs) { feedbackModule.toast('默认标准没有改动', 'info'); return; }
        if (!confirm(`将把默认预算标准写入服务器 data/defaults.json（共 ${diffs} 处改动）。`
          + '之后的新月份会使用这套标准；已保存的其它月份会固化为完整快照，'
          + '当前月份的预算不会被改动。是否继续？')) return;
        const defaultsPayload = sharedModule.deepClone({
          base_revision: state.meta.defaults_revision,
          variable: draft.variable,
          fixed: draft.fixed,
          travel: draft.travel,
          extra: draft.extra,
          location_names: service.snapshotDraftLocationNames(),
          currency_names: service.snapshotDraftCurrencyNames(),
        });
        runtime.defaultsSaveInFlight = true;
        service.syncStandardsModeUI();
        feedbackModule.setLoading(true, '正在保存默认标准…');
        try {
          standardsModule.preserveExistingMonthsBeforeDefaultChange();
          const snapshotsSaved = await persistenceModule.persist('now');
          if (!snapshotsSaved) {
            feedbackModule.toast('当前及历史月份快照保存失败，已取消修改服务器默认标准', 'error');
            return;
          }
          const meta = await apiModule.api('/api/defaults', {
            method: 'POST',
            body: defaultsPayload,
          });
          service.refreshDefaultsAfterServerChange(meta);
          feedbackModule.toast('已保存默认预算标准（当月预算保持不变）', 'success');
        } catch (err) {
          feedbackModule.toast(err.message, 'error');
        } finally {
          runtime.defaultsSaveInFlight = false;
          feedbackModule.setLoading(false);
          service.syncStandardsModeUI();
        }
      }

      function snapshotDraftLocationNames() {
        const names = { Extra: '额外预算', ...((state.meta && state.meta.location_names) || {}) };
        for (const loc of Object.keys((state.defaultsDraft && state.defaultsDraft.standards.variable) || {})) {
          names[loc] = locationsModule.locName(loc);
        }
        for (const loc of Object.keys((state.defaultsDraft && state.defaultsDraft.standards.travel) || {})) {
          names[loc] = locationsModule.locName(loc);
        }
        for (const c of (state.defaultsDraft && state.defaultsDraft.locations) || []) names[c.key] = c.name;
        return names;
      }

      function snapshotDraftCurrencyNames() {
        const names = { ...((state.meta && state.meta.currency_names) || {}) };
        Object.assign(names, (state.defaultsDraft && state.defaultsDraft.currencyNames) || {});
        return names;
      }

      async function restoreFactoryDefaults() {
        if (!confirm('将删除 data/defaults.json，把服务器默认标准恢复为内置出厂值。'
          + '当前月份的预算数值不会被改动（如需按出厂值重算，请点「恢复默认」）。是否继续？')) return;
        feedbackModule.setLoading(true, '正在恢复出厂默认…');
        try {
          standardsModule.preserveExistingMonthsBeforeDefaultChange();
          const snapshotsSaved = await persistenceModule.persist('now');
          if (!snapshotsSaved) {
            throw new Error('当前及历史月份快照保存失败，已取消恢复出厂默认');
          }
          const meta = await apiModule.api('/api/defaults/reset', {
            method: 'POST',
            body: { base_revision: state.meta.defaults_revision },
          });
          service.refreshDefaultsAfterServerChange(meta);
          feedbackModule.toast('已恢复出厂默认预算标准（当月预算保持不变）', 'info');
        } catch (err) {
          feedbackModule.toast(err.message, 'error');
        } finally {
          feedbackModule.setLoading(false);
        }
      }

      /** 当月数值改回当前生效的默认标准（显式操作，只影响本月） */
      function resetMonthToDefaults() {
        standardsModule.resetStandardsToDefault();
        state.customLocations = [];
        state.customCurrencies = {};
        standardsModule.saveOverrides();        // 无修改项时先移除统一状态里的覆盖 key
        persistenceModule.saveState();
        standardsViewModule.renderStandards();
        calendarModule.renderLocChips();
        travelModule.renderTravelPicker();
        feedbackModule.toast('本月预算已改回当前默认标准（含清除本月新建项）', 'info');
      }

      Object.assign(service, {
        runtime,
        beginDefaultsDraft,
        reconstructDefaultsDraft,
        defaultsDraftDirty,
        countStandardsDiffs,
        diffChipHtml,
        monthDiffChip,
        defaultsDiffChip,
        applyMonthInput,
        applyDefaultsInput,
        refreshRowChip,
        updateRowChip,
        restoreDefaultEntry,
        openDefaultsModal,
        closeDefaultsModal,
        requestCloseDefaultsModal,
        syncStandardsModeUI,
        updateDefaultsHint,
        openAddStandard,
        closeAddStandard,
        confirmAddStandard,
        uniqueLocationKey,
        confirmAddDefaultStandard,
        deleteCustomDefaultStandard,
        deleteCustomStandard,
        snapshotLocationNames,
        snapshotCurrencyNames,
        refreshDefaultsAfterServerChange,
        saveDefaultStandardsToServer,
        snapshotDraftLocationNames,
        snapshotDraftCurrencyNames,
        restoreFactoryDefaults,
        resetMonthToDefaults,
      });

      return service;
    },
  });
})(window.BudgetModules || (window.BudgetModules = Object.create(null)));
