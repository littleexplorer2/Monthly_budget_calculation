'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadAppForTest() {
  const appPath = path.join(__dirname, '..', 'web', 'js', 'app.js');
  const source = fs.readFileSync(appPath, 'utf8');
  const storage = new Map();
  const keepaliveCalls = [];
  const windowListeners = new Map();
  const context = {
    AbortController,
    Blob,
    clearTimeout,
    console,
    Date,
    fetch: async (...args) => {
      keepaliveCalls.push(args);
      return { ok: true, status: 200, json: async () => ({}) };
    },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      removeItem: (key) => storage.delete(key),
      setItem: (key, value) => storage.set(key, String(value)),
    },
    navigator: {},
    setTimeout,
    window: {
      addEventListener: (type, handler) => {
        const handlers = windowListeners.get(type) || [];
        handlers.push(handler);
        windowListeners.set(type, handlers);
      },
      confirm: () => true,
      crypto: { randomUUID: () => 'test-tab' },
    },
    document: {
      addEventListener: () => {},
      querySelector: () => null,
      querySelectorAll: () => [],
    },
  };
  vm.createContext(context);
  vm.runInContext(`${source}\n
    globalThis.testApi = {
      deleteMonth: deleteMonthData,
      flush: flushPersist,
      unregister: unregisterTab,
      heartbeat: heartbeatTab,
      uploadAll: uploadAllData,
      seed(month) {
        serverStateReady = true;
        state.meta = {
          default_standards: { variable: {}, fixed: {}, travel: {}, extra: {} },
          locations: [],
          location_names: {},
          currency_names: {},
        };
        state.year = 2026;
        state.month = 9;
        state.itineraryByMonth = { [month]: { Shenzhen: [{ start: month + '-01', end: month + '-02' }] } };
        state.optionsByMonth = { [month]: { region: 'Mainland' } };
        state.overridesByMonth = { [month]: { fixed: { Mainland: { CNY: 1 } } } };
        state.resultsByMonth = { [month]: { summary: { total: 1 } } };
      },
      setApi(mock) {
        api = mock;
        openDataManager = async () => {};
        toast = () => {};
      },
      setBeacon(mock) {
        navigator.sendBeacon = mock;
      },
      setServerBaseline(bundle) {
        serverBaseline = JSON.parse(JSON.stringify(bundle));
        serverStateReady = true;
      },
      touchMonthlyState() {
        persist('debounce');
      },
      markServerReadFailed() {
        serverStateReady = false;
        serverBaseline = null;
      },
      isServerStateReady() {
        return serverStateReady;
      },
      setResultTotal(month, total) {
        state.resultsByMonth[month].summary.total = total;
      },
      buildWrite(bundle) {
        return buildStateWrite(bundle);
      },
      applyBundle,
      snapshot: snapshotBundle,
    };
  `, context);
  return {
    ...context.testApi,
    keepaliveCalls,
    dispatchWindow(type, event = {}) {
      for (const handler of windowListeners.get(type) || []) handler(event);
    },
  };
}

test('deleting February waits for queued writes and removes local tombstones', async () => {
  const app = loadAppForTest();
  const month = '2026-02';
  const stateWrites = [];
  let releaseFirstWrite;
  const firstWrite = new Promise((resolve) => { releaseFirstWrite = resolve; });

  app.seed(month);
  app.setApi(async (url, options = {}) => {
    if (url === '/api/state') {
      stateWrites.push(JSON.parse(JSON.stringify(options.body)));
      if (stateWrites.length === 1) await firstWrite;
      return {};
    }
    if (url === '/api/data/rates/delete') return { removed: [month], months: [] };
    return {};
  });

  const queuedWrite = app.flush();
  let deletionFinished = false;
  const deletion = app.deleteMonth(month).then(() => { deletionFinished = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(deletionFinished, false, 'delete must wait for the earlier state write');

  releaseFirstWrite();
  await Promise.all([queuedWrite, deletion]);

  const snapshot = JSON.parse(JSON.stringify(app.snapshot()));
  for (const field of ['itineraryByMonth', 'optionsByMonth', 'overridesByMonth', 'resultsByMonth']) {
    assert.equal(month in snapshot[field], false, `${field} retained an empty February tombstone`);
    assert.deepEqual(stateWrites.at(-1)[field][month], {}, `${field} did not send a deletion tombstone`);
  }
});

test('upload saves the latest state before requesting the remote push', async () => {
  const app = loadAppForTest();
  const calls = [];
  app.seed('2026-02');
  app.setApi(async (url) => {
    calls.push(url);
    if (url === '/api/data/upload') {
      return { remote: 'origin', branch: 'main', commit: 'abc1234', message: '数据已提交并上传' };
    }
    return {};
  });

  await app.uploadAll();
  assert.deepEqual(calls, ['/api/state', '/api/data/upload']);
});

test('closing the page sends one complete state snapshot with unregister', async () => {
  const app = loadAppForTest();
  const month = '2026-02';
  let beaconPayload;
  app.seed(month);
  app.touchMonthlyState();
  app.setBeacon((url, blob) => {
    beaconPayload = blob.text().then((text) => ({ url, body: JSON.parse(text) }));
    return true;
  });

  app.unregister();
  const sent = await beaconPayload;
  assert.equal(sent.url, '/api/tabs/unregister');
  assert.equal(sent.body.tab_id, 'test-tab');
  for (const field of ['itineraryByMonth', 'optionsByMonth', 'overridesByMonth', 'resultsByMonth']) {
    assert.equal(month in sent.body.state[field], true, `${field} missing from final snapshot`);
  }
});

test('heartbeat refreshes the server lease when Safari loses the close event', async () => {
  const app = loadAppForTest();
  const calls = [];
  app.seed('2026-02');
  app.setApi(async (url, options = {}) => {
    calls.push([url, options]);
    return { open_tabs: 1 };
  });

  await app.heartbeat();

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/api/tabs/heartbeat');
  assert.deepEqual(
    JSON.parse(JSON.stringify(calls[0][1].body)),
    { tab_id: 'test-tab' },
  );
});

test('sendBeacon refusal falls back to a keepalive unregister request', async () => {
  const app = loadAppForTest();
  app.seed('2026-02');
  app.touchMonthlyState();
  app.setBeacon(() => false);

  app.unregister();
  await new Promise((resolve) => setImmediate(resolve));

  const unregisterCalls = app.keepaliveCalls.filter(([url]) => url === '/api/tabs/unregister');
  assert.equal(unregisterCalls.length, 1, JSON.stringify(app.keepaliveCalls.map(([url]) => url)));
  const [url, options] = unregisterCalls[0];
  assert.equal(url, '/api/tabs/unregister');
  assert.equal(options.keepalive, true);
  assert.equal(JSON.parse(options.body).tab_id, 'test-tab');
});

test('sendBeacon exception also falls back to keepalive fetch', async () => {
  const app = loadAppForTest();
  app.seed('2026-02');
  app.touchMonthlyState();
  app.setBeacon(() => { throw new Error('beacon queue unavailable'); });

  app.unregister();
  await new Promise((resolve) => setImmediate(resolve));

  const unregisterCalls = app.keepaliveCalls.filter(([url]) => url === '/api/tabs/unregister');
  assert.equal(unregisterCalls.length, 1);
  assert.equal(unregisterCalls[0][1].keepalive, true);
});

test('bfcache pagehide keeps the tab registered and writable', async () => {
  const app = loadAppForTest();
  let beacons = 0;
  const calls = [];
  app.seed('2026-02');
  app.setServerBaseline(JSON.parse(JSON.stringify(app.snapshot())));
  app.setBeacon(() => { beacons += 1; return true; });
  app.setApi(async (url) => {
    calls.push(url);
    return app.snapshot();
  });

  app.dispatchWindow('pagehide', { persisted: true });
  app.dispatchWindow('pageshow', { persisted: true });
  assert.equal(beacons, 0, '进入 bfcache 时不得注销最后一个标签页');
  assert.equal(await app.flush(), true, '从 bfcache 返回后仍应保持可写');
  assert.deepEqual(calls, ['/api/state']);
});

test('failed server state read never writes stale local cache back to the server', async () => {
  const app = loadAppForTest();
  const calls = [];
  let beaconPayload;
  app.seed('2026-02');
  app.markServerReadFailed();
  app.setApi(async (url) => {
    calls.push(url);
    return {};
  });
  app.setBeacon((url, blob) => {
    beaconPayload = blob.text().then((text) => ({ url, body: JSON.parse(text) }));
    return true;
  });

  assert.equal(await app.flush(), false);
  assert.deepEqual(calls, [], '无可信服务器基线时不得 PUT 旧 localStorage 快照');

  app.unregister();
  const sent = await beaconPayload;
  assert.equal(sent.url, '/api/tabs/unregister');
  assert.deepEqual(sent.body, { tab_id: 'test-tab' },
    '关闭页只注销标签，不得附带无基线的旧状态');
});

test('state persistence starts locked until the initial server read is trusted', () => {
  const app = loadAppForTest();
  assert.equal(app.isServerStateReady(), false);
});

test('an unchanged stale tab omits month keys while an edit carries its compare baseline', () => {
  const app = loadAppForTest();
  const month = '2026-02';
  app.seed(month);
  const baseline = JSON.parse(JSON.stringify(app.snapshot()));
  app.setServerBaseline(baseline);

  const unchanged = app.buildWrite(app.snapshot()).payload;
  for (const field of ['itineraryByMonth', 'optionsByMonth', 'overridesByMonth', 'resultsByMonth']) {
    assert.equal(field in unchanged, false,
      `unchanged stale tab must not resend ${field} and resurrect another tab's deletion`);
  }

  const edited = JSON.parse(JSON.stringify(app.snapshot()));
  edited.resultsByMonth[month].summary.total = 2;
  const write = app.buildWrite(edited).payload;
  assert.equal(write.resultsByMonth[month].summary.total, 2);
  assert.deepEqual(
    JSON.parse(JSON.stringify(write.baseValues.resultsByMonth[month])),
    { exists: true, value: baseline.resultsByMonth[month] },
    'same-key edits must include the old value for an atomic server conflict check',
  );

  const nextMonth = JSON.parse(JSON.stringify(app.snapshot()));
  nextMonth.month = 10;
  const selectionWrite = app.buildWrite(nextMonth).payload;
  assert.equal(selectionWrite.year, 2026, 'year/month selection must be submitted atomically');
  assert.equal(selectionWrite.month, 10);
  assert.ok(selectionWrite.baseValues.year);
  assert.ok(selectionWrite.baseValues.month);
});

test('loading more than 60 server months never turns local cache trimming into deletion tombstones', async () => {
  const app = loadAppForTest();
  const months = Array.from({ length: 61 }, (_, index) => {
    const year = 2021 + Math.floor(index / 12);
    const month = (index % 12) + 1;
    return `${year}-${String(month).padStart(2, '0')}`;
  });
  const current = months.at(-1);
  const bundle = {
    version: 1,
    updatedAt: '2026-01-01T00:00:00Z',
    year: Number(current.slice(0, 4)),
    month: Number(current.slice(5, 7)),
    itineraryByMonth: {},
    optionsByMonth: {},
    overridesByMonth: {},
    resultsByMonth: {},
    annualBudgetsByYear: {},
    annualResultsByYear: {},
  };
  for (const month of months) {
    bundle.itineraryByMonth[month] = {
      Shenzhen: [{ start: `${month}-01`, end: `${month}-02` }],
    };
    bundle.optionsByMonth[month] = { region: 'Mainland' };
  }
  bundle.resultsByMonth[current] = { summary: { total: 1 } };

  const stateWrites = [];
  app.setApi(async (url, options = {}) => {
    if (url === '/api/state') stateWrites.push(JSON.parse(JSON.stringify(options.body)));
    return {};
  });
  app.setServerBaseline(bundle);
  app.applyBundle(bundle);

  const loaded = JSON.parse(JSON.stringify(app.snapshot()));
  assert.equal(Object.keys(loaded.itineraryByMonth).length, 61);
  assert.equal(Object.keys(loaded.optionsByMonth).length, 61);

  app.setResultTotal(current, 2);
  assert.equal(await app.flush(), true);
  assert.equal(stateWrites.length, 1);
  assert.equal('itineraryByMonth' in stateWrites[0], false,
    'localStorage 容量限制不得为服务器旧行程生成删除墓碑');
  assert.equal('optionsByMonth' in stateWrites[0], false,
    'localStorage 容量限制不得为服务器旧选项生成删除墓碑');
  assert.equal(stateWrites[0].resultsByMonth[current].summary.total, 2);
});

test('final unregister write accepts the target of this tab pending PUT as an alternate base', async () => {
  const app = loadAppForTest();
  const month = '2026-02';
  app.seed(month);
  app.setServerBaseline(JSON.parse(JSON.stringify(app.snapshot())));
  let releaseWrite;
  const pending = new Promise((resolve) => { releaseWrite = resolve; });
  app.setApi(async (url) => {
    if (url === '/api/state') await pending;
    return {};
  });

  app.setResultTotal(month, 2);
  const firstWrite = app.flush();
  await new Promise((resolve) => setImmediate(resolve));
  app.setResultTotal(month, 3);

  let beaconPayload;
  app.setBeacon((url, blob) => {
    beaconPayload = blob.text().then((text) => ({ url, body: JSON.parse(text) }));
    return true;
  });
  app.unregister();
  const sent = await beaconPayload;
  const marker = sent.body.state.baseValues.resultsByMonth[month];
  assert.equal(sent.body.state.resultsByMonth[month].summary.total, 3);
  assert.deepEqual(marker.alternatives.map((item) => item.value.summary.total), [2],
    'final beacon must accept the pending write target, not only the older server baseline');

  releaseWrite();
  await firstWrite;
});

test('final unregister keeps a user rollback while a prior write is active and uses a newer sequence', async () => {
  const app = loadAppForTest();
  const month = '2026-09';
  app.seed(month);
  app.setServerBaseline(JSON.parse(JSON.stringify(app.snapshot())));
  let releaseWrite;
  const pending = new Promise((resolve) => { releaseWrite = resolve; });
  const stateWrites = [];
  app.setApi(async (url, options = {}) => {
    if (url === '/api/state') {
      stateWrites.push(JSON.parse(JSON.stringify(options.body)));
      await pending;
    }
    return {};
  });

  // 服务器基线和用户最终值都是 X=1；在途请求先尝试写成 A=2。
  app.setResultTotal(month, 2);
  const activeWrite = app.flush();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stateWrites.length, 1);
  const activeSequence = stateWrites[0].sequence;
  app.setResultTotal(month, 1);

  let beaconPayload;
  app.setBeacon((url, blob) => {
    beaconPayload = blob.text().then((text) => JSON.parse(text));
    return true;
  });
  app.unregister();
  const sent = await beaconPayload;

  assert.equal(sent.state.resultsByMonth[month].summary.total, 1,
    '最终 beacon 必须显式带回用户回退后的 X，不能让在途 A 获胜');
  assert.ok(sent.state.sequence > activeSequence,
    '最终 beacon 的标签内序列必须高于在途 PUT');
  const alternatives = sent.state.baseValues.resultsByMonth[month].alternatives || [];
  assert.deepEqual(alternatives.map((item) => item.value.summary.total), [2],
    '最终写入应允许在途请求的 A 作为合法前置状态');

  releaseWrite();
  await activeWrite;
});

test('a write with an uncertain response remains an alternate base for final unregister', async () => {
  const app = loadAppForTest();
  const month = '2026-02';
  app.seed(month);
  app.setServerBaseline(JSON.parse(JSON.stringify(app.snapshot())));
  app.setApi(async () => { throw new Error('response lost after request may have committed'); });

  app.setResultTotal(month, 2);
  assert.equal(await app.flush(), false);
  app.setResultTotal(month, 3);
  let beaconPayload;
  app.setBeacon((url, blob) => {
    beaconPayload = blob.text().then((text) => JSON.parse(text));
    return true;
  });
  app.unregister();

  const sent = await beaconPayload;
  const marker = sent.state.baseValues.resultsByMonth[month];
  assert.deepEqual(marker.alternatives.map((item) => item.value.summary.total), [2]);
  assert.equal(sent.state.resultsByMonth[month].summary.total, 3);
});
