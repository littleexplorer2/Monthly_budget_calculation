'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp, defaultStateFixture } = require('./helpers/dom-stub');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function ratePayload(value) {
  return {
    dates: ['2026-09-01'],
    series: { USD: [value] },
    stats: { USD: { start: value, end: value, avg: value, min: value, max: value } },
  };
}

test('统计面板只展示预算计算响应，不单独请求月度汇率', async () => {
  const { app, doc, requests } = createApp({
    monthlyRates: () => { throw new Error('不应调用独立月度汇率接口'); },
  });
  await app.init();

  app.openSection('dashboard');

  assert.equal(app.state.activeSection, 'dashboard');
  assert.equal(doc.querySelector('#tab-dashboard').classList.contains('active'), true);
  assert.equal(doc.querySelector('#tab-analysis').classList.contains('active'), true);
  doc.querySelector('.dashboard-nav-item[data-dashboard-tab="rates"]').click();
  assert.equal(app.state.activeDashboardTab, 'rates');
  assert.equal(doc.querySelector('#tab-analysis').classList.contains('active'), false);
  assert.equal(doc.querySelector('#tab-rates').classList.contains('active'), true);
  assert.equal(doc.querySelector('#rates-empty').hasAttribute('hidden'), false);
  assert.equal(requests.some((request) => request.url.includes('/api/rates?')), false);
  assert.equal(doc.querySelector('#btn-refresh-rates'), null);
});

test('月度计算期间切月后，响应仍保存到发起月份且不污染当前月份结果或汇率', async () => {
  const calculation = deferred();
  const initialState = defaultStateFixture();
  initialState.itineraryByMonth = {
    '2026-09': { Shenzhen: [{ start: '2026-09-01', end: '2026-09-02' }] },
  };
  const { app, doc, requests } = createApp({
    state: initialState,
    monthlyBudget: () => calculation.promise,
  });
  await app.init();
  const pending = app.calculate();
  app.changeMonth(1);
  calculation.resolve({
    summary: {
      '计算月份': '2026-09',
      '居住区域': 'Mainland',
      '总预算(人民币)': 321,
      '可变费用合计(人民币)': 321,
      '固定费用合计(人民币)': 0,
      '额外预算合计(人民币)': 0,
    },
    daily_details: [],
    fixed_details: [],
    extra_details: [],
    warnings: [],
    rates: ratePayload(7.19),
  });
  await pending;

  const calculateRequest = requests.find((request) => request.url.includes('/api/calculate'));
  assert.equal(calculateRequest.body.year, 2026);
  assert.equal(calculateRequest.body.month, 9);
  assert.equal(app.state.month, 10);
  assert.equal(app.state.resultsByMonth['2026-09'].summary['总预算(人民币)'], 321);
  assert.equal(app.state.resultsByMonth['2026-10'], undefined);
  assert.equal(app.state.calcResult, null, '当前十月不应展示九月返回的结果');
  assert.notEqual(app.state.ratesMonth, '2026-10', '九月计算附带汇率不应标成十月数据');
  assert.equal(doc.querySelector('#tab-result').classList.contains('active'), false,
    '切到十月后，九月响应不应强制跳转到结果页');

  const stateWrite = requests.filter((request) => (
    request.url.includes('/api/state') && request.method === 'PUT'
  )).at(-1);
  assert.equal(stateWrite.body.resultsByMonth['2026-09'].summary['总预算(人民币)'], 321);
  assert.equal(stateWrite.body.resultsByMonth['2026-10'], undefined);
});
