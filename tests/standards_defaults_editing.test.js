'use strict';

/**
 * 预算标准页「当月预算」与「服务器默认预算标准」两个独立区域的回归测试。
 * 关键约定：保存默认标准绝不改动当月预算；默认标准编辑区是独立区域，可随时展开/收起。
 * 用 vm 加载 app.js（不依赖浏览器），只覆盖纯逻辑与渲染流程不抛异常。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function makeEl() {
  return {
    innerHTML: '', textContent: '', value: '', disabled: false, hidden: false, checked: false,
    dataset: {}, style: { cssText: '' },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, appendChild() {}, remove() {},
    removeAttribute() {}, setAttribute() {},
    querySelector: () => null, querySelectorAll: () => [],
    closest: () => null, scrollIntoView() {}, insertAdjacentHTML() {},
  };
}

function loadAppForTest() {
  const appPath = path.join(__dirname, '..', 'web', 'js', 'app.js');
  const source = fs.readFileSync(appPath, 'utf8');
  const storage = new Map();
  // 每个选择器返回同一个元素，便于断言渲染结果（浏览器里也是同一个节点）
  const elements = new Map();
  const elementFor = (sel) => {
    if (!elements.has(sel)) elements.set(sel, makeEl());
    return elements.get(sel);
  };
  const fetchCalls = [];
  const context = {
    AbortController,
    Blob,
    clearTimeout,
    confirm: () => true,
    console,
    Date,
    fetch: async (...args) => { fetchCalls.push(args[0]); return { ok: true, status: 200, json: async () => ({}) }; },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      removeItem: (key) => storage.delete(key),
      setItem: (key, value) => storage.set(key, String(value)),
    },
    navigator: {},
    setTimeout,
    window: {
      addEventListener: () => {},
      confirm: () => true,
      crypto: { randomUUID: () => 'test-tab' },
    },
    document: {
      addEventListener: () => {},
      createElement: () => makeEl(),
      querySelector: (sel) => elementFor(sel),
      querySelectorAll: () => [],
    },
  };
  vm.createContext(context);
  vm.runInContext(`${source}\n
    globalThis.testApi = {
      state,
      countStandardsDiffs,
      monthDiffChip,
      defaultsDiffChip,
      rowInputHtml,
      defaultsDraftDirty,
      defaultsScope,
      monthItineraryTravelLocations,
      renderDefaultsPanel,
      updateDefaultsScopeHint,
      openAddStandard,
      confirmAddStandard,
      openDefaultsModal,
      closeDefaultsModal,
      applyMonthInput,
      applyDefaultsInput,
      refreshDefaultsAfterServerChange,
      saveDefaultStandardsToServer,
      activeStandardsOverride,
      persistNow: () => persist('now'),
      snapshotBundle,
      applyBundle,
      loadOverrides,
      resetStandardsToDefault,
      restoreDefaultEntry,
      reconstructDefaultsDraft,
      renderStandards,
      syncStandardsModeUI,
      setApi(mock) { api = mock; },
      setToast(mock) { toast = mock; },
      seed() {
        // 该逻辑测试不执行异步 init；显式模拟 GET /api/state 已成功，
        // 否则生产代码会正确地把初始化窗口视为只读。
        serverStateReady = true;
        state.meta = {
          default_standards: {
            variable: { Shenzhen: { CNY: 80 } },
            fixed: { Mainland: { CNY: 64 }, Overseas: { USD: 10 } },
            travel: {
              Shanghai: { CNY: { daily: 175, once: 200 } },
              Taipei: { TWD: { daily: 1450, once: 1000 } },
            },
            extra: { CNY: 0, USD: 0, HKD: 0 },
          },
          locations: [
            { key: 'Shenzhen', name: '深圳', category: 'variable', currency: 'CNY' },
            // 真实 /api/meta 的注册表里包含全部旅居地点，不能把它当成「新建」列表
            { key: 'Shanghai', name: '上海', category: 'travel', currency: 'CNY' },
            { key: 'Taipei', name: '台北', category: 'travel', currency: 'TWD' },
          ],
          location_names: { Shenzhen: '深圳', Shanghai: '上海', Taipei: '台北' },
          currency_names: { CNY: '人民币', TWD: '新台币' },
          currencies: ['CNY', 'USD', 'HKD'],
          regions: [{ key: 'Mainland', name: '内地' }, { key: 'Overseas', name: '境外' }],
          defaults_customized: true,
          defaults_revision: '0'.repeat(64),
        };
        state.year = 2026;
        state.month = 9;
        state.region = 'Mainland';
        state.standards = JSON.parse(JSON.stringify(state.meta.default_standards));
        state.customLocations = [];
        state.customCurrencies = {};
        state.monthStandardsSnapshot = false;
        state.editingDefaults = false;
        state.defaultsDraft = null;
        state.defaultsShowAll = false;
        state.overridesByMonth = {};
        state.itineraryByMonth = {};
        state.includeTravel = false;
        state.travelSelected = null;
      },
    };
  `, context);
  return {
    ...context.testApi,
    el: (sel) => elementFor(sel),
    fetchCalls,
  };
}

test('当月预算里与默认值不同的行会带「与默认值不同」标记，但不带任何改动按钮', () => {
  const app = loadAppForTest();
  app.seed();
  assert.equal(app.monthDiffChip('variable', 'Shenzhen', 'CNY', ''), '');

  app.state.standards.variable.Shenzhen.CNY = 100;
  const chip = app.monthDiffChip('variable', 'Shenzhen', 'CNY', '');
  assert.match(chip, /与默认值不同/);
  assert.match(chip, /默认 80/);
  assert.match(chip, /data-action="chip"/);
  assert.doesNotMatch(chip, /<button/, '当月标记不应带按钮，避免误改另一区域');
});

test('所有金额输入都带 data-field 属性，保证局部刷新能命中', () => {
  const app = loadAppForTest();
  app.seed();
  for (const [cat, loc, curr, field] of [
    ['variable', 'Shenzhen', 'CNY', ''],
    ['fixed', 'Mainland', 'CNY', ''],
    ['extra', 'extra', 'CNY', ''],
    ['travel', 'Shanghai', 'CNY', 'daily'],
    ['travel', 'Shanghai', 'CNY', 'once'],
  ]) {
    const html = app.rowInputHtml(cat, loc, curr, field, 12);
    assert.match(html, new RegExp(`data-field="${field}"`), `${cat}.${loc}.${curr}.${field} 缺少 data-field`);
  }
});

test('旅居每日/单次按字段分别标记差异', () => {
  const app = loadAppForTest();
  app.seed();
  app.state.standards.travel.Shanghai.CNY.once = 300;
  assert.equal(app.monthDiffChip('travel', 'Shanghai', 'CNY', 'daily'), '');
  assert.match(app.monthDiffChip('travel', 'Shanghai', 'CNY', 'once'), /默认 200/);
});

test('默认标准是独立区域：改动只进草稿，不写当月覆盖', () => {
  const app = loadAppForTest();
  app.seed();
  assert.equal(app.state.editingDefaults, false, '默认收起');

  app.openDefaultsModal();
  assert.equal(app.state.editingDefaults, true);
  assert.equal(app.defaultsDraftDirty(), false, '刚展开时草稿应与已保存默认值一致');

  app.state.defaultsDraft.standards.variable.Shenzhen.CNY = 120;
  assert.equal(app.defaultsDraftDirty(), true);
  assert.equal(app.state.standards.variable.Shenzhen.CNY, 80, '当月数值不应被默认草稿改动');
  assert.equal(app.state.overridesByMonth['2026-09'], undefined, '默认草稿不应写成当月覆盖');

  const chip = app.defaultsDiffChip('variable', 'Shenzhen', 'CNY', '');
  assert.match(chip, /与已保存默认值不同/);
  assert.match(chip, /revert-row/, '默认区域应提供还原');
  assert.match(chip, /data-action="chip"/);
});

test('保存默认标准后当月数值保持不变（不会被覆盖）', () => {
  const app = loadAppForTest();
  app.seed();
  app.openDefaultsModal();
  const monthSnapshot = JSON.stringify(app.state.standards);
  app.state.defaultsDraft.standards.variable.Shenzhen.CNY = 120;

  // 模拟服务端返回新默认标准
  const meta = JSON.parse(JSON.stringify(app.state.meta));
  meta.default_standards.variable.Shenzhen.CNY = 120;
  app.refreshDefaultsAfterServerChange(meta);

  assert.equal(app.state.meta.default_standards.variable.Shenzhen.CNY, 120, '默认标准已更新');
  assert.equal(app.state.standards.variable.Shenzhen.CNY, 80, '当月数值必须保持不变');
  assert.equal(JSON.stringify(app.state.standards), monthSnapshot, '当月标准结构整体不变');
  assert.equal(app.defaultsDraftDirty(), false, '保存后草稿与新的默认值一致');
  assert.equal(app.state.editingDefaults, true, '保存后编辑区保持展开');
});

test('保存默认标准前先落盘当月完整快照，重载后仍保持旧值', async () => {
  const app = loadAppForTest();
  app.seed();
  app.openDefaultsModal();
  const monthBeforeSave = JSON.parse(JSON.stringify(app.state.standards));
  app.state.defaultsDraft.standards.variable.Shenzhen.CNY = 120;

  const nextMeta = JSON.parse(JSON.stringify(app.state.meta));
  nextMeta.default_standards.variable.Shenzhen.CNY = 120;
  const calls = [];
  let persistedBundle = null;
  app.setToast(() => {});
  app.setApi(async (url, options = {}) => {
    calls.push(url);
    if (url === '/api/state') {
      persistedBundle = JSON.parse(JSON.stringify(options.body));
      return persistedBundle;
    }
    if (url === '/api/defaults') return nextMeta;
    throw new Error(`unexpected request: ${url}`);
  });

  await app.saveDefaultStandardsToServer();

  assert.deepEqual(calls, ['/api/state', '/api/defaults'], '当月快照必须在修改默认值前落盘');
  const savedMonth = persistedBundle.overridesByMonth['2026-09'];
  assert.equal(savedMonth._snapshot, true, '当月必须固化为完整快照');
  assert.equal(savedMonth.variable.Shenzhen.CNY, 80);

  // 模拟默认值已改变后的全新页面加载：先取新 meta，再恢复 app-state。
  const reloaded = loadAppForTest();
  reloaded.seed();
  reloaded.state.meta = JSON.parse(JSON.stringify(nextMeta));
  reloaded.resetStandardsToDefault();
  reloaded.applyBundle(persistedBundle);
  reloaded.loadOverrides();

  assert.equal(
    JSON.stringify(reloaded.state.standards),
    JSON.stringify(monthBeforeSave),
    '重载不得用新默认值覆盖当月旧标准',
  );
});

test('当月快照落盘失败时不修改服务器默认标准', async () => {
  const app = loadAppForTest();
  app.seed();
  app.openDefaultsModal();
  app.state.defaultsDraft.standards.variable.Shenzhen.CNY = 120;
  const oldDefault = app.state.meta.default_standards.variable.Shenzhen.CNY;
  const calls = [];
  const toasts = [];
  app.setToast((message, type) => toasts.push({ message, type }));
  app.setApi(async (url) => {
    calls.push(url);
    if (url === '/api/state') throw new Error('写盘失败');
    throw new Error('不应请求默认标准接口');
  });

  await app.saveDefaultStandardsToServer();

  assert.deepEqual(calls, ['/api/state']);
  assert.equal(app.state.meta.default_standards.variable.Shenzhen.CNY, oldDefault);
  assert.equal(app.state.overridesByMonth['2026-09']._snapshot, true, '本地快照仍应保留供重试');
  assert.deepEqual(toasts, [{ message: '当前及历史月份快照保存失败，已取消修改服务器默认标准', type: 'error' }]);
});

test('默认标准保存开始后冻结提交体，并在月份快照等待期间阻止重复提交', async () => {
  const app = loadAppForTest();
  app.seed();
  app.openDefaultsModal();
  const draft = app.state.defaultsDraft;
  draft.standards.variable.Shenzhen.CNY = 120;
  draft.standards.variable.Custom = { EUR: 50 };
  draft.locations.push({ key: 'Custom', name: '原地点名', category: 'variable', currency: 'EUR' });
  draft.locationNames.Custom = '原地点名';
  draft.currencyNames.EUR = '原币种名';

  let releaseStateWrite;
  let stateWriteStarted;
  const stateGate = new Promise((resolve) => { releaseStateWrite = resolve; });
  const stateStarted = new Promise((resolve) => { stateWriteStarted = resolve; });
  const calls = [];
  let defaultsBody = null;
  app.setToast(() => {});
  app.setApi(async (url, options = {}) => {
    calls.push(url);
    if (url === '/api/state') {
      stateWriteStarted();
      await stateGate;
      return options.body;
    }
    if (url === '/api/defaults') {
      defaultsBody = JSON.parse(JSON.stringify(options.body));
      return JSON.parse(JSON.stringify(app.state.meta));
    }
    throw new Error(`unexpected request: ${url}`);
  });

  const firstSave = app.saveDefaultStandardsToServer();
  await stateStarted;
  assert.equal(app.el('#btn-save-defaults').disabled, true, '等待月份快照时应立即禁用重复保存');

  // 模拟用户在慢速 /api/state 请求期间继续编辑草稿；POST 必须仍使用点击保存时的值。
  draft.standards.variable.Shenzhen.CNY = 999;
  draft.standards.variable.Custom.EUR = 888;
  draft.locations.find((item) => item.key === 'Custom').name = '后来地点名';
  draft.locationNames.Custom = '后来地点名';
  draft.currencyNames.EUR = '后来币种名';
  await app.saveDefaultStandardsToServer();

  releaseStateWrite();
  await firstSave;

  assert.deepEqual(calls, ['/api/state', '/api/defaults'], '重复点击不得启动第二条保存管线');
  assert.equal(defaultsBody.variable.Shenzhen.CNY, 120);
  assert.equal(defaultsBody.variable.Custom.EUR, 50);
  assert.equal(defaultsBody.location_names.Custom, '原地点名');
  assert.equal(defaultsBody.currency_names.EUR, '原币种名');
  assert.equal(app.el('#btn-save-defaults').disabled, false, '保存结束后应恢复按钮');
});

test('普通状态持久化把旧差异覆盖升级为当前月份完整标准快照', async () => {
  const app = loadAppForTest();
  app.seed();
  app.state.overridesByMonth['2026-09'] = { variable: { Shenzhen: { CNY: 95 } } };
  app.resetStandardsToDefault();
  assert.equal(app.loadOverrides(), true, '旧版差异结构仍应能够读取');
  assert.equal(app.state.standards.variable.Shenzhen.CNY, 95);
  let stateBody = null;
  app.setApi(async (url, options = {}) => {
    assert.equal(url, '/api/state');
    stateBody = JSON.parse(JSON.stringify(options.body));
    return options.body;
  });

  assert.equal(await app.persistNow(), true);

  const saved = stateBody.overridesByMonth['2026-09'];
  assert.equal(saved._snapshot, true);
  assert.equal(saved.variable.Shenzhen.CNY, 95);
  assert.equal(saved.fixed.Mainland.CNY, 64, '完整快照不能只保留相对默认值的差异');

  const reloaded = loadAppForTest();
  reloaded.seed();
  reloaded.state.meta.default_standards.variable.Shenzhen.CNY = 777;
  reloaded.resetStandardsToDefault();
  reloaded.state.overridesByMonth = { '2026-09': saved };
  reloaded.loadOverrides();
  assert.equal(reloaded.state.standards.variable.Shenzhen.CNY, 95,
    '另一标签修改默认值后，已保存月份不得按新默认值重新解释');
});

test('月度计算始终提交用户已确认的完整标准快照，不受并发默认值变化影响', () => {
  const app = loadAppForTest();
  app.seed();
  app.state.standards.variable.Shenzhen.CNY = 95;
  app.state.meta.default_standards.variable.Shenzhen.CNY = 777;

  const submitted = app.activeStandardsOverride();
  assert.equal(submitted._snapshot, true);
  assert.equal(submitted.variable.Shenzhen.CNY, 95);
  assert.equal(submitted.fixed.Mainland.CNY, 64, '请求必须包含完整标准，不能只发送差异');
});

test('收起编辑区会丢弃草稿；重新展开又能拿到干净的草稿', () => {
  const app = loadAppForTest();
  app.seed();
  app.openDefaultsModal();
  app.state.defaultsDraft.standards.variable.Shenzhen.CNY = 120;

  app.reconstructDefaultsDraft();
  app.closeDefaultsModal();
  assert.equal(app.state.editingDefaults, false);
  assert.equal(app.defaultsDraftDirty(), false, '收起后不再算作有未保存改动');
  assert.equal(app.state.standards.variable.Shenzhen.CNY, 80, '收起不应改动当月');

  app.openDefaultsModal();
  assert.equal(app.state.defaultsDraft.standards.variable.Shenzhen.CNY, 80, '重新展开应为已保存默认值');
});

test('两个区域的输入互不影响（当月改当月，默认改草稿）', () => {
  const app = loadAppForTest();
  app.seed();
  app.openDefaultsModal();

  // 当月输入：只改 state.standards 与当月覆盖
  app.applyMonthInput('variable', 'Shenzhen', 'CNY', '', 95);
  assert.equal(app.state.standards.variable.Shenzhen.CNY, 95);
  assert.equal(app.state.defaultsDraft.standards.variable.Shenzhen.CNY, 80, '默认草稿不受影响');
  assert.equal(app.state.overridesByMonth['2026-09'].variable.Shenzhen.CNY, 95, '当月改动应记入覆盖');

  // 默认区域输入：只改草稿
  app.applyDefaultsInput('variable', 'Shenzhen', 'CNY', '', 130);
  assert.equal(app.state.defaultsDraft.standards.variable.Shenzhen.CNY, 130);
  assert.equal(app.state.standards.variable.Shenzhen.CNY, 95, '当月数值不受默认草稿影响');
});

test('还原把草稿中的某项恢复为已保存默认值', () => {
  const app = loadAppForTest();
  app.seed();
  app.openDefaultsModal();
  app.state.defaultsDraft.standards.variable.Shenzhen.CNY = 120;
  assert.equal(app.defaultsDraftDirty(), true);

  app.restoreDefaultEntry('variable', 'Shenzhen', 'CNY', '');
  assert.equal(app.state.defaultsDraft.standards.variable.Shenzhen.CNY, 80);
  assert.equal(app.defaultsDraftDirty(), false);
});

test('渲染两个区域都不抛异常（含旅居开关）', () => {
  const app = loadAppForTest();
  app.seed();
  app.renderStandards();
  app.syncStandardsModeUI();

  app.state.includeTravel = true;
  app.renderStandards();
  app.openDefaultsModal();
  app.state.defaultsDraft.standards.travel.Shanghai.CNY.daily = 200;
  app.renderStandards();
  app.syncStandardsModeUI();
});

/* ---------- 默认标准弹窗的显示范围（显示所有默认预算） ---------- */

test('未勾选「显示所有默认预算」时只看本月对应的部分（当前区域 + 本月行程里的旅居地点）', () => {
  const app = loadAppForTest();
  app.seed();
  app.openDefaultsModal();
  app.state.itineraryByMonth['2026-09'] = { Shanghai: [{ start: '2026-09-01', end: '2026-09-03' }] };
  app.state.region = 'Overseas';

  const scope = app.defaultsScope();
  assert.deepEqual(Array.from(scope.regions), ['Overseas'], '只显示本月居住区域的固定预算');
  assert.deepEqual(Array.from(scope.travelLocs), ['Shanghai'], '只显示本月行程里的旅居地点');
});

test('勾选「显示所有默认预算」时内地/境外与全部旅居地点都出现', () => {
  const app = loadAppForTest();
  app.seed();
  app.openDefaultsModal();
  app.state.defaultsShowAll = true;

  const scope = app.defaultsScope();
  assert.deepEqual(Array.from(scope.regions), ['Mainland', 'Overseas']);
  assert.deepEqual(Array.from(scope.travelLocs), ['Shanghai', 'Taipei'], '未出现在本月行程里的旅居地点也要显示');
});

test('默认标准弹窗的旅居预算不再依赖「包含旅居」开关，且不再只列已勾选地点', () => {
  const app = loadAppForTest();
  app.seed();
  assert.equal(app.state.includeTravel, false, '本月未勾选「包含旅居」');
  app.openDefaultsModal();
  app.renderStandards();

  const host = app.el('.defaults-editor');
  assert.match(host.innerHTML, /旅居预算/, '关掉旅居开关时默认标准弹窗仍应有旅居预算');
  assert.match(host.innerHTML, /data-table="travel"/);
  assert.doesNotMatch(host.innerHTML, /Taipei/, '未勾选时只列本月行程里的旅居地点');
  assert.match(host.innerHTML, /＋ 新建旅居地点/, '没有可编辑地点时也要能新建');

  app.state.region = 'Overseas';
  app.state.defaultsShowAll = true;
  app.renderDefaultsPanel();
  assert.match(host.innerHTML, /境外/, '勾选后境外固定预算一并显示');
  assert.match(host.innerHTML, /内地/);
  assert.match(host.innerHTML, /Taipei/, '勾选后显示全部旅居地点');
});

test('显示范围开关只影响展示：不改数值、不写覆盖、不发请求', () => {
  const app = loadAppForTest();
  app.seed();
  app.openDefaultsModal();
  const monthSnapshot = JSON.stringify(app.state.standards);
  const draftSnapshot = JSON.stringify(app.state.defaultsDraft.standards);
  const callsBefore = app.fetchCalls.length;

  app.state.defaultsShowAll = true;
  app.renderDefaultsPanel();
  app.updateDefaultsScopeHint();
  app.syncStandardsModeUI();

  assert.equal(JSON.stringify(app.state.standards), monthSnapshot, '当月标准不应被显示范围影响');
  assert.equal(JSON.stringify(app.state.defaultsDraft.standards), draftSnapshot, '草稿不应被显示范围影响');
  assert.equal(app.state.overridesByMonth['2026-09'], undefined, '显示范围不应写成当月覆盖');
  assert.equal(app.fetchCalls.length, callsBefore, '显示范围切换不应发任何请求');
  assert.equal(app.defaultsDraftDirty(), false);
});

test('当月预算面板仍按「包含旅居」与勾选过滤，不受默认标准弹窗影响', () => {
  const app = loadAppForTest();
  app.seed();
  app.state.defaultsShowAll = true;
  app.renderStandards();
  assert.equal(app.el('#travel-standards-host').innerHTML, '', '未勾选「包含旅居」时当月面板没有旅居小节');

  app.state.includeTravel = true;
  app.state.travelSelected = new Set(['Taipei']);
  app.renderStandards();
  const host = app.el('#travel-standards-host');
  assert.match(host.innerHTML, /Taipei/);
  assert.doesNotMatch(host.innerHTML, /Shanghai/, '当月面板只显示本次勾选的旅居地点');
});

test('默认标准弹窗的「＋ 新建币种」按分组写入目标区域', () => {
  const app = loadAppForTest();
  app.seed();
  app.openDefaultsModal();

  app.openAddStandard('fixed', 'Overseas');
  app.el('#af-currency').value = 'EUR';
  app.el('#af-name').value = '欧元';
  app.el('#af-daily').value = '12';
  app.confirmAddStandard();
  assert.equal(app.state.defaultsDraft.standards.fixed.Overseas.EUR, 12);
  assert.equal(app.state.defaultsDraft.standards.fixed.Mainland.EUR, undefined);

  // 同一币种可以再加进内地（重复判断只看目标区域）
  app.openAddStandard('fixed', 'Mainland');
  app.el('#af-currency').value = 'EUR';
  app.el('#af-daily').value = '20';
  app.confirmAddStandard();
  assert.equal(app.state.defaultsDraft.standards.fixed.Mainland.EUR, 20);
  assert.equal(app.state.standards.fixed.Mainland.EUR, undefined, '新建默认币种不得改动当月标准');
  assert.equal(app.defaultsDraftDirty(), true);
});
