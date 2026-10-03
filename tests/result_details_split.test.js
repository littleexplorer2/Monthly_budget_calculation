'use strict';

/**
 * 计算结果页三张明细表的排布与拆分的回归测试。
 *
 * 背景：额外预算（CNY / USD / HKD 月额）原先与固定预算行混在一张「一次性明细」表里。
 * 现在结果页拆成三张表——每日预算明细（通栏）、固定预算明细、额外预算明细（并排），
 * 每张表的合计显示在卡片标题右侧，且「可变 + 固定 + 额外 = 本月总预算」。
 *
 * 这里用 tests/helpers/dom-stub.js 载入真实 index.html + app.js 渲染结果页，
 * 并覆盖旧存档（data/app-state.json 里只有 fixed_details、没有 extra_details）的兜底拆分。
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { createApp } = require('./helpers/dom-stub.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const VARIABLE_RMB = 810;    // 285 + 525
const FIXED_RMB = 420.2;     // 64 + 156.2 + 200
const EXTRA_RMB = 71;        // 10 USD × 7.1
const ONCE_RMB = 491.2;      // 固定费用合计 = 固定 + 额外
const TOTAL_RMB = 1301.2;    // 可变 + 固定费用合计

/** 构造一份含每日、固定、额外与旅居一次性费用的计算结果 */
function calcResult({ withExtraKey = true, withExtraRows = true } = {}) {
  const fixedRows = [
    { location: 'Mainland', type: '固定预算', currency: 'CNY', avg_rate: 1, local_cost: 64, rmb_cost: 64 },
    { location: 'Mainland', type: '固定预算', currency: 'USD', avg_rate: 7.1, local_cost: 22, rmb_cost: 156.2 },
  ];
  if (withExtraRows) {
    fixedRows.push({ location: 'Extra', type: '额外预算', currency: 'USD', avg_rate: 7.1, local_cost: 10, rmb_cost: 71 });
  }
  fixedRows.push({ location: '上海', type: '旅居一次性费用', currency: 'CNY', avg_rate: 1, local_cost: 200, rmb_cost: 200 });

  const result = {
    summary: {
      '计算月份': '2026年9月',
      '居住区域': 'Mainland',
      '可变费用合计(人民币)': VARIABLE_RMB,
      '固定费用合计(人民币)': ONCE_RMB,
      '总预算(人民币)': TOTAL_RMB,
    },
    daily_details: [
      { location: 'Shenzhen', type: '可变预算', currency: 'CNY', day_count: 3, daily_standard_local: 95, variable_cost_local: 285, variable_cost_rmb: 285 },
      { location: 'Shanghai', type: '旅居每日预算', currency: 'CNY', day_count: 3, daily_standard_local: 175, variable_cost_local: 525, variable_cost_rmb: 525 },
    ],
    fixed_details: fixedRows,
    warnings: [],
  };
  if (withExtraKey) {
    // 新后端：额外预算单独一份明细 + 单独的合计
    result.extra_details = fixedRows.filter((d) => d.type === '额外预算');
    result.summary['额外预算合计(人民币)'] = result.extra_details.reduce((a, d) => a + d.rmb_cost, 0);
  }
  return result;
}

/** 表格 body 里每一行的单元格文本 */
function rowCells(doc, id) {
  return doc.querySelectorAll(`#${id} tbody tr`).map((tr) => tr.querySelectorAll('td').map((td) => td.textContent));
}

function rowTypes(doc, id) {
  return rowCells(doc, id).map((cells) => cells[1]);
}

function totalOf(doc, id) {
  return doc.querySelector(`#${id}`).textContent;
}

async function renderWith(result) {
  const { doc, app } = createApp();
  await app.init();
  await sleep(30);
  app.state.calcResult = result;
  app.renderResult();
  return { doc, app };
}

test('结果页三张明细表：每日通栏，固定与额外并排，各自不再混行', async () => {
  const { doc } = await renderWith(calcResult());

  // 排布：每日预算明细独占整行，固定/额外在下面并排
  assert.ok(doc.querySelector('.result-details .result-details-wide #daily-details-table'), '每日预算明细应在通栏卡片里');
  assert.equal(doc.querySelector('.result-details-wide #fixed-details-table'), null, '固定预算明细不应在通栏卡片里');
  assert.equal(doc.querySelector('.result-details-wide #extra-details-table'), null, '额外预算明细不应在通栏卡片里');
  assert.equal(doc.querySelectorAll('.result-details > .sheet').length, 3, '结果页应有三张明细卡片');

  assert.deepEqual(rowTypes(doc, 'daily-details-table'), ['可变预算', '旅居每日预算']);
  assert.deepEqual(rowTypes(doc, 'fixed-details-table'), ['固定预算', '固定预算', '旅居一次性费用']);
  assert.deepEqual(rowCells(doc, 'extra-details-table'), [['USD', '10.00', '7.1000', '¥ 71.00']]);

  const fixedText = doc.querySelector('#fixed-details-table').textContent;
  assert.equal(fixedText.includes('额外预算'), false, '固定预算明细里不得再出现额外预算行');
  assert.equal(fixedText.includes('Mainland'), false, '居住区域应显示中文（内地），不显示内部键名');
  assert.deepEqual(
    rowCells(doc, 'fixed-details-table')[0].slice(0, 4),
    ['内地', '固定预算', 'CNY', '64.00'],
    '金额只写数字，币种由「币种」列给出，不再每格重复币种代码'
  );
  assert.deepEqual(
    rowCells(doc, 'daily-details-table')[0],
    ['深圳', '可变预算', 'CNY', '95.00', '3', '285.00', '¥ 285.00']
  );
});

test('每张表的合计显示在卡片标题右侧，且 可变 + 固定 + 额外 = 本月总预算', async () => {
  const { doc } = await renderWith(calcResult());

  assert.equal(totalOf(doc, 'daily-details-total'), '¥ 810.00');
  assert.equal(totalOf(doc, 'fixed-details-total'), '¥ 420.20');
  assert.equal(totalOf(doc, 'extra-details-total'), '¥ 71.00');

  // 固定 + 额外 = summary 的固定费用合计；三者相加 = 总预算
  assert.equal(FIXED_RMB + EXTRA_RMB, ONCE_RMB);
  assert.equal(VARIABLE_RMB + FIXED_RMB + EXTRA_RMB, TOTAL_RMB);
  assert.equal(doc.querySelector('#fixed-details-total').textContent, `¥ ${(ONCE_RMB - EXTRA_RMB).toFixed(2)}`);
});

test('总额胶囊显示 可变 / 固定 / 额外，且数值与三张表一一对应', async () => {
  const { doc } = await renderWith(calcResult());

  const hero = doc.querySelector('#result-summary').textContent;
  assert.match(hero, /可变 ¥ 810\.00/);
  assert.match(hero, /固定 ¥ 420\.20/);
  assert.match(hero, /额外 ¥ 71\.00/);
  assert.equal(hero.includes('其中额外预算'), false, '胶囊文案应为「额外」');
  assert.match(hero, /¥ 1,301\.20/, '总预算金额保持不变');
});

test('旧存档（只有 fixed_details）也能把额外预算拆出来，不会重复计算', async () => {
  const { doc } = await renderWith(calcResult({ withExtraKey: false }));

  assert.deepEqual(rowTypes(doc, 'fixed-details-table'), ['固定预算', '固定预算', '旅居一次性费用']);
  assert.deepEqual(rowCells(doc, 'extra-details-table'), [['USD', '10.00', '7.1000', '¥ 71.00']]);
  assert.equal(totalOf(doc, 'extra-details-total'), '¥ 71.00');
  assert.equal(totalOf(doc, 'fixed-details-total'), '¥ 420.20');
});

test('没有额外预算时给出提示、合计为 0，清空结果时合计与表格一起清掉', async () => {
  const { doc, app } = await renderWith(calcResult({ withExtraRows: false }));

  const extra = doc.querySelector('#extra-details-table');
  assert.equal(extra.querySelector('table'), null, '没有额外预算时不应渲染表格');
  assert.match(extra.textContent, /没有额外预算/);
  assert.equal(totalOf(doc, 'extra-details-total'), '¥ 0.00');
  assert.match(doc.querySelector('#result-summary').textContent, /额外 ¥ 0\.00/);
  // 额外为 0 时固定表合计应等于「固定费用合计」
  assert.equal(totalOf(doc, 'fixed-details-total'), '¥ 491.20');
  assert.equal(rowTypes(doc, 'fixed-details-table').includes('额外预算'), false);

  app.clearResult();
  for (const id of ['daily-details-table', 'fixed-details-table', 'extra-details-table']) {
    assert.equal(doc.querySelector(`#${id}`).textContent, '', `${id} 应被清空`);
  }
  for (const id of ['daily-details-total', 'fixed-details-total', 'extra-details-total']) {
    assert.equal(doc.querySelector(`#${id}`).textContent, '', `${id} 合计应被清空`);
  }
});
