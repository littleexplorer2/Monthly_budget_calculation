'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { loadFrontend } = require('./helpers/frontend-loader.js');

function loadAppForTest() {
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
  loadFrontend(context);
  vm.runInContext(`
    const modules = window.BudgetApp.modules;
    const clone = (value) => JSON.parse(JSON.stringify(value));
    const monthEntity = (month, revision = 1) => ({
      schemaVersion: 2,
      month,
      revision,
      updatedAt: '2026-09-01T00:00:00Z',
      itinerary: { Shenzhen: [{ start: month + '-01', end: month + '-02' }] },
      options: { region: 'Mainland', includeTravel: false, travelSelected: null },
      standards: {
        _snapshot: true,
        variable: { Shenzhen: { CNY: 85 } },
        travel: {},
        custom_locations: [], custom_currencies: {},
        _locations: [{ key: 'Shenzhen', name: '深圳', category: 'variable', currency: 'CNY' }],
        _location_names: { Shenzhen: '深圳' }, _currency_names: { CNY: '人民币' },
      },
      subscriptions: { items: [], retiredIds: [] },
      result: null,
    });

    globalThis.testApi = {
      seed(month = '2026-09', revision = 1) {
        const entity = monthEntity(month, revision);
        modules.state.state.meta = {
          default_standards: { variable: { Shenzhen: { CNY: 85 } }, fixed: {}, travel: {}, extra: {} },
          default_subscriptions: [], default_subscriptions_configured: true,
          locations: entity.standards._locations,
          location_names: entity.standards._location_names,
          currency_names: entity.standards._currency_names,
        };
        modules.state.state.year = 2026;
        modules.state.state.month = 9;
        modules.state.state.monthsByKey = { [month]: clone(entity) };
        modules.state.state.globalRevision = 1;
        modules.state.state.annualBudgetsByYear = {};
        modules.state.state.annualResultsByYear = {};
        modules.state.state.assetPortfoliosById = {};
        modules.persistence.runtime.serverMonthBaselines = { [month]: clone(entity) };
        modules.persistence.runtime.globalBaseline = {
          schemaVersion: 2, revision: 1, selectedMonth: month,
          annualBudgetsByYear: {}, annualResultsByYear: {}, assetPortfoliosById: {},
        };
        modules.persistence.runtime.serverStateReady = true;
        modules.persistence.runtime.dirtyMonthFields = Object.create(null);
        modules.persistence.runtime.dirtyGlobalFields = new Set();
        return clone(entity);
      },
      entity(month = '2026-09') { return modules.state.state.monthsByKey[month]; },
      baseline(month = '2026-09') { return modules.persistence.runtime.serverMonthBaselines[month]; },
      dirty(month = '2026-09') {
        return Array.from(modules.persistence.runtime.dirtyMonthFields[month] || []);
      },
      mark(field, month = '2026-09') { modules.persistence.markMonthDirty(field, month); },
      markGlobal(field) { modules.persistence.markGlobalDirty(field); },
      flush: modules.persistence.flushPersist,
      persist: modules.persistence.persist,
      ensureDraft: modules.persistence.ensureLocalMonthDraft,
      snapshot: modules.persistence.snapshotBundle,
      applyOffline: modules.persistence.applyOfflineBundle,
      finalBundle: modules.persistence.finalWriteBundle,
      deleteMonth: modules.persistence.deleteMonth,
      saveSelection: modules.persistence.saveSelection,
      unregister: modules.lifecycle.unregisterTab,
      register: modules.lifecycle.registerTab,
      runtime: modules.persistence.runtime,
      state: modules.state.state,
      setApi(mock) {
        modules.http.api = mock;
        modules.feedback.toast = () => {};
      },
      setBeacon(mock) { navigator.sendBeacon = mock; },
      poisonQueue() {
        modules.persistence.runtime.persistChain = Promise.reject(new Error('queue setup failed'));
        modules.persistence.runtime.persistChain.catch(() => {});
      },
    };
  `, context);
  return {
    ...context.testApi,
    storage,
    keepaliveCalls,
    dispatchWindow(type, event = {}) {
      for (const handler of windowListeners.get(type) || []) handler(event);
    },
  };
}

test('revision=0 draft is explicitly ensured before the first entity PUT', async () => {
  const app = loadAppForTest();
  app.seed();
  delete app.state.monthsByKey['2026-09'];
  delete app.runtime.serverMonthBaselines['2026-09'];
  const draft = app.ensureDraft('2026-09');
  draft.itinerary = { Shenzhen: [{ start: '2026-09-03', end: '2026-09-04' }] };
  app.mark('itinerary');
  const calls = [];
  app.setApi(async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/ensure')) return { created: true, month: { ...draft, revision: 1 } };
    if (url === '/api/months/2026-09' && options.method === 'PUT') {
      return { ...draft, revision: 2, ...options.body.data };
    }
    throw new Error(`unexpected ${url}`);
  });

  assert.equal(await app.flush(), true);
  assert.deepEqual(calls.map((call) => call.url), [
    '/api/months/2026-09/ensure', '/api/months/2026-09',
  ]);
  assert.equal(calls[1].options.body.base_revision, 1);
  assert.equal(app.entity().revision, 2);
  assert.equal(JSON.stringify(app.dirty()), '[]');
});

test('whole-entity CAS automatically merges non-overlapping field updates and retries', async () => {
  const app = loadAppForTest();
  const original = app.seed();
  app.entity().itinerary.Shenzhen[0].end = '2026-09-03';
  app.mark('itinerary');
  const latest = { ...original, revision: 2, options: { ...original.options, region: 'Overseas' } };
  let putCount = 0;
  app.setApi(async (url, options = {}) => {
    if (url === '/api/months/2026-09' && options.method === 'PUT') {
      putCount += 1;
      if (putCount === 1) {
        const error = new Error('conflict'); error.code = 'STATE_CONFLICT'; throw error;
      }
      return { ...latest, ...options.body.data, revision: 3 };
    }
    if (url === '/api/months/2026-09') return latest;
    throw new Error(`unexpected ${url}`);
  });

  assert.equal(await app.flush(), true);
  assert.equal(putCount, 2);
  assert.equal(app.entity().options.region, 'Overseas');
  assert.equal(app.entity().itinerary.Shenzhen[0].end, '2026-09-03');
});

test('same-field conflict keeps local edits dirty and never overwrites the newer server entity', async () => {
  const app = loadAppForTest();
  const original = app.seed();
  app.entity().options.region = 'Overseas';
  app.mark('options');
  const latest = { ...original, revision: 2, options: { ...original.options, includeTravel: true } };
  app.setApi(async (url, options = {}) => {
    if (options.method === 'PUT') { const error = new Error('conflict'); error.code = 'STATE_CONFLICT'; throw error; }
    return latest;
  });

  assert.equal(await app.flush(), false);
  assert.equal(app.entity().options.region, 'Overseas');
  assert.equal(app.entity().options.includeTravel, false, '冲突字段保留本机完整值供用户核对');
  assert.equal(JSON.stringify(app.dirty()), '["options"]');
  assert.equal(app.baseline().options.includeTravel, true);
});

test('annual and asset writes use only global.json and carry its business revision', async () => {
  const app = loadAppForTest();
  app.seed();
  app.state.annualBudgetsByYear = { 2026: { USD: 100 } };
  app.markGlobal('annualBudgetsByYear');
  const calls = [];
  app.setApi(async (url, options = {}) => {
    calls.push({ url, options });
    return {
      schemaVersion: 2, revision: 2, selectedMonth: '2026-09',
      annualBudgetsByYear: options.body.data.annualBudgetsByYear,
      annualResultsByYear: {}, assetPortfoliosById: {},
    };
  });

  assert.equal(await app.flush(), true);
  assert.deepEqual(calls.map((call) => call.url), ['/api/global']);
  assert.equal(calls[0].options.body.base_revision, 1);
  assert.equal('months' in calls[0].options.body.data, false);
});

test('month selection is a separate last-write-wins request', async () => {
  const app = loadAppForTest();
  app.seed();
  const calls = [];
  app.setApi(async (url, options = {}) => {
    calls.push({ url, options });
    return { revision: 1, selectedMonth: options.body.month };
  });
  assert.equal(await app.saveSelection('2026-10'), true);
  assert.deepEqual(calls.map((call) => call.url), ['/api/global/selection']);
  assert.equal(JSON.stringify(calls[0].options.body), JSON.stringify({ month: '2026-10' }));
});

test('delete sends the entity revision before removing local state', async () => {
  const app = loadAppForTest();
  app.seed('2026-02', 7);
  const calls = [];
  app.setApi(async (url, options = {}) => {
    calls.push({ url, options });
    return { deleted: true };
  });
  assert.equal(await app.deleteMonth('2026-02'), true);
  assert.equal(calls[0].url, '/api/months/2026-02');
  assert.equal(calls[0].options.method, 'DELETE');
  assert.equal(calls[0].options.body.base_revision, 7);
  assert.equal(app.state.monthsByKey['2026-02'], undefined);
});

test('unregister sends only dirty v2 entities; oversized payload keeps the service alive', () => {
  const app = loadAppForTest();
  app.seed();
  app.entity().result = { summary: { total: 1 }, auditNote: 'x'.repeat(70000) };
  app.mark('result');
  let beaconBody = null;
  app.setBeacon((_url, blob) => {
    beaconBody = blob;
    return true;
  });
  app.unregister();
  assert.ok(beaconBody);
  return beaconBody.text().then((text) => {
    const payload = JSON.parse(text);
    assert.equal(payload.tab_id, 'test-tab');
    assert.equal(payload.state, undefined);
    assert.equal(payload.state_omitted, true);
    assert.equal(app.storage.has('budget-web-state-v2'), true);
  });
});

test('ordinary unregister carries a revision-guarded entity bundle', () => {
  const app = loadAppForTest();
  app.seed();
  app.entity().options.region = 'Overseas';
  app.mark('options');
  let beaconBody = null;
  app.setBeacon((_url, blob) => { beaconBody = blob; return true; });
  app.unregister();
  return beaconBody.text().then((text) => {
    const payload = JSON.parse(text);
    assert.equal(payload.state.schemaVersion, 2);
    assert.equal(payload.state.months.length, 1);
    assert.equal(payload.state.months[0].base_revision, 1);
    assert.equal(payload.state.months[0].data.options.region, 'Overseas');
  });
});

test('bfcache pagehide leaves the tab registered and later edits remain writable', async () => {
  const app = loadAppForTest();
  app.seed();
  app.register();
  app.dispatchWindow('pagehide', { persisted: true });
  app.entity().options.region = 'Overseas';
  app.mark('options');
  let writes = 0;
  app.setApi(async (_url, options = {}) => {
    if (options.method === 'PUT') writes += 1;
    return { ...app.entity(), revision: 2 };
  });
  assert.equal(await app.flush(), true);
  assert.equal(writes, 1);
});

test('a rejected persist chain is normalized so later writes are not poisoned', async () => {
  const app = loadAppForTest();
  app.seed();
  app.entity().options.region = 'Overseas';
  app.mark('options');
  app.poisonQueue();
  app.setApi(async (_url, options = {}) => ({ ...app.entity(), ...options.body.data, revision: 2 }));
  const first = app.persist('now');
  await assert.rejects(first, /queue setup failed/);
  // persist() always replaces the public queue with a settled continuation.
  assert.equal(await app.persist('now'), true);
});
