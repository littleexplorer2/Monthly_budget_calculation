'use strict';

/** 新预算模型只展示每日预算与订阅月均固定预算两张明细卡。 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { createApp } = require('./helpers/dom-stub.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const VARIABLE_RMB = 810;
const FIXED_RMB = 420.2;
const TOTAL_RMB = 1230.2;
const LEGACY_EXTRA_RMB = 71;

function calcResult({ legacyExtra = false } = {}) {
  const fixedRows = [
    { location: 'Mainland', type: '固定预算', currency: 'CNY', avg_rate: 1, local_cost: 64, rmb_cost: 64 },
    { location: 'Mainland', type: '固定预算', currency: 'USD', avg_rate: 7.1, local_cost: 22, rmb_cost: 156.2 },
    { location: '上海', type: '旅居一次性费用', currency: 'CNY', avg_rate: 1, local_cost: 200, rmb_cost: 200 },
  ];
  if (legacyExtra) {
    fixedRows.splice(2, 0, {
      location: 'Extra', type: '额外预算', currency: 'USD',
      avg_rate: 7.1, local_cost: 10, rmb_cost: LEGACY_EXTRA_RMB,
    });
  }
  return {
    budgetModel: legacyExtra ? undefined : 'subscription-fixed-monthly-equivalent-v2',
    summary: {
      '计算月份': '2026年9月',
      '居住区域': 'Mainland',
      '可变费用合计(人民币)': VARIABLE_RMB,
      '固定费用合计(人民币)': FIXED_RMB + (legacyExtra ? LEGACY_EXTRA_RMB : 0),
      '额外预算合计(人民币)': legacyExtra ? LEGACY_EXTRA_RMB : 0,
      '总预算(人民币)': TOTAL_RMB + (legacyExtra ? LEGACY_EXTRA_RMB : 0),
    },
    daily_details: [
      { location: 'Shenzhen', type: '可变预算', currency: 'CNY', day_count: 3, daily_standard_local: 95, variable_cost_local: 285, variable_cost_rmb: 285 },
      { location: 'Shanghai', type: '旅居每日预算', currency: 'CNY', day_count: 3, daily_standard_local: 175, variable_cost_local: 525, variable_cost_rmb: 525 },
    ],
    fixed_details: fixedRows,
    extra_details: legacyExtra ? fixedRows.filter((row) => row.type === '额外预算') : [],
    warnings: [],
  };
}

function rowCells(doc, id) {
  return doc.querySelectorAll(`#${id} tbody tr`)
    .map((tr) => tr.querySelectorAll('td').map((td) => td.textContent));
}

function rowTypes(doc, id) {
  return rowCells(doc, id).map((cells) => cells[1]);
}

async function renderWith(result) {
  const { doc, app } = createApp();
  await app.init();
  await sleep(30);
  app.state.calcResult = result;
  app.renderResult();
  return { doc, app };
}

test('结果页只保留每日与订阅固定预算两张明细卡', async () => {
  const { doc } = await renderWith(calcResult());

  assert.ok(doc.querySelector('.result-details .result-details-wide #daily-details-table'));
  assert.equal(doc.querySelectorAll('.result-details > .sheet').length, 2);
  assert.equal(doc.querySelector('#extra-details-table'), null);
  assert.deepEqual(rowTypes(doc, 'daily-details-table'), ['可变预算', '旅居每日预算']);
  assert.deepEqual(rowTypes(doc, 'fixed-details-table'), ['固定预算', '固定预算', '旅居一次性费用']);
  assert.deepEqual(rowCells(doc, 'fixed-details-table')[0].slice(0, 4),
    ['内地', '固定预算', 'CNY', '64.00']);
});

test('可变与固定两张表的合计正好等于本月总预算', async () => {
  const { doc } = await renderWith(calcResult());

  assert.equal(doc.querySelector('#daily-details-total').textContent, '¥ 810.00');
  assert.equal(doc.querySelector('#fixed-details-total').textContent, '¥ 420.20');
  assert.equal(VARIABLE_RMB + FIXED_RMB, TOTAL_RMB);
  assert.match(doc.querySelector('#result-summary').textContent, /¥ 1,230\.20/);
});

test('新预算模型的总额胶囊不再出现额外预算', async () => {
  const { doc } = await renderWith(calcResult());
  const hero = doc.querySelector('#result-summary').textContent;
  assert.match(hero, /可变 ¥ 810\.00/);
  assert.match(hero, /固定 ¥ 420\.20/);
  assert.doesNotMatch(hero, /额外/);
});

test('旧结果仍可追溯旧额外金额，但不会恢复额外预算编辑或明细卡', async () => {
  const { doc } = await renderWith(calcResult({ legacyExtra: true }));
  assert.deepEqual(rowTypes(doc, 'fixed-details-table'), ['固定预算', '固定预算', '旅居一次性费用']);
  assert.equal(doc.querySelector('#fixed-details-total').textContent, '¥ 420.20');
  assert.match(doc.querySelector('#result-summary').textContent, /旧额外 ¥ 71\.00/);
  assert.equal(doc.querySelector('#extra-details-table'), null);
});

test('清空结果时两张表与合计一起清空', async () => {
  const { doc, app } = await renderWith(calcResult());
  app.clearResult();
  for (const id of ['daily-details-table', 'fixed-details-table']) {
    assert.equal(doc.querySelector(`#${id}`).textContent, '');
  }
  for (const id of ['daily-details-total', 'fixed-details-total']) {
    assert.equal(doc.querySelector(`#${id}`).textContent, '');
  }
});
