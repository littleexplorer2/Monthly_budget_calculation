'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createApp, defaultStateFixture } = require('./helpers/dom-stub.js');

function currentMonthState() {
  const now = new Date();
  const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  return {
    ...defaultStateFixture(),
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    itineraryByMonth: {
      [key]: { Shenzhen: [{ start: `${key}-01`, end: `${key}-02` }] },
    },
    optionsByMonth: {
      [key]: { region: 'Mainland', includeTravel: false, travelSelected: null },
    },
    annualBudgetsByYear: {
      [String(now.getFullYear())]: { CNY: 1000, HKD: 200, USD: 300, THB: 999 },
    },
  };
}

test('启动时自动更新年度与有行程的月度预算，且不要求确认标准或切换页签', async () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const { doc, app, requests } = createApp({
    autoCalculations: true,
    state: currentMonthState(),
    annualRates: {
      year,
      start_date: `${year}-01-01`,
      requested_through: `${year}-11-01`,
      observed_through: `${year}-10-30`,
      stats: {
        CNY: { average: 1, observation_count: 1 },
        HKD: { average: 0.92, observation_count: 210 },
        USD: { average: 7.1, observation_count: 210 },
      },
      errors: {}, complete: true,
    },
    annualBudget: ({ body }) => ({
      year: body.year,
      start_date: `${year}-01-01`,
      requested_through: `${year}-11-01`,
      observed_through: `${year}-10-30`,
      summary: { '全年预算合计(人民币)': 3314 },
      details: Object.entries(body.amounts).map(([currency, amount]) => ({
        currency, amount, average_rate: currency === 'CNY' ? 1 : (currency === 'HKD' ? 0.92 : 7.1),
        observation_count: currency === 'CNY' ? 1 : 210,
        cny_amount: currency === 'CNY' ? amount : amount * (currency === 'HKD' ? 0.92 : 7.1),
      })),
      errors: {},
    }),
    monthlyBudget: {
      summary: {
        '可变费用合计(人民币)': 200,
        '固定费用合计(人民币)': 100,
        '额外预算合计(人民币)': 0,
        '总预算(人民币)': 300,
      },
      daily_details: [], fixed_details: [], extra_details: [], warnings: [],
    },
  });

  await app.init();

  const annual = requests.find((item) => item.url === '/api/annual-budget');
  const monthly = requests.find((item) => item.url === '/api/calculate');
  assert.ok(requests.some((item) => item.url.startsWith('/api/annual-rates?')));
  assert.ok(annual, '启动时应自动计算全年预算');
  assert.deepEqual(Object.keys(annual.body.amounts).sort(), ['CNY', 'HKD', 'USD']);
  assert.equal('THB' in annual.body.amounts, false, '旧年度数据中的其它币种不得继续参与计算');
  assert.ok(monthly, '当前月已有行程时应自动计算月度预算');
  assert.equal(doc.querySelector('#chk-standards-confirmed'), null, '界面不再提供确认标准门禁');
  assert.equal(app.state.activeSection, 'budget');
  assert.equal(app.state.activeBudgetTab, 'standards', '自动更新不能强制跳到结果页');
  app.openSection('dashboard');
  assert.equal(doc.querySelector('.dashboard-nav-item[data-dashboard-tab="rates"]'), null);
  assert.equal(doc.querySelector('#tab-rates'), null);
  assert.equal(Object.prototype.hasOwnProperty.call(app.state, 'ratesData'), false);
});

test('各月比较不再渲染独立表格，完整月份数据只在折线图提示框显示', async () => {
  const state = currentMonthState();
  state.resultsByMonth = {
    '2026-03': {
      summary: { '总预算(人民币)': 4335.81 }, region: 'Overseas', includeTravel: true,
    },
  };
  state.optionsByMonth = {
    ...state.optionsByMonth,
    '2026-03': { region: 'Overseas', includeTravel: true },
  };
  const { doc, app } = createApp({ state });
  await app.init();
  app.openSection('dashboard');

  assert.equal(doc.querySelector('#analysis-data-table'), null);
  const chart = doc.querySelector('#analysis-chart');
  const tooltip = chart.__chartOption.tooltip.formatter([{ dataIndex: 0 }]);
  assert.match(tooltip, /2026年03月/);
  assert.match(tooltip, /4,335\.81/);
  assert.match(tooltip, /境外/);
  assert.match(tooltip, /含旅居/);
});

test('启动时没有行程的空月份不会被自动计算或静默创建', async () => {
  const now = new Date();
  const state = {
    ...defaultStateFixture(),
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    itineraryByMonth: {},
    optionsByMonth: {},
    overridesByMonth: {},
    resultsByMonth: {},
  };
  const { app, requests } = createApp({ autoCalculations: true, state });

  await app.init();

  assert.equal(requests.some((item) => item.url === '/api/calculate'), false);
  assert.equal(Object.keys(app.state.itineraryByMonth).length, 0);
  assert.equal(Object.keys(app.state.optionsByMonth).length, 0);
  assert.equal(Object.keys(app.state.overridesByMonth).length, 0);
  assert.equal(Object.keys(app.state.resultsByMonth).length, 0);
});
