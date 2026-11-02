/* 资产管理：最近一年平均汇率、持仓编辑与结构化汇总。
 * 汇率只通过应用层 HTTP 接口取得；前端不直接访问行情提供方。
 */
(function register(registry) {
  'use strict';
  registry.assets = Object.freeze({
    dependencies: Object.freeze(["feedback","http","persistence","shared","state"]),
    create({ feedback: feedbackModule, http: apiModule, persistence: persistenceModule, shared: sharedModule, state: stateModule }, service = {}) {
      const { state } = stateModule;
      let fallbackId = 0;
      const KIND_LABELS = Object.freeze({ cash: '活期存款', term: '定期存款', investment: '投资' });
      const PURPOSE_LABELS = Object.freeze({ spending: '消费', reserve: '储备', other: '其它' });
      const ASSET_RATE_CURRENCIES = Object.freeze(['HKD', 'USD']);
      const rateState = {
        status: 'idle',
        rates: { CNY: 1, HKD: null, USD: null },
        payload: null,
        error: null,
        promise: null,
      };

      function defaultPortfolio() {
        return {
          calculationBase: { CNY: 20000, HKD: 0, USD: 0 },
          rates: { CNY: 1, HKD: null, USD: null },
          items: [],
        };
      }

      function portfolio(create = false) {
        if (!state.assetPortfoliosById || typeof state.assetPortfoliosById !== 'object') {
          state.assetPortfoliosById = {};
        }
        const current = state.assetPortfoliosById.current;
        if (current && typeof current === 'object' && Array.isArray(current.items)) return current;
        if (!create) return service.defaultPortfolio();
        state.assetPortfoliosById.current = service.defaultPortfolio();
        return state.assetPortfoliosById.current;
      }

      function createId() {
        fallbackId += 1;
        const uuid = window.crypto && typeof window.crypto.randomUUID === 'function'
          ? window.crypto.randomUUID() : `${Date.now()}-${fallbackId}`;
        const used = new Set((service.portfolio().items || []).map((item) => item.id));
        let id = `asset-${uuid}`.slice(0, 64);
        while (used.has(id)) {
          fallbackId += 1;
          id = `asset-${String(uuid).slice(0, 50)}-${fallbackId}`.slice(0, 64);
        }
        return id;
      }

      function option(value, label, selected) {
        return `<option value="${sharedModule.esc(value)}"${selected ? ' selected' : ''}>${sharedModule.esc(label)}</option>`;
      }

      function currentRates() {
        return rateState.rates;
      }

      function baseAmounts(input = service.portfolio()) {
        const raw = input && input.calculationBase;
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          return Object.fromEntries(sharedModule.EXTRA_CURRENCIES.map((currency) => {
            const value = Number(raw[currency]);
            return [currency, Number.isFinite(value) && value >= 0 ? value : 0];
          }));
        }
        const legacyCny = Number(raw);
        return {
          CNY: Number.isFinite(legacyCny) && legacyCny > 0 ? legacyCny : 20000,
          HKD: 0,
          USD: 0,
        };
      }

      function compute(input = service.portfolio(), rates = service.currentRates()) {
        const summary = {
          total: 0,
          cash: 0,
          term: 0,
          investment: 0,
          marketInvestment: 0,
          deposit: 0,
          byCurrency: { CNY: 0, HKD: 0, USD: 0 },
          missingRates: new Set(),
          baseByCurrency: service.baseAmounts(input),
          baseTotal: 0,
          baseMissingRates: new Set(),
          baseComplete: true,
          complete: true,
        };
        for (const currency of sharedModule.EXTRA_CURRENCIES) {
          const amount = summary.baseByCurrency[currency];
          const rate = currency === 'CNY' ? 1 : Number(rates && rates[currency]);
          if (!Number.isFinite(rate) || rate <= 0) {
            if (amount > 0) summary.baseMissingRates.add(currency);
            continue;
          }
          summary.baseTotal += amount * rate;
        }
        summary.baseComplete = summary.baseMissingRates.size === 0 && summary.baseTotal > 0;
        for (const item of input.items || []) {
          const amount = Number(item.amount);
          if (!Number.isFinite(amount) || amount < 0) continue;
          const rate = item.currency === 'CNY' ? 1 : Number(rates && rates[item.currency]);
          if (!Number.isFinite(rate) || rate <= 0) {
            if (amount > 0) summary.missingRates.add(item.currency);
            continue;
          }
          const converted = amount * rate;
          summary.total += converted;
          summary.byCurrency[item.currency] += converted;
          if (item.kind === 'cash') summary.cash += converted;
          else if (item.kind === 'term') {
            summary.term += converted;
            summary.investment += converted;
          } else {
            summary.marketInvestment += converted;
            summary.investment += converted;
          }
        }
        summary.deposit = summary.cash + summary.term;
        summary.complete = summary.missingRates.size === 0;
        return summary;
      }

      function percent(value, total) {
        return total > 0 ? `${(value / total * 100).toFixed(2)}%` : '0.00%';
      }

      function cny(value, approximate = false) {
        return `${approximate ? '约 ' : ''}¥ ${sharedModule.fmtMoney(value)}`;
      }

      function itemHtml(item) {
        const purpose = item.kind === 'cash'
          ? `<label class="field-stack"><span>用途</span><select data-asset-field="purpose" aria-label="资产用途">
              ${Object.entries(PURPOSE_LABELS).map(([value, label]) => service.option(value, label, item.purpose === value)).join('')}
            </select></label>`
          : `<div class="field-stack asset-kind-note"><span>分类</span><strong>${sharedModule.esc(KIND_LABELS[item.kind])}</strong></div>`;
        return `<div class="asset-row" data-asset-id="${sharedModule.esc(item.id)}">
          <label class="field-stack"><span>类型</span><select data-asset-field="kind" aria-label="资产类型">
            ${Object.entries(KIND_LABELS).map(([value, label]) => service.option(value, label, item.kind === value)).join('')}
          </select></label>
          <label class="field-stack"><span>地点 / 机构</span><input type="text" maxlength="120" data-asset-field="location" value="${sharedModule.esc(item.location)}"></label>
          <label class="field-stack asset-name"><span>账户 / 项目</span><input type="text" maxlength="120" data-asset-field="name" value="${sharedModule.esc(item.name)}"></label>
          ${purpose}
          <label class="field-stack"><span>币种</span><select data-asset-field="currency" aria-label="资产币种">
            ${sharedModule.EXTRA_CURRENCIES.map((currency) => service.option(currency, currency, item.currency === currency)).join('')}
          </select></label>
          <label class="field-stack asset-amount"><span>金额</span><input type="number" min="0" step="0.01" data-asset-field="amount" value="${sharedModule.esc(item.amount)}"></label>
          <button type="button" class="icon-delete" data-action="delete-asset" title="删除资产条目" aria-label="删除资产条目">✕</button>
        </div>`;
      }

      function renderGroup(kind, input, summary) {
        const holder = sharedModule.$(`#asset-${kind}-list`);
        if (!holder) return;
        const items = input.items.filter((item) => item.kind === kind);
        holder.innerHTML = items.length
          ? items.map(service.itemHtml).join('')
          : `<div class="asset-empty">暂无${sharedModule.esc(KIND_LABELS[kind])}条目</div>`;
        const total = kind === 'cash' ? summary.cash : input.items
          .filter((item) => item.kind === kind)
          .reduce((sum, item) => {
            const rate = item.currency === 'CNY' ? 1 : Number(service.currentRates()[item.currency]);
            return Number.isFinite(rate) && rate > 0 ? sum + Number(item.amount || 0) * rate : sum;
          }, 0);
        const summaryNode = sharedModule.$(`#asset-${kind}-summary`);
        if (summaryNode) {
          summaryNode.textContent = `${service.cny(total, true)} · ${summary.complete ? service.percent(total, summary.total) : '占比待补汇率'}`;
        }
      }

      function renderRateState() {
        for (const currency of ASSET_RATE_CURRENCIES) {
          const output = sharedModule.$(`[data-asset-rate-output="${currency}"]`);
          const note = sharedModule.$(`[data-asset-rate-note="${currency}"]`);
          const stat = rateState.payload && rateState.payload.stats && rateState.payload.stats[currency];
          const value = Number(rateState.rates[currency]);
          if (output) {
            output.textContent = Number.isFinite(value) && value > 0
              ? value.toFixed(6)
              : rateState.status === 'loading' ? '获取中…' : '不可用';
          }
          if (note) {
            const error = rateState.payload && rateState.payload.errors && rateState.payload.errors[currency];
            note.textContent = stat
              ? `${stat.observation_count} 个交易日 · 截至 ${stat.last_date}`
              : error ? '该币种获取失败' : '最近 365 天均值';
          }
        }
        const source = sharedModule.$('#asset-rate-source-note');
        if (source) {
          if (rateState.status === 'loading' || rateState.status === 'idle') {
            source.textContent = 'CNY 汇率固定为 1；正在获取最近 365 天实际交易日 Close 均值。';
          } else if (rateState.payload) {
            const observed = rateState.payload.observed_through || '暂无共同观测日';
            const observations = ASSET_RATE_CURRENCIES.map((currency) => {
              const stat = rateState.payload.stats && rateState.payload.stats[currency];
              return stat ? `${currency} ${stat.observation_count} 个交易日` : `${currency} 无可用交易日`;
            }).join('，');
            source.textContent = `${rateState.payload.start_date} 至 ${rateState.payload.requested_through}；`
              + `实际交易日 Close（${observations}），保守观测截至 ${observed}。获取失败的币种不会使用旧手填值替代。`;
          } else {
            source.textContent = `最近一年汇率获取失败：${rateState.error || '未知错误'}。外币资产暂不计入完整总额。`;
          }
        }
        const refresh = sharedModule.$('#btn-refresh-asset-rates');
        if (refresh) refresh.disabled = rateState.status === 'loading';
      }

      function loadRates(refresh = false) {
        if (rateState.promise) return rateState.promise;
        if (!refresh && ['ready', 'partial', 'error'].includes(rateState.status)) {
          return Promise.resolve(rateState.payload);
        }
        rateState.status = 'loading';
        rateState.error = null;
        service.renderRateState();
        const suffix = refresh ? '&refresh=true' : '';
        const pending = apiModule.api(`/api/asset-rates?currencies=HKD%2CUSD${suffix}`, { timeout: 180000 })
          .then((payload) => {
            rateState.payload = payload;
            rateState.rates = { CNY: 1, HKD: null, USD: null };
            for (const currency of ASSET_RATE_CURRENCIES) {
              const stat = payload && payload.stats && payload.stats[currency];
              const value = Number(stat && stat.average);
              if (Number.isFinite(value) && value > 0) rateState.rates[currency] = value;
            }
            rateState.status = ASSET_RATE_CURRENCIES.every((currency) => rateState.rates[currency] != null)
              ? 'ready' : 'partial';
            service.render();
            return payload;
          })
          .catch((error) => {
            rateState.status = 'error';
            rateState.payload = null;
            rateState.rates = { CNY: 1, HKD: null, USD: null };
            rateState.error = error && error.message ? error.message : String(error);
            service.render();
            if (refresh) feedbackModule.toast(`资产汇率更新失败：${rateState.error}`, 'error');
            return null;
          })
          .finally(() => { rateState.promise = null; });
        rateState.promise = pending;
        return pending;
      }

      function render() {
        if (rateState.status === 'idle') void service.loadRates();
        const input = service.portfolio();
        const summary = service.compute(input);
        sharedModule.$$('[data-asset-base-currency]').forEach((baseInput) => {
          baseInput.value = summary.baseByCurrency[baseInput.dataset.assetBaseCurrency];
        });
        const total = sharedModule.$('#asset-current-total');
        if (total) total.textContent = service.cny(summary.total, true);
        const totalNote = sharedModule.$('#asset-total-note');
        if (totalNote) {
          totalNote.textContent = summary.complete
            ? `${input.items.length} 个资产条目已纳入换算`
            : `尚缺 ${Array.from(summary.missingRates).join('、')} 最近一年均值，当前仅为已知部分`;
        }
        const completion = sharedModule.$('#asset-base-progress');
        const completionNote = sharedModule.$('#asset-base-note');
        if (completion) {
          completion.textContent = summary.complete && summary.baseComplete
            ? service.percent(summary.total, summary.baseTotal)
            : summary.baseMissingRates.size || !summary.complete ? '待补汇率' : '待补基数';
        }
        if (completionNote) {
          completionNote.textContent = summary.baseComplete
            ? `当前总额 ÷ ${service.cny(summary.baseTotal, true)}`
            : summary.baseMissingRates.size
              ? `基数尚缺 ${Array.from(summary.baseMissingRates).join('、')} 汇率`
              : '请填写至少一种计算基数';
        }
        const cashRate = sharedModule.$('#asset-cash-rate');
        if (cashRate) cashRate.textContent = summary.complete ? service.percent(summary.cash, summary.total) : '待补汇率';
        const investmentRate = sharedModule.$('#asset-investment-rate');
        if (investmentRate) investmentRate.textContent = summary.complete ? service.percent(summary.investment, summary.total) : '待补汇率';
        const depositRate = sharedModule.$('#asset-deposit-rate');
        if (depositRate) depositRate.textContent = summary.complete ? service.percent(summary.deposit, summary.total) : '待补汇率';

        const allocation = sharedModule.$('#asset-currency-allocation');
        if (allocation) {
          const entries = sharedModule.EXTRA_CURRENCIES.map((currency) => {
            const value = summary.byCurrency[currency];
            const share = summary.complete ? service.percent(value, summary.total) : '—';
            const width = summary.complete && summary.total > 0 ? Math.min(100, value / summary.total * 100) : 0;
            return { currency, value, share, width };
          });
          const segments = entries.map(({ currency, width }) => (
            `<div class="allocation-segment" data-allocation-currency="${currency}" style="width:${width.toFixed(4)}%">
              <span>${currency}</span>
            </div>`
          )).join('');
          const stackLabel = entries.map(({ currency, share }) => `${currency} ${share}`).join('，');
          const emptyLabel = summary.complete && summary.total <= 0
            ? '<span class="allocation-empty-label">CNY | HKD | USD · 暂无资产数据</span>'
            : !summary.complete
              ? '<span class="allocation-empty-label">CNY | HKD | USD · 汇率数据不完整</span>'
              : '';
          const legend = entries.map(({ currency, value, share }) => (
            `<div class="allocation-legend-item" data-allocation-legend="${currency}">
              <span><i aria-hidden="true"></i>${currency}</span>
              <strong>${share}</strong>
              <small>${service.cny(value, true)}</small>
            </div>`
          )).join('');
          allocation.innerHTML = `<div class="allocation-stack" role="img" aria-label="币种占比：${stackLabel}">
            ${segments}${emptyLabel}
          </div><div class="allocation-legend">${legend}</div>`;
        }
        for (const kind of Object.keys(KIND_LABELS)) service.renderGroup(kind, input, summary);
        service.renderRateState();
      }

      function persistAndRender(message) {
        persistenceModule.persist('debounce', 'assets');
        service.render();
        if (message) feedbackModule.toast(message, 'info');
      }

      function addItem(kind) {
        if (!Object.prototype.hasOwnProperty.call(KIND_LABELS, kind)) return false;
        const input = service.portfolio(true);
        const defaults = kind === 'cash'
          ? { location: '深圳', name: '消费账户', purpose: 'spending' }
          : kind === 'term'
            ? { location: '香港', name: '定期存款', purpose: 'other' }
            : { location: '投资账户', name: '投资项目', purpose: 'other' };
        const item = {
          id: service.createId(), kind, ...defaults, currency: 'CNY', amount: 0,
        };
        input.items.push(item);
        service.persistAndRender();
        const nameInput = sharedModule.$(`[data-asset-id="${item.id}"] input[data-asset-field="name"]`);
        if (nameInput) nameInput.focus();
        return true;
      }

      function deleteItem(id) {
        const input = service.portfolio(true);
        const index = input.items.findIndex((item) => item.id === id);
        if (index < 0) return false;
        if (!window.confirm(`删除资产条目“${input.items[index].name}”？`)) return false;
        input.items.splice(index, 1);
        service.persistAndRender('已删除资产条目');
        return true;
      }

      function updateSetting(element) {
        const input = service.portfolio(true);
        const currency = element && element.dataset.assetBaseCurrency;
        if (sharedModule.EXTRA_CURRENCIES.includes(currency)) {
          const value = Number(element.value);
          if (!Number.isFinite(value) || value < 0) {
            element.classList.add('invalid');
            return false;
          }
          const base = service.baseAmounts(input);
          base[currency] = value;
          if (!Object.values(base).some((amount) => amount > 0)) {
            element.classList.add('invalid');
            return false;
          }
          element.classList.remove('invalid');
          input.calculationBase = base;
        } else {
          return false;
        }
        service.persistAndRender();
        return true;
      }

      function updateField(element) {
        const row = element && element.closest('.asset-row');
        const field = element && element.dataset.assetField;
        if (!row || !field) return false;
        const input = service.portfolio(true);
        const item = input.items.find((candidate) => candidate.id === row.dataset.assetId);
        if (!item) return false;
        if (field === 'amount') {
          const value = Number(element.value);
          if (!Number.isFinite(value) || value < 0) {
            element.classList.add('invalid');
            return false;
          }
          element.classList.remove('invalid');
          item.amount = value;
        } else if (field === 'location' || field === 'name') {
          const value = String(element.value || '').trim();
          if (!value || value.length > 120) {
            element.classList.add('invalid');
            return false;
          }
          element.classList.remove('invalid');
          item[field] = value;
        } else if (field === 'kind' && Object.prototype.hasOwnProperty.call(KIND_LABELS, element.value)) {
          item.kind = element.value;
          if (item.kind !== 'cash') item.purpose = 'other';
        } else if (field === 'purpose' && Object.prototype.hasOwnProperty.call(PURPOSE_LABELS, element.value)) {
          item.purpose = element.value;
        } else if (field === 'currency' && sharedModule.EXTRA_CURRENCIES.includes(element.value)) {
          item.currency = element.value;
        } else {
          return false;
        }
        service.persistAndRender();
        return true;
      }

      Object.assign(service, {
        KIND_LABELS,
        PURPOSE_LABELS,
        defaultPortfolio,
        portfolio,
        rateState,
        currentRates,
        baseAmounts,
        createId,
        option,
        compute,
        percent,
        cny,
        itemHtml,
        renderGroup,
        renderRateState,
        loadRates,
        render,
        persistAndRender,
        addItem,
        deleteItem,
        updateSetting,
        updateField,
      });
      return service;
    },
  });
})(window.BudgetModules || (window.BudgetModules = Object.create(null)));
