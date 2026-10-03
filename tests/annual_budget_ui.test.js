'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createApp } = require('./helpers/dom-stub.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, message) {
  for (let i = 0; i < 50; i++) {
    if (predicate()) return;
    await sleep(5);
  }
  assert.fail(message);
}

function annualRatesFixture(year) {
  return {
    year,
    start_date: `${year}-01-01`,
    requested_through: `${year}-09-28`,
    observed_through: `${year}-09-25`,
    source: 'Yahoo Finance',
    price_field: 'Close',
    non_trading_days: 'excluded',
    stats: {
      CNY: { average: 1, observation_count: 190, first_date: `${year}-01-02`, last_date: `${year}-09-25` },
      HKD: { average: 0.912345, observation_count: 188, first_date: `${year}-01-02`, last_date: `${year}-09-25` },
      USD: { average: 7.123456, observation_count: 187, first_date: `${year}-01-02`, last_date: `${year}-09-25` },
      TWD: { average: 0.223344, observation_count: 186, first_date: `${year}-01-02`, last_date: `${year}-09-25` },
      THB: { average: 0.201234, observation_count: 185, first_date: `${year}-01-02`, last_date: `${year}-09-25` },
    },
    errors: {},
    complete: true,
  };
}

function annualRow(doc, currency) {
  return doc.querySelector(`#annual-budget-rows tr[data-annual-row="${currency}"]`);
}

function annualInput(doc, currency) {
  return doc.querySelector(`#annual-budget-rows input[data-annual-currency="${currency}"]`);
}

async function initializedApp(options = {}) {
  const created = createApp(options);
  await created.app.init();
  await sleep(20);
  return created;
}

test('全年行情展示实际 Close 年平均、观测日数量和覆盖日期', async () => {
  const year = new Date().getFullYear();
  const fixture = annualRatesFixture(year);
  const { doc, app, requests } = await initializedApp({ annualRates: fixture });

  app.state.annualYear = year;
  app.renderAnnualBudget();
  const yearOptions = doc.querySelectorAll('#annual-year option').map((option) => option.getAttribute('value'));
  assert.ok(yearOptions.includes(String(year - 1)), '全新状态也应允许首次创建历史年度预算');
  assert.ok(yearOptions.includes('2000'), '年份选择范围应与后端支持下限一致');
  await app.loadAnnualRates();

  const usd = annualRow(doc, 'USD');
  assert.ok(usd, '应按后端币种注册表渲染 USD 行');
  assert.equal(usd.querySelector('[data-annual-rate]').textContent, '7.123456');
  assert.match(usd.textContent, /187 日/, '应显示实际 Close 观测数，不应补齐非交易日');
  assert.match(doc.querySelector('#annual-budget-range').textContent, new RegExp(`${year}-01-01`));
  assert.match(doc.querySelector('#annual-budget-range').textContent, new RegExp(`${year}-09-25`));
  assert.match(doc.querySelector('#annual-budget-note').textContent, /Close/);

  const request = requests.find((item) => item.url.startsWith('/api/annual-rates?'));
  assert.ok(request, '应请求年度收盘汇率接口');
  assert.equal(request.method, 'GET');
  assert.match(request.url, new RegExp(`year=${year}`));
  assert.match(decodeURIComponent(request.url), /currencies=CNY,HKD,THB,TWD,USD/);
});

test('全年金额输入不重建节点、不丢焦点，并使旧结果失效', async () => {
  const year = new Date().getFullYear();
  const { doc, app, requests } = await initializedApp({ annualRates: annualRatesFixture(year) });
  app.state.annualYear = year;
  app.state.annualResultsByYear[String(year)] = {
    summary: { '全年预算合计(人民币)': 100 },
    details: [{ currency: 'USD', amount: 10, average_rate: 7.123456, cny_amount: 71.23 }],
  };
  app.renderAnnualBudget();
  await app.loadAnnualRates();

  const input = annualInput(doc, 'USD');
  assert.ok(input);
  input.focus();
  let typed = '';
  for (const digit of '2500') {
    typed += digit;
    input.value = typed;
    input.dispatchEvent({ type: 'input', bubbles: true, target: input });
    assert.equal(annualInput(doc, 'USD'), input, '输入过程不得替换输入框节点');
    assert.equal(doc.activeElement, input, '输入过程必须保持焦点');
  }

  assert.equal(app.state.annualBudgetsByYear[String(year)].USD, 2500);
  assert.equal(app.state.annualResultsByYear[String(year)].stale, true,
    '金额修改后应保留可持久化的过期标记，避免空映射合并时旧结果复活');
  assert.equal(doc.querySelector('#annual-budget-status').textContent, '待重新计算');
  assert.equal(doc.querySelector('#annual-budget-total').textContent, '¥ —');

  await sleep(350);
  const stateWrite = [...requests].reverse()
    .find((item) => item.url === '/api/state' && item.method === 'PUT');
  assert.ok(stateWrite, '输入变更应触发统一状态 PUT');
  assert.equal(stateWrite.body.annualResultsByYear[String(year)].stale, true,
    '过期标记必须进入统一状态 PUT，而不是发送无法表达删除的空映射');
  const roundTrip = JSON.parse(JSON.stringify(app.snapshotBundle()));
  app.applyBundle(roundTrip);
  app.state.annualYear = year;
  app.renderAnnualBudget();
  assert.equal(doc.querySelector('#annual-budget-total').textContent, '¥ —', '重载后不得恢复旧总额');
});

test('POST 计算后渲染总额，并通过唯一 state PUT 保存紧凑年度状态', async () => {
  const year = new Date().getFullYear();
  const averages = { CNY: 1, HKD: 0.912345, USD: 7.123456, TWD: 0.223344, THB: 0.201234 };
  const { doc, app, requests } = await initializedApp({
    annualRates: annualRatesFixture(year),
    annualBudget: ({ body }) => {
      const details = Object.entries(body.amounts).sort().map(([currency, amount]) => ({
        currency,
        amount,
        average_rate: averages[currency],
        cny_amount: Math.round(amount * averages[currency] * 100) / 100,
      }));
      const total = details.reduce((sum, row) => sum + row.cny_amount, 0);
      return {
        year: body.year,
        start_date: `${year}-01-01`,
        requested_through: `${year}-09-28`,
        observed_through: `${year}-09-25`,
        summary: { '全年预算合计(人民币)': Math.round(total * 100) / 100 },
        details,
        errors: {},
        series: { USD: [7.1, 7.2] },
        rates: { USD: [7.1, 7.2] },
      };
    },
  });

  app.state.annualYear = year;
  app.renderAnnualBudget();
  await app.loadAnnualRates();

  const cny = annualInput(doc, 'CNY');
  const usd = annualInput(doc, 'USD');
  cny.value = '1000';
  cny.dispatchEvent({ type: 'input', bubbles: true, target: cny });
  usd.value = '1000';
  usd.dispatchEvent({ type: 'input', bubbles: true, target: usd });

  await app.calculateAnnualBudget();

  const calculateRequest = requests.find((item) => item.url === '/api/annual-budget');
  assert.ok(calculateRequest);
  assert.equal(calculateRequest.method, 'POST');
  assert.equal(calculateRequest.body.year, year);
  assert.equal(calculateRequest.body.amounts.CNY, 1000);
  assert.equal(calculateRequest.body.amounts.USD, 1000);
  assert.equal(calculateRequest.body.amounts.HKD, 0, '未填写币种应以 0 参与规范化请求');

  assert.equal(doc.querySelector('#annual-budget-total').textContent, '¥ 8,123.46');
  assert.equal(annualRow(doc, 'USD').querySelector('[data-annual-cny]').textContent, '¥ 7,123.46');
  assert.equal(app.state.annualBudgetsByYear[String(year)].USD, 1000);
  assert.equal(app.state.annualResultsByYear[String(year)].summary['全年预算合计(人民币)'], 8123.46);
  assert.equal('series' in app.state.annualResultsByYear[String(year)], false, '原始行情不得进状态');
  assert.equal('rates' in app.state.annualResultsByYear[String(year)], false, '原始汇率不得进状态');

  const stateWrites = requests.filter((item) => item.url === '/api/state' && item.method === 'PUT');
  assert.equal(stateWrites.length, 1, '显式计算应只产生一次最终状态 PUT');
  const saved = stateWrites[0].body;
  assert.equal(saved.annualBudgetsByYear[String(year)].USD, 1000);
  assert.equal(saved.annualResultsByYear[String(year)].summary['全年预算合计(人民币)'], 8123.46);
  assert.equal('series' in saved.annualResultsByYear[String(year)], false);
  assert.equal('rates' in saved.annualResultsByYear[String(year)], false);
  for (const field of ['year', 'month', 'itineraryByMonth', 'optionsByMonth',
    'overridesByMonth', 'resultsByMonth']) {
    assert.equal(field in saved, false, `纯年度保存不应夹带月度字段 ${field}`);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(app.snapshotBundle().annualBudgetsByYear[String(year)])), saved.annualBudgetsByYear[String(year)]);
});

test('切换年份时会发起新行情请求，且在途的旧年响应不得覆盖新年', async () => {
  const currentYear = new Date().getFullYear();
  const nextYear = currentYear - 1;
  const resolvers = new Map();
  const { doc, app, requests } = await initializedApp({
    annualRates: (request) => new Promise((resolve) => {
      const year = Number(new URL(`http://test${request.url}`).searchParams.get('year'));
      resolvers.set(year, resolve);
    }),
  });

  app.state.annualYear = currentYear;
  app.state.annualBudgetsByYear[String(nextYear)] = { USD: 0 };
  app.renderAnnualBudget();
  const oldRequest = app.loadAnnualRates();
  await waitFor(() => resolvers.has(currentYear), '当前年行情请求未发出');

  const yearSelect = doc.querySelector('#annual-year');
  yearSelect.value = String(nextYear);
  yearSelect.dispatchEvent({ type: 'change', bubbles: true, target: yearSelect });
  await waitFor(() => resolvers.has(nextYear), '切年后未发出新年份行情请求');

  resolvers.get(currentYear)(annualRatesFixture(currentYear));
  await oldRequest;
  assert.notEqual(app.state.annualRatesYear, String(currentYear), '旧年响应不得在切年后回填');
  assert.equal(app.state.annualYear, nextYear);
  assert.equal(app.state.annualLoading, true, '新年请求未完成时仍应保持加载状态');

  const newFixture = annualRatesFixture(nextYear);
  newFixture.stats.USD.average = 6.54321;
  resolvers.get(nextYear)(newFixture);
  await waitFor(() => !app.state.annualLoading, '新年行情请求未完成');

  assert.equal(app.state.annualRatesYear, String(nextYear));
  assert.equal(app.state.annualRatesData.year, nextYear);
  assert.equal(annualRow(doc, 'USD').querySelector('[data-annual-rate]').textContent, '6.543210');
  const rateRequests = requests.filter((item) => item.url.startsWith('/api/annual-rates?'));
  assert.equal(rateRequests.length, 2);
  assert.match(rateRequests[0].url, new RegExp(`year=${currentYear}`));
  assert.match(rateRequests[1].url, new RegExp(`year=${nextYear}`));
});

test('已计算总额始终显示计算快照汇率，手动刷新后结果会持久化为待重算', async () => {
  const year = new Date().getFullYear();
  const fixture = annualRatesFixture(year);
  const { doc, app, requests } = await initializedApp({ annualRates: fixture });
  app.state.annualYear = year;
  app.state.annualResultsByYear[String(year)] = {
    year,
    start_date: fixture.start_date,
    requested_through: fixture.requested_through,
    observed_through: fixture.observed_through,
    summary: { '全年预算合计(人民币)': 700 },
    details: [{
      currency: 'USD', amount: 100, average_rate: 7,
      observation_count: 180, first_date: `${year}-01-02`,
      last_date: fixture.observed_through, cny_amount: 700,
    }],
    errors: {},
  };
  app.state.annualRatesData = fixture;
  app.state.annualRatesYear = String(year);
  app.renderAnnualBudget();

  assert.equal(annualRow(doc, 'USD').querySelector('[data-annual-rate]').textContent, '7.000000',
    '有效总额旁必须展示生成该总额时的汇率，而不是后来加载的行情');
  assert.equal(doc.querySelector('#annual-budget-total').textContent, '¥ 700.00');

  await app.loadAnnualRates(true);
  assert.equal(app.state.annualResultsByYear[String(year)].stale, true);
  assert.equal(doc.querySelector('#annual-budget-total').textContent, '¥ —');
  assert.equal(doc.querySelector('#annual-budget-status').textContent, '待重新计算');

  await sleep(350);
  const stateWrite = [...requests].reverse()
    .find((item) => item.url === '/api/state' && item.method === 'PUT');
  assert.ok(stateWrite);
  assert.equal(stateWrite.body.annualResultsByYear[String(year)].stale, true);
  assert.match(
    stateWrite.body.annualResultsByYear[String(year)].staleReason,
    /手动刷新/,
  );
});

test('全年汇率刷新进行中会禁用并阻止计算', async () => {
  const year = new Date().getFullYear();
  const { doc, app, requests } = await initializedApp({ annualRates: annualRatesFixture(year) });
  app.state.annualYear = year;
  app.state.annualLoading = true;
  app.renderAnnualBudget();

  assert.equal(doc.querySelector('#btn-calculate-annual').disabled, true);
  await app.calculateAnnualBudget();
  assert.equal(requests.some((item) => item.url === '/api/annual-budget'), false);
  assert.match(doc.querySelector('#toast').textContent, /仍在刷新/);
});

test('全年汇率强制刷新不完整时保留已有有效总额', async () => {
  const year = new Date().getFullYear();
  const fixture = annualRatesFixture(year);
  const failedRefresh = {
    ...fixture,
    stats: { CNY: fixture.stats.CNY },
    errors: { USD: '网络不可达' },
    complete: false,
  };
  const { doc, app, requests } = await initializedApp({
    annualRates: (request) => (request.url.includes('refresh=true') ? failedRefresh : fixture),
  });
  app.state.annualYear = year;
  app.state.annualResultsByYear[String(year)] = {
    year,
    start_date: fixture.start_date,
    requested_through: fixture.requested_through,
    observed_through: fixture.observed_through,
    summary: { '全年预算合计(人民币)': 700 },
    details: [{
      currency: 'USD', amount: 100, average_rate: 7,
      observation_count: 180, first_date: `${year}-01-02`,
      last_date: fixture.observed_through, cny_amount: 700,
    }],
    errors: {},
  };
  app.renderAnnualBudget();

  await app.loadAnnualRates(true);

  assert.equal(app.state.annualResultsByYear[String(year)].stale, undefined);
  assert.equal(doc.querySelector('#annual-budget-total').textContent, '¥ 700.00');
  assert.match(doc.querySelector('#toast').textContent, /刷新不完整/);
  assert.equal(
    requests.filter((item) => item.url === '/api/state' && item.method === 'PUT').length,
    0,
    '失败的刷新不应把有效年度结果持久化为过期',
  );
});
