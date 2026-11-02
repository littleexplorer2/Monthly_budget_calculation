'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./helpers/dom-stub');

test('订阅固定预算只显示 CNY、HKD、USD，年度预算沿用同一顺序', async () => {
  const { app, doc } = createApp();
  await app.init();
  app.state.standards.fixed.Mainland = {
    EUR: 10, USD: 20, AUD: 30, HKD: 40, CNY: 50,
  };
  app.renderStandards();

  const fixed = doc.querySelectorAll('#fixed-standards-table .budget-row-title')
    .map((element) => element.textContent.trim().slice(0, 3));
  assert.deepEqual(fixed, ['CNY', 'HKD', 'USD']);
  assert.equal(doc.querySelector('#extra-standards-table'), null);
  assert.deepEqual(app.annualCurrencies(), ['CNY', 'HKD', 'USD']);
});
