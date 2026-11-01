'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp, defaultStateFixture } = require('./helpers/dom-stub');

test('切换到没有数据的月份前显示确认，取消后不切月也不创建数据', async () => {
  const prompts = [];
  const { app, requests } = createApp({
    confirm: (message) => { prompts.push(message); return false; },
  });
  await app.init();

  const changed = app.changeMonth(1);

  assert.equal(changed, false);
  assert.deepEqual(prompts, ['是否要新增2026年10月的预算数据？']);
  assert.equal(app.state.year, 2026);
  assert.equal(app.state.month, 9);
  assert.deepEqual(Object.keys(app.state.itineraryByMonth), []);
  assert.deepEqual(Object.keys(app.state.optionsByMonth), []);
  assert.deepEqual(Object.keys(app.state.overridesByMonth), []);
  assert.equal(requests.some((request) => request.url.includes('/api/state') && request.method === 'PUT'), false);
});

test('确认新增月份后才建立目标月选项和标准快照', async () => {
  const prompts = [];
  const { app } = createApp({
    confirm: (message) => { prompts.push(message); return true; },
  });
  await app.init();

  const changed = app.changeMonth(1);

  assert.equal(changed, true);
  assert.deepEqual(prompts, ['是否要新增2026年10月的预算数据？']);
  assert.equal(app.state.month, 10);
  assert.ok(app.state.optionsByMonth['2026-10']);
  assert.ok(app.state.optionsByMonth['2026-10'].savedAt);
  assert.equal(app.state.overridesByMonth['2026-10']._snapshot, true);
  assert.equal(app.state.optionsByMonth['2026-09'], undefined, '空白来源月不应因离开而自动创建');
  assert.equal(app.state.overridesByMonth['2026-09'], undefined, '空白来源月不应因离开而自动创建');
});

test('已有数据的月份直接切换，不重复询问新增', async () => {
  const state = defaultStateFixture();
  state.resultsByMonth['2026-10'] = { summary: { '总预算(人民币)': 123 } };
  let confirmations = 0;
  const { app } = createApp({
    state,
    confirm: () => { confirmations += 1; return false; },
  });
  await app.init();

  assert.equal(app.changeMonth(1), true);
  assert.equal(app.state.month, 10);
  assert.equal(confirmations, 0);
});
