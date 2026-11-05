'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createApp, defaultMetaFixture } = require('./helpers/dom-stub.js');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 旧聚合状态只作为测试输入交给夹具中的一次性 v1 -> v2 适配器；应用初始化后
// 所有断言均读取正式的 monthsByKey/global v2 实体，避免把兼容结构带回生产运行时。
function defaultStateFixture() {
  return {
    version: 1,
    year: 2026,
    month: 9,
    itineraryByMonth: {},
    optionsByMonth: {},
    overridesByMonth: {},
    resultsByMonth: {},
    subscriptionsByMonth: {},
    annualBudgetsByYear: {},
    annualResultsByYear: {},
    assetPortfoliosById: {},
  };
}

function monthEntity(app, key = '2026-09') {
  return app.state.monthsByKey[key];
}

function subscription(id, overrides = {}) {
  return {
    id,
    name: id,
    currency: 'USD',
    cycle: 'monthly',
    amount: 10,
    included: true,
    includeByDefault: true,
    appliesTo: { Mainland: true, Overseas: true },
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
  assert.equal(Object.hasOwn(monthEntity(app).standards, 'fixed'), false);
  assert.equal(Object.hasOwn(monthEntity(app).standards, 'extra'), false);
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
  assert.equal(monthEntity(app).subscriptions.items[0].name, '年度会员');

  const amount = doc.querySelector('[data-subscription-id="annual"] input[data-subscription-field="amount"]');
  amount.value = '2400';
  amount.dispatchEvent({ type: 'input', bubbles: true, target: amount });
  assert.equal(app.state.standards.fixed.Mainland.HKD, 200);

  await wait(360);
  const writes = requests.filter((request) => request.url === '/api/months/2026-09' && request.method === 'PUT');
  assert.ok(writes.length > 0);
  const saved = writes.at(-1).body.data.subscriptions.items[0];
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
  assert.equal(await app.navigateToMonth(2026, 10), true);

  const october = monthEntity(app, '2026-10').subscriptions;
  assert.deepEqual(JSON.parse(JSON.stringify(october.items.map((item) => [item.id, item.included]))), [
    ['keep', true],
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(october.retiredIds)), ['skip']);

  const keep = doc.querySelector('[data-subscription-id="keep"] input[data-subscription-field="included"]');
  keep.checked = false;
  keep.dispatchEvent({ type: 'change', bubbles: true, target: keep });

  assert.equal(monthEntity(app, '2026-10').subscriptions.items[0].included, false);
  assert.equal(monthEntity(app).subscriptions.items[0].included, false,
    '九月原快照应保持原来的未勾选值');
  assert.equal(monthEntity(app).subscriptions.items[1].included, true,
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
  assert.ok(keep, '旧月份中仍计入默认的项目应进入默认配置草稿');
  assert.equal(skip, null, '未计入默认的项目不应显示在默认预算标准中');
  assert.equal(keep.checked, true);
  assert.equal(app.state.defaultsDraft.subscriptions.length, 2,
    '隐藏的非默认项目仍留在草稿中，保存时不会误改历史快照');

  assert.equal(await app.navigateToMonth(2026, 10), true);
  assert.deepEqual(JSON.parse(JSON.stringify(monthEntity(app, '2026-10').subscriptions.items.map((item) => (
    [item.id, item.included]
  )))), [['keep', true]], '未计入默认的项目应从新月份消失');
  assert.deepEqual(JSON.parse(JSON.stringify(monthEntity(app, '2026-10').subscriptions.retiredIds)), ['skip']);
});

test('本月条目把计入默认与计入当月预算拆开，两个状态互不代替', async () => {
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

  const row = doc.querySelector('[data-subscription-id="keep"]');
  const includeByDefault = row.querySelector('input[data-subscription-field="includeByDefault"]');
  const included = row.querySelector('input[data-subscription-field="included"]');
  assert.ok(includeByDefault && included, '每张本月订阅卡必须同时提供两个独立勾选框');
  assert.match(row.textContent, /计入默认/);
  assert.match(row.textContent, /计入当月预算/);
  assert.equal(includeByDefault.checked, false);
  assert.equal(included.checked, false);

  included.checked = true;
  included.dispatchEvent({ type: 'change', bubbles: true, target: included });
  assert.equal(monthEntity(app).subscriptions.items[0].included, true);
  assert.equal(monthEntity(app).subscriptions.items[0].includeByDefault, false,
    '计入当月预算不得改写下月默认状态');

  const rerenderedDefault = doc.querySelector(
    '[data-subscription-id="keep"] input[data-subscription-field="includeByDefault"]',
  );
  rerenderedDefault.checked = true;
  rerenderedDefault.dispatchEvent({ type: 'change', bubbles: true, target: rerenderedDefault });
  assert.equal(monthEntity(app).subscriptions.items[0].included, true);
  assert.equal(monthEntity(app).subscriptions.items[0].includeByDefault, true,
    '计入默认不得取消当前月预算勾选');

  doc.querySelector('#btn-defaults-modal').click();
  const defaultCheckbox = doc.querySelector(
    '[data-default-subscription-id="keep"] input[data-default-subscription-field="includeByDefault"]',
  );
  assert.ok(defaultCheckbox, '默认勾选框应位于默认配置弹窗的订阅管理部分');
  assert.ok(doc.querySelector('.defaults-budget-section'));
  assert.ok(doc.querySelector('.defaults-subscriptions-section'));
  const defaultsBudget = doc.querySelector('.defaults-budget-section');
  assert.doesNotMatch(defaultsBudget.textContent,
    /维护各地点的每日固定预算与旅居标准|各地点 \/ 币种每日固定预算|原可变预算|每日预算 × 旅游天数/);
  const addSettlement = defaultsBudget.querySelector('[data-action="add-std"][data-cat="variable"]');
  assert.ok(addSettlement.closest('.defaults-section-head'), '新建定居地点按钮应与主标题位于同一行');

  assert.equal(await app.navigateToMonth(2026, 10), true);
  assert.deepEqual(JSON.parse(JSON.stringify(monthEntity(app, '2026-10').subscriptions.items.map((item) => (
    [item.id, item.name, item.amount, item.included]
  )))), [
    ['keep', '保留项目', 20, true],
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(monthEntity(app, '2026-10').subscriptions.retiredIds)), ['skip']);
  assert.equal(monthEntity(app).subscriptions.items[0].included, true,
    '创建十月不能回写九月已经单独勾选的当月状态');
  assert.equal(monthEntity(app).subscriptions.items[0].amount, 10,
    '九月单独金额必须保留，十月应重新使用默认目录中的 20');
});

test('永久取消只清理后续月份并用墓碑阻止默认目录重新加入，过去月份保持原样', async () => {
  const meta = defaultMetaFixture();
  meta.default_subscriptions_configured = true;
  meta.default_subscriptions = [
    { id: 'cancelled', name: '已取消服务', currency: 'USD', cycle: 'monthly', amount: 20, includeByDefault: true },
  ];
  const state = defaultStateFixture();
  state.subscriptionsByMonth['2026-08'] = {
    items: [subscription('cancelled', { amount: 8 })],
  };
  state.subscriptionsByMonth['2026-09'] = {
    items: [subscription('cancelled', { amount: 9, included: true })],
  };
  state.subscriptionsByMonth['2026-10'] = {
    items: [subscription('cancelled', { amount: 10 })],
  };
  state.subscriptionsByMonth['2026-11'] = {
    items: [subscription('cancelled', { amount: 11 })],
  };
  const { doc, app } = createApp({ meta, state });
  await app.init();

  const checkbox = doc.querySelector(
    '[data-subscription-id="cancelled"] input[data-subscription-field="includeByDefault"]',
  );
  checkbox.checked = false;
  checkbox.dispatchEvent({ type: 'change', bubbles: true, target: checkbox });

  assert.equal(monthEntity(app, '2026-08').subscriptions.items[0].amount, 8);
  assert.equal(monthEntity(app).subscriptions.items[0].amount, 9);
  assert.equal(monthEntity(app).subscriptions.items[0].includeByDefault, false);
  for (const month of ['2026-10', '2026-11']) {
    assert.equal(monthEntity(app, month).subscriptions.items.length, 0, `${month} 不应再保留已取消项目`);
    assert.deepEqual(JSON.parse(JSON.stringify(monthEntity(app, month).subscriptions.retiredIds)), ['cancelled']);
  }

  assert.equal(await app.navigateToMonth(2026, 12), true);
  assert.equal(monthEntity(app, '2026-12').subscriptions.items.length, 0,
    '默认目录仍有同 ID 项目时，取消墓碑也必须阻止十二月重新加入');
  assert.deepEqual(JSON.parse(JSON.stringify(monthEntity(app, '2026-12').subscriptions.retiredIds)), ['cancelled']);

  doc.querySelector('#btn-defaults-modal').click();
  assert.equal(doc.querySelector('[data-default-subscription-id="cancelled"]'), null,
    '永久取消的项目不应再显示在默认预算标准中');
});

test('已从默认目录移除的幽灵订阅不会继续传播到新月份', async () => {
  const meta = defaultMetaFixture();
  meta.default_subscriptions_configured = true;
  meta.default_subscriptions = [
    { id: 'active', name: '当前目录项目', currency: 'CNY', cycle: 'monthly', amount: 10, includeByDefault: true },
  ];
  const state = defaultStateFixture();
  state.subscriptionsByMonth['2026-09'] = {
    items: [subscription('ghost', { name: '已删除目录项目', includeByDefault: true })],
    retiredIds: [],
  };
  const { app } = createApp({ meta, state });
  await app.init();

  assert.equal(await app.navigateToMonth(2026, 10), true);
  const october = monthEntity(app, '2026-10').subscriptions;
  assert.deepEqual(JSON.parse(JSON.stringify(october.items.map((item) => item.id))), ['active']);
  assert.deepEqual(JSON.parse(JSON.stringify(october.retiredIds)), ['ghost']);
});

test('三种币种各自新增本月订阅，卡片内不提供改币种下拉框', async () => {
  const { doc, app } = createApp();
  await app.init();

  assert.equal(doc.querySelector('#btn-add-subscription'), null,
    '不应保留会默认写入 CNY 的全局新增按钮');
  const buttons = doc.querySelectorAll('#subscription-list [data-action="add-subscription"]');
  assert.equal(buttons.length, 3);

  const hkdButton = doc.querySelector(
    '[data-subscription-currency="HKD"] [data-action="add-subscription"]',
  );
  hkdButton.click();
  const snapshot = monthEntity(app).subscriptions;
  assert.equal(snapshot.items.length, 1);
  assert.equal(snapshot.items[0].currency, 'HKD');
  const row = doc.querySelector(`[data-subscription-id="${snapshot.items[0].id}"]`);
  assert.equal(row.closest('[data-subscription-currency="HKD"]') !== null, true);
  assert.equal(row.querySelector('select[data-subscription-field="currency"]'), null);
  assert.equal(doc.querySelectorAll('#subscription-list select[data-subscription-field="currency"]').length, 0);
});

test('订阅地点下拉独立控制内地与海外显示和固定预算汇总', async () => {
  const state = defaultStateFixture();
  state.optionsByMonth['2026-09'] = {
    region: 'Mainland', includeTravel: false, travelSelected: null,
  };
  state.subscriptionsByMonth['2026-09'] = {
    items: [
      subscription('mainland', {
        currency: 'CNY', amount: 10,
        appliesTo: { Mainland: true, Overseas: false },
      }),
      subscription('overseas', {
        currency: 'CNY', amount: 20,
        appliesTo: { Mainland: false, Overseas: true },
      }),
      subscription('both', { currency: 'CNY', amount: 5 }),
    ],
  };
  const { doc, app } = createApp({ state });
  await app.init();

  assert.ok(doc.querySelector('[data-subscription-id="mainland"]'));
  assert.equal(doc.querySelector('[data-subscription-id="overseas"]'), null);
  const both = doc.querySelector('[data-subscription-id="both"]');
  assert.ok(both.querySelector('details.subscription-region-picker'));
  const bothRegionToggles = both.querySelectorAll('input[data-subscription-field="appliesTo"]');
  assert.equal(bothRegionToggles.length, 2);
  assert.ok(bothRegionToggles.every((input) => input.checked));
  assert.deepEqual(JSON.parse(JSON.stringify(app.subscriptionTotals())), { CNY: 15, HKD: 0, USD: 0 });
  assert.equal(app.state.standards.fixed.Mainland.CNY, 15);
  assert.equal(app.state.standards.fixed.Overseas.CNY, 25);

  const overseasToggle = both.querySelector('input[data-region="Overseas"]');
  overseasToggle.checked = false;
  overseasToggle.dispatchEvent({ type: 'change', bubbles: true, target: overseasToggle });
  assert.deepEqual(
    JSON.parse(JSON.stringify(monthEntity(app).subscriptions.items[2].appliesTo)),
    { Mainland: true, Overseas: false },
  );
  assert.equal(app.state.standards.fixed.Overseas.CNY, 20);

  doc.querySelector('#region-seg .seg-btn[data-region="Overseas"]').click();
  assert.equal(doc.querySelector('[data-subscription-id="mainland"]'), null);
  assert.equal(doc.querySelector('[data-subscription-id="both"]'), null);
  assert.ok(doc.querySelector('[data-subscription-id="overseas"]'));
  assert.deepEqual(JSON.parse(JSON.stringify(app.subscriptionTotals())), { CNY: 20, HKD: 0, USD: 0 });
});

test('订阅地点至少保留一个，避免卡片在两个预算区域都不可访问', async () => {
  const state = defaultStateFixture();
  state.subscriptionsByMonth['2026-09'] = {
    items: [subscription('mainland-only', {
      appliesTo: { Mainland: true, Overseas: false },
    })],
  };
  const { doc, app } = createApp({ state });
  await app.init();

  const toggle = doc.querySelector(
    '[data-subscription-id="mainland-only"] input[data-region="Mainland"]',
  );
  toggle.checked = false;
  toggle.dispatchEvent({ type: 'change', bubbles: true, target: toggle });
  assert.equal(toggle.checked, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(monthEntity(app).subscriptions.items[0].appliesTo)),
    { Mainland: true, Overseas: false },
  );
});

test('默认订阅卡片的地点下拉兼容旧数据并让新卡片默认勾选两个区域', async () => {
  const meta = defaultMetaFixture();
  meta.default_subscriptions_configured = true;
  meta.default_subscriptions = [{
    id: 'legacy-default', name: '旧默认项目', currency: 'CNY', cycle: 'monthly',
    amount: 8, includeByDefault: true,
  }];
  const { doc, app } = createApp({ meta });
  await app.init();

  doc.querySelector('#btn-defaults-modal').click();
  const legacy = doc.querySelector('[data-default-subscription-id="legacy-default"]');
  assert.match(legacy.textContent, /对内地预算使用/);
  assert.match(legacy.textContent, /对海外预算使用/);
  assert.ok(legacy.querySelectorAll(
    'input[data-default-subscription-field="appliesTo"]',
  ).every((input) => input.checked));

  doc.querySelector('[data-action="add-default-subscription"]').click();
  const created = app.state.defaultsDraft.subscriptions.at(-1);
  assert.deepEqual(
    JSON.parse(JSON.stringify(created.appliesTo)),
    { Mainland: true, Overseas: true },
  );
  const createdToggles = doc.querySelectorAll(
    `[data-default-subscription-id="${created.id}"] input[data-default-subscription-field="appliesTo"]`,
  );
  assert.equal(createdToggles.length, 2);
  assert.ok(createdToggles.every((input) => input.checked));
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
  assert.equal(Object.hasOwn(app.state.monthsByKey, '2026-10'), false);
  assert.equal(await app.navigateToMonth(2026, 10), true);
  assert.equal(monthEntity(app, '2026-10').subscriptions.items[0].included, true);
  assert.equal(monthEntity(app).subscriptions.items[0].included, true);
});

test('资产条目使用最近一年均值生成总额、现金率、存款率，并只写全局实体', async () => {
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
  const writes = requests.filter((request) => request.url === '/api/global' && request.method === 'PUT');
  assert.ok(writes.length > 0);
  const payload = writes.at(-1).body.data;
  assert.ok(payload.assetPortfoliosById.current);
  assert.deepEqual(JSON.parse(JSON.stringify(payload.assetPortfoliosById.current.calculationBase)), {
    CNY: 10000, HKD: 1000, USD: 1000,
  });
  for (const field of ['year', 'month', 'itinerary', 'options', 'standards', 'subscriptions', 'result']) {
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
