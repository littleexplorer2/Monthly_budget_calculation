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

test('较早月份的汇率成功响应不能覆盖新月份，且不能提前关闭新请求的 loading', async () => {
  const september = deferred();
  const october = deferred();
  const { app, doc } = createApp({
    monthlyRates: (request) => (
      request.url.includes('month=9') ? september.promise : october.promise
    ),
  });
  await app.init();

  app.state.year = 2026;
  app.state.month = 9;
  const oldRequest = app.loadRates();
  app.state.month = 10;
  const currentRequest = app.loadRates();

  september.resolve(ratePayload(7.01));
  await oldRequest;
  assert.equal(app.state.ratesData, null, '旧月份响应不应写入当前月份');
  assert.equal(doc.querySelector('#loading-overlay').hasAttribute('hidden'), false,
    '新月份请求仍在进行时，旧请求 finally 不应关闭 loading');

  october.resolve(ratePayload(7.22));
  await currentRequest;
  assert.equal(app.state.ratesMonth, '2026-10');
  assert.equal(app.state.ratesData.series.USD[0], 7.22);
  assert.equal(doc.querySelector('#loading-overlay').hasAttribute('hidden'), true);
});

test('较早月份的汇率失败响应不能清空新月份已经成功的数据', async () => {
  const september = deferred();
  const october = deferred();
  const { app, doc } = createApp({
    monthlyRates: (request) => (
      request.url.includes('month=9') ? september.promise : october.promise
    ),
  });
  await app.init();

  app.state.year = 2026;
  app.state.month = 9;
  const oldRequest = app.loadRates();
  app.state.month = 10;
  const currentRequest = app.loadRates();

  october.resolve(ratePayload(7.33));
  await currentRequest;
  september.reject(new Error('测试：旧月份请求失败'));
  await oldRequest;

  assert.equal(app.state.ratesMonth, '2026-10');
  assert.equal(app.state.ratesData.series.USD[0], 7.33);
  assert.equal(doc.querySelector('#toast').textContent.includes('旧月份请求失败'), false,
    '已过期失败不应向当前月份显示错误');
  assert.equal(doc.querySelector('#loading-overlay').hasAttribute('hidden'), true);
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
  app.state.standardsConfirmed = true;

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
