'use strict';

/**
 * 默认预算标准弹窗的输入回归测试。
 *
 * 背景：弹窗里每次输入都会刷新「与默认值不同」标记。如果刷新方式是**整块重绘**，
 * 正在编辑的输入框会被替换成新节点：后续按键落在旧节点上，界面表现为
 * 「数字没反应 / 输入错位 / 必须重新点一次输入框」。
 * 这里用可交互的 DOM 桩（tests/helpers/dom-stub.js）真实触发 input 事件来盯住这一点。
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { createApp } = require('./helpers/dom-stub.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fixedInput(doc, region, curr) {
  return doc.querySelector(`.defaults-editor input[data-cat="fixed"][data-loc="${region}"][data-curr="${curr}"]`);
}

/** 逐字符输入（输入框保持焦点，值随按键累积），返回过程中的焦点变化 */
function typeInto(doc, input, text) {
  const steps = [];
  let value = '';
  for (const ch of text) {
    value += ch;
    input.value = value;
    input.dispatchEvent({ type: 'input', bubbles: true, target: input });
    steps.push({ ch, focused: doc.activeElement === input, value: input.value });
  }
  return steps;
}

async function openDefaultsWithAll(region) {
  const { doc, app } = createApp();
  await app.init();
  await sleep(50);
  app.state.region = region;
  app.state.year = 2026;
  app.state.month = 9;
  app.renderStandards();
  doc.querySelector('#btn-defaults-modal').click();
  const chk = doc.querySelector('#chk-defaults-show-all');
  chk.checked = true;
  chk.dispatchEvent({ type: 'change', bubbles: true });
  return { doc, app };
}

test('输入时不会替换正在编辑的输入框节点（连续输入不丢字符、不丢焦点）', async () => {
  const { doc, app } = await openDefaultsWithAll('Overseas');
  const input = fixedInput(doc, 'Mainland', 'CNY');
  assert.ok(input, '弹窗里应显示内地的固定预算行');

  input.focus();
  const nodeIdentity = [];
  let value = '';
  for (const ch of '957') {
    value += ch;
    input.value = value;
    input.dispatchEvent({ type: 'input', bubbles: true, target: input });
    nodeIdentity.push({
      sameNode: fixedInput(doc, 'Mainland', 'CNY') === input,
      focused: doc.activeElement === input,
    });
  }

  assert.deepEqual(nodeIdentity, [
    { sameNode: true, focused: true },
    { sameNode: true, focused: true },
    { sameNode: true, focused: true },
  ], '输入过程中输入框节点必须保持不变且保持焦点（整块重绘会导致后续按键写进旧节点）');
  assert.equal(input.value, '957');
  assert.equal(app.state.defaultsDraft.standards.fixed.Mainland.CNY, 957);
  assert.equal(app.state.defaultsDraft.standards.fixed.Overseas.CNY, 249, '不应改到境外');
});

test('弹窗里改默认预算不会改动当月数值', async () => {
  const { doc, app } = await openDefaultsWithAll('Overseas');
  const monthBefore = JSON.stringify(app.state.standards);
  const input = fixedInput(doc, 'Mainland', 'CNY');
  input.focus();
  const steps = typeInto(doc, input, '120');

  assert.equal(steps.every((s) => s.focused), true, '每一步都应保持焦点');
  assert.equal(app.state.defaultsDraft.standards.fixed.Mainland.CNY, 120);
  assert.equal(JSON.stringify(app.state.standards), monthBefore, '当月标准不应被弹窗编辑改动');
});

test('各类别（可变 / 固定 / 额外 / 旅居每日单次）输入都保持节点与焦点', async () => {
  const { doc, app } = await openDefaultsWithAll('Mainland');
  const cases = [
    { sel: '.defaults-editor input[data-cat="variable"][data-loc="Shenzhen"]', text: '123' },
    { sel: '.defaults-editor input[data-cat="extra"][data-loc="extra"][data-curr="CNY"]', text: '55' },
    { sel: '.defaults-editor input[data-cat="travel"][data-loc="Shanghai"][data-curr="CNY"][data-field="daily"]', text: '199' },
    { sel: '.defaults-editor input[data-cat="travel"][data-loc="Shanghai"][data-curr="CNY"][data-field="once"]', text: '299' },
  ];
  for (const c of cases) {
    const input = doc.querySelector(c.sel);
    assert.ok(input, `应找到输入框: ${c.sel}`);
    input.focus();
    const steps = typeInto(doc, input, c.text);
    assert.equal(steps.every((s) => s.focused), true, `${c.sel} 输入过程中丢了焦点`);
    assert.equal(doc.querySelector(c.sel), input, `${c.sel} 输入过程中节点被替换`);
    assert.equal(input.value, c.text, `${c.sel} 值应为 ${c.text}`);
  }
});

test('标记随输入即时出现，且不会破坏同行的其它输入框', async () => {
  const { doc, app } = await openDefaultsWithAll('Mainland');
  const cny = fixedInput(doc, 'Mainland', 'CNY');
  const usd = fixedInput(doc, 'Mainland', 'USD');
  assert.ok(cny && usd);
  assert.equal(cny.closest('.budget-row').querySelector('.chip-diff'), null, '初始不应有差异标记');

  cny.focus();
  typeInto(doc, cny, '200');
  const chip = cny.closest('.budget-row').querySelector('.chip-diff');
  assert.ok(chip, '改动后应出现「与已保存默认值不同」标记');
  assert.match(chip.textContent, /与已保存默认值不同/);
  assert.equal(fixedInput(doc, 'Mainland', 'USD'), usd, '同一块里的其它输入框不应被重建');

  // 还原回已保存默认值 → 标记消失
  const row = cny.closest('.budget-row');
  const revert = row.querySelector('button[data-action="revert-row"]');
  assert.ok(revert, '标记里应有还原按钮');
  revert.dispatchEvent({ type: 'click', bubbles: true, target: revert });
  assert.equal(fixedInput(doc, 'Mainland', 'CNY').closest('.budget-row').querySelector('.chip-diff'), null,
    '还原后标记应消失');
});

test('当月面板的输入同样不会替换节点（回归对照）', async () => {
  const { doc, app } = createApp();
  await app.init();
  await sleep(50);
  app.state.region = 'Mainland';
  app.state.year = 2026;
  app.state.month = 9;
  app.renderStandards();

  const sel = '#variable-standards-table input[data-cat="variable"][data-loc="Shenzhen"]';
  const input = doc.querySelector(sel);
  assert.ok(input, '当月面板应有深圳行');
  input.focus();
  const steps = typeInto(doc, input, '130');
  assert.equal(steps.every((s) => s.focused), true, '当月输入过程中丢了焦点');
  assert.equal(doc.querySelector(sel), input, '当月输入过程中节点被替换');
  assert.equal(app.state.standards.variable.Shenzhen.CNY, 130);
});
