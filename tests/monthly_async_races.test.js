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

async function waitFor(predicate) {
  for (let i = 0; i < 50; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('等待异步请求超时');
}

test('统计面板已删除月度汇率走势分区和独立月度汇率请求', async () => {
  const { app, doc, requests } = createApp();
  await app.init();

  app.openSection('dashboard');

  assert.equal(app.state.activeSection, 'dashboard');
  assert.equal(doc.querySelector('#tab-dashboard').classList.contains('active'), true);
  assert.equal(doc.querySelector('#tab-analysis').classList.contains('active'), true);
  assert.equal(doc.querySelector('.dashboard-nav-item[data-dashboard-tab="rates"]'), null);
  assert.equal(doc.querySelector('#tab-rates'), null);
  assert.equal(requests.some((request) => request.url.includes('/api/rates?')), false);
  assert.deepEqual(
    doc.querySelectorAll('.dashboard-nav-item').map((node) => node.dataset.dashboardTab),
    ['analysis', 'assets'],
  );
});

test('月度计算期间切月后，响应仍保存到发起月份且不污染当前月份结果', async () => {
  const calculation = deferred();
  const initialState = { version: 1, year: 2026, month: 9, itineraryByMonth: {
    '2026-09': { Shenzhen: [{ start: '2026-09-01', end: '2026-09-02' }] },
  } };
  const { app, doc, requests } = createApp({
    state: initialState,
    monthlyBudget: () => calculation.promise,
  });
  await app.init();
  const pending = app.calculate();
  await waitFor(() => requests.some((request) => request.url.endsWith('/calculate')));
  await app.changeMonth(1);
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
  });
  await pending;

  const calculateRequest = requests.find((request) => request.url.endsWith('/calculate'));
  assert.equal(calculateRequest.url, '/api/months/2026-09/calculate');
  assert.equal(calculateRequest.body.base_revision, 1);
  assert.equal(app.state.month, 10);
  assert.equal(app.state.monthsByKey['2026-09'].result.summary['总预算(人民币)'], 321);
  assert.equal(app.state.monthsByKey['2026-10'].result, null);
  assert.equal(app.state.calcResult, null, '当前十月不应展示九月返回的结果');
  assert.equal(doc.querySelector('#tab-result').classList.contains('active'), false,
    '切到十月后，九月响应不应强制跳转到结果页');

  assert.equal(requests.some((request) => (
    request.url === '/api/months/2026-09' && request.method === 'PUT'
      && request.body.data.result
  )), false, '计算结果只由 calculate-and-save 端点落盘');
});

test('月度计算期间输入发生变化时，后端 revision CAS 拒绝保存旧结果', async () => {
  const calculation = deferred();
  const initialState = { version: 1, year: 2026, month: 9, itineraryByMonth: {
    '2026-09': { Shenzhen: [{ start: '2026-09-01', end: '2026-09-02' }] },
  } };
  const { app, requests } = createApp({
    state: initialState,
    monthlyBudget: () => calculation.promise,
  });
  await app.init();
  const pending = app.calculate();
  await waitFor(() => requests.some((request) => request.url.endsWith('/calculate')));
  app.state.region = 'Overseas';
  await app.saveMonthlyState();
  calculation.resolve({
    summary: {
      '计算月份': '2026-09',
      '居住区域': 'Mainland',
      '总预算(人民币)': 123,
      '可变费用合计(人民币)': 123,
      '固定费用合计(人民币)': 0,
      '额外预算合计(人民币)': 0,
    },
    daily_details: [], fixed_details: [], extra_details: [], warnings: [],
  });
  assert.equal(await pending, false);

  const saved = app.state.monthsByKey['2026-09'];
  assert.equal(saved.options.region, 'Overseas');
  assert.equal(saved.result, null);
});
