'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp, defaultStateFixture, defaultMetaFixture } = require('./helpers/dom-stub');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cachedEntity(month) {
  const meta = defaultMetaFixture();
  return {
    schemaVersion: 2,
    month,
    revision: 0,
    updatedAt: '2026-09-01T00:00:00Z',
    itinerary: { Shenzhen: [{ start: `${month}-01`, end: `${month}-02` }] },
    options: { region: 'Mainland', includeTravel: false, travelSelected: null },
    standards: {
      _snapshot: true,
      variable: meta.default_standards.variable,
      travel: meta.default_standards.travel,
      custom_locations: [], custom_currencies: {},
      _locations: meta.locations,
      _location_names: meta.location_names,
      _currency_names: meta.currency_names,
    },
    subscriptions: { items: [], retiredIds: [] },
    result: null,
  };
}

test('初始化和渲染空白月份不会静默创建任何月份实体', async () => {
  const { app, requests } = createApp();
  await app.init();

  assert.deepEqual(Object.keys(app.state.monthsByKey), []);
  assert.equal(requests.some((request) => (
    request.url.includes('/api/months/') && ['POST', 'PUT'].includes(request.method)
  )), false);
});

test('空白当前月的第一次编辑也必须确认，取消后丢弃 revision=0 草稿', async () => {
  const prompts = [];
  const { app, requests } = createApp({
    confirm: (message) => { prompts.push(message); return false; },
  });
  await app.init();

  app.addRange('Shenzhen', '2026-09-01', '2026-09-02');
  await wait(450);

  assert.deepEqual(prompts, ['是否要新增2026年09月的预算数据？']);
  assert.equal(app.state.monthsByKey['2026-09'], undefined);
  assert.equal(requests.some((request) => request.url === '/api/months/2026-09/ensure'), false);
  assert.equal(requests.some((request) => (
    request.url === '/api/months/2026-09' && request.method === 'PUT'
  )), false);
});

test('服务器恢复后会提示并重新同步故障期间保存在浏览器的 v2 字段修改', async () => {
  const local = defaultStateFixture();
  local.months['2026-09'] = cachedEntity('2026-09');
  local.dirty = { months: { '2026-09': ['itinerary'] }, global: [] };
  const { app, storage, requests } = createApp({ confirm: () => true });
  storage.set('budget-web-state-v2', JSON.stringify(local));
  storage.set('budget-web-state-v2-unsynced', '1');

  await app.init();

  assert.ok(app.state.monthsByKey['2026-09']);
  assert.equal(storage.has('budget-web-state-v2-unsynced'), false);
  assert.equal(requests.some((request) => (
    request.url === '/api/months/2026-09' && request.method === 'PUT'
      && request.body.data.itinerary.Shenzhen
  )), true);
});

test('切换到没有数据的月份前显示确认，取消后不切月也不创建数据', async () => {
  const prompts = [];
  const { app, requests } = createApp({
    confirm: (message) => { prompts.push(message); return false; },
  });
  await app.init();

  const changed = await app.changeMonth(1);

  assert.equal(changed, false);
  assert.deepEqual(prompts, ['是否要新增2026年10月的预算数据？']);
  assert.equal(app.state.year, 2026);
  assert.equal(app.state.month, 9);
  assert.deepEqual(Object.keys(app.state.monthsByKey), []);
  assert.equal(requests.some((request) => request.url.endsWith('/ensure')), false);
});

test('确认新增月份后才调用 ensure 并接收完整目标月实体', async () => {
  const prompts = [];
  const { app, requests } = createApp({
    confirm: (message) => { prompts.push(message); return true; },
  });
  await app.init();

  const changed = await app.changeMonth(1);

  assert.equal(changed, true);
  assert.deepEqual(prompts, ['是否要新增2026年10月的预算数据？']);
  assert.equal(app.state.month, 10);
  assert.equal(app.state.monthsByKey['2026-10'].revision, 1);
  assert.equal(app.state.monthsByKey['2026-10'].standards._snapshot, true);
  assert.equal(app.state.monthsByKey['2026-09'], undefined, '空白来源月不应因离开而创建');
  assert.equal(requests.some((request) => (
    request.url === '/api/months/2026-10/ensure' && request.method === 'POST'
  )), true);
});

test('已有月份实体直接切换，不重复询问新增', async () => {
  const state = {
    version: 1, year: 2026, month: 9,
    resultsByMonth: { '2026-10': { summary: { '总预算(人民币)': 123 } } },
  };
  let confirmations = 0;
  const { app } = createApp({
    state,
    confirm: () => { confirmations += 1; return false; },
  });
  await app.init();

  assert.equal(await app.changeMonth(1), true);
  assert.equal(app.state.month, 10);
  assert.equal(confirmations, 0);
});
