'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { loadFrontend } = require('./helpers/frontend-loader.js');

const webRoot = path.join(__dirname, '..', 'web');
const bootstrap = fs.readFileSync(path.join(webRoot, 'js', 'app.js'), 'utf8');

function contextForModules() {
  const listeners = new Map();
  const calls = [];
  const context = vm.createContext({
    AbortController, Blob, console, clearTimeout, setTimeout,
    fetch: async (url) => { calls.push(url); return { ok: true, json: async () => ({}) }; },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: {},
    window: {
      crypto: { randomUUID: () => 'module-test' },
      addEventListener(name, callback) { listeners.set(name, callback); },
    },
    document: { addEventListener(name, callback) { listeners.set(name, callback); }, querySelector: () => null, querySelectorAll: () => [] },
  });
  return { context, listeners, calls };
}

test('production script list assembles isolated modules and registers startup once', async () => {
  const { context, listeners, calls } = contextForModules();
  const app = loadFrontend(context);
  await Promise.resolve();
  assert.equal(app.state, app.modules.state.state);
  assert.equal(listeners.get('DOMContentLoaded'), app.modules.shell.init);
  assert.deepEqual(calls, ['/api/tabs/register']);
  assert.equal(typeof listeners.get('pagehide'), 'function');
  assert.equal(typeof listeners.get('pageshow'), 'function');
  assert.equal(context.state, undefined, 'UI state must not leak into the global scope');
  assert.equal(context.persist, undefined, 'persistence must only be reachable through its module interface');
  assert.equal(context.calculate, undefined, 'monthly actions must keep their module scope');
  for (const [name, definition] of Object.entries(context.window.BudgetModules)) {
    for (const dependency of definition.dependencies) assert.ok(app.modules[dependency], `${name}: ${dependency}`);
  }
  clearTimeout(app.modules.lifecycle.runtime.tabHeartbeatTimer);
});

test('bootstrap rejects a missing production module before starting any network request', () => {
  const { context, calls } = contextForModules();
  loadFrontend(context);
  clearTimeout(context.window.BudgetApp.modules.lifecycle.runtime.tabHeartbeatTimer);
  calls.length = 0;
  delete context.window.BudgetModules.annual;
  assert.throws(() => vm.runInContext(bootstrap, context), /缺少前端模块：annual/);
  assert.deepEqual(calls, []);
});

test('bootstrap rejects an undeclared module target before lifecycle side effects', () => {
  const { context, calls } = contextForModules();
  loadFrontend(context);
  clearTimeout(context.window.BudgetApp.modules.lifecycle.runtime.tabHeartbeatTimer);
  calls.length = 0;
  const previous = context.window.BudgetModules.monthly;
  context.window.BudgetModules.monthly = {
    ...previous,
    dependencies: [...previous.dependencies, 'missingDependency'],
  };
  assert.throws(() => vm.runInContext(bootstrap, context), /monthly 依赖未注册模块：missingDependency/);
  assert.deepEqual(calls, []);
});

test('explicit module injection shares a single persistence pipeline and preserves substitutable API ports', async () => {
  const { context } = contextForModules();
  const { modules } = loadFrontend(context);
  modules.state.state.year = 2026;
  modules.state.state.month = 10;
  modules.persistence.runtime.serverStateReady = true;
  const requests = [];
  modules.http.api = async (url, options) => { requests.push({ url, options }); return {}; };
  assert.equal(await modules.persistence.persist('now', 'annual'), true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/global');
  assert.equal(requests[0].options.method, 'PUT');
  assert.ok(requests[0].options.body.data.annualBudgetsByYear);
  assert.equal(Object.hasOwn(requests[0].options.body.data, 'itinerary'), false);
  clearTimeout(modules.lifecycle.runtime.tabHeartbeatTimer);
});
