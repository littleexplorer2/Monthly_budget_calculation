'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const manifest = require('./frontend-manifest.js');

const root = path.resolve(__dirname, '..', '..');
const webRoot = path.join(root, 'web');
const html = fs.readFileSync(path.join(webRoot, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)]
  .map((match) => new URL(match[1], 'http://127.0.0.1/').pathname);

test('every frontend module has one folder entry and is loaded once before composition', () => {
  const expected = Object.values(manifest).map((directory) => `/${directory}/index.js`);
  const actual = fs.readdirSync(webRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(webRoot, entry.name, 'index.js')))
    .map((entry) => `/${entry.name}/index.js`);
  assert.deepEqual(actual.sort(), [...expected].sort(), '新增模块须登记架构清单');
  assert.equal(scripts.filter((script) => script === '/js/app.js').length, 1);
  for (const entry of expected) {
    assert.ok(fs.statSync(path.join(webRoot, entry)).isFile(), entry);
    assert.equal(scripts.filter((script) => script === entry).length, 1, `${entry} 必须装配一次`);
    assert.ok(scripts.indexOf(entry) < scripts.indexOf('/js/app.js'), `${entry} 必须先注册再组装`);
  }
  assert.deepEqual(fs.readdirSync(path.join(webRoot, 'js')).filter((name) => name.endsWith('.js')), ['app.js'],
    '旧平铺 js 目录只能保存组装入口');
});

test('module dependencies are explicit, complete, and passed through public service objects', () => {
  // Only register factories. No DOM, network, persistence or create() call occurs.
  const registry = Object.create(null);
  const context = vm.createContext({ window: { BudgetModules: registry } });
  for (const [name, directory] of Object.entries(manifest)) {
    const filename = path.join(webRoot, directory, 'index.js');
    const source = fs.readFileSync(filename, 'utf8');
    const previous = new Set(Object.keys(registry));
    new vm.Script(source, { filename }).runInContext(context, { timeout: 1000 });
    assert.deepEqual(Object.keys(registry).filter((key) => !previous.has(key)), [name],
      `${directory} 只能注册自己的公开模块`);
    const descriptor = registry[name];
    assert.equal(typeof descriptor.create, 'function');
    assert.ok(Array.isArray(descriptor.dependencies));
    const dependencies = Array.from(descriptor.dependencies);
    assert.equal(new Set(dependencies).size, dependencies.length, `${name} 依赖重复`);
    for (const dependency of dependencies) {
      assert.ok(Object.hasOwn(manifest, dependency), `${name} 引用了未登记模块 ${dependency}`);
      assert.notEqual(dependency, name, `${name} 不应依赖自身公开对象`);
    }

    const signature = /^create\s*\(\s*\{([^}]*)\}/.exec(descriptor.create.toString());
    assert.ok(signature, `${name} 必须显式解构注入模块，不能接收全局模块表`);
    const injected = signature[1].split(',').map((part) => part.trim()).filter(Boolean)
      .map((part) => part.split(':')[0].trim());
    assert.deepEqual([...injected].sort(), [...dependencies].sort(), `${name} 的依赖声明与工厂输入不一致`);

    // All cross-module calls go through those injected objects. registry is only
    // for registration; deferred UI callbacks may form explicitly declared cycles
    // after app.js has assembled all public service objects.
    const registryAccess = [...source.matchAll(/\bregistry\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[)/g)];
    assert.equal(registryAccess.length, 1, `${name} 不得从注册表读取其它模块`);
    assert.equal(registryAccess[0][1], name);
    const globalRegistry = /\(window\.BudgetModules \|\| \(window\.BudgetModules = Object\.create\(null\)\)\)/;
    assert.ok(globalRegistry.test(source), `${name} 缺少统一注册入口`);
    assert.doesNotMatch(source.replace(globalRegistry, ''), /\b(?:window|globalThis)\s*\.\s*Budget(?:Modules|App)\b/,
      `${name} 不得动态读取全局模块或应用对象`);
  }
  assert.deepEqual(Object.keys(registry).sort(), Object.keys(manifest).sort());
});
