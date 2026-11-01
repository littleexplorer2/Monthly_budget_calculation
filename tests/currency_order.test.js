'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./helpers/dom-stub');

test('预算标准统一按 CNY、HKD、USD、其余字母序显示', async () => {
  const { app, doc } = createApp();
  await app.init();
  app.state.standards.fixed.Mainland = {
    EUR: 10, USD: 20, AUD: 30, HKD: 40, CNY: 50,
  };
  app.renderStandards();

  const fixed = doc.querySelectorAll('#fixed-standards-table .budget-row-title')
    .map((element) => element.textContent.trim().slice(0, 3));
  const extra = doc.querySelectorAll('#extra-standards-table .budget-row-title')
    .map((element) => element.textContent.trim().slice(0, 3));

  assert.deepEqual(fixed, ['CNY', 'HKD', 'USD', 'AUD', 'EUR']);
  assert.deepEqual(extra, ['CNY', 'HKD', 'USD']);
  assert.deepEqual(app.annualCurrencies(), ['CNY', 'HKD', 'USD']);
});
