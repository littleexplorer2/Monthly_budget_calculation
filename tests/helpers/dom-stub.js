'use strict';

/**
 * 测试用的最小 DOM 实现 + app.js 加载器。
 *
 * 为什么不用空对象桩：预算标准页的输入交互涉及「节点身份」「事件冒泡」「焦点」
 * 三件事，空桩测不出「重绘把正在编辑的输入框替换掉，后续按键写到旧节点」这类真实缺陷。
 * 这里实现够用的子集：HTML 模板解析、querySelector（后代 / 子代 / 属性 / :scope）、
 * 事件冒泡、focus/activeElement、innerHTML/outerHTML 赋值。
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'source', 'area', 'base', 'col', 'embed', 'track', 'wbr']);

class ClassList {
  constructor(el) { this.el = el; }
  get _set() { return new Set((this.el.getAttribute('class') || '').split(/\s+/).filter(Boolean)); }
  _write(set) { this.el.setAttribute('class', Array.from(set).join(' ')); }
  add(...names) { const s = this._set; names.forEach((n) => n && s.add(n)); this._write(s); }
  remove(...names) { const s = this._set; names.forEach((n) => s.delete(n)); this._write(s); }
  contains(name) { return this._set.has(name); }
  toggle(name, force) {
    const on = force === undefined ? !this.contains(name) : !!force;
    if (on) this.add(name); else this.remove(name);
    return on;
  }
  toString() { return Array.from(this._set).join(' '); }
}

class El {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.nodeType = 1;
    this.attributes = new Map();
    this.childNodes = [];
    this.parentNode = null;
    this._text = '';
    this._listeners = new Map();
    this.classList = new ClassList(this);
    this.style = { cssText: '' };
    this._value = '';
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this.scrollTop = 0;
    this.ownerDocument = null;
    this._htmlCache = null;
  }

  setAttribute(name, value) {
    this.attributes.set(String(name), String(value));
    if (name === 'value' && this.tagName === 'INPUT') this._value = String(value);
    this._htmlCache = null;
  }
  getAttribute(name) { return this.attributes.has(String(name)) ? this.attributes.get(String(name)) : null; }
  hasAttribute(name) { return this.attributes.has(String(name)); }
  removeAttribute(name) { this.attributes.delete(String(name)); this._htmlCache = null; }

  get id() { return this.getAttribute('id') || ''; }
  set id(v) { this.setAttribute('id', v); }
  get className() { return this.getAttribute('class') || ''; }
  set className(v) { this.setAttribute('class', v); }
  get dataset() {
    const out = {};
    for (const [k, v] of this.attributes) {
      if (!k.startsWith('data-')) continue;
      out[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
    }
    return out;
  }

  get textContent() {
    if (this.childNodes.length === 0) return this._text;
    return this.childNodes.map((c) => (c.nodeType === 1 ? c.textContent : c.text)).join('') + this._text;
  }
  set textContent(v) { this.childNodes = []; this._text = String(v); this._htmlCache = null; }

  get innerHTML() {
    if (this._htmlCache !== null) return this._htmlCache;
    let out = this.childNodes.map((c) => (c.nodeType === 1 ? c.outerHTML : c.text)).join('');
    if (this._text) out += this._text;
    this._htmlCache = out;
    return out;
  }
  set innerHTML(html) {
    for (const child of this.childNodes) if (child.nodeType === 1) child._detachFocus();
    this.childNodes = [];
    this._text = '';
    this._htmlCache = String(html);
    for (const node of parseHTML(String(html), this.ownerDocument)) this.appendChild(node);
  }
  get outerHTML() {
    const attrs = Array.from(this.attributes).map(([k, v]) => ` ${k}="${v}"`).join('');
    const tag = this.tagName.toLowerCase();
    if (VOID_TAGS.has(tag)) return `<${tag}${attrs}>`;
    return `<${tag}${attrs}>${this._innerHTMLRaw()}</${tag}>`;
  }
  set outerHTML(html) {
    const parent = this.parentNode;
    if (!parent) return;
    const index = parent.childNodes.indexOf(this);
    const nodes = parseHTML(String(html), this.ownerDocument);
    this._detachFocus();
    if (index >= 0) parent.childNodes.splice(index, 1);
    for (let i = 0; i < nodes.length; i += 1) {
      nodes[i].parentNode = parent;
      if (nodes[i].nodeType === 1) nodes[i]._setDoc(this.ownerDocument);
      parent.childNodes.splice(index + i, 0, nodes[i]);
    }
    parent._htmlCache = null;
    this.parentNode = null;
  }
  _innerHTMLRaw() {
    let out = this.childNodes.map((c) => (c.nodeType === 1 ? c.outerHTML : c.text)).join('');
    if (this._text) out += this._text;
    return out;
  }

  appendChild(child) {
    child.parentNode = this;
    this.childNodes.push(child);
    this._htmlCache = null;
    if (child.nodeType === 1) child._setDoc(this.ownerDocument);
    return child;
  }
  insertAdjacentHTML(position, html) {
    const nodes = parseHTML(String(html), this.ownerDocument);
    if (position === 'beforeend') { for (const n of nodes) this.appendChild(n); return; }
    if (position === 'afterbegin') {
      for (let i = nodes.length - 1; i >= 0; i -= 1) {
        nodes[i].parentNode = this;
        if (nodes[i].nodeType === 1) nodes[i]._setDoc(this.ownerDocument);
        this.childNodes.unshift(nodes[i]);
      }
      this._htmlCache = null;
      return;
    }
    throw new Error(`insertAdjacentHTML 不支持的位置: ${position}`);
  }
  remove() {
    this._detachFocus();
    if (!this.parentNode) return;
    const i = this.parentNode.childNodes.indexOf(this);
    if (i >= 0) this.parentNode.childNodes.splice(i, 1);
    this.parentNode._htmlCache = null;
    this.parentNode = null;
  }
  _detachFocus() {
    const doc = this.ownerDocument;
    if (doc && doc.activeElement && doc.activeElement !== doc.body && this.contains(doc.activeElement)) {
      doc.activeElement = doc.body;
    }
    for (const c of this.childNodes) if (c.nodeType === 1) c._detachFocus();
  }
  _setDoc(doc) {
    this.ownerDocument = doc;
    for (const c of this.childNodes) if (c.nodeType === 1) c._setDoc(doc);
  }
  contains(node) {
    if (node === this) return true;
    return this.childNodes.some((c) => c.nodeType === 1 && c.contains(node));
  }

  get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
  get firstChild() { return this.childNodes[0] || null; }
  closest(sel) {
    let cur = this;
    while (cur && cur.nodeType === 1) {
      if (matches(cur, sel)) return cur;
      cur = cur.parentNode;
    }
    return null;
  }
  matches(sel) { return matches(this, sel); }
  querySelector(sel) { const found = queryAll(this, sel, true); return found.length ? found[0] : null; }
  querySelectorAll(sel) { return queryAll(this, sel, false); }

  get value() { return this._value !== '' ? this._value : (this.getAttribute('value') || ''); }
  set value(v) { this._value = String(v); this._htmlCache = null; }
  get disabled() { return this.hasAttribute('disabled'); }
  set disabled(v) { if (v) this.setAttribute('disabled', ''); else this.removeAttribute('disabled'); }
  get hidden() { return this.hasAttribute('hidden'); }
  set hidden(v) { if (v) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }
  get checked() { return this.hasAttribute('checked'); }
  set checked(v) { if (v) this.setAttribute('checked', ''); else this.removeAttribute('checked'); }
  focus() { if (this.ownerDocument) this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument && this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  click() { this.dispatchEvent({ type: 'click', bubbles: true, target: this }); }
  setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; }
  scrollIntoView() {}
  getBoundingClientRect() { return { width: 100, height: 20, top: 10, left: 10 }; }

  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this._listeners.get(type) || [];
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }
  dispatchEvent(ev) {
    ev.target = ev.target || this;
    let cur = this;
    while (cur) {
      ev.currentTarget = cur;
      for (const fn of (cur._listeners.get(ev.type) || []).slice()) fn(ev);
      if (!ev.bubbles) break;
      cur = cur.parentNode;
    }
    return true;
  }
}

class TextNode {
  constructor(text) { this.nodeType = 3; this.text = String(text); this.parentNode = null; }
  get textContent() { return this.text; }
}

/* ---------- 选择器 ---------- */
function parseSimple(sel) {
  const out = { tag: null, id: null, classes: [], attrs: [] };
  const re = /([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:([~^$*|]?=)"([^"]*)"|([~^$*|]?=)'([^']*)')?\]|:scope/g;
  let m;
  while ((m = re.exec(sel))) {
    if (m[1]) out.tag = m[1].toLowerCase();
    else if (m[2]) out.id = m[2];
    else if (m[3]) out.classes.push(m[3]);
    else if (m[4]) out.attrs.push({ name: m[4], op: m[5] || m[7] || null, value: m[6] !== undefined ? m[6] : (m[8] !== undefined ? m[8] : null) });
  }
  return out;
}

function matchesSimple(el, simple) {
  if (simple.tag && el.tagName !== simple.tag.toUpperCase()) return false;
  if (simple.id && el.id !== simple.id) return false;
  for (const c of simple.classes) if (!el.classList.contains(c)) return false;
  for (const a of simple.attrs) {
    const v = el.getAttribute(a.name);
    if (v === null) return false;
    if (!a.op) continue;
    if (a.op === '=' && v !== a.value) return false;
    if (a.op === '^=' && !v.startsWith(a.value)) return false;
    if (a.op === '$=' && !v.endsWith(a.value)) return false;
    if (a.op === '*=' && !v.includes(a.value)) return false;
  }
  return true;
}

/** 按组合符切分（忽略 [] 与引号内部的分隔符） */
function tokenize(selector) {
  const tokens = [];
  let buf = '';
  let depth = 0;
  let quote = null;
  const flush = () => { const t = buf.trim(); if (t) tokens.push(t); buf = ''; };
  for (const ch of String(selector)) {
    if (quote) { buf += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
    if (ch === '[') { depth += 1; buf += ch; continue; }
    if (ch === ']') { depth -= 1; buf += ch; continue; }
    if (depth === 0 && (ch === '>' || /\s/.test(ch))) { flush(); if (ch === '>') tokens.push('>'); continue; }
    buf += ch;
  }
  flush();
  return tokens;
}

function matchesDescendant(el, group) {
  const tokens = tokenize(group);
  if (!tokens.length) return false;
  if (!matchesSimple(el, parseSimple(tokens[tokens.length - 1].replace(':scope', '')))) return false;
  let cur = el;
  let i = tokens.length - 2;
  while (i >= 0) {
    const token = tokens[i];
    if (token === '>') {
      i -= 1;
      if (i < 0) return false;
      cur = cur.parentNode;
      if (!cur || cur.nodeType !== 1) return false;
      if (!matchesSimple(cur, parseSimple(tokens[i].replace(':scope', '')))) return false;
      i -= 1;
      continue;
    }
    const simple = parseSimple(token.replace(':scope', ''));
    let anc = cur.parentNode;
    let found = null;
    while (anc && anc.nodeType === 1) {
      if (matchesSimple(anc, simple)) { found = anc; break; }
      anc = anc.parentNode;
    }
    if (!found) return false;
    cur = found;
    i -= 1;
  }
  return true;
}

function matches(el, selector) {
  const groups = String(selector).split(',').map((s) => s.trim()).filter(Boolean);
  return groups.some((group) => matchesDescendant(el, group));
}

function matchesSelectorWithScope(el, selector, root) {
  const groups = String(selector).split(',').map((s) => s.trim()).filter(Boolean);
  return groups.some((group) => {
    if (group.includes(':scope')) {
      const idx = group.indexOf('>');
      if (idx < 0) return false;
      if (!matchesSimple(el, parseSimple(group.slice(idx + 1).trim()))) return false;
      let anc = el.parentNode;
      while (anc && anc.nodeType === 1) {
        if (anc === root) return true;
        anc = anc.parentNode;
      }
      return false;
    }
    return matchesDescendant(el, group);
  });
}

function queryAll(root, selector, firstOnly) {
  const out = [];
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType !== 1) continue;
      if (matchesSelectorWithScope(child, selector, root)) {
        out.push(child);
        if (firstOnly) return true;
      }
      if (walk(child)) return true;
    }
    return false;
  };
  walk(root);
  return out;
}

/* ---------- HTML 解析 ---------- */
function findTagEnd(html, start) {
  let quote = null;
  for (let i = start; i < html.length; i += 1) {
    const ch = html[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '>') return i;
  }
  return -1;
}

function parseHTML(html, doc) {
  const nodes = [];
  const stack = [];
  let i = 0;
  const push = (node) => {
    const top = stack[stack.length - 1];
    if (top) top.appendChild(node);
    else nodes.push(node);
  };
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { const text = html.slice(i); if (text) push(new TextNode(text)); break; }
    if (lt > i) push(new TextNode(html.slice(i, lt)));
    const gt = findTagEnd(html, lt + 1);
    if (gt < 0) { push(new TextNode(html.slice(lt))); break; }
    const raw = html.slice(lt + 1, gt).trim();
    i = gt + 1;
    if (raw.startsWith('/')) { stack.pop(); continue; }
    const selfClose = raw.endsWith('/');
    const body = selfClose ? raw.slice(0, -1).trim() : raw;
    const sp = body.search(/\s/);
    const tag = (sp < 0 ? body : body.slice(0, sp)).toLowerCase();
    const attrText = sp < 0 ? '' : body.slice(sp + 1);
    const el = new El(tag);
    el.ownerDocument = doc;
    const attrRe = /([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    let am;
    while ((am = attrRe.exec(attrText))) {
      const value = am[2] !== undefined ? am[2] : (am[3] !== undefined ? am[3] : (am[4] !== undefined ? am[4] : ''));
      el.setAttribute(am[1], value);
    }
    push(el);
    if (!VOID_TAGS.has(tag) && !selfClose) stack.push(el);
  }
  return nodes;
}

class Doc extends El {
  constructor() {
    super('#document');
    this.nodeType = 9;
    this.ownerDocument = this;
    this.body = new El('body');
    this.body.ownerDocument = this;
    this.body.parentNode = this;
    this.childNodes = [this.body];
    this.activeElement = this.body;
  }
  createElement(tag) { const el = new El(tag); el.ownerDocument = this; return el; }
  get documentElement() { return this.body; }
  querySelector(sel) { return this.body.querySelector(sel); }
  querySelectorAll(sel) { return this.body.querySelectorAll(sel); }
}

function createDocument(html) {
  const doc = new Doc();
  for (const n of parseHTML(html, doc)) doc.body.appendChild(n);
  return doc;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

/** 固定、最小且与用户 data/ 完全隔离的 /api/meta 测试夹具。 */
function defaultMetaFixture() {
  return {
    default_standards: {
      variable: {
        Shenzhen: { CNY: 85 },
        HongKong: { HKD: 95 },
      },
      fixed: {
        Mainland: { CNY: 64, USD: 22, HKD: 30 },
        Overseas: { CNY: 249, USD: 35, HKD: 120 },
      },
      extra: { CNY: 0, USD: 0, HKD: 0 },
      travel: {
        Shanghai: { CNY: { daily: 175, once: 200 } },
        Taipei: { TWD: { daily: 1450, once: 1000 } },
        Bangkok: { THB: { daily: 1200, once: 800 } },
      },
    },
    locations: [
      { key: 'Shenzhen', name: '深圳', category: 'variable', currency: 'CNY' },
      { key: 'HongKong', name: '香港', category: 'variable', currency: 'HKD' },
      { key: 'Shanghai', name: '上海', category: 'travel', currency: 'CNY' },
      { key: 'Taipei', name: '台北', category: 'travel', currency: 'TWD' },
      { key: 'Bangkok', name: '曼谷', category: 'travel', currency: 'THB' },
    ],
    regions: [{ key: 'Mainland', name: '内地' }, { key: 'Overseas', name: '境外' }],
    currencies: ['CNY', 'HKD', 'USD', 'TWD', 'THB'],
    currency_names: {
      CNY: '人民币', HKD: '港币', USD: '美元', TWD: '新台币', THB: '泰铢',
    },
    location_names: {
      Shenzhen: '深圳', HongKong: '香港', Shanghai: '上海', Taipei: '台北', Bangkok: '曼谷',
    },
    defaults_customized: false,
    defaults_revision: '0'.repeat(64),
  };
}

function defaultStateFixture() {
  return {
    version: 1,
    year: 2026,
    month: 9,
    itineraryByMonth: {},
    optionsByMonth: {},
    overridesByMonth: {},
    resultsByMonth: {},
    annualBudgetsByYear: {},
    annualResultsByYear: {},
  };
}

/**
 * 用真实 index.html + app.js 装配一个可交互的应用实例。
 * @param {object} options.meta  可注入的 /api/meta 返回；默认用内存固定夹具
 * @param {object} options.state  可注入的 GET /api/state 返回
 * @param {boolean|object|function} options.statePutFailure  模拟 PUT /api/state 失败
 * @param {object|function} options.monthlyRates 可注入的 GET /api/rates 返回
 * @param {object|function} options.monthlyBudget 可注入的 POST /api/calculate 返回
 * @param {object|function} options.annualRates  可注入的 GET /api/annual-rates 返回
 * @param {object|function} options.annualBudget 可注入的 POST /api/annual-budget 返回
 */
function createApp(options = {}) {
  const root = path.join(__dirname, '..', '..');
  const indexHtml = fs.readFileSync(path.join(root, 'web', 'index.html'), 'utf8');
  const source = fs.readFileSync(path.join(root, 'web', 'js', 'app.js'), 'utf8');

  const meta = cloneJson(options.meta || defaultMetaFixture());
  const initialState = cloneJson(options.state || defaultStateFixture());

  const doc = createDocument(indexHtml);
  const storage = new Map();
  const calls = [];
  const requests = [];
  const responseValue = async (configured, request, fallback) => {
    const value = configured === undefined ? fallback : configured;
    return cloneJson(typeof value === 'function' ? await value(request) : value);
  };
  const win = {
    document: doc,
    localStorage: {
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    navigator: { sendBeacon: () => true, userAgent: 'test' },
    crypto: { randomUUID: () => 'test-tab' },
    addEventListener: () => {},
    confirm: () => (typeof options.confirm === 'function' ? options.confirm() : true),
    fetch: async (url, fetchOptions = {}) => {
      const u = String(url);
      calls.push(u);
      let body = null;
      if (fetchOptions.body != null) {
        try { body = JSON.parse(String(fetchOptions.body)); } catch (_) { body = fetchOptions.body; }
      }
      const request = {
        url: u,
        method: String(fetchOptions.method || 'GET').toUpperCase(),
        body,
      };
      requests.push(request);
      const send = (o) => ({ ok: true, status: 200, json: async () => o });
      if (u.includes('/api/meta')) return send(meta);
      if (u.includes('/api/state')) {
        if (request.method === 'PUT' && options.statePutFailure) {
          const configured = typeof options.statePutFailure === 'function'
            ? await options.statePutFailure(request)
            : options.statePutFailure;
          const failure = configured && typeof configured === 'object' ? configured : {};
          return {
            ok: false,
            status: Number(failure.status) || 503,
            json: async () => failure.body || { error: { code: 'state_write_failed', message: '测试：状态写入失败' } },
          };
        }
        return send(request.method === 'GET' ? initialState : {});
      }
      if (u.includes('/api/network-check')) return send({ ok: true });
      if (u.includes('/api/annual-rates')) {
        return send(await responseValue(options.annualRates, request, {
          year: new Date().getFullYear(),
          start_date: `${new Date().getFullYear()}-01-01`,
          requested_through: `${new Date().getFullYear()}-09-28`,
          observed_through: `${new Date().getFullYear()}-09-25`,
          source: 'Yahoo Finance',
          price_field: 'Close',
          non_trading_days: 'excluded',
          stats: {},
          errors: {},
          complete: true,
        }));
      }
      if (u.includes('/api/rates')) {
        return send(await responseValue(options.monthlyRates, request, {
          dates: [], series: {}, stats: {},
        }));
      }
      if (u.includes('/api/calculate')) {
        return send(await responseValue(options.monthlyBudget, request, {
          summary: { '预算总计': 0 },
          daily_details: [], fixed_details: [], extra_details: [], warnings: [],
          rates: { dates: [], series: {}, stats: {} },
        }));
      }
      if (u.includes('/api/annual-budget')) {
        return send(await responseValue(options.annualBudget, request, {
          year: new Date().getFullYear(),
          summary: { '全年预算合计(人民币)': 0 },
          details: [],
          errors: {},
        }));
      }
      return send({});
    },
  };
  win.window = win;

  const context = vm.createContext({
    window: win,
    document: doc,
    localStorage: win.localStorage,
    navigator: win.navigator,
    fetch: win.fetch,
    confirm: win.confirm,
    echarts: {
      init: () => ({ setOption: () => {}, dispose: () => {}, resize: () => {} }),
    },
    setTimeout,
    clearTimeout,
    console: options.console || console,
    AbortController,
    Blob,
    Date,
    JSON,
    Math,
    Number,
    Object,
    Array,
    String,
    Boolean,
    Set,
    Map,
    Error,
    Promise,
    isNaN,
    parseInt,
    parseFloat,
    encodeURIComponent,
    decodeURIComponent,
  });
  vm.runInContext(`${source}
    globalThis.app = {
      state, init, renderStandards, refreshRowChip, applyDefaultsInput, applyMonthInput,
      renderResult, clearResult, splitFixedExtraDetails,
      renderAnnualBudget, loadAnnualRates, calculateAnnualBudget, invalidateAnnualResult,
      annualBudgetAmounts, annualCurrencies, snapshotBundle, applyBundle, switchTab,
      collectAnalysisMonths, markCurrentResultStale, addRange, deleteMonthData,
      loadRates, calculate, changeMonth,
    };
  `, context, { filename: 'app.js' });

  return { doc, app: context.app, meta, calls, requests, storage };
}

module.exports = {
  createDocument, createApp, defaultMetaFixture, defaultStateFixture,
  parseHTML, El, Doc, TextNode,
};
