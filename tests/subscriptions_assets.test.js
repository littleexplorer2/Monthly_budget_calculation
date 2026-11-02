'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createApp, defaultMetaFixture, defaultStateFixture } = require('./helpers/dom-stub.js');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function subscription(id, overrides = {}) {
  return {
    id,
    name: id,
    currency: 'USD',
    cycle: 'monthly',
    amount: 10,
    included: true,
    includeByDefault: true,
    ...overrides,
  };
}

test('勾选订阅按币种驱动固定预算，年付金额按十二个月平均计入', async () => {
  const state = defaultStateFixture();
  state.subscriptionsByMonth['2026-09'] = {
    items: [
      subscription('monthly-usd'),
      subscription('yearly-hkd', {
        currency: 'HKD', cycle: 'yearly', amount: 1200,
        included: false, includeByDefault: false,
      }),
    ],
  };
  const { doc, app } = createApp({ state });
  await app.init();

  assert.deepEqual(JSON.parse(JSON.stringify(app.subscriptionTotals())), { CNY: 0, HKD: 0, USD: 10 });
  assert.equal(app.state.standards.fixed.Mainland.USD, 10);
  assert.equal(app.state.standards.fixed.Overseas.USD, 10);
  assert.equal(app.state.standards.extra.USD, 0);
  assert.equal(doc.querySelectorAll('#fixed-standards-table input[data-cat="fixed"]').length, 0,
    '固定预算必须只读，不能形成第二套手工金额来源');
  assert.equal(doc.querySelectorAll('#subscription-list .subscription-currency-card').length, 3,
    'CNY / HKD / USD 应分成三栏');

  const yearly = doc.querySelector('[data-subscription-id="yearly-hkd"] input[data-subscription-field="included"]');
  yearly.checked = true;
  yearly.dispatchEvent({ type: 'change', bubbles: true, target: yearly });

  assert.equal(app.state.standards.fixed.Mainland.HKD, 100);
  assert.equal(app.state.standards.fixed.Overseas.HKD, 100);
  assert.equal(Object.hasOwn(app.state.overridesByMonth['2026-09'], 'fixed'), false);
  assert.equal(Object.hasOwn(app.state.overridesByMonth['2026-09'], 'extra'), false);
});

test('订阅名称与金额在输入时进入保存队列，不依赖失焦或 change 事件', async () => {
  const state = defaultStateFixture();
  state.subscriptionsByMonth['2026-09'] = {
    items: [subscription('annual', { name: '旧名称', currency: 'HKD', cycle: 'yearly', amount: 1200 })],
  };
  const { doc, app, requests } = createApp({ state });
  await app.init();

  const name = doc.querySelector('[data-subscription-id="annual"] input[data-subscription-field="name"]');
  name.focus();
  name.value = '年度会员';
  name.dispatchEvent({ type: 'input', bubbles: true, target: name });
  assert.equal(doc.querySelector('[data-subscription-id="annual"] input[data-subscription-field="name"]'), name,
    '输入期间不能重建正在编辑的输入框');
  assert.equal(app.state.subscriptionsByMonth['2026-09'].items[0].name, '年度会员');

  const amount = doc.querySelector('[data-subscription-id="annual"] input[data-subscription-field="amount"]');
  amount.value = '2400';
  amount.dispatchEvent({ type: 'input', bubbles: true, target: amount });
  assert.equal(app.state.standards.fixed.Mainland.HKD, 200);

  await wait(360);
  const writes = requests.filter((request) => request.url === '/api/state' && request.method === 'PUT');
  assert.ok(writes.length > 0);
  const saved = writes.at(-1).body.subscriptionsByMonth['2026-09'].items[0];
  assert.equal(saved.name, '年度会员');
  assert.equal(saved.amount, 2400);
});

test('新月份按计入默认继承订阅，但修改目标月不反写过去月份', async () => {
  const meta = defaultMetaFixture();
  meta.default_subscriptions_configured = true;
  meta.default_subscriptions = [
    { id: 'keep', name: 'keep', currency: 'USD', cycle: 'monthly', amount: 10, includeByDefault: true },
    { id: 'skip', name: 'skip', currency: 'USD', cycle: 'monthly', amount: 10, includeByDefault: false },
  ];
  const state = defaultStateFixture();
  state.subscriptionsByMonth['2026-09'] = {
    items: [
      subscription('keep', { included: false, includeByDefault: true }),
      subscription('skip', { included: true, includeByDefault: false }),
    ],
  };
  const { doc, app } = createApp({ meta, state });
  await app.init();
  assert.equal(app.navigateToMonth(2026, 10), true);

  const october = app.state.subscriptionsByMonth['2026-10'];
  assert.deepEqual(JSON.parse(JSON.stringify(october.items.map((item) => [item.id, item.included]))), [
    ['keep', true], ['skip', false],
  ]);

  const keep = doc.querySelector('[data-subscription-id="keep"] input[data-subscription-field="included"]');
  keep.checked = false;
  keep.dispatchEvent({ type: 'change', bubbles: true, target: keep });

  assert.equal(app.state.subscriptionsByMonth['2026-10'].items[0].included, false);
  assert.equal(app.state.subscriptionsByMonth['2026-09'].items[0].included, false,
    '九月原快照应保持原来的未勾选值');
  assert.equal(app.state.subscriptionsByMonth['2026-09'].items[1].included, true,
    '修改十月不能改变九月的其它项目');
});

test('首次启用默认订阅目录时把旧月份项目迁入弹窗草稿', async () => {
  const meta = defaultMetaFixture();
  meta.default_subscriptions_configured = false;
  meta.default_subscriptions = [];
  const state = defaultStateFixture();
  state.subscriptionsByMonth['2026-09'] = {
    items: [
      subscription('keep', { name: '旧默认项目', includeByDefault: true }),
      subscription('skip', { name: '旧非默认项目', includeByDefault: false }),
    ],
  };
  const { doc, app } = createApp({ meta, state });
  await app.init();

  doc.querySelector('#btn-defaults-modal').click();
  const keep = doc.querySelector(
    '[data-default-subscription-id="keep"] input[data-default-subscription-field="includeByDefault"]',
  );
  const skip = doc.querySelector(
    '[data-default-subscription-id="skip"] input[data-default-subscription-field="includeByDefault"]',
  );
  assert.ok(keep && skip, '旧月份项目应先进入默认配置草稿，不能显示为空');
  assert.equal(keep.checked, true);
  assert.equal(skip.checked, false);
  assert.equal(app.state.defaultsDraft.subscriptions.length, 2,
    '首次保存会把迁移草稿写成正式默认订阅目录');

  assert.equal(app.navigateToMonth(2026, 10), true);
  assert.deepEqual(JSON.parse(JSON.stringify(app.state.subscriptionsByMonth['2026-10'].items.map((item) => (
    [item.id, item.included]
  )))), [['keep', true], ['skip', false]], '正式目录保存前仍应保留旧版默认继承语义');
});

test('本月条目使用计入默认文案，默认目录字段仍只由配置弹窗维护', async () => {
  const meta = defaultMetaFixture();
  meta.default_subscriptions_configured = true;
  meta.default_subscriptions = [
    { id: 'keep', name: '保留项目', currency: 'USD', cycle: 'monthly', amount: 20, includeByDefault: true },
    { id: 'skip', name: '暂不计入', currency: 'HKD', cycle: 'yearly', amount: 600, includeByDefault: false },
  ];
  const state = defaultStateFixture();
  state.subscriptionsByMonth['2026-09'] = {
    items: [
      subscription('keep', { amount: 10, included: false, includeByDefault: false }),
      subscription('skip', { included: true, includeByDefault: true }),
    ],
  };
  const { doc, app } = createApp({ meta, state });
  await app.init();

  assert.equal(doc.querySelector('#subscription-list .subscription-toggle span').textContent, '计入默认');
  assert.equal(doc.querySelector('#subscription-list [data-subscription-field="includeByDefault"]'), null,
    '本月订阅分区不应再混放默认勾选框');
  doc.querySelector('#btn-defaults-modal').click();
  const defaultCheckbox = doc.querySelector(
    '[data-default-subscription-id="keep"] input[data-default-subscription-field="includeByDefault"]',
  );
  assert.ok(defaultCheckbox, '默认勾选框应位于默认配置弹窗的订阅管理部分');
  assert.ok(doc.querySelector('.defaults-budget-section'));
  assert.ok(doc.querySelector('.defaults-subscriptions-section'));
  assert.doesNotMatch(doc.querySelector('.defaults-budget-section').textContent,
    /维护各地点的每日固定预算与旅居标准/);

  assert.equal(app.navigateToMonth(2026, 10), true);
  assert.deepEqual(JSON.parse(JSON.stringify(app.state.subscriptionsByMonth['2026-10'].items.map((item) => (
    [item.id, item.name, item.amount, item.included]
  )))), [
    ['keep', '保留项目', 20, true],
    ['skip', '暂不计入', 600, false],
  ]);
  assert.equal(app.state.subscriptionsByMonth['2026-09'].items[0].included, false,
    '使用默认目录创建十月不能修改九月快照');
});

test('删除一个月份后再次确认创建，可重新按最近过去月份的默认勾选生成', async () => {
  const meta = defaultMetaFixture();
  meta.default_subscriptions_configured = true;
  meta.default_subscriptions = [
    { id: 'keep', name: 'keep', currency: 'USD', cycle: 'monthly', amount: 10, includeByDefault: true },
  ];
  const state = defaultStateFixture();
  state.subscriptionsByMonth['2026-09'] = {
    items: [subscription('keep', { included: true, includeByDefault: true })],
  };
  state.subscriptionsByMonth['2026-10'] = {
    items: [subscription('keep', { included: false, includeByDefault: false })],
  };
  const { app } = createApp({ meta, state });
  await app.init();

  await app.deleteMonthData('2026-10');
  assert.equal(Object.hasOwn(app.state.subscriptionsByMonth, '2026-10'), false);
  assert.equal(app.navigateToMonth(2026, 10), true);
  assert.equal(app.state.subscriptionsByMonth['2026-10'].items[0].included, true);
  assert.equal(app.state.subscriptionsByMonth['2026-09'].items[0].included, true);
});

test('资产条目使用最近一年均值生成总额、现金率、存款率，并只写资产状态域', async () => {
  const { doc, app, requests } = createApp();
  await app.init();
  await app.loadAssetRates();

  app.addAsset('cash');
  let cash = doc.querySelector('#asset-cash-list .asset-row');
  const cashAmount = cash.querySelector('input[data-asset-field="amount"]');
  cashAmount.value = '1000';
  cashAmount.dispatchEvent({ type: 'change', bubbles: true, target: cashAmount });

  app.addAsset('term');
  let term = doc.querySelector('#asset-term-list .asset-row');
  const termCurrency = term.querySelector('select[data-asset-field="currency"]');
  termCurrency.value = 'USD';
  termCurrency.dispatchEvent({ type: 'change', bubbles: true, target: termCurrency });
  term = doc.querySelector('#asset-term-list .asset-row');
  const termAmount = term.querySelector('input[data-asset-field="amount"]');
  termAmount.value = '2000';
  termAmount.dispatchEvent({ type: 'change', bubbles: true, target: termAmount });

  const summary = app.assetSummary();
  assert.equal(summary.total, 15400);
  assert.equal(summary.cash, 1000);
  assert.equal(summary.term, 14400);
  assert.equal(summary.deposit, 15400);
  assert.equal(summary.investment, 14400);
  assert.equal(summary.complete, true);
  assert.match(doc.querySelector('#asset-current-total').textContent, /15,400\.00/);
  assert.equal(doc.querySelector('#asset-base-progress').textContent, '77.00%');
  assert.equal(doc.querySelector('#asset-cash-rate').textContent, '6.49%');
  assert.equal(doc.querySelector('#asset-deposit-rate').textContent, '100.00%');
  assert.equal(doc.querySelector('[data-asset-rate-output="USD"]').textContent, '7.200000');
  assert.match(doc.querySelector('#asset-rate-source-note').textContent, /HKD 250 个交易日，USD 250 个交易日/);
  assert.equal(doc.querySelectorAll('[data-asset-rate]').length, 0, '最近一年均值必须只读');
  const allocation = doc.querySelectorAll('#asset-currency-allocation .allocation-segment');
  assert.deepEqual(allocation.map((node) => node.getAttribute('data-allocation-currency')),
    ['CNY', 'HKD', 'USD']);
  const widths = allocation.map((node) => Number.parseFloat(node.getAttribute('style').match(/width:([\d.]+)%/)[1]));
  assert.ok(Math.abs(widths[0] - 6.4935) < 0.001);
  assert.equal(widths[1], 0);
  assert.ok(Math.abs(widths[2] - 93.5065) < 0.001);

  const baseValues = { CNY: '10000', HKD: '1000', USD: '1000' };
  for (const [currency, value] of Object.entries(baseValues)) {
    const baseInput = doc.querySelector(`[data-asset-base-currency="${currency}"]`);
    baseInput.value = value;
    baseInput.dispatchEvent({ type: 'change', bubbles: true, target: baseInput });
  }
  const rebased = app.assetSummary();
  assert.equal(rebased.baseTotal, 18120);
  assert.equal(rebased.baseComplete, true);
  assert.equal(doc.querySelector('#asset-base-progress').textContent, '84.99%');
  assert.match(doc.querySelector('#asset-base-note').textContent, /18,120\.00/);

  await wait(360);
  const writes = requests.filter((request) => request.url === '/api/state' && request.method === 'PUT');
  assert.ok(writes.length > 0);
  const payload = writes.at(-1).body;
  assert.ok(payload.assetPortfoliosById.current);
  assert.deepEqual(JSON.parse(JSON.stringify(payload.assetPortfoliosById.current.calculationBase)), {
    CNY: 10000, HKD: 1000, USD: 1000,
  });
  for (const field of ['year', 'month', 'overridesByMonth', 'subscriptionsByMonth',
    'annualBudgetsByYear', 'annualResultsByYear']) {
    assert.equal(Object.hasOwn(payload, field), false, `资产编辑不应夹带 ${field}`);
  }
});

test('最近一年外币均值缺失时明确标为不完整，且不使用旧手填值替代', async () => {
  const state = defaultStateFixture();
  state.assetPortfoliosById.current = {
    calculationBase: 20000,
    rates: { CNY: 1, HKD: 88, USD: 99 },
    items: [{
      id: 'usd-cash', kind: 'cash', location: '香港', name: '美元账户',
      purpose: 'reserve', currency: 'USD', amount: 100,
    }],
  };
  const { doc, app } = createApp({
    state,
    assetRates: {
      kind: 'trailing_365_day_close_average', window_days: 365,
      start_date: '2025-09-29', requested_through: '2026-09-28', observed_through: null,
      source: 'Yahoo Finance', price_field: 'Close', non_trading_days: 'excluded',
      stats: { HKD: { average: 0.92, observation_count: 250, first_date: '2025-09-29', last_date: '2026-09-25' } },
      errors: { USD: '测试：无可用行情' }, complete: false,
    },
  });
  await app.init();
  await app.loadAssetRates();

  const summary = app.assetSummary();
  assert.equal(summary.complete, false);
  assert.equal(summary.total, 0);
  assert.equal(doc.querySelector('#asset-base-progress').textContent, '待补汇率');
  assert.match(doc.querySelector('#asset-total-note').textContent, /USD 最近一年均值/);
  assert.equal(doc.querySelector('[data-asset-rate-output="USD"]').textContent, '不可用');
  assert.deepEqual(JSON.parse(JSON.stringify(summary.baseByCurrency)), { CNY: 20000, HKD: 0, USD: 0 },
    '旧数值计算基数应按纯 CNY 兼容读取');
});

test('外币计算基数缺少最近一年均值时只把相对基数标为待补汇率', async () => {
  const state = defaultStateFixture();
  state.assetPortfoliosById.current = {
    calculationBase: { CNY: 10000, HKD: 0, USD: 100 },
    rates: { CNY: 1, HKD: 88, USD: 99 },
    items: [{
      id: 'cny-cash', kind: 'cash', location: '深圳', name: '人民币账户',
      purpose: 'reserve', currency: 'CNY', amount: 100,
    }],
  };
  const { doc, app } = createApp({
    state,
    assetRates: {
      kind: 'trailing_365_day_close_average', window_days: 365,
      start_date: '2025-09-29', requested_through: '2026-09-28', observed_through: null,
      source: 'Yahoo Finance', price_field: 'Close', non_trading_days: 'excluded',
      stats: { HKD: { average: 0.92, observation_count: 250, first_date: '2025-09-29', last_date: '2026-09-25' } },
      errors: { USD: '测试：无可用行情' }, complete: false,
    },
  });
  await app.init();
  await app.loadAssetRates();

  const summary = app.assetSummary();
  assert.equal(summary.complete, true, '纯 CNY 资产总额仍然完整');
  assert.equal(summary.baseComplete, false);
  assert.equal(summary.total, 100);
  assert.equal(doc.querySelector('#asset-base-progress').textContent, '待补汇率');
  assert.match(doc.querySelector('#asset-base-note').textContent, /USD 汇率/);
  assert.match(doc.querySelector('#asset-total-note').textContent, /1 个资产条目/);
});
