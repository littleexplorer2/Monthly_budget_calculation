'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createApp, defaultStateFixture } = require('./helpers/dom-stub.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MONTH = '2026-09';

function savedResult() {
  return {
    summary: {
      '计算月份': '2026年9月',
      '居住区域': 'Overseas',
      '可变费用合计(人民币)': 800,
      '固定费用合计(人民币)': 200,
      '额外预算合计(人民币)': 0,
      '总预算(人民币)': 1000,
    },
    daily_details: [],
    fixed_details: [],
    extra_details: [],
    warnings: [],
    savedAt: '2026/9/20 10:00:00',
    region: 'Overseas',
    includeTravel: true,
    stale: false,
  };
}

function stateWithSavedMonth() {
  const state = defaultStateFixture();
  state.itineraryByMonth[MONTH] = {
    Shenzhen: [{ start: '2026-09-01', end: '2026-09-02' }],
  };
  state.optionsByMonth[MONTH] = {
    region: 'Overseas', includeTravel: true, travelSelected: null,
  };
  state.overridesByMonth[MONTH] = {
    variable: { Shenzhen: { CNY: 90 } },
  };
  state.resultsByMonth[MONTH] = savedResult();
  return state;
}

async function initialized(options = {}) {
  const created = createApp({ state: stateWithSavedMonth(), ...options });
  await created.app.init();
  await sleep(20);
  return created;
}

function assertStaleResult(doc, app, reasonPattern) {
  const result = app.state.resultsByMonth[MONTH];
  assert.equal(result.stale, true, '输入变化后已保存结果必须标记为 stale');
  assert.match(result.staleReason, reasonPattern);
  assert.equal(app.state.calcResult, result, '结果页应指向同一份已过期结果');

  app.renderResult();
  assert.match(doc.querySelector('#result-meta').textContent, /旧结果/);
  assert.match(doc.querySelector('#result-warnings').textContent, /请重新计算/);
  assert.deepEqual(Array.from(app.collectAnalysisMonths()), [], '月度比较不得纳入 stale 结果');
}

test('当前月已有结果时，修改预算标准会标记旧结果并从月度比较排除', async () => {
  const { doc, app } = await initialized();
  assert.equal(app.collectAnalysisMonths().length, 1, '变更前当前月应可比较');

  const input = doc.querySelector('#variable-standards-table input[data-cat="variable"][data-loc="Shenzhen"]');
  assert.ok(input);
  input.value = '99';
  input.dispatchEvent({ type: 'input', bubbles: true, target: input });

  assertStaleResult(doc, app, /预算标准|计算选项/);
});

test('当前月已有结果时，修改行程会标记旧结果并从月度比较排除', async () => {
  const { doc, app } = await initialized();
  app.addRange('Shenzhen', '2026-09-03', '2026-09-04');

  assert.equal(app.state.itineraryByMonth[MONTH].Shenzhen.length, 2);
  assert.deepEqual(
    JSON.parse(JSON.stringify(app.state.itineraryByMonth[MONTH].Shenzhen[1])),
    { start: '2026-09-03', end: '2026-09-04' },
  );
  assertStaleResult(doc, app, /行程|计算选项/);
});

test('删除月份的 state PUT 失败时回滚内存、页面与本机快照', async () => {
  const quietConsole = { log() {}, info() {}, warn() {}, error() {} };
  const { doc, app, requests, storage } = await initialized({ statePutFailure: true, console: quietConsole });
  const before = JSON.parse(JSON.stringify(app.snapshotBundle()));
  assert.match(doc.querySelector('#result-summary').textContent, /¥ 1,000\.00/);

  await app.deleteMonthData(MONTH);

  const after = JSON.parse(JSON.stringify(app.snapshotBundle()));
  for (const field of ['itineraryByMonth', 'optionsByMonth', 'overridesByMonth', 'resultsByMonth']) {
    assert.deepEqual(after[field], before[field], `${field} 应在 PUT 失败后回滚`);
  }
  assert.equal(app.state.region, 'Overseas');
  assert.equal(app.state.includeTravel, true);
  assert.equal(app.state.standards.variable.Shenzhen.CNY, 90);
  assert.equal(app.state.calcResult.summary['总预算(人民币)'], 1000);
  assert.match(doc.querySelector('#result-summary').textContent, /¥ 1,000\.00/, '结果页应恢复删除前内容');
  assert.match(doc.querySelector('#toast').textContent, /页面数据已恢复/);

  const statePut = requests.find((item) => item.url === '/api/state' && item.method === 'PUT');
  assert.ok(statePut, '应先向服务器提交删除墓碑');
  for (const field of ['itineraryByMonth', 'optionsByMonth', 'overridesByMonth', 'resultsByMonth']) {
    assert.deepEqual(statePut.body[field][MONTH], {}, `${field} 应发送删除墓碑`);
  }
  assert.equal(requests.some((item) => item.url === '/api/data/rates/delete'), false,
    '状态删除失败后不应继续删汇率缓存');

  const cached = JSON.parse(storage.get('budget-web-state-v1'));
  for (const field of ['itineraryByMonth', 'optionsByMonth', 'overridesByMonth', 'resultsByMonth']) {
    assert.deepEqual(cached[field], before[field], `${field} 的 localStorage 快照也必须回滚`);
  }
});
