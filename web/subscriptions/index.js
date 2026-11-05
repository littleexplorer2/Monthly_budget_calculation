/* 订阅项目逐月快照与固定预算月均汇总。
 * 订阅是固定预算的唯一金额来源；每个已存在月份保存独立快照。
 */
(function register(registry) {
  'use strict';
  registry.subscriptions = Object.freeze({
    dependencies: Object.freeze(["feedback","persistence","shared","standards","standardsView","state"]),
    create({ feedback: feedbackModule, persistence: persistenceModule, shared: sharedModule, standards: standardsModule, standardsView: standardsViewModule, state: stateModule }, service = {}) {
      const { state } = stateModule;
      let fallbackId = 0;
      const runtime = { suppressedMonths: new Set() };

      function monthKey() {
        return `${state.year}-${sharedModule.pad2(state.month)}`;
      }

      function createId() {
        fallbackId += 1;
        const uuid = window.crypto && typeof window.crypto.randomUUID === 'function'
          ? window.crypto.randomUUID() : `${Date.now()}-${fallbackId}`;
        const monthlyIds = Object.values(state.subscriptionsByMonth || {})
          .flatMap((snapshot) => {
            if (!snapshot || typeof snapshot !== 'object') return [];
            const itemIds = Array.isArray(snapshot.items)
              ? snapshot.items.map((item) => item.id) : [];
            const retiredIds = Array.isArray(snapshot.retiredIds) ? snapshot.retiredIds : [];
            return [...itemIds, ...retiredIds];
          });
        const defaultIds = [
          ...(((state.meta || {}).default_subscriptions) || []),
          ...(((state.defaultsDraft || {}).subscriptions) || []),
        ].map((item) => item && item.id).filter(Boolean);
        const used = new Set([...monthlyIds, ...defaultIds]);
        let id = `sub-${uuid}`.slice(0, 64);
        while (used.has(id)) {
          fallbackId += 1;
          id = `sub-${String(uuid).slice(0, 52)}-${fallbackId}`.slice(0, 64);
        }
        return id;
      }

      function defaultCatalogConfigured(meta = state.meta || {}) {
        if (Object.prototype.hasOwnProperty.call(meta, 'default_subscriptions_configured')) {
          return meta.default_subscriptions_configured === true;
        }
        // 兼容尚未返回显式配置标记的旧服务端：出现目录字段即视为已配置。
        return Object.prototype.hasOwnProperty.call(meta, 'default_subscriptions');
      }

      function normalizeAppliesTo(item) {
        const raw = item && item.appliesTo;
        if (!raw || typeof raw !== 'object') {
          return { Mainland: true, Overseas: true };
        }
        const normalized = {
          Mainland: raw.Mainland !== false,
          Overseas: raw.Overseas !== false,
        };
        return normalized.Mainland || normalized.Overseas
          ? normalized
          : { Mainland: true, Overseas: true };
      }

      function appliesToRegion(item, region = state.region) {
        return service.normalizeAppliesTo(item)[region] === true;
      }

      function applicabilitySummary(item) {
        const appliesTo = service.normalizeAppliesTo(item);
        if (appliesTo.Mainland && appliesTo.Overseas) return '内地 + 海外';
        return appliesTo.Mainland ? '仅内地' : '仅海外';
      }

      function applicabilityFieldHtml(item, fieldAttribute) {
        const appliesTo = service.normalizeAppliesTo(item);
        const checkbox = (region, label) => `<label>
          <input type="checkbox" ${fieldAttribute}="appliesTo" data-region="${region}"${appliesTo[region] ? ' checked' : ''}>
          <span>${label}</span>
        </label>`;
        return `<div class="field-stack subscription-region-field"><span>适用预算</span>
          <details class="subscription-region-picker">
            <summary>${service.applicabilitySummary(item)}</summary>
            <div class="subscription-region-menu">
              ${checkbox('Mainland', '对内地预算使用')}
              ${checkbox('Overseas', '对海外预算使用')}
            </div>
          </details>
        </div>`;
      }

      function updateApplicability(item, region, checked, element) {
        if (!['Mainland', 'Overseas'].includes(region)) return false;
        const appliesTo = service.normalizeAppliesTo(item);
        appliesTo[region] = !!checked;
        if (!appliesTo.Mainland && !appliesTo.Overseas) {
          if (element) element.checked = true;
          feedbackModule.toast('订阅项目至少要适用于一个预算区域', 'warning');
          return false;
        }
        item.appliesTo = appliesTo;
        return true;
      }

      function cloneForNextMonth(snapshot) {
        const meta = state.meta || {};
        const retiredIds = new Set(
          snapshot && Array.isArray(snapshot.retiredIds)
            ? snapshot.retiredIds.map((id) => String(id)) : [],
        );
        const previousItems = snapshot && Array.isArray(snapshot.items) ? snapshot.items : [];
        const catalog = service.defaultCatalogConfigured(meta)
          && Object.prototype.hasOwnProperty.call(meta, 'default_subscriptions')
          && Array.isArray(meta.default_subscriptions) ? meta.default_subscriptions : null;
        if (catalog) {
          const defaultsById = new Map(catalog.map((item) => [String(item.id), item]));
          const inherited = [];
          const inheritedIds = new Set();
          for (const previous of previousItems) {
            const id = String(previous.id);
            const item = defaultsById.get(id);
            if (retiredIds.has(id) || !previous.includeByDefault || (item && !item.includeByDefault)) {
              retiredIds.add(id);
              continue;
            }
            inheritedIds.add(id);
            const next = item ? service.monthItemFromDefault(item) : {
              id,
              name: String(previous.name),
              currency: sharedModule.EXTRA_CURRENCIES.includes(previous.currency) ? previous.currency : 'CNY',
              cycle: previous.cycle === 'yearly' ? 'yearly' : 'monthly',
              amount: Math.max(0, Number(previous.amount) || 0),
              included: true,
              includeByDefault: true,
              appliesTo: service.normalizeAppliesTo(previous),
            };
            // 默认目录提供每个新月份的标准金额；当月单独改过的金额不会向后传播。
            // 只在本月新增、尚未进入目录的项目仍按当前定义延续。
            next.included = true;
            next.includeByDefault = true;
            next.appliesTo = service.normalizeAppliesTo(previous);
            inherited.push(next);
          }
          for (const item of catalog) {
            const id = String(item.id);
            if (item.includeByDefault && !inheritedIds.has(id) && !retiredIds.has(id)) {
              inherited.push(service.monthItemFromDefault(item));
            }
          }
          return { items: inherited, retiredIds: Array.from(retiredIds) };
        }
        const inherited = [];
        for (const item of previousItems) {
          const id = String(item.id);
          if (retiredIds.has(id) || !item.includeByDefault) {
            retiredIds.add(id);
            continue;
          }
          inherited.push({
            id,
            name: String(item.name),
            currency: sharedModule.EXTRA_CURRENCIES.includes(item.currency) ? item.currency : 'CNY',
            cycle: item.cycle === 'yearly' ? 'yearly' : 'monthly',
            amount: Math.max(0, Number(item.amount) || 0),
            included: true,
            includeByDefault: true,
            appliesTo: service.normalizeAppliesTo(item),
          });
        }
        return {
          items: inherited,
          retiredIds: Array.from(retiredIds),
        };
      }

      function monthItemFromDefault(item) {
        const includeByDefault = !!item.includeByDefault;
        return {
          id: String(item.id),
          name: String(item.name),
          currency: sharedModule.EXTRA_CURRENCIES.includes(item.currency) ? item.currency : 'CNY',
          cycle: item.cycle === 'yearly' ? 'yearly' : 'monthly',
          amount: Math.max(0, Number(item.amount) || 0),
          included: includeByDefault,
          includeByDefault,
          appliesTo: service.normalizeAppliesTo(item),
        };
      }

      function legacySnapshot() {
        // 旧手工固定/额外预算不自动伪装成订阅。历史月份由用户逐月补录。
        return { items: [], retiredIds: [] };
      }

      function previousSnapshot(key) {
        const map = state.subscriptionsByMonth || {};
        const previousKey = Object.keys(map)
          .filter((candidate) => candidate < key && map[candidate]
            && Array.isArray(map[candidate].items))
          .sort()
          .at(-1);
        return previousKey ? map[previousKey] : null;
      }

      /**
       * 月份首次创建时继承最近过去月份。普通月内编辑只改当前快照；
       * 唯一例外是明确确认的永久取消，它会从取消月之后传播墓碑。
       */
      function ensureMonth(key = service.monthKey()) {
        if (runtime.suppressedMonths.has(key)) return { items: [], retiredIds: [] };
        if (!state.subscriptionsByMonth || typeof state.subscriptionsByMonth !== 'object') {
          state.subscriptionsByMonth = {};
        }
        if (Object.prototype.hasOwnProperty.call(state.subscriptionsByMonth, key)) {
          const existing = state.subscriptionsByMonth[key];
          return existing && Array.isArray(existing.items)
            ? existing : { items: [], retiredIds: [] };
        }
        const monthAlreadyExisted = [
          state.itineraryByMonth, state.optionsByMonth, state.overridesByMonth, state.resultsByMonth,
        ].some((map) => map && Object.prototype.hasOwnProperty.call(map, key));
        const previous = monthAlreadyExisted ? null : service.previousSnapshot(key);
        const configured = service.defaultCatalogConfigured();
        const snapshot = previous
          ? service.cloneForNextMonth(previous)
          : (configured && !monthAlreadyExisted
            ? service.cloneForNextMonth({ items: [], retiredIds: [] }) : service.legacySnapshot());
        state.subscriptionsByMonth[key] = snapshot;
        return snapshot;
      }

      function editableSnapshot() {
        const key = service.monthKey();
        runtime.suppressedMonths.delete(key);
        const current = service.ensureMonth(key);
        if (state.subscriptionsByMonth[key] !== current) {
          state.subscriptionsByMonth[key] = { items: [], retiredIds: [] };
        }
        return state.subscriptionsByMonth[key];
      }

      function updateFutureLifecycle(id, sourceKey, activeItem = null) {
        const itemId = String(id);
        const map = state.subscriptionsByMonth || {};
        const catalog = Array.isArray((state.meta || {}).default_subscriptions)
          ? state.meta.default_subscriptions : [];
        const catalogItem = catalog.find((item) => String(item.id) === itemId);
        for (const key of Object.keys(map).filter((candidate) => candidate > sourceKey).sort()) {
          const snapshot = map[key];
          if (!snapshot || !Array.isArray(snapshot.items)) continue;
          const retired = new Set(Array.isArray(snapshot.retiredIds)
            ? snapshot.retiredIds.map((value) => String(value)) : []);
          if (!activeItem) {
            snapshot.items = snapshot.items.filter((item) => String(item.id) !== itemId);
            retired.add(itemId);
          } else {
            retired.delete(itemId);
            let future = snapshot.items.find((item) => String(item.id) === itemId);
            if (!future) {
              future = catalogItem
                ? service.monthItemFromDefault({ ...catalogItem, includeByDefault: true })
                : service.monthItemFromDefault({ ...activeItem, includeByDefault: true });
              future.appliesTo = service.normalizeAppliesTo(activeItem);
              snapshot.items.push(future);
            } else {
              future.includeByDefault = true;
            }
          }
          snapshot.retiredIds = Array.from(retired);
        }
      }

      function suppressMonth(key = service.monthKey()) {
        runtime.suppressedMonths.add(key);
      }

      function unsuppressMonth(key = service.monthKey()) {
        runtime.suppressedMonths.delete(key);
      }

      function totals(snapshot = service.ensureMonth(), region = state.region) {
        const out = { CNY: 0, HKD: 0, USD: 0 };
        for (const item of snapshot.items || []) {
          if (!item.included || !service.appliesToRegion(item, region)
              || !Object.prototype.hasOwnProperty.call(out, item.currency)) continue;
          const amount = Number(item.amount);
          if (Number.isFinite(amount) && amount >= 0) {
            out[item.currency] += item.cycle === 'yearly' ? amount / 12 : amount;
          }
        }
        return out;
      }

      function syncCurrentMonth() {
        state.standards.fixed = {
          Mainland: service.totals(service.ensureMonth(), 'Mainland'),
          Overseas: service.totals(service.ensureMonth(), 'Overseas'),
        };
        standardsModule.ensureExtraStandards();
        return sharedModule.deepClone(state.standards.fixed[state.region]);
      }

      function option(value, label, selected) {
        return `<option value="${sharedModule.esc(value)}"${selected ? ' selected' : ''}>${sharedModule.esc(label)}</option>`;
      }

      function itemHtml(item) {
        const cycleLabel = item.cycle === 'yearly' ? '年付金额' : '月付金额';
        return `<div class="subscription-row" data-subscription-id="${sharedModule.esc(item.id)}">
          <div class="subscription-row-primary">
            <div class="subscription-toggle-group">
              <label class="subscription-toggle" title="取消后保留本月与更早月份，并从后续月份移除">
                <input type="checkbox" data-subscription-field="includeByDefault"${item.includeByDefault ? ' checked' : ''}>
                <span>计入默认</span>
              </label>
              <label class="subscription-toggle" title="只决定该项目是否计入当前月份固定预算">
                <input type="checkbox" data-subscription-field="included"${item.included ? ' checked' : ''}>
                <span>计入当月预算</span>
              </label>
            </div>
            <label class="field-stack subscription-name"><span>名称</span>
              <input type="text" maxlength="120" data-subscription-field="name" value="${sharedModule.esc(item.name)}" aria-label="订阅名称">
            </label>
            <button type="button" class="icon-delete" data-action="delete-subscription" title="删除本月订阅项目" aria-label="删除订阅项目">✕</button>
          </div>
          <div class="subscription-row-fields">
            <label class="field-stack"><span>周期</span>
              <select data-subscription-field="cycle" aria-label="订阅周期">
                ${service.option('monthly', '每月', item.cycle !== 'yearly')}
                ${service.option('yearly', '每年', item.cycle === 'yearly')}
              </select>
            </label>
            <label class="field-stack subscription-amount"><span>${cycleLabel}</span>
              <input type="number" min="0" step="0.01" data-subscription-field="amount" value="${sharedModule.esc(item.amount)}" aria-label="订阅金额">
            </label>
            ${service.applicabilityFieldHtml(item, 'data-subscription-field')}
          </div>
        </div>`;
      }

      function defaultDraftItems() {
        const meta = state.meta || {};
        const saved = Array.isArray(meta.default_subscriptions) ? meta.default_subscriptions : [];
        if (service.defaultCatalogConfigured(meta)) {
          return saved.map((item) => ({
            ...sharedModule.deepClone(item),
            appliesTo: service.normalizeAppliesTo(item),
          }));
        }
        const current = service.ensureMonth();
        return (current.items || []).map((item) => ({
          id: String(item.id),
          name: String(item.name),
          currency: sharedModule.EXTRA_CURRENCIES.includes(item.currency) ? item.currency : 'CNY',
          cycle: item.cycle === 'yearly' ? 'yearly' : 'monthly',
          amount: Math.max(0, Number(item.amount) || 0),
          includeByDefault: !!item.includeByDefault,
          appliesTo: service.normalizeAppliesTo(item),
        }));
      }

      function visibleDefaultDraftItems() {
        const draft = state.defaultsDraft && Array.isArray(state.defaultsDraft.subscriptions)
          ? state.defaultsDraft.subscriptions : [];
        const latest = Object.entries(state.subscriptionsByMonth || {})
          .filter(([, snapshot]) => snapshot && Array.isArray(snapshot.items))
          .sort(([left], [right]) => left.localeCompare(right))
          .at(-1);
        if (!latest) return draft.filter((item) => item.includeByDefault === true);
        const snapshot = latest[1];
        const currentById = new Map(snapshot.items.map((item) => [String(item.id), item]));
        const retired = new Set(Array.isArray(snapshot.retiredIds)
          ? snapshot.retiredIds.map((id) => String(id)) : []);
        return draft.filter((item) => {
          const id = String(item.id);
          if (!item.includeByDefault || retired.has(id)) return false;
          const current = currentById.get(id);
          return !current || current.includeByDefault === true;
        });
      }

      function defaultDiffCount(left, right) {
        const a = Array.isArray(left) ? left : [];
        const b = Array.isArray(right) ? right : [];
        const byId = (items) => new Map(items.map((item) => [String(item.id), item]));
        const leftById = byId(a);
        const rightById = byId(b);
        let count = 0;
        for (const id of new Set([...leftById.keys(), ...rightById.keys()])) {
          const x = leftById.get(id);
          const y = rightById.get(id);
          if (!x || !y || ['name', 'currency', 'cycle', 'amount', 'includeByDefault']
            .some((field) => field === 'amount'
              ? Number(x[field]) !== Number(y[field])
              : x[field] !== y[field])
            || ['Mainland', 'Overseas'].some((region) => (
              service.normalizeAppliesTo(x)[region] !== service.normalizeAppliesTo(y)[region]
            ))) count += 1;
        }
        return count;
      }

      function defaultItemHtml(item) {
        const cycleLabel = item.cycle === 'yearly' ? '年付金额' : '月付金额';
        return `<div class="subscription-default-row" data-default-subscription-id="${sharedModule.esc(item.id)}">
          <label class="field-stack subscription-name"><span>名称</span>
            <input type="text" maxlength="120" data-default-subscription-field="name" value="${sharedModule.esc(item.name)}" aria-label="默认订阅名称">
          </label>
          <label class="field-stack"><span>币种</span>
            <select data-default-subscription-field="currency" aria-label="默认订阅币种">
              ${sharedModule.EXTRA_CURRENCIES.map((currency) => service.option(currency, currency, item.currency === currency)).join('')}
            </select>
          </label>
          <label class="field-stack"><span>周期</span>
            <select data-default-subscription-field="cycle" aria-label="默认订阅周期">
              ${service.option('monthly', '每月', item.cycle !== 'yearly')}
              ${service.option('yearly', '每年', item.cycle === 'yearly')}
            </select>
          </label>
          <label class="field-stack subscription-amount"><span>${cycleLabel}</span>
            <input type="number" min="0" step="0.01" data-default-subscription-field="amount" value="${sharedModule.esc(item.amount)}" aria-label="默认订阅金额">
          </label>
          <label class="subscription-default" title="取消后从默认清单隐藏；已经保存的月份不改变">
            <input type="checkbox" data-default-subscription-field="includeByDefault"${item.includeByDefault ? ' checked' : ''}>
            <span>计入默认</span>
          </label>
          ${service.applicabilityFieldHtml(item, 'data-default-subscription-field')}
          <button type="button" class="icon-delete" data-action="delete-default-subscription" title="从默认订阅中删除" aria-label="删除默认订阅项目">✕</button>
        </div>`;
      }

      function defaultsSectionHtml() {
        const items = service.visibleDefaultDraftItems();
        const rows = items.length
          ? items.map(service.defaultItemHtml).join('')
          : '<div class="subscription-empty"><strong>暂无默认订阅项目</strong><span>在这里建立的项目会出现在以后新建的月份中。</span></div>';
        return `<section class="defaults-section defaults-subscriptions-section">
          <div class="defaults-section-head">
            <div><span class="eyebrow">02 · SUBSCRIPTIONS</span><h2>订阅项目管理</h2></div>
            <button type="button" class="text-btn" data-action="add-default-subscription">＋ 新增默认订阅</button>
          </div>
          <p class="sheet-rule">这里只显示仍计入默认的项目。新月份使用这里的标准金额；某个月单独修改金额不会影响其它月份。</p>
          <div class="subscription-default-column-hint" aria-hidden="true">
            <span>项目</span><span>币种</span><span>周期</span><span>金额</span><span>计入默认</span><span>适用预算</span>
          </div>
          <div id="subscription-defaults-list" class="subscription-list">${rows}</div>
        </section>`;
      }

      function addDefaultItem() {
        if (!state.defaultsDraft || !Array.isArray(state.defaultsDraft.subscriptions)) return null;
        const item = {
          id: service.createId(), name: '新订阅', currency: 'CNY', cycle: 'monthly', amount: 0,
          includeByDefault: true, appliesTo: { Mainland: true, Overseas: true },
        };
        state.defaultsDraft.subscriptions.push(item);
        standardsViewModule.renderDefaultsPanel();
        const input = sharedModule.$(`[data-default-subscription-id="${item.id}"] input[data-default-subscription-field="name"]`);
        if (input) {
          input.focus();
          if (typeof input.setSelectionRange === 'function') input.setSelectionRange(0, input.value.length);
        }
        return item;
      }

      function deleteDefaultItem(id) {
        if (!state.defaultsDraft || !Array.isArray(state.defaultsDraft.subscriptions)) return false;
        const index = state.defaultsDraft.subscriptions.findIndex((item) => item.id === id);
        if (index < 0) return false;
        state.defaultsDraft.subscriptions.splice(index, 1);
        standardsViewModule.renderDefaultsPanel();
        return true;
      }

      function updateDefaultField(element) {
        const row = element && element.closest('.subscription-default-row');
        const field = element && element.dataset.defaultSubscriptionField;
        if (!row || !field || !state.defaultsDraft || !Array.isArray(state.defaultsDraft.subscriptions)) return false;
        const item = state.defaultsDraft.subscriptions.find((candidate) => candidate.id === row.dataset.defaultSubscriptionId);
        if (!item) return false;
        if (field === 'includeByDefault') {
          item.includeByDefault = !!element.checked;
          standardsViewModule.renderDefaultsPanel();
        } else if (field === 'appliesTo') {
          if (!service.updateApplicability(item, element.dataset.region, element.checked, element)) return false;
          standardsViewModule.renderDefaultsPanel();
        } else if (field === 'amount') {
          const amount = Number(element.value);
          if (!Number.isFinite(amount) || amount < 0) { element.classList.add('invalid'); return false; }
          element.classList.remove('invalid');
          item.amount = amount;
        } else if (field === 'name') {
          const name = String(element.value || '').trim();
          if (!name || name.length > 120) { element.classList.add('invalid'); return false; }
          element.classList.remove('invalid');
          item.name = name;
        } else if (field === 'currency' && sharedModule.EXTRA_CURRENCIES.includes(element.value)) {
          item.currency = element.value;
        } else if (field === 'cycle' && ['monthly', 'yearly'].includes(element.value)) {
          item.cycle = element.value;
          standardsViewModule.renderDefaultsPanel();
        } else {
          return false;
        }
        return true;
      }

      function renderSummary(snapshot, total) {
        const visibleItems = snapshot.items.filter((item) => service.appliesToRegion(item));
        const totalBox = sharedModule.$('#subscription-totals');
        if (totalBox) {
          totalBox.innerHTML = sharedModule.EXTRA_CURRENCIES.map((currency) => `
            <div><span>${currency}</span><strong>${sharedModule.fmtMoney(total[currency])}</strong></div>`).join('');
        }
        const count = sharedModule.$('#subscription-count');
        if (count) {
          const selected = visibleItems.filter((item) => item.included).length;
          count.textContent = `${selected} / ${visibleItems.length} 项计入本月`;
        }
        for (const currency of sharedModule.EXTRA_CURRENCIES) {
          const meta = sharedModule.$(
            `[data-subscription-currency="${currency}"] > header span`,
          );
          if (meta) {
            const itemCount = visibleItems.filter((item) => item.currency === currency).length;
            meta.textContent = `${itemCount} 项 · 月均 ${sharedModule.fmtMoney(total[currency])}`;
          }
        }
        const monthLabel = sharedModule.$('#subscriptions-month-label');
        if (monthLabel) monthLabel.textContent = `${state.year}年${state.month}月`;
      }

      function render() {
        const snapshot = service.ensureMonth();
        const total = service.syncCurrentMonth();
        service.renderSummary(snapshot, total);
        const list = sharedModule.$('#subscription-list');
        if (list) {
          list.innerHTML = sharedModule.EXTRA_CURRENCIES.map((currency) => {
            const items = snapshot.items.filter((item) => (
              item.currency === currency && service.appliesToRegion(item)
            ));
            const rows = items.length
              ? items.map(service.itemHtml).join('')
              : `<div class="subscription-currency-empty">暂无 ${currency} 订阅</div>`;
            return `<section class="subscription-currency-card" data-subscription-currency="${currency}">
              <header>
                <div class="subscription-currency-title"><strong>${currency} 订阅项目</strong><span>${items.length} 项 · 月均 ${sharedModule.fmtMoney(total[currency])}</span></div>
                <button type="button" class="text-btn subscription-add-button" data-action="add-subscription" data-currency="${currency}" aria-label="新增 ${currency} 本月订阅">＋ 新增</button>
              </header>
              <div class="subscription-currency-list">${rows}</div>
            </section>`;
          }).join('');
        }
        return total;
      }

      function commit(message, options = {}) {
        const total = service.syncCurrentMonth();
        standardsModule.saveOverrides();
        persistenceModule.saveState();
        standardsViewModule.renderStandards();
        if (options.renderList === false) service.renderSummary(service.ensureMonth(), total);
        else service.render();
        if (message) feedbackModule.toast(message, 'info');
      }

      function addItem(rawCurrency = 'CNY') {
        const currency = sharedModule.EXTRA_CURRENCIES.includes(rawCurrency) ? rawCurrency : 'CNY';
        const snapshot = service.editableSnapshot();
        const item = {
          id: service.createId(),
          name: '新订阅',
          currency,
          cycle: 'monthly',
          amount: 0,
          included: true,
          includeByDefault: !service.defaultCatalogConfigured(),
          appliesTo: { Mainland: true, Overseas: true },
        };
        snapshot.items.push(item);
        service.commit();
        const input = sharedModule.$(`[data-subscription-id="${item.id}"] input[data-subscription-field="name"]`);
        if (input) {
          input.focus();
          if (typeof input.setSelectionRange === 'function') input.setSelectionRange(0, input.value.length);
        }
      }

      function deleteItem(id) {
        const snapshot = service.editableSnapshot();
        const index = snapshot.items.findIndex((item) => item.id === id);
        if (index < 0) return false;
        if (!window.confirm(`只删除 ${service.monthKey()} 的订阅项目“${snapshot.items[index].name}”？`)) return false;
        snapshot.items.splice(index, 1);
        service.commit('已删除本月订阅项目；其它月份未改变');
        return true;
      }

      function updateField(element, options = {}) {
        const row = element && element.closest('.subscription-row');
        const field = element && element.dataset.subscriptionField;
        if (!row || !field) return false;
        const snapshot = service.editableSnapshot();
        const item = snapshot.items.find((candidate) => candidate.id === row.dataset.subscriptionId);
        if (!item) return false;
        let message = null;
        if (field === 'included') {
          item.included = !!element.checked;
        } else if (field === 'includeByDefault') {
          const enabled = !!element.checked;
          if (!enabled && item.includeByDefault && !window.confirm(
            `永久取消订阅“${item.name}”？本月与更早月份会保留，${service.monthKey()} 之后已有和新建的月份都会移除该项目。`,
          )) {
            element.checked = true;
            return false;
          }
          item.includeByDefault = enabled;
          service.updateFutureLifecycle(item.id, service.monthKey(), enabled ? item : null);
          message = enabled
            ? '已恢复为默认订阅，并同步到后续已有月份'
            : '已永久取消默认订阅；本月与更早月份保持不变';
        } else if (field === 'appliesTo') {
          if (!service.updateApplicability(item, element.dataset.region, element.checked, element)) return false;
        } else if (field === 'amount') {
          const amount = Number(element.value);
          if (!Number.isFinite(amount) || amount < 0) {
            element.classList.add('invalid');
            return false;
          }
          element.classList.remove('invalid');
          item.amount = amount;
        } else if (field === 'name') {
          const name = String(element.value || '').trim();
          if (!name || name.length > 120) {
            element.classList.add('invalid');
            return false;
          }
          element.classList.remove('invalid');
          item.name = name;
        } else if (field === 'cycle' && ['monthly', 'yearly'].includes(element.value)) {
          item.cycle = element.value;
        } else {
          return false;
        }
        service.commit(message, options);
        return true;
      }

      Object.assign(service, {
        runtime,
        monthKey,
        createId,
        defaultCatalogConfigured,
        normalizeAppliesTo,
        appliesToRegion,
        applicabilitySummary,
        applicabilityFieldHtml,
        updateApplicability,
        cloneForNextMonth,
        monthItemFromDefault,
        legacySnapshot,
        previousSnapshot,
        ensureMonth,
        editableSnapshot,
        suppressMonth,
        unsuppressMonth,
        totals,
        syncCurrentMonth,
        option,
        itemHtml,
        defaultDraftItems,
        visibleDefaultDraftItems,
        defaultDiffCount,
        defaultItemHtml,
        defaultsSectionHtml,
        addDefaultItem,
        deleteDefaultItem,
        updateDefaultField,
        updateFutureLifecycle,
        renderSummary,
        render,
        commit,
        addItem,
        deleteItem,
        updateField,
      });
      return service;
    },
  });
})(window.BudgetModules || (window.BudgetModules = Object.create(null)));
