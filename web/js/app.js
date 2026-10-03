/* ==========================================================================
 * 多币种旅行预算计算器 - Web 版前端逻辑
 * 依赖：ECharts（vendor/echarts.min.js，本地化，无需外网 CDN）
 * 后端接口：/api/meta、/api/state、/api/defaults、/api/rates、/api/calculate、/api/data/upload
 * ========================================================================== */
'use strict';

/* --------------------------------------------------------------------------
 * 常量与全局状态
 * ------------------------------------------------------------------------ */
const STORE_KEY = 'budget-web-state-v1';        // 月份/行程/当月选项（区域+旅居，按月份）
const OVERRIDES_KEY = 'budget-web-overrides-v1'; // 旧版独立缓存 key（只用于兼容迁移）
const RESULTS_KEY = 'budget-web-results-v1';     // 每月计算结果（按月索引）
const MAX_KEPT_MONTHS = 60; // localStorage 镜像的行程/选项月份上限（服务器真源不裁剪）
const TAB_HEARTBEAT_INTERVAL_MS = 5000;

// 地点差异化配色（定居/旅居各地点颜色差别大，便于日历/列表/芯片区分）
const LOC_COLORS = ['#2563eb', '#16a34a', '#ea580c', '#9333ea', '#0891b2', '#dc2626'];
const EXTRA_CURRENCIES = ['CNY', 'USD', 'HKD']; // 额外预算固定币种，默认金额均为 0

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
  meta: null,               // /api/meta 返回的元数据
  year: 0,
  month: 0,                 // 1-12
  region: 'Mainland',
  standards: { variable: {}, fixed: {}, travel: {}, extra: {} }, // 当前生效标准（默认 + 覆盖）
  itineraryByMonth: {},     // { 'YYYY-MM': { location: [{start, end}] } }
  optionsByMonth: {},       // { 'YYYY-MM': { region, includeTravel, travelSelected } }
  overridesByMonth: {},     // { 'YYYY-MM': 完整标准快照；兼容读取旧版差异 }
  resultsByMonth: {},       // { 'YYYY-MM': 计算结果（不含汇率明细） }
  annualBudgetsByYear: {},  // { 'YYYY': { currency: 全年当地金额 } }
  annualResultsByYear: {},  // { 'YYYY': 紧凑全年计算结果（不含原始汇率序列） }
  annualYear: 0,
  annualRatesData: null,
  annualRatesYear: null,
  annualLoading: false,
  annualLoadingYear: null,
  annualRateRequestId: 0,
  persistFailureNotified: false,
  activeLocation: null,     // 当前日历操作的目标地点
  calSel: { start: null, end: null },
  ratesData: null,          // 最近一次汇率数据
  ratesMonth: null,         // 汇率数据对应的月份 key
  ratesFromCalc: false,     // 当前汇率数据是否来自计算响应（仅涉及币种子集）
  rateRequestId: 0,         // 月度汇率请求序号；切月/重复刷新时只接受最后一次响应
  calcResult: null,
  rateCharts: [],           // 每币种独立折线图实例 { currency, instance }
  analysisChart: null,      // 数据分析页折线图
  busy: false,
  standardsConfirmed: false, // 用户是否已确认当前预算标准无误（修改标准/切换区域后需重新确认）
  // 新建预算标准：当月自定义地点（[{key,name,category,currency}]）与固定预算自定义币种名
  customLocations: [],
  customCurrencies: {},
  monthLocations: null,
  monthLocationNames: null,
  monthCurrencyNames: null,
  monthStandardsSnapshot: false,
  // 旅居开关与选择（按月保存）：默认关闭；travelSelected=null 表示全部
  includeTravel: false,
  travelSelected: null,
  // 默认标准编辑：editingDefaults=true 时输入框直接编辑服务器默认标准（defaultsDraft 为未保存草稿）
  editingDefaults: false,
  defaultsDraft: null,
  // 默认标准弹窗的显示范围：false=只显示本月对应的部分，true=显示所有默认预算。
  // 纯界面偏好，只存在于内存（不写 app-state.json / localStorage，也不进草稿）。
  defaultsShowAll: false,
};

/* --------------------------------------------------------------------------
 * 工具函数
 * ------------------------------------------------------------------------ */
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function fmtMoney(n) {
  const v = Number(n);
  return Number.isFinite(v)
    ? v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '-';
}

function pad2(n) { return String(n).padStart(2, '0'); }

function dateStr(y, m, d) { return `${y}-${pad2(m)}-${pad2(d)}`; }

function monthKey() { return `${state.year}-${pad2(state.month)}`; }

function defaultMonthOptions() {
  return { region: 'Mainland', includeTravel: false, travelSelected: null };
}

/** 把当前页的居住区域 / 是否旅居 / 旅居地点勾选快照到当月数据集 */
function snapshotMonthOptions(markSaved) {
  const o = {
    region: state.region === 'Overseas' ? 'Overseas' : 'Mainland',
    includeTravel: !!state.includeTravel,
    travelSelected: state.travelSelected === null ? null : Array.from(state.travelSelected),
  };
  const prev = state.optionsByMonth && state.optionsByMonth[monthKey()];
  if (markSaved) o.savedAt = new Date().toISOString();
  else if (prev && prev.savedAt) o.savedAt = prev.savedAt;
  return o;
}

function saveMonthOptions(markSaved) {
  if (!state.year || !state.month) return;
  if (!state.optionsByMonth || typeof state.optionsByMonth !== 'object') state.optionsByMonth = {};
  state.optionsByMonth[monthKey()] = snapshotMonthOptions(markSaved);
}

/** 从当月数据集恢复居住区域与旅居勾选；该月没有记录则用默认值 */
function applyMonthOptions(key) {
  const saved = state.optionsByMonth && state.optionsByMonth[key];
  const opt = (saved && typeof saved === 'object') ? saved : defaultMonthOptions();
  state.region = opt.region === 'Overseas' ? 'Overseas' : 'Mainland';
  state.includeTravel = !!opt.includeTravel;
  if (opt.travelSelected == null || !Array.isArray(opt.travelSelected)) {
    state.travelSelected = null;
  } else {
    state.travelSelected = new Set(opt.travelSelected);
  }
}

function syncOptionsUI() {
  $$('#region-seg .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.region === state.region));
  const chk = $('#chk-include-travel');
  if (chk) chk.checked = !!state.includeTravel;
  updateTravelUiVisibility();
}

/** 仅勾选「包含旅居」时：创建旅居预算栏目；关闭时从 DOM 删除（不只是 CSS 隐藏） */
function updateTravelUiVisibility() {
  const on = !!state.includeTravel;
  const chk = $('#chk-include-travel');
  if (chk) chk.checked = on;

  const picker = $('#travel-picker-wrap');
  if (picker) picker.hidden = !on;
  if (!on) {
    const menu = $('#travel-picker-menu');
    if (menu) menu.hidden = true;
    const list = $('#tp-list');
    if (list) list.innerHTML = '';
  }

  const travelGroup = $('#loc-group-travel');
  setElVisible(travelGroup, on);

  if (!on && state.activeLocation && locationCategory(state.activeLocation) === 'travel') {
    const firstSettle = allLocations().find((l) => l.category !== 'travel');
    if (firstSettle) state.activeLocation = firstSettle.key;
  }

  renderTravelStandardsBlock();
}

function catLetter(name) {
  const s = String(name || '').trim();
  return s ? s.slice(0, 1) : '·';
}

function budgetRowHtml({ color, letter, title, sub, inputs, chip = '', action = '' }) {
  return `<div class="budget-row">
    <span class="cat-icon" style="background:${color}">${esc(letter)}</span>
    <div class="budget-row-text">
      <div class="budget-row-title">${title}${chip}</div>
      <div class="budget-row-sub">${sub}</div>
    </div>
    <div class="budget-row-actions">${action}</div>
    <div class="budget-row-amt">${inputs}</div>
  </div>`;
}

function parseDate(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

/** 按本地日历逐日枚举（含首尾），Windows/macOS 夏令时下也不跳日、不串地点 */
function iterDays(start, end) {
  const days = [];
  if (!start || !end) return days;
  let cur = parseDate(start);
  const last = parseDate(end);
  if (Number.isNaN(cur.getTime()) || Number.isNaN(last.getTime()) || cur > last) return days;
  while (cur <= last) {
    days.push(dateStr(cur.getFullYear(), cur.getMonth() + 1, cur.getDate()));
    cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 1);
  }
  return days;
}

function rangesFromDays(days) {
  const sorted = Array.from(new Set(days)).sort();
  if (!sorted.length) return [];
  const ranges = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const d = parseDate(prev);
    const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    const expected = dateStr(next.getFullYear(), next.getMonth() + 1, next.getDate());
    if (sorted[i] === expected) {
      prev = sorted[i];
    } else {
      ranges.push({ start, end: prev });
      start = prev = sorted[i];
    }
  }
  ranges.push({ start, end: prev });
  return ranges;
}

/** 同一天只属于一个地点：更短的日期段优先，避免香港大段盖住深圳空隙 */
function exclusiveItineraryMonth(month) {
  if (!month || typeof month !== 'object') return {};
  const owners = new Map();
  for (const [loc, ranges] of Object.entries(month)) {
    if (!Array.isArray(ranges)) continue;
    for (const r of ranges) {
      if (!r || !r.start || !r.end) continue;
      const days = iterDays(r.start, r.end);
      const length = days.length;
      if (!length) continue;
      for (const day of days) {
        const prev = owners.get(day);
        if (!prev || length < prev.len) owners.set(day, { loc, len: length });
      }
    }
  }
  const byLoc = {};
  for (const [day, info] of owners) {
    if (!byLoc[info.loc]) byLoc[info.loc] = [];
    byLoc[info.loc].push(day);
  }
  const out = {};
  for (const loc of Object.keys(month)) {
    if (byLoc[loc] && byLoc[loc].length) {
      out[loc] = rangesFromDays(byLoc[loc]);
      delete byLoc[loc];
    }
  }
  for (const [loc, days] of Object.entries(byLoc)) {
    if (days.length) out[loc] = rangesFromDays(days);
  }
  return out;
}

function exclusiveAllMonths(map) {
  const out = {};
  for (const [month, itin] of Object.entries(map && typeof map === 'object' ? map : {})) {
    out[month] = exclusiveItineraryMonth(itin);
  }
  return out;
}

function daysOwnedByOthers(exceptLoc) {
  const days = new Set();
  const itin = currentItinerary();
  for (const [loc, ranges] of Object.entries(itin)) {
    if (loc === exceptLoc || !Array.isArray(ranges)) continue;
    for (const r of ranges) {
      for (const day of iterDays(r.start, r.end)) days.add(day);
    }
  }
  return days;
}

/** 两个日期之间的天数（含首尾） */
function daysBetween(a, b) {
  return Math.round((parseDate(b) - parseDate(a)) / 86400000) + 1;
}

function locName(key) {
  if (key === 'Extra') return '额外预算';
  if (state.monthLocationNames && state.monthLocationNames[key]) {
    return state.monthLocationNames[key];
  }
  if (state.meta && state.meta.location_names && state.meta.location_names[key]) {
    return state.meta.location_names[key];
  }
  const onDefaults = state.editingDefaults && state.defaultsDraft;
  if (onDefaults && onDefaults.locationNames && onDefaults.locationNames[key]) {
    return onDefaults.locationNames[key];
  }
  const c = activeCustomLocations().find((x) => x.key === key);
  return c ? c.name : key;
}

/** 当前编辑目标下的自定义地点列表（默认标准草稿模式取草稿） */
function activeCustomLocations() {
  if (state.editingDefaults && state.defaultsDraft) return state.defaultsDraft.locations || [];
  return state.customLocations || [];
}

/** 当前编辑目标下的自定义币种名（默认标准草稿模式取草稿） */
function activeCustomCurrencies() {
  if (state.editingDefaults && state.defaultsDraft) return state.defaultsDraft.currencyNames || {};
  return state.customCurrencies || {};
}

/** 全部地点列表（默认 + 当月自定义），用于颜色索引与展示 */
function allLocations() {
  const defaults = state.monthLocations || (state.meta && state.meta.locations) || [];
  const byKey = new Map(defaults.map((loc) => [loc.key, loc]));
  for (const loc of activeCustomLocations()) byKey.set(loc.key, loc);
  return Array.from(byKey.values());
}

/** 地点所属类别：variable（定居）| travel（旅居） */
function locationCategory(loc) {
  const d = (state.monthLocations || state.meta && state.meta.locations || []).find((l) => l.key === loc);
  if (d) return d.category;
  const c = activeCustomLocations().find((x) => x.key === loc);
  return c ? c.category : null;
}

/** 地点币种：默认地点取默认，自定义地点取用户输入 */
function locationCurrency(loc) {
  const d = (state.monthLocations || state.meta && state.meta.locations || []).find((l) => l.key === loc);
  if (d) return d.currency;
  const c = activeCustomLocations().find((x) => x.key === loc);
  return c ? c.currency : null;
}

function currencyName(key) {
  if (state.monthCurrencyNames && state.monthCurrencyNames[key]) {
    return state.monthCurrencyNames[key];
  }
  if (state.meta && state.meta.currency_names && state.meta.currency_names[key]) {
    return state.meta.currency_names[key];
  }
  const customs = activeCustomCurrencies();
  return (customs && customs[key]) || key;
}

function regionName(key) {
  const r = (state.meta && state.meta.regions || []).find((x) => x.key === key);
  return r ? r.name : key;
}

function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }

function resetStandardsToDefault() {
  state.standards = deepClone(state.meta.default_standards);
  state.monthLocations = null;
  state.monthLocationNames = null;
  state.monthCurrencyNames = null;
  state.monthStandardsSnapshot = false;
}

/* ---------- 地点差异化配色 ---------- */
function hexToRgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

function locColor(loc) {
  const idx = allLocations().findIndex((l) => l.key === loc);
  return LOC_COLORS[idx >= 0 ? idx % LOC_COLORS.length : 0];
}

/** 返回内联 CSS 变量（--lc 主色 / --lc-soft 浅色 / --lc-border 边框色），
 *  用于芯片、日历格子、行程分组的地点色标注 */
function locColorVars(loc) {
  const c = locColor(loc);
  return `--lc:${c};--lc-soft:${hexToRgba(c, 0.16)};--lc-border:${hexToRgba(c, 0.55)}`;
}

/* --------------------------------------------------------------------------
 * API 封装（统一错误处理与超时）
 * ------------------------------------------------------------------------ */
async function api(path, options = {}) {
  const controller = new AbortController();
  const timeoutMs = options.timeout || 120000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(path, {
      method: options.method || 'GET',
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    let data = null;
    try { data = await resp.json(); } catch (_) { /* 非 JSON 响应 */ }
    if (!resp.ok) {
      const msg = (data && data.error && data.error.message) || `请求失败（HTTP ${resp.status}）`;
      const error = new Error(msg);
      error.code = data && data.error && data.error.code;
      error.status = resp.status;
      throw error;
    }
    return data;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('请求超时，请稍后重试');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/* --------------------------------------------------------------------------
 * Toast 与加载遮罩
 * ------------------------------------------------------------------------ */
let toastTimer = null;
function toast(msg, type = 'info') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 3600);
}

function setElVisible(el, on) {
  if (!el) return;
  el.classList.toggle('hidden', !on);
  if (on) el.removeAttribute('hidden');
  else el.setAttribute('hidden', '');
}

function setLoading(on, text) {
  setElVisible($('#loading-overlay'), !!on);
  const label = $('#loading-text');
  if (text && label) label.textContent = text;
  if (!on && label) label.textContent = '加载中…';
}

/* --------------------------------------------------------------------------
 * 持久化（单一管线）
 *   真源：GET/PUT /api/state → data/app-state.json
 *   缓存：localStorage 一份完整 bundle；GET 成功时只镜像真源，不反向合并
 *   写入：所有变更只走 persist('debounce'|'now'|'unload')
 * ------------------------------------------------------------------------ */
let persistTimer = null;
let persistChain = Promise.resolve();
let pendingPersistScope = null;
let tabUnregistered = false;
let serverBaseline = null;
// GET /api/state 完成前或失败后，本机状态只能用于只读恢复；在没有可信读取
// 基线时禁止写服务器，否则初始化窗口里的旧默认值可能覆盖磁盘较新数据。
let serverStateReady = false;
let activeStateWritePayload = null;
let uncertainStateWritePayloads = [];
let nextStateWriteSequence = 1;
let defaultsSaveInFlight = false;
let sessionMonthlyTouched = false;
let sessionAnnualTouched = false;
const STATE_MAP_FIELDS = [
  'itineraryByMonth', 'optionsByMonth', 'overridesByMonth', 'resultsByMonth',
  'annualBudgetsByYear', 'annualResultsByYear',
];

function emptyBundle() {
  return {
    version: 1,
    updatedAt: null,
    year: null,
    month: null,
    itineraryByMonth: {},
    optionsByMonth: {},
    overridesByMonth: {},
    resultsByMonth: {},
    annualBudgetsByYear: {},
    annualResultsByYear: {},
  };
}

function compactResult(result) {
  if (!result || typeof result !== 'object') return result;
  const out = {};
  for (const [k, v] of Object.entries(result)) {
    if (k === 'rates' || k === 'rates_dict') continue;
    out[k] = v;
  }
  return out;
}

function compactResultsMap(map) {
  const compact = {};
  for (const [k, v] of Object.entries(map && typeof map === 'object' ? map : {})) {
    compact[k] = compactResult(v);
  }
  return compact;
}

function cleanAnnualBudgetsMap(map) {
  const out = {};
  for (const [year, amounts] of Object.entries(map && typeof map === 'object' ? map : {})) {
    if (!/^\d{4}$/.test(year) || !amounts || typeof amounts !== 'object') continue;
    const clean = {};
    for (const [rawCurrency, rawAmount] of Object.entries(amounts)) {
      const currency = String(rawCurrency).trim().toUpperCase();
      const amount = Number(rawAmount);
      if (/^[A-Z]{2,6}$/.test(currency) && Number.isFinite(amount) && amount >= 0) clean[currency] = amount;
    }
    if (Object.keys(clean).length) out[year] = clean;
  }
  return out;
}

function compactAnnualResultsMap(map) {
  const out = {};
  for (const [year, result] of Object.entries(map && typeof map === 'object' ? map : {})) {
    if (!/^\d{4}$/.test(year) || !result || typeof result !== 'object') continue;
    const clean = {};
    for (const [key, value] of Object.entries(result)) {
      if (key === 'rates' || key === 'rates_dict' || key === 'series') continue;
      clean[key] = value;
    }
    if (Object.keys(clean).length) out[year] = clean;
  }
  return out;
}

function snapshotBundle() {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    year: state.year,
    month: state.month,
    itineraryByMonth: exclusiveAllMonths(state.itineraryByMonth),
    optionsByMonth: deepClone(state.optionsByMonth),
    overridesByMonth: deepClone(state.overridesByMonth),
    resultsByMonth: compactResultsMap(state.resultsByMonth),
    annualBudgetsByYear: cleanAnnualBudgetsMap(state.annualBudgetsByYear),
    annualResultsByYear: compactAnnualResultsMap(state.annualResultsByYear),
  };
}

function sameStateValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function stateValueMarker(container, key) {
  if (container && Object.prototype.hasOwnProperty.call(container, key)) {
    return { exists: true, value: deepClone(container[key]) };
  }
  return { exists: false };
}

/**
 * 把完整内存快照压成相对本标签页读取基线的逐键补丁。这样旧标签页关闭时
 * 不会重发自己从未修改的月份；baseValues 让后端原子拒绝同一键的并发覆盖。
 */
function buildStateWrite(bundle) {
  const snap = deepClone(bundle || snapshotBundle());
  if (!serverBaseline || snap.replace) {
    return { payload: snap, touched: null };
  }
  const payload = {
    version: snap.version || 1,
    updatedAt: snap.updatedAt || new Date().toISOString(),
    baseValues: {},
  };
  const selectionChanged = !sameStateValue(snap.year, serverBaseline.year)
    || !sameStateValue(snap.month, serverBaseline.month);
  if (selectionChanged) {
    // 年/月构成一个选择值，必须成对比较和提交，避免只改月份时后端静默忽略。
    for (const field of ['year', 'month']) {
      payload[field] = snap[field];
      payload.baseValues[field] = stateValueMarker(serverBaseline, field);
    }
  }
  for (const field of STATE_MAP_FIELDS) {
    const current = snap[field] && typeof snap[field] === 'object' ? snap[field] : {};
    const baseline = serverBaseline[field] && typeof serverBaseline[field] === 'object'
      ? serverBaseline[field] : {};
    const keys = new Set([...Object.keys(current), ...Object.keys(baseline)]);
    for (const key of keys) {
      const currentHas = Object.prototype.hasOwnProperty.call(current, key);
      const baselineHas = Object.prototype.hasOwnProperty.call(baseline, key);
      if (currentHas === baselineHas
          && (!currentHas || sameStateValue(current[key], baseline[key]))) continue;
      if (!payload[field]) payload[field] = {};
      if (!payload.baseValues[field]) payload.baseValues[field] = {};
      payload[field][key] = currentHas ? deepClone(current[key]) : {};
      payload.baseValues[field][key] = stateValueMarker(baseline, key);
    }
  }
  return { payload, touched: payload.baseValues };
}

function mergePersistScope(left, right) {
  if (left === 'all' || right === 'all') return 'all';
  return left || right || 'annual';
}

function restrictStateWriteScope(writeRequest, scope) {
  if (scope !== 'annual') return writeRequest;
  for (const field of ['year', 'month', 'itineraryByMonth', 'optionsByMonth',
    'overridesByMonth', 'resultsByMonth']) {
    delete writeRequest.payload[field];
    if (writeRequest.payload.baseValues) delete writeRequest.payload.baseValues[field];
  }
  return writeRequest;
}

function payloadTouchesMonthlyState(payload) {
  if (!payload || typeof payload !== 'object') return false;
  return ['year', 'month', 'itineraryByMonth', 'optionsByMonth',
    'overridesByMonth', 'resultsByMonth'].some((field) => (
    Object.prototype.hasOwnProperty.call(payload, field)
    && (typeof payload[field] !== 'object' || payload[field] === null
      || Object.keys(payload[field]).length > 0)
  ));
}

/** 只推进本次成功写入的键；未触及键仍保留旧基线，后续不会误发旧标签快照。 */
function advanceServerBaseline(saved, payload, touched) {
  if (!serverBaseline || !touched) {
    serverBaseline = deepClone(saved && typeof saved === 'object' && Object.keys(saved).length
      ? saved : payload);
    return;
  }
  const response = saved && typeof saved === 'object' ? saved : {};
  for (const field of ['year', 'month']) {
    if (!Object.prototype.hasOwnProperty.call(touched, field)) continue;
    serverBaseline[field] = Object.prototype.hasOwnProperty.call(response, field)
      ? deepClone(response[field]) : deepClone(payload[field]);
  }
  for (const field of STATE_MAP_FIELDS) {
    if (!touched[field] || typeof touched[field] !== 'object') continue;
    if (!serverBaseline[field] || typeof serverBaseline[field] !== 'object') serverBaseline[field] = {};
    const responseMap = response[field] && typeof response[field] === 'object' ? response[field] : null;
    for (const key of Object.keys(touched[field])) {
      if (responseMap && Object.prototype.hasOwnProperty.call(responseMap, key)) {
        serverBaseline[field][key] = deepClone(responseMap[key]);
      } else if (payload[field] && payload[field][key]
                 && Object.keys(payload[field][key]).length) {
        serverBaseline[field][key] = deepClone(payload[field][key]);
      } else {
        delete serverBaseline[field][key];
      }
    }
  }
  if (response.updatedAt) serverBaseline.updatedAt = response.updatedAt;
}

function payloadTargetMarker(payload, field, key = null) {
  if (!payload || typeof payload !== 'object') return null;
  if (key === null) {
    return Object.prototype.hasOwnProperty.call(payload, field)
      ? { exists: true, value: deepClone(payload[field]) } : null;
  }
  const map = payload[field];
  if (!map || typeof map !== 'object' || !Object.prototype.hasOwnProperty.call(map, key)) return null;
  const value = map[key];
  return value && typeof value === 'object' && Object.keys(value).length
    ? { exists: true, value: deepClone(value) }
    : { exists: false };
}

/**
 * 关闭页可能与本标签页上一笔在途 PUT 竞速。最终 beacon 允许后端把“旧基线”
 * 或“上一笔 PUT 的目标值”都视为合法前置状态，但不会接受其它标签页的任意值。
 */
function addOutstandingWriteAlternatives(payload) {
  if (!payload || !payload.baseValues) return payload;
  const candidates = [activeStateWritePayload, ...uncertainStateWritePayloads.slice(-3)].filter(Boolean);
  const appendAlternative = (marker, alternative) => {
    if (!alternative || sameStateValue(alternative, marker)) return;
    const existing = marker.alternatives || [];
    if (existing.some((item) => sameStateValue(item, alternative))) return;
    marker.alternatives = [...existing, alternative].slice(-4);
  };
  for (const source of candidates) {
    for (const field of ['year', 'month']) {
      const marker = payload.baseValues[field];
      if (!marker) continue;
      appendAlternative(marker, payloadTargetMarker(source, field));
    }
    for (const field of STATE_MAP_FIELDS) {
      const bases = payload.baseValues[field];
      if (!bases || typeof bases !== 'object') continue;
      for (const [key, marker] of Object.entries(bases)) {
        appendAlternative(marker, payloadTargetMarker(source, field, key));
      }
    }
  }
  return payload;
}

function includeOutstandingTouchedKeys(payload, bundle) {
  if (!payload || !payload.baseValues || !serverBaseline) return payload;
  const sources = [activeStateWritePayload, ...uncertainStateWritePayloads].filter(Boolean);
  const forceSelection = sources.some((source) => source.baseValues
    && (source.baseValues.year || source.baseValues.month));
  if (forceSelection && !payload.baseValues.year && !payload.baseValues.month) {
    for (const field of ['year', 'month']) {
      payload[field] = bundle[field];
      payload.baseValues[field] = stateValueMarker(serverBaseline, field);
    }
  }
  for (const source of sources) {
    for (const field of STATE_MAP_FIELDS) {
      const touched = source.baseValues && source.baseValues[field];
      if (!touched || typeof touched !== 'object') continue;
      const current = bundle[field] && typeof bundle[field] === 'object' ? bundle[field] : {};
      if (!payload[field]) payload[field] = {};
      if (!payload.baseValues[field]) payload.baseValues[field] = {};
      for (const key of Object.keys(touched)) {
        if (!Object.prototype.hasOwnProperty.call(payload[field], key)) {
          payload[field][key] = Object.prototype.hasOwnProperty.call(current, key)
            ? deepClone(current[key]) : {};
          payload.baseValues[field][key] = stateValueMarker(serverBaseline[field] || {}, key);
        }
      }
    }
  }
  return payload;
}

function addStateWriteIdentity(payload) {
  payload.tabId = TAB_ID;
  payload.sequence = nextStateWriteSequence;
  nextStateWriteSequence += 1;
  return payload;
}

function writeLocalCache(bundle) {
  try {
    const snap = deepClone(bundle || snapshotBundle());
    snap.itineraryByMonth = trimLocalMonthMap(snap.itineraryByMonth);
    snap.optionsByMonth = trimLocalMonthMap(snap.optionsByMonth);
    localStorage.setItem(STORE_KEY, JSON.stringify(snap));
    localStorage.removeItem(OVERRIDES_KEY);
    localStorage.removeItem(RESULTS_KEY);
  } catch (err) {
    console.warn('本机缓存写入失败', err);
  }
}

function readLocalBundle() {
  const bundle = emptyBundle();
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (data && typeof data === 'object') {
        if (data.year && data.month) { bundle.year = data.year; bundle.month = data.month; }
        if (data.updatedAt) bundle.updatedAt = data.updatedAt;
        if (data.itineraryByMonth && typeof data.itineraryByMonth === 'object') {
          bundle.itineraryByMonth = data.itineraryByMonth;
        }
        if (data.optionsByMonth && typeof data.optionsByMonth === 'object') {
          bundle.optionsByMonth = data.optionsByMonth;
        } else if (data.region === 'Mainland' || data.region === 'Overseas') {
          bundle.optionsByMonth = {
            [`${data.year}-${String(data.month).padStart(2, '0')}`]: {
              region: data.region,
              includeTravel: false,
              travelSelected: null,
            },
          };
        }
        if (data.overridesByMonth && typeof data.overridesByMonth === 'object') {
          bundle.overridesByMonth = data.overridesByMonth;
        } else if (data.standards && !localStorage.getItem(OVERRIDES_KEY)) {
          bundle.overridesByMonth = { [`${data.year}-${String(data.month).padStart(2, '0')}`]: data.standards };
        }
        if (data.resultsByMonth && typeof data.resultsByMonth === 'object') {
          bundle.resultsByMonth = compactResultsMap(data.resultsByMonth);
        }
        if (data.annualBudgetsByYear && typeof data.annualBudgetsByYear === 'object') {
          bundle.annualBudgetsByYear = cleanAnnualBudgetsMap(data.annualBudgetsByYear);
        }
        if (data.annualResultsByYear && typeof data.annualResultsByYear === 'object') {
          bundle.annualResultsByYear = compactAnnualResultsMap(data.annualResultsByYear);
        }
      }
    }
  } catch (err) {
    console.warn('本机行程缓存读取失败', err);
  }
  if (!Object.keys(bundle.overridesByMonth).length) {
    try {
      const raw = localStorage.getItem(OVERRIDES_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          if ('variable' in parsed || 'fixed' in parsed || 'travel' in parsed) {
            bundle.overridesByMonth = { [`${bundle.year}-${String(bundle.month).padStart(2, '0')}`]: parsed };
          } else {
            bundle.overridesByMonth = parsed;
          }
        }
      }
    } catch (err) {
      console.warn('本机标准缓存读取失败', err);
    }
  }
  if (!Object.keys(bundle.resultsByMonth).length) {
    try {
      const raw = localStorage.getItem(RESULTS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') bundle.resultsByMonth = compactResultsMap(parsed);
      }
    } catch (err) {
      console.warn('本机结果缓存读取失败', err);
    }
  }
  return bundle;
}

function applyBundle(data) {
  const bundle = data && typeof data === 'object' ? data : emptyBundle();
  if (bundle.year && bundle.month) {
    state.year = bundle.year;
    state.month = bundle.month;
  }
  state.itineraryByMonth = exclusiveAllMonths(bundle.itineraryByMonth || {});
  state.optionsByMonth = bundle.optionsByMonth || {};
  state.overridesByMonth = bundle.overridesByMonth || {};
  state.resultsByMonth = compactResultsMap(bundle.resultsByMonth || {});
  state.annualBudgetsByYear = cleanAnnualBudgetsMap(bundle.annualBudgetsByYear || {});
  state.annualResultsByYear = compactAnnualResultsMap(bundle.annualResultsByYear || {});
  applyMonthOptions(monthKey());
}

function schedulePersist(scope = 'all') {
  pendingPersistScope = mergePersistScope(pendingPersistScope, scope);
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const scheduledScope = pendingPersistScope || 'all';
    pendingPersistScope = null;
    flushPersist(undefined, true, scheduledScope);
  }, 280);
}

function flushPersist(bundle = snapshotBundle(), notifyFailure = false, scope = 'all') {
  if (tabUnregistered) return Promise.resolve(false);
  if (!serverStateReady) {
    if (notifyFailure && !state.persistFailureNotified) {
      state.persistFailureNotified = true;
      toast('服务器状态尚未成功读取；修改仅保存在浏览器缓存中，请刷新页面后再保存。', 'warn');
    }
    return Promise.resolve(false);
  }
  const write = persistChain.then(async () => {
    // 页面已注销时由 unregister 携带的最终快照负责写盘，跳过排队中的旧快照。
    if (tabUnregistered) return false;
    const writeRequest = restrictStateWriteScope(buildStateWrite(bundle), scope);
    addStateWriteIdentity(writeRequest.payload);
    activeStateWritePayload = writeRequest.payload;
    try {
      const saved = await api('/api/state', {
        method: 'PUT', body: writeRequest.payload, timeout: 20000,
      });
      advanceServerBaseline(saved, writeRequest.payload, writeRequest.touched);
      state.persistFailureNotified = false;
      return true;
    } catch (err) {
      console.warn('同步到 data/app-state.json 失败', err);
      const definitelyRejected = err.code === 'STATE_CONFLICT'
        || (Number.isFinite(err.status) && err.status >= 400 && err.status < 500 && err.status !== 408);
      if (!definitelyRejected) {
        uncertainStateWritePayloads = [...uncertainStateWritePayloads, writeRequest.payload].slice(-4);
      }
      if (notifyFailure && !state.persistFailureNotified) {
        state.persistFailureNotified = true;
        toast(
          err.code === 'STATE_CONFLICT'
            ? '另一个标签页已修改同一月份或年份；本标签页未覆盖它，请刷新后再重试。'
            : '项目状态暂时无法写入服务器；本次修改仍保存在浏览器缓存中。',
          'warn',
        );
      }
      return false;
    } finally {
      if (activeStateWritePayload === writeRequest.payload) activeStateWritePayload = null;
    }
  });
  // 保持队列可继续使用；单次失败不会让后续写入永远跳过。
  persistChain = write.then(() => undefined);
  return write;
}

/** 唯一写入口。unload 只落本地缓存并返回 bundle，由注销请求带去服务端。 */
function persist(mode, scope = 'all') {
  if (tabUnregistered && mode !== 'unload') return null;
  if (scope !== 'annual') {
    snapshotOverridesIntoState();
    sessionMonthlyTouched = true;
  } else {
    sessionAnnualTouched = true;
  }
  const bundle = snapshotBundle();
  writeLocalCache(bundle);
  if (mode === 'unload') return bundle;
  if (mode === 'now') {
    clearTimeout(persistTimer);
    const effectiveScope = mergePersistScope(pendingPersistScope, scope);
    pendingPersistScope = null;
    return flushPersist(bundle, false, effectiveScope);
  }
  schedulePersist(scope);
  return null;
}

function saveState(markSaved) {
  saveMonthOptions(markSaved);
  markCurrentResultStale();
  persist('debounce');
}

/** 把旧版差异或已有快照合并到指定默认标准，供状态迁移/固化使用。 */
function mergeStandardsInto(base, saved) {
  const out = deepClone(base);
  const incoming = saved && typeof saved === 'object' ? saved : {};
  for (const cat of ['variable', 'fixed', 'travel']) {
    for (const [group, values] of Object.entries(incoming[cat] || {})) {
      if (!out[cat][group]) out[cat][group] = {};
      for (const [curr, value] of Object.entries(values || {})) {
        out[cat][group][curr] = (cat === 'travel' && value && typeof value === 'object')
          ? { daily: Number(value.daily), once: Number(value.once) }
          : Number(value);
      }
    }
  }
  out.extra = { ...(out.extra || {}) };
  for (const [curr, value] of Object.entries(incoming.extra || {})) out.extra[curr] = Number(value);
  return out;
}

function standardsSnapshot(defaults, saved) {
  if (saved && saved._snapshot) return deepClone(saved);
  const customs = saved && Array.isArray(saved.custom_locations) ? deepClone(saved.custom_locations) : [];
  const locations = deepClone((state.meta && state.meta.locations) || []);
  for (const loc of customs) {
    if (!locations.some((item) => item.key === loc.key)) locations.push(deepClone(loc));
  }
  return {
    _snapshot: true,
    ...mergeStandardsInto(defaults, saved),
    custom_locations: customs,
    custom_currencies: deepClone(saved && saved.custom_currencies || {}),
    _locations: locations,
    _location_names: deepClone(state.meta && state.meta.location_names || {}),
    _currency_names: deepClone(state.meta && state.meta.currency_names || {}),
  };
}

function currentStandardsSnapshot() {
  return {
    _snapshot: true,
    variable: deepClone(state.standards.variable),
    fixed: deepClone(state.standards.fixed),
    travel: deepClone(state.standards.travel),
    extra: deepClone(state.standards.extra || {}),
    custom_locations: deepClone(state.customLocations || []),
    custom_currencies: deepClone(state.customCurrencies || {}),
    _locations: deepClone(allLocations()),
    _location_names: snapshotLocationNames(),
    _currency_names: snapshotCurrencyNames(),
  };
}

function preserveExistingMonthsBeforeDefaultChange() {
  const currentKey = monthKey();
  const keys = new Set([
    ...Object.keys(state.itineraryByMonth || {}),
    ...Object.keys(state.optionsByMonth || {}),
    ...Object.keys(state.overridesByMonth || {}),
    ...Object.keys(state.resultsByMonth || {}),
  ]);
  const map = loadOverridesMap();
  for (const key of keys) {
    if (key === currentKey) continue;
    map[key] = standardsSnapshot(state.meta.default_standards, map[key]);
  }
  // 当月数值可能完全等于旧默认值，因而没有 overrides 记录。
  // 必须直接固化当前内存值，否则默认值 POST 成功后异常退出，
  // 下次加载会把新默认值误当作当月数值。
  map[currentKey] = currentStandardsSnapshot();
  state.overridesByMonth = map;
  state.monthStandardsSnapshot = true;
}

function activeStandardsOverride() {
  // 计算请求必须携带用户刚刚确认的完整标准快照。只发送相对默认值的差异，
  // 会让另一标签页恰好保存的新默认值改变本页已经确认过的计算输入。
  return currentStandardsSnapshot();
}

/* --------------------------------------------------------------------------
 * 「服务器默认预算标准」独立区域
 * - 当月预算面板的输入只改 state.standards（写入 app-state.json 的当月覆盖）；
 * - 默认标准面板的输入只改 state.defaultsDraft，由「保存默认标准」写入
 *   data/defaults.json（影响之后的新月份），保存不改动当月数值。
 * ------------------------------------------------------------------------ */

/** 进入「默认标准」编辑：以服务器默认标准为草稿，并入当月新建的地点/币种 */
function beginDefaultsDraft() {
  const draft = deepClone(state.meta.default_standards || { variable: {}, fixed: {}, travel: {}, extra: {} });
  draft.variable = draft.variable || {};
  draft.fixed = draft.fixed || {};
  draft.travel = draft.travel || {};
  draft.extra = draft.extra || {};
  const draftLocs = deepClone((state.meta && state.meta.locations) || []);
  const draftLocNames = { ...((state.meta && state.meta.location_names) || {}) };
  const draftCurrNames = { ...((state.meta && state.meta.currency_names) || {}) };

  for (const c of state.customLocations || []) {
    if (c.category === 'variable') {
      const st = state.standards.variable[c.key];
      if (st && st[c.currency] != null && !draft.variable[c.key]) draft.variable[c.key] = { [c.currency]: st[c.currency] };
      if (!draftLocs.some((l) => l.key === c.key)) {
        draftLocs.push({ key: c.key, name: c.name, category: 'variable', currency: c.currency });
      }
    } else if (c.category === 'travel') {
      const st = state.standards.travel[c.key];
      if (st && st[c.currency] && !draft.travel[c.key]) {
        draft.travel[c.key] = { [c.currency]: { daily: st[c.currency].daily, once: st[c.currency].once } };
      }
      if (!draftLocs.some((l) => l.key === c.key)) {
        draftLocs.push({ key: c.key, name: c.name, category: 'travel', currency: c.currency });
      }
    }
    draftLocNames[c.key] = c.name;
  }
  // 当月新增的固定预算币种：并入草稿（该币种属于当时选中的区域）
  for (const [curr, name] of Object.entries(state.customCurrencies || {})) {
    draftCurrNames[curr] = name;
    const region = state.region === 'Overseas' ? 'Overseas' : 'Mainland';
    const st = state.standards.fixed[region] && state.standards.fixed[region][curr];
    if (st != null) {
      if (!draft.fixed[region]) draft.fixed[region] = {};
      if (draft.fixed[region][curr] == null) draft.fixed[region][curr] = st;
    }
  }
  state.defaultsDraft = {
    standards: draft, locations: draftLocs,
    locationNames: draftLocNames, currencyNames: draftCurrNames,
  };
}

/** 放弃未保存的默认标准草稿，重新以服务器已保存默认值构造草稿 */
function reconstructDefaultsDraft() {
  const keepCustoms = state.customLocations;
  const keepCurrs = state.customCurrencies;
  const prevEditing = state.editingDefaults;
  state.customLocations = [];
  state.customCurrencies = {};
  state.editingDefaults = false;
  beginDefaultsDraft();
  state.customLocations = keepCustoms;
  state.customCurrencies = keepCurrs;
  state.editingDefaults = prevEditing;
}

/** 默认预算标准是否有未保存的改动（收起编辑区时一律视为没有） */
function defaultsDraftDirty() {
  if (!state.editingDefaults || !state.defaultsDraft) return false;
  return countStandardsDiffs(state.defaultsDraft.standards, state.meta.default_standards) > 0;
}

/** 比较两套标准（variable/fixed/travel/extra）的差异处数 */
function countStandardsDiffs(a, b) {
  const left = a || {};
  const right = b || {};
  let diffs = 0;
  const same = (x, y) => Number(x) === Number(y);
  for (const [loc, std] of Object.entries(left.variable || {})) {
    for (const [curr, val] of Object.entries(std || {})) {
      if (!right.variable || !right.variable[loc] || !same(val, right.variable[loc][curr])) diffs += 1;
    }
  }
  for (const [loc, std] of Object.entries(right.variable || {})) {
    if (!left.variable || !left.variable[loc]) diffs += 1;
  }
  for (const cat of ['fixed', 'extra']) {
    const groups = new Set([...Object.keys(left[cat] || {}), ...Object.keys(right[cat] || {})]);
    for (const g of groups) {
      const currs = new Set([
        ...Object.keys((left[cat] || {})[g] || {}),
        ...Object.keys((right[cat] || {})[g] || {}),
      ]);
      for (const curr of currs) {
        if (!same(((left[cat] || {})[g] || {})[curr], ((right[cat] || {})[g] || {})[curr])) diffs += 1;
      }
    }
  }
  for (const loc of new Set([...Object.keys(left.travel || {}), ...Object.keys(right.travel || {})])) {
    const aStd = (left.travel || {})[loc] || {};
    const bStd = (right.travel || {})[loc] || {};
    for (const curr of new Set([...Object.keys(aStd), ...Object.keys(bStd)])) {
      const aSub = aStd[curr] || {};
      const bSub = bStd[curr] || {};
      if (!same(aSub.daily, bSub.daily)) diffs += 1;
      if (!same(aSub.once, bSub.once)) diffs += 1;
    }
  }
  return diffs;
}

/** 生成「与默认值不同」标记；dir 决定行内动作指向哪一侧。
 *  当月侧提供「存入默认」（只写内存草稿，需再点保存）；默认标准侧提供「还原」。 */
function diffChipHtml(cat, loc, curr, field, left, right, dir) {
  const fld = field || '';
  const a = left && right ? (fld ? (left[curr] || {})[fld] : left[curr]) : null;
  const b = left && right ? (fld ? (right[curr] || {})[fld] : right[curr]) : null;
  if (a == null || b == null || Number(a) === Number(b)) return '';
  const toDefaults = dir === 'to-defaults';
  let btn = '';
  if (toDefaults) {
    btn = `<button type="button" class="chip-diff-btn" data-action="revert-row"
         title="把该项恢复为已保存的默认值 ${Number(b)}">还原</button>`;
  }
  const where = toDefaults ? '与已保存默认值不同' : '与默认值不同';
  return `<span class="chip-diff" data-action="chip" data-cat="${esc(cat)}" data-loc="${esc(loc)}" data-curr="${esc(curr)}" data-field="${esc(fld)}">
    <span class="chip-diff-text">${where} · 默认 ${Number(b)}</span>${btn}</span>`;
}

/** 当月表格：只标记与服务器默认值不同的行（不会改动默认标准） */
function monthDiffChip(cat, loc, curr, field) {
  if (state.monthStandardsSnapshot) return '';
  const defs = state.meta.default_standards;
  if (cat === 'extra') return diffChipHtml(cat, loc, curr, field, state.standards.extra, defs.extra, 'to-month');
  const defGroup = (defs[cat] || {})[loc];
  if (!defGroup || defGroup[curr] == null) return ''; // 当月新建（默认标准里没有）→ 已有「新建」标记
  return diffChipHtml(cat, loc, curr, field, state.standards[cat][loc], defGroup, 'to-month');
}

/** 默认标准区域：标记与已保存默认值不同的行 */
function defaultsDiffChip(cat, loc, curr, field) {
  const draft = state.defaultsDraft;
  if (!draft) return '';
  const saved = state.meta.default_standards;
  if (cat === 'extra') return diffChipHtml(cat, loc, curr, field, draft.standards.extra, saved.extra, 'to-defaults');
  const draftGroup = (draft.standards[cat] || {})[loc];
  if (!draftGroup) return '';
  return diffChipHtml(cat, loc, curr, field, draftGroup, (saved[cat] || {})[loc] || {}, 'to-defaults');
}

/** 当月预算：只改本月（写入 app-state.json 的当月覆盖），不影响默认标准 */
function applyMonthInput(cat, loc, curr, field, value) {
  if (cat === 'extra') {
    ensureExtraStandards();
    state.standards.extra[curr] = value;
  } else if (field) {
    state.standards[cat][loc][curr][field] = value;
  } else {
    state.standards[cat][loc][curr] = value;
  }
  saveOverrides();        // 先把标准差异写入统一状态快照
  saveState();
  renderStandardsHint();
  renderTravelPicker();   // 旅居金额变化同步到选择菜单
  invalidateConfirmation(); // 标准被修改，需重新确认
}

/** 默认标准区域：只改内存草稿，由「保存默认标准」写入 data/defaults.json */
function applyDefaultsInput(cat, loc, curr, field, value) {
  if (!state.defaultsDraft) return;
  const ds = state.defaultsDraft.standards;
  if (cat === 'extra') {
    if (!ds.extra) ds.extra = {};
    ds.extra[curr] = value;
  } else if (field) {
    if (!ds[cat][loc]) ds[cat][loc] = {};
    if (!ds[cat][loc][curr]) ds[cat][loc][curr] = { daily: 0, once: 0 };
    ds[cat][loc][curr][field] = value;
  } else {
    if (!ds[cat][loc]) ds[cat][loc] = {};
    ds[cat][loc][curr] = value;
  }
  updateDefaultsHint();
}

/** 输入后刷新那一行的「与默认值不同」标记。
 *  只替换该行的标记节点，**不重建输入框**：重建会让正在编辑的输入框被替换成新节点，
 *  后续按键落在旧节点上（表现为数字被拼接到旧值、光标错位、输入\"没反应\"）。
 *  el 是触发 input 事件的输入框本身，用它判断属于弹窗还是当月面板。 */
function refreshRowChip(cat, loc, curr, field, el) {
  const fld = field || '';
  const input = el || document.querySelector(
    `input[data-cat="${cat}"][data-loc="${loc}"][data-curr="${curr}"][data-field="${fld}"]`
  );
  if (!input || typeof input.closest !== 'function') return;
  const row = input.closest('.budget-row');
  if (!row) return;
  const inDefaults = !!input.closest('.defaults-editor');
  const html = inDefaults ? defaultsDiffChip(cat, loc, curr, fld) : monthDiffChip(cat, loc, curr, fld);
  updateRowChip(row, html);
}

/** 在行内放置 / 更新 / 移除「与默认值不同」标记 */
function updateRowChip(row, html) {
  const existing = row.querySelector('.chip-diff[data-action="chip"]');
  if (!html) {
    if (existing) existing.remove();
    return;
  }
  if (existing) {
    existing.outerHTML = html;
    return;
  }
  const title = row.querySelector('.budget-row-title') || row.querySelector('.budget-row-text');
  if (title) title.insertAdjacentHTML('beforeend', html);
}

/** 把默认标准草稿的某一项还原成已保存的默认值 */
function restoreDefaultEntry(cat, loc, curr, field) {
  const draft = state.defaultsDraft;
  if (!draft) return;
  const saved = state.meta.default_standards;
  if (cat === 'extra') {
    draft.standards.extra[curr] = Number((saved.extra || {})[curr] != null ? saved.extra[curr] : 0);
  } else if (field) {
    const defSub = (((saved.travel || {})[loc] || {})[curr]) || {};
    if (!draft.standards.travel[loc]) draft.standards.travel[loc] = {};
    if (!draft.standards.travel[loc][curr]) draft.standards.travel[loc][curr] = { daily: 0, once: 0 };
    draft.standards.travel[loc][curr][field] = Number(defSub[field] != null ? defSub[field] : 0);
  } else {
    const defVal = (((saved[cat] || {})[loc] || {})[curr]);
    if (defVal == null) {
      // 已保存默认值里没有这一项（新增项）→ 从草稿中删除
      if (draft.standards[cat] && draft.standards[cat][loc]) {
        delete draft.standards[cat][loc][curr];
        if (!Object.keys(draft.standards[cat][loc]).length) delete draft.standards[cat][loc];
      }
    } else {
      if (!draft.standards[cat][loc]) draft.standards[cat][loc] = {};
      draft.standards[cat][loc][curr] = Number(defVal);
    }
  }
  renderStandards();
  toast('已还原为已保存的默认值（尚未保存）', 'info');
}

/** 打开默认预算标准弹窗（进入编辑：以服务器默认标准构造草稿） */
function openDefaultsModal() {
  state.editingDefaults = true;
  if (!state.defaultsDraft) beginDefaultsDraft();
  renderStandards();
  renderLocChips();
  renderTravelPicker();
  const modal = $('#defaults-modal');
  if (modal && typeof modal.querySelector === 'function') {
    const first = modal.querySelector('.defaults-editor input[data-cat]');
    if (first && typeof first.focus === 'function') first.focus({ preventScroll: true });
  }
}

/** 关闭默认预算标准弹窗：丢弃未保存草稿 */
function closeDefaultsModal() {
  state.editingDefaults = false;
  state.defaultsDraft = null;
  renderStandards();
  renderLocChips();
  renderTravelPicker();
}

/** 关闭前询问：有未保存改动时让用户确认 */
function requestCloseDefaultsModal() {
  if (defaultsDraftDirty() && !confirm('默认标准有未保存的修改，关闭将丢弃这些修改。是否继续？')) return;
  closeDefaultsModal();
}

/** 同步默认预算标准弹窗的按钮显隐与提示文字 */
function syncStandardsModeUI() {
  const open = !!state.editingDefaults;
  setElVisible($('#defaults-modal'), open);
  setElVisible($('#btn-discard-defaults'), open);
  const showAllChk = $('#chk-defaults-show-all');
  if (showAllChk) showAllChk.checked = !!state.defaultsShowAll;
  updateDefaultsScopeHint();
  const saveBtn = $('#btn-save-defaults');
  if (saveBtn) {
    saveBtn.disabled = !open || defaultsSaveInFlight;
    saveBtn.title = '把默认预算标准写入服务器 data/defaults.json（不影响当月与已保存月份）';
  }
  updateDefaultsHint();
}

/** 默认标准区域的「已修改 N 处 / 尚未保存」提示 */
function updateDefaultsHint() {
  const hint = $('#defaults-hint');
  if (!hint) return;
  const open = !!state.editingDefaults;
  if (open) {
    const diffs = defaultsDraftDirty()
      ? countStandardsDiffs(state.defaultsDraft.standards, state.meta.default_standards)
      : 0;
    if (diffs > 0) {
      hint.textContent = `默认标准已修改 ${diffs} 处（尚未保存）`;
      hint.classList.add('dirty');
    } else {
      hint.textContent = '默认标准与已保存值一致';
      hint.classList.remove('dirty');
    }
    return;
  }
  if (state.meta && state.meta.defaults_customized) {
    hint.textContent = '默认标准读取自 data/defaults.json';
  } else {
    hint.textContent = '默认标准读取自 functions.py 出厂值';
  }
  hint.classList.remove('dirty');
}

/** 读取 overrides 的月份映射表 { 'YYYY-MM': {variable,fixed,travel} } */
function loadOverridesMap() {
  return state.overridesByMonth && typeof state.overridesByMonth === 'object'
    ? state.overridesByMonth
    : {};
}

function snapshotOverridesIntoState() {
  if (!state.meta || !state.year || !state.month || !state.standards) return;
  const map = loadOverridesMap();
  const key = monthKey();
  const existing = map[key];
  // 删除当前月份时，空对象是发给后端的显式墓碑；不能在同一笔 persist 中复活它。
  if (Object.prototype.hasOwnProperty.call(map, key)
      && existing && typeof existing === 'object'
      && !Object.keys(existing).length) return;
  map[key] = currentStandardsSnapshot();
  state.overridesByMonth = map;
  state.monthStandardsSnapshot = true;
}

/** 把当月完整标准快照写入统一状态；实际落盘只由 saveState/persist 负责。 */
function saveOverrides() {
  snapshotOverridesIntoState();
}

/** 读取当前月份的预算标准修改并合并到默认标准 */
function loadOverrides() {
  const map = loadOverridesMap();
  const monthOv = map[monthKey()];
  if (monthOv && typeof monthOv === 'object') {
    if (monthOv._snapshot) {
      state.standards = deepClone({
        variable: monthOv.variable || {},
        fixed: monthOv.fixed || {},
        travel: monthOv.travel || {},
        extra: monthOv.extra || {},
      });
      state.monthLocations = deepClone(monthOv._locations || []);
      state.monthLocationNames = deepClone(monthOv._location_names || {});
      state.monthCurrencyNames = deepClone(monthOv._currency_names || {});
      state.monthStandardsSnapshot = true;
    }
    applyStandards(monthOv);
    return true;
  }
  return false;
}

/** 每月计算结果存储：{ 'YYYY-MM': {summary, daily_details, fixed_details, extra_details, warnings, savedAt} } */
function loadResultsMap() {
  return state.resultsByMonth && typeof state.resultsByMonth === 'object'
    ? state.resultsByMonth
    : {};
}

function writeResultsMap(map, mode = 'debounce') {
  state.resultsByMonth = compactResultsMap(map);
  return persist(mode);
}

function saveResult(result, mode = 'debounce', context = {}) {
  const map = loadResultsMap();
  const targetMonth = context.monthKey || monthKey();
  const resultRegion = context.region == null ? state.region : context.region;
  const saved = Object.assign({}, compactResult(result), {
    savedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
    region: resultRegion === 'Overseas' ? 'Overseas' : 'Mainland',
    includeTravel: context.includeTravel == null
      ? !!state.includeTravel : !!context.includeTravel,
    stale: false,
  });
  map[targetMonth] = saved;
  if (targetMonth === monthKey()) state.calcResult = saved;
  return writeResultsMap(map, mode);
}

/** 预算输入变化后保留旧结果供追溯，但明确标为过期，避免分析页误用。 */
function markCurrentResultStale(reason = '预算标准、行程或计算选项已更改') {
  const map = loadResultsMap();
  const result = map[monthKey()];
  if (!result || typeof result !== 'object' || !result.summary) return;
  result.stale = true;
  result.staleReason = reason;
  result.staleAt = new Date().toISOString();
  if (state.calcResult) state.calcResult = result;
}

function loadResultForMonth(key) {
  return loadResultsMap()[key] || null;
}

function trimLocalMonthMap(map) {
  const out = deepClone(map && typeof map === 'object' ? map : {});
  const keys = Object.keys(out).sort();
  const current = monthKey();
  while (keys.length > MAX_KEPT_MONTHS) {
    const removableIndex = keys.findIndex((key) => key !== current);
    const index = removableIndex >= 0 ? removableIndex : 0;
    delete out[keys[index]];
    keys.splice(index, 1);
  }
  return out;
}

/** 载入当月「新建预算标准」产生的自定义地点与币种名，并初始化标准容器 */
function applyCustoms(saved) {
  const defaultKeys = new Set((state.meta && state.meta.locations || []).map((l) => l.key));
  const customs = (saved && Array.isArray(saved.custom_locations))
    ? saved.custom_locations.filter((c) => c && c.key && (c.category === 'variable' || c.category === 'travel') && c.currency && !defaultKeys.has(c.key))
    : [];
  state.customLocations = customs;
  const knownCurr = new Set((state.meta && state.meta.currencies) || []);
  const rawCurr = (saved && saved.custom_currencies && typeof saved.custom_currencies === 'object')
    ? saved.custom_currencies
    : {};
  state.customCurrencies = {};
  for (const [k, v] of Object.entries(rawCurr)) {
    if (!knownCurr.has(k)) state.customCurrencies[k] = v;
  }
  for (const c of customs) {
    if (c.category === 'variable') {
      if (!state.standards.variable[c.key]) state.standards.variable[c.key] = {};
      if (!(c.currency in state.standards.variable[c.key])) {
        state.standards.variable[c.key][c.currency] = 0;
      }
    } else {
      if (!state.standards.travel[c.key]) state.standards.travel[c.key] = {};
      if (!(c.currency in state.standards.travel[c.key])) {
        state.standards.travel[c.key][c.currency] = { daily: 0, once: 0 };
      }
    }
  }
}

/** 读取当月完整快照或兼容旧版差异（含当月新建地点/币种）。
 *  对旧版差异，缺失项必须保留默认值；null/undefined 不能覆盖有效默认值。 */
function applyStandards(saved) {
  applyCustoms(saved);
  const defs = state.meta.default_standards;
  const num = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; };
  // 取覆盖值：路径任一环节缺失 → 返回 null（表示"使用默认值"）
  const pick = (holder, loc, curr) => {
    const entry = holder && holder[loc];
    return entry && entry[curr] != null ? num(entry[curr]) : null;
  };

  // 可变：默认地点 + 自定义定居地点
  const varLocs = new Set([
    ...Object.keys(defs.variable),
    ...activeCustomLocations().filter((c) => c.category === 'variable').map((c) => c.key),
  ]);
  for (const loc of varLocs) {
    const curr = locationCurrency(loc);
    const v = pick(saved.variable, loc, curr);
    if (v !== null) state.standards.variable[loc][curr] = v;
  }
  // 固定：默认币种 + 覆盖中新增的自定义币种
  for (const reg of Object.keys(defs.fixed)) {
    const savedReg = saved.fixed && saved.fixed[reg];
    const currs = new Set([
      ...Object.keys(defs.fixed[reg]),
      ...(savedReg && typeof savedReg === 'object' ? Object.keys(savedReg) : []),
    ]);
    for (const curr of currs) {
      const v = pick(saved.fixed, reg, curr);
      if (v !== null) state.standards.fixed[reg][curr] = v;
    }
  }
  // 旅居：默认地点 + 自定义旅居地点
  const trLocs = new Set([
    ...Object.keys(defs.travel),
    ...activeCustomLocations().filter((c) => c.category === 'travel').map((c) => c.key),
  ]);
  for (const loc of trLocs) {
    const curr = locationCurrency(loc);
    const sub = saved.travel && saved.travel[loc] && saved.travel[loc][curr];
    if (sub && typeof sub === 'object') {
      for (const f of ['daily', 'once']) {
        const v = num(sub[f]);
        if (v !== null) state.standards.travel[loc][curr][f] = v;
      }
    }
  }
  // 额外预算：缺失则保持默认 0
  ensureExtraStandards();
  const savedExtra = saved.extra;
  if (savedExtra && typeof savedExtra === 'object') {
    for (const curr of EXTRA_CURRENCIES) {
      const v = num(savedExtra[curr]);
      if (v !== null) state.standards.extra[curr] = v;
    }
  }
}

/** 保证额外预算三项存在（默认 0），兼容旧存档没有 extra 的情况 */
function ensureExtraStandards() {
  const defs = (state.meta && state.meta.default_standards && state.meta.default_standards.extra) || {};
  if (!state.standards.extra || typeof state.standards.extra !== 'object') state.standards.extra = {};
  for (const curr of EXTRA_CURRENCIES) {
    if (state.standards.extra[curr] == null) {
      const n = Number(defs[curr]);
      state.standards.extra[curr] = Number.isFinite(n) && n >= 0 ? n : 0;
    }
  }
}

/* --------------------------------------------------------------------------
 * 浏览器标签页生命周期（配合后端「关闭页面立即停止服务并释放端口」）
 * - 页面加载 → 注册 tab；普通 pagehide（关闭/刷新/导航）→ 先保存再注销 tab；
 *   后端在最后一个 tab 注销后立即退出进程。
 * - 进入 bfcache 的 pagehide 不注销；普通刷新和多标签会按各自生命周期注册。
 * - 每 5 秒刷新一次服务器租约；Safari 漏发关闭事件时由租约超时兜底退出。
 * - 关闭前做最后一次保存（行程 + 当月选项 + 标准修改均已落盘）。
 * ------------------------------------------------------------------------ */
const TAB_ID = (window.crypto && typeof window.crypto.randomUUID === 'function')
  ? window.crypto.randomUUID()
  : `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
let tabHeartbeatTimer = null;

function scheduleTabHeartbeat() {
  clearTimeout(tabHeartbeatTimer);
  if (tabUnregistered) return;
  tabHeartbeatTimer = setTimeout(heartbeatTab, TAB_HEARTBEAT_INTERVAL_MS);
  // Node 测试环境不要让后台心跳阻止进程结束；浏览器的数字 timer 无此方法。
  if (tabHeartbeatTimer && typeof tabHeartbeatTimer.unref === 'function') {
    tabHeartbeatTimer.unref();
  }
}

async function heartbeatTab() {
  if (tabUnregistered) return;
  try {
    await api('/api/tabs/heartbeat', {
      method: 'POST', body: { tab_id: TAB_ID }, timeout: 8000,
    });
  } catch (_) { /* 短暂失败由下一次心跳或服务端租约处理 */ }
  scheduleTabHeartbeat();
}

function registerTab() {
  api('/api/tabs/register', { method: 'POST', body: { tab_id: TAB_ID }, timeout: 10000 })
    .catch(() => { /* 服务尚未就绪等场景忽略 */ });
  scheduleTabHeartbeat();
}

function unregisterTab() {
  if (tabUnregistered) return;
  tabUnregistered = true;
  clearTimeout(tabHeartbeatTimer);
  tabHeartbeatTimer = null;
  clearTimeout(persistTimer);
  pendingPersistScope = null;
  const bundle = snapshotBundle();
  writeLocalCache(bundle);
  const unregisterPayload = { tab_id: TAB_ID };
  if (serverStateReady) {
    const hasOutstandingMonthly = [activeStateWritePayload, ...uncertainStateWritePayloads]
      .some(payloadTouchesMonthlyState);
    const finalScope = (sessionMonthlyTouched || hasOutstandingMonthly) ? 'all' : 'annual';
    if (sessionMonthlyTouched || sessionAnnualTouched
        || activeStateWritePayload || uncertainStateWritePayloads.length) {
      const finalWrite = restrictStateWriteScope(buildStateWrite(bundle), finalScope);
      includeOutstandingTouchedKeys(finalWrite.payload, bundle);
      addOutstandingWriteAlternatives(finalWrite.payload);
      addStateWriteIdentity(finalWrite.payload);
      unregisterPayload.state = finalWrite.payload;
    }
  }
  const payload = JSON.stringify(unregisterPayload);
  const fallbackFetch = () => fetch('/api/tabs/unregister', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
    keepalive: true,
  }).catch(() => { /* 忽略 */ });
  let queued = false;
  try {
    if (typeof navigator.sendBeacon === 'function') {
      queued = navigator.sendBeacon(
        '/api/tabs/unregister', new Blob([payload], { type: 'application/json' }),
      );
    }
  } catch (_) { /* 忽略 */ }
  if (!queued) {
    try { fallbackFetch(); } catch (_) { /* 忽略 */ }
  }
}

// pagehide 同时覆盖普通导航、刷新和关闭；进入 bfcache 时页面仍然存活，
// 不能注销最后一个标签页并触发后端退出。
window.addEventListener('pagehide', (ev) => {
  if (ev.persisted) return;
  unregisterTab();
});
window.addEventListener('pageshow', (ev) => {
  if (!ev.persisted || !tabUnregistered) return;
  tabUnregistered = false;
  registerTab();
});

// 立即注册（无需等待 DOM，避免关闭倒计时期间页面加载完成前服务退出）
registerTab();

/* --------------------------------------------------------------------------
 * Yahoo Finance 连通性检测（打开页面时自动执行，失败时提示打开 VPN）
 * ------------------------------------------------------------------------ */
function showNetworkWarning(message) {
  const banner = $('#network-banner');
  if (!banner) return;
  $('#network-banner-text').textContent = message
    || '网络异常：无法连接 Yahoo Finance 获取汇率数据，请打开 VPN 后重试。';
  setElVisible(banner, true);
}

function hideNetworkWarning() {
  setElVisible($('#network-banner'), false);
}

async function runNetworkCheck(manual = false) {
  try {
    const data = await api('/api/network-check', { timeout: 20000 });
    if (data && data.ok === true) {
      hideNetworkWarning();
      if (manual) toast('网络正常：Yahoo Finance 可正常访问', 'success');
    } else {
      const msg = (data && data.hint)
        || '网络异常：无法连接 Yahoo Finance 获取汇率数据，请打开 VPN 后重试。';
      showNetworkWarning(msg);
      if (manual) toast(msg, 'error');
    }
  } catch (err) {
    // 本地后端本身不可达（连不上 127.0.0.1）时不在页面上弹 VPN 提示
    if (manual) toast(`检测失败：${err.message}`, 'error');
  }
}

/** 汇率相关请求失败（502/下载异常）时，同步点亮网络横幅 */
function maybeShowNetworkWarning(errorMessage) {
  if (/汇率|下载|Yahoo/i.test(String(errorMessage))) {
    showNetworkWarning();
  }
}

/* --------------------------------------------------------------------------
 * 行程访问（按月份索引）
 * ------------------------------------------------------------------------ */
function currentItinerary() {
  return state.itineraryByMonth[monthKey()] || {};
}

function ensureCurrentItinerary() {
  const key = monthKey();
  if (!state.itineraryByMonth[key]) state.itineraryByMonth[key] = {};
  return state.itineraryByMonth[key];
}

function addRange(location, start, end) {
  const wanted = iterDays(start, end);
  if (!wanted.length) { toast('日期无效', 'warn'); return; }
  const blocked = daysOwnedByOthers(location);
  const free = wanted.filter((day) => !blocked.has(day));
  if (!free.length) {
    toast('这些日期已属于其他地点，请先删除原行程再改', 'warn');
    return;
  }
  const pieces = rangesFromDays(free);
  const itin = ensureCurrentItinerary();
  if (!itin[location]) itin[location] = [];
  let added = 0;
  for (const piece of pieces) {
    const dup = itin[location].some((r) => r.start === piece.start && r.end === piece.end);
    if (dup) continue;
    itin[location].push(piece);
    added += 1;
  }
  if (!added) { toast('该时间段已存在', 'warn'); return; }
  const skipped = wanted.length - free.length;
  saveState();
  renderCalendar();
  renderItinerary();
  const label = pieces.map((p) => `${p.start} ~ ${p.end}`).join('，');
  toast(
    skipped
      ? `已添加 ${locName(location)}：${label}（已跳过 ${skipped} 天，那些日期属于其他地点）`
      : `已添加 ${locName(location)}：${label}`,
    'success'
  );
}

/* --------------------------------------------------------------------------
 * 预算标准编辑区
 * - 「当月预算」面板（#tab-standards 顶部三张表）：只编辑 state.standards，
 *   差异只写当月覆盖，不影响服务器默认标准；
 * - 「服务器默认预算标准」面板（.defaults-editor，弹窗内）：只编辑
 *   state.defaultsDraft，点「保存默认标准」才写 data/defaults.json。
 * 两个面板互不影响：保存默认标准不会改动当月数值。
 * ------------------------------------------------------------------------ */
function rowInputHtml(cat, loc, curr, field, value) {
  return `<input type="number" min="0" step="0.01" inputmode="decimal"
    data-cat="${esc(cat)}" data-loc="${esc(loc)}" data-curr="${esc(curr)}" data-field="${esc(field || '')}"
    value="${Number(value)}">`;
}
function delCustomBtnHtml(loc) {
  return `<button type="button" class="link danger" data-action="del-custom" data-loc="${esc(loc)}">删除</button>`;
}

/** 旅居预算小节（两个区域共用）
 *  - 默认（不传 locs）：只显示本次勾选的旅居地点，供「当月预算」面板使用；
 *  - 传 locs：按给定的地点列表渲染（默认标准弹窗用它显示全部或本月对应的部分）。
 *  customs 为自定义旅居地点（当月或草稿），同样按 locs / 勾选状态过滤。 */
function renderTravelStandardsBlocks({ values, chipFor, customs, locs, emptyText, ruleText }) {
  const all = Object.keys(values.travel || {});
  const explicit = Array.isArray(locs);
  const wanted = explicit ? locs.filter((loc) => all.includes(loc)) : all.filter(isTravelLocationSelected);
  let rows = '';
  for (const loc of wanted) {
    const curr = findStdCurrency(values.travel[loc], loc);
    const sub = values.travel[loc][curr] || { daily: 0, once: 0 };
    rows += budgetRowHtml({
      color: locColor(loc),
      letter: catLetter(locName(loc)),
      title: esc(locName(loc)),
      sub: `${esc(curr)} · 每日 / 单次`,
      chip: chipFor('travel', loc, curr, 'daily') + chipFor('travel', loc, curr, 'once'),
      inputs: `<label class="amt-lab">每日${rowInputHtml('travel', loc, curr, 'daily', sub.daily)}</label>
        <label class="amt-lab">单次${rowInputHtml('travel', loc, curr, 'once', sub.once)}</label>`,
    });
  }
  for (const c of (customs || []).filter((x) => x.category === 'travel')) {
    if (explicit ? !locs.includes(c.key) : !isTravelLocationSelected(c.key)) continue;
    const sub = ((values.travel[c.key] || {})[c.currency]);
    if (!sub) continue;
    rows += budgetRowHtml({
      color: locColor(c.key),
      letter: catLetter(c.name),
      title: `${esc(c.name)} <span class="muted">新建</span>`,
      sub: `${esc(c.currency)} · 每日 / 单次`,
      inputs: `<label class="amt-lab">每日${rowInputHtml('travel', c.key, c.currency, 'daily', sub.daily)}</label>
        <label class="amt-lab">单次${rowInputHtml('travel', c.key, c.currency, 'once', sub.once)}</label>`
        + delCustomBtnHtml(c.key),
    });
  }
  if (!rows) rows = `<p class="empty">${esc(emptyText || '请先在上方勾选本次包含的旅居地点')}</p>`;
  return `<div class="sheet-head"><h2>旅居预算</h2>
      <button type="button" class="text-btn" data-action="add-std" data-cat="travel">＋ 新建旅居地点</button></div>
    <p class="sheet-rule">${esc(ruleText || '每日预算 × 旅游天数 + 单次预算 × 月均汇率。仅显示已勾选地点。')}</p>
    <div class="row-list" data-table="travel">${rows}</div>`;
}

/** 渲染当月预算面板（页面固定的三张表 + 旅居小节） */
function renderMonthStandardsPanel() {
  const defs = state.meta.default_standards;
  const values = state.standards;
  ensureExtraStandards();
  const extraColor = { CNY: '#00c48c', USD: '#3d7eff', HKD: '#ff8a3d' };

  let html = '';
  for (const loc of Object.keys(state.monthStandardsSnapshot ? values.variable : defs.variable)) {
    const curr = findStdCurrency(values.variable[loc], loc);
    html += budgetRowHtml({
      color: locColor(loc),
      letter: catLetter(locName(loc)),
      title: esc(locName(loc)),
      sub: `${esc(curr)} · 每日`,
      chip: monthDiffChip('variable', loc, curr, ''),
      inputs: rowInputHtml('variable', loc, curr, '', values.variable[loc][curr]),
    });
  }
  const customsVar = state.monthStandardsSnapshot
    ? []
    : activeCustomLocations().filter((c) => c.category === 'variable');
  for (const c of customsVar) {
    const val = ((values.variable[c.key] || {})[c.currency]);
    if (val == null) continue;
    html += budgetRowHtml({
      color: locColor(c.key),
      letter: catLetter(c.name),
      title: `${esc(c.name)} <span class="muted">新建</span>`,
      sub: `${esc(c.currency)} · 每日`,
      inputs: rowInputHtml('variable', c.key, c.currency, '', val) + delCustomBtnHtml(c.key),
    });
  }
  $('#variable-standards-table').innerHTML = html || '<p class="empty">暂无定居地点</p>';

  html = '';
  for (const curr of Object.keys(values.fixed[state.region] || {})) {
    const isCustomCurr = !state.monthStandardsSnapshot && (defs.fixed[state.region][curr] === undefined);
    html += budgetRowHtml({
      color: extraColor[curr] || '#7b61ff',
      letter: curr.slice(0, 1),
      title: `${esc(curr)}（${esc(currencyName(curr))}）${isCustomCurr ? ' <span class="muted">新建</span>' : ''}`,
      sub: `${esc(regionName(state.region))} · 每月一次`,
      chip: monthDiffChip('fixed', state.region, curr, ''),
      inputs: rowInputHtml('fixed', state.region, curr, '', values.fixed[state.region][curr])
        + (isCustomCurr ? delCustomBtnHtml(curr) : ''),
    });
  }
  $('#fixed-standards-table').innerHTML = html;

  html = '';
  for (const curr of EXTRA_CURRENCIES) {
    html += budgetRowHtml({
      color: extraColor[curr] || '#7b61ff',
      letter: curr.slice(0, 1),
      title: `${esc(curr)}（${esc(currencyName(curr))}）`,
      sub: '额外 · 每月一次',
      chip: monthDiffChip('extra', 'extra', curr, ''),
      inputs: rowInputHtml('extra', 'extra', curr, '', values.extra[curr]),
    });
  }
  $('#extra-standards-table').innerHTML = html;

  renderTravelStandardsBlock();
}

/** 当月面板里的旅居小节（按「包含旅居」开关创建/销毁） */
function renderTravelStandardsBlock() {
  const host = $('#travel-standards-host');
  if (!host) return;
  if (!state.includeTravel || !state.meta) {
    host.innerHTML = '';
    return;
  }
  const body = renderTravelStandardsBlocks({
    values: state.standards,
    chipFor: monthDiffChip,
    customs: state.monthStandardsSnapshot ? [] : activeCustomLocations(),
  });
  host.innerHTML = `<article class="sheet" id="card-travel-standards">${body}</article>`;
}

/** 渲染默认预算标准面板（收起时清空） */
function renderDefaultsPanel() {
  const host = $('.defaults-editor');
  if (!host) return;
  if (!state.editingDefaults || !state.defaultsDraft) {
    host.innerHTML = '';
    return;
  }
  const values = state.defaultsDraft.standards;
  const defs = state.meta.default_standards;
  const extraColor = { CNY: '#00c48c', USD: '#3d7eff', HKD: '#ff8a3d' };
  const scope = defaultsScope();

  let html = '';
  for (const loc of Object.keys(values.variable || {})) {
    const curr = findStdCurrency(values.variable[loc], loc);
    html += budgetRowHtml({
      color: locColor(loc),
      letter: catLetter(locName(loc)),
      title: esc(locName(loc)),
      sub: `${esc(curr)} · 每日`,
      chip: defaultsDiffChip('variable', loc, curr, ''),
      inputs: rowInputHtml('variable', loc, curr, '', values.variable[loc][curr]),
    });
  }
  const blocks = [];
  blocks.push(`<div class="sheet-head"><h2>定居 · 可变预算</h2>
      <button type="button" class="text-btn" data-action="add-std" data-cat="variable">＋ 新建定居地点</button></div>
    <div class="row-list" data-table="variable">${html || '<p class="empty">暂无定居地点</p>'}</div>`);

  // 固定预算：勾选「显示所有默认预算」时内地、境外逐组显示（各自带「＋ 新建币种」，新建归该组）；
  // 未勾选时只显示本月对应的那一个区域。
  for (const region of scope.regions) {
    const regionStd = (values.fixed || {})[region] || {};
    const savedRegion = (defs.fixed || {})[region] || {};
    html = '';
    for (const curr of Object.keys(regionStd)) {
      const isCustomCurr = savedRegion[curr] === undefined;
      html += budgetRowHtml({
        color: extraColor[curr] || '#7b61ff',
        letter: curr.slice(0, 1),
        title: `${esc(curr)}（${esc(currencyName(curr))}）${isCustomCurr ? ' <span class="muted">新建</span>' : ''}`,
        sub: `${esc(regionName(region))} · 每月一次`,
        chip: defaultsDiffChip('fixed', region, curr, ''),
        inputs: rowInputHtml('fixed', region, curr, '', regionStd[curr]),
      });
    }
    blocks.push(`<div class="sheet-head"><h2>固定预算 <span class="muted">· ${esc(regionName(region))}</span></h2>
        <button type="button" class="text-btn" data-action="add-std" data-cat="fixed" data-region="${esc(region)}">＋ 新建币种</button></div>
      <div class="row-list" data-table="fixed" data-region="${esc(region)}">${html || '<p class="empty">该区域暂无固定预算币种</p>'}</div>`);
  }
  html = '';
  for (const curr of EXTRA_CURRENCIES) {
    html += budgetRowHtml({
      color: extraColor[curr] || '#7b61ff',
      letter: curr.slice(0, 1),
      title: `${esc(curr)}（${esc(currencyName(curr))}）`,
      sub: '额外 · 每月一次',
      chip: defaultsDiffChip('extra', 'extra', curr, ''),
      inputs: rowInputHtml('extra', 'extra', curr, '', values.extra[curr]),
    });
  }
  blocks.push(`<div class="sheet-head"><h2>额外预算</h2></div>
    <div class="row-list" data-table="extra">${html}</div>`);

  // 旅居预算：默认标准弹窗里始终显示（不再依赖「包含旅居」开关），
  // 未勾选「显示所有默认预算」时只列本月行程里出现过的旅居地点。
  blocks.push(renderTravelStandardsBlocks({
    values,
    chipFor: defaultsDiffChip,
    customs: [],
    locs: scope.travelLocs,
    emptyText: state.defaultsShowAll
      ? '暂无旅居地点'
      : '本月行程里还没有旅居地点；勾选上方「显示所有默认预算」可查看全部。',
    ruleText: '每日预算 × 旅游天数 + 单次预算 × 月均汇率。',
  }));
  host.innerHTML = blocks.join('');
}

/** 本月行程里出现过的旅居地点（按行程表里的先后顺序；只认有旅居标准的地点） */
function monthItineraryTravelLocations(values) {
  const map = (state.itineraryByMonth && state.itineraryByMonth[monthKey()]) || {};
  const known = new Set(Object.keys((values && values.travel) || {}));
  const out = [];
  for (const key of Object.keys(map)) {
    if (!known.has(key)) continue;
    if (!Array.isArray(map[key]) || !map[key].length) continue;
    out.push(key);
  }
  return out;
}

/** 默认标准弹窗的显示范围（纯展示过滤，不改动任何数值）
 *  - 勾选「显示所有默认预算」：内地 + 境外两组固定预算、全部旅居地点；
 *  - 未勾选：只显示本月对应的部分——本月居住区域的固定预算 + 本月行程里的旅居地点
 *    （本月/草稿里新建的旅居地点始终保留，避免刚建完就看不见）。
 *  注意：`defaultsDraft.locations` 是**整份地点注册表**（含全部默认旅居地点），
 *  判断「新建」必须与服务器已保存默认标准比较，不能拿它当自定义列表。 */
function defaultsScope() {
  const values = (state.defaultsDraft && state.defaultsDraft.standards) || {};
  const fixed = values.fixed || {};
  const travel = values.travel || {};
  const savedTravel = Object.keys((((state.meta || {}).default_standards || {}).travel) || {});
  const customTravel = Object.keys(travel).filter((k) => !savedTravel.includes(k));

  const orderedRegions = ['Mainland', 'Overseas'].filter((r) => fixed[r]);
  for (const r of Object.keys(fixed)) if (!orderedRegions.includes(r)) orderedRegions.push(r);

  const allTravel = Object.keys(travel);
  for (const k of customTravel) if (!allTravel.includes(k)) allTravel.push(k);

  if (state.defaultsShowAll) {
    return { regions: orderedRegions.length ? orderedRegions : [state.region], travelLocs: allTravel };
  }

  const regions = orderedRegions.includes(state.region)
    ? [state.region]
    : (orderedRegions.length ? [orderedRegions[0]] : [state.region]);
  const travelLocs = monthItineraryTravelLocations(values);
  for (const k of customTravel) if (!travelLocs.includes(k)) travelLocs.push(k);
  return { regions, travelLocs };
}

/** 默认标准弹窗里「显示所有默认预算」开关旁的说明文字 */
function updateDefaultsScopeHint() {
  const hint = $('#defaults-scope-hint');
  if (!hint) return;
  if (!state.editingDefaults || !state.defaultsDraft) {
    hint.textContent = '';
    return;
  }
  if (state.defaultsShowAll) {
    hint.textContent = '正在显示全部默认预算：内地 / 境外固定预算 + 全部旅居地点。';
    return;
  }
  const scope = defaultsScope();
  const region = scope.regions.length ? regionName(scope.regions[0]) : regionName(state.region);
  const n = scope.travelLocs.length;
  hint.textContent = `只显示本月对应的部分：${region}固定预算`
    + (n ? ` + 本月行程中的 ${n} 个旅居地点` : '（本月行程里暂无旅居地点）');
}

function renderStandards() {
  renderMonthStandardsPanel();
  renderDefaultsPanel();
  const regionText = `${regionName(state.region)}（${state.region}）`;
  const regionHint = $('#options-region-hint');
  if (regionHint) regionHint.textContent = `固定预算按 ${regionText} 计算`;
  const fixedRegionLabel = $('#fixed-region-label');
  if (fixedRegionLabel) fixedRegionLabel.textContent = `· ${regionText}`;
  const monthLabel = $('#standards-month-label');
  if (monthLabel) monthLabel.textContent = `${state.year}年${state.month}月`;
  renderStandardsHint();
  syncStandardsModeUI();
}

/** 取标准组里的币种代码；优先当前生效标准，缺失时回退到首个键 */
function findStdCurrency(stdHolder, loc) {
  const holder = stdHolder || {};
  const keys = Object.keys(holder);
  if (!keys.length) return locationCurrency(loc);
  const current = locationCurrency(loc);
  return holder[current] != null ? current : keys[0];
}


/** 当月标准与默认值的差异文案（默认标准区域有独立提示，这里只讲当月） */
function renderStandardsHint() {
  const defs = state.meta.default_standards;
  const st = state.standards;
  const hint = $('#standards-hint');
  if (!hint) return;
  const dirtyHint = (text) => {
    hint.textContent = text;
    hint.classList.add('dirty');
  };
  const cleanHint = (text) => {
    hint.textContent = text;
    hint.classList.remove('dirty');
  };

  if (state.monthStandardsSnapshot) {
    cleanHint('该月份使用保存默认值之前的完整预算标准快照');
    return;
  }
  let diffs = 0;
  let customLocCount = 0;
  const count = (a, b) => { if (Number(a) !== Number(b)) diffs += 1; };

  for (const loc of Object.keys(defs.variable)) {
    const curr = findStdCurrency(defs.variable[loc], loc);
    const holder = (st.variable[loc] || {});
    if (holder[curr] == null) diffs += 1;
    else count(holder[curr], defs.variable[loc][curr]);
  }
  for (const curr of Object.keys(st.fixed[state.region] || {})) {
    if (defs.fixed[state.region] && defs.fixed[state.region][curr] !== undefined) {
      count(st.fixed[state.region][curr], defs.fixed[state.region][curr]);
    } else {
      diffs += 1; // 自定义币种计为已修改
    }
  }
  for (const loc of Object.keys(st.variable || {})) {
    if (!defs.variable[loc]) customLocCount += 1; // 当月新建的定居地点
  }
  if (state.includeTravel) {
    for (const loc of Object.keys(defs.travel)) {
      const curr = findStdCurrency(defs.travel[loc], loc);
      const cur = ((st.travel[loc] || {})[curr]) || {};
      const def = defs.travel[loc][curr];
      count(cur.daily, def.daily);
      count(cur.once, def.once);
    }
    for (const loc of Object.keys(st.travel || {})) {
      if (!defs.travel[loc]) customLocCount += 1; // 当月新建的旅居地点
    }
  }
  const defExtra = defs.extra || {};
  ensureExtraStandards();
  for (const curr of EXTRA_CURRENCIES) {
    count(st.extra[curr], defExtra[curr] != null ? defExtra[curr] : 0);
  }
  const customCount = (activeCustomLocations() || []).filter((c) => (
    state.includeTravel || c.category !== 'travel'
  )).length;
  const customTotal = Math.max(customCount, customLocCount);
  const fixedCustom = Object.keys(activeCustomCurrencies() || {}).length;

  if (diffs > 0) {
    dirtyHint(`已修改 ${diffs} 处当月标准（仅当月生效；要改长期默认请切到「默认标准」）`);
  } else if (customTotal || fixedCustom) {
    dirtyHint('当月有新建标准（仅当月生效；要长期使用请切到「默认标准」并保存）');
  } else if (state.meta && state.meta.defaults_customized) {
    cleanHint('默认标准读取自 data/defaults.json');
  } else {
    cleanHint('默认标准读取自 functions.py 出厂值');
  }
}

/** 标准发生变化（修改/恢复/切换区域/新建删除）后，撤销确认，要求用户重新核对 */
function invalidateConfirmation() {
  state.standardsConfirmed = false;
  const chk = $('#chk-standards-confirmed');
  if (chk) chk.checked = false;
  const panel = $('#options-panel');
  if (panel) {
    panel.classList.remove('confirmed');
    panel.classList.remove('attention');
  }
}

/* --------------------------------------------------------------------------
 * 地点选择 chips
 * ------------------------------------------------------------------------ */
function renderLocChips() {
  const settleBox = $('#loc-chips-settle');
  const travelBox = $('#loc-chips-travel');
  const travelGroup = $('#loc-group-travel');
  if (!settleBox || !travelBox) return;
  settleBox.innerHTML = '';
  travelBox.innerHTML = '';

  const showTravel = !!state.includeTravel;
  if (state.activeLocation && locationCategory(state.activeLocation) === 'travel'
      && (!showTravel || !isTravelLocationSelected(state.activeLocation))) {
    const firstSettle = allLocations().find((l) => l.category !== 'travel');
    if (firstSettle) state.activeLocation = firstSettle.key;
  }

  let travelCount = 0;
  for (const loc of allLocations()) {
    if (loc.category === 'travel') {
      if (!showTravel || !isTravelLocationSelected(loc.key)) continue;
      travelCount += 1;
    }
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'chip' + (state.activeLocation === loc.key ? ' active' : '');
    el.dataset.location = loc.key;
    el.style.cssText = locColorVars(loc.key);
    const isCustom = activeCustomLocations().some((c) => c.key === loc.key);
    let sub;
    if (loc.category === 'travel') {
      const st = state.standards.travel[loc.key] && state.standards.travel[loc.key][loc.currency];
      sub = `每日 ${st ? st.daily : loc.daily} · 单次 ${st ? st.once : loc.once}`;
    } else {
      const v = state.standards.variable[loc.key] && state.standards.variable[loc.key][loc.currency];
      sub = `每日 ${v != null ? v : loc.default}`;
    }
    if (isCustom) sub += ' · 新建';
    el.innerHTML = `<i class="chip-dot"></i>${esc(loc.name)}<span class="chip-sub">${esc(sub)} ${esc(loc.currency)}</span>`;
    (loc.category === 'travel' ? travelBox : settleBox).appendChild(el);
  }

  if (showTravel && travelCount === 0) {
    travelBox.innerHTML = '<p class="empty">请先在上方选择旅居地点</p>';
  }
  setElVisible(travelGroup, showTravel);
}

function selectLocation(key) {
  state.activeLocation = key;
  state.calSel = { start: null, end: null };
  renderLocChips();
  renderCalendar();
}

/* --------------------------------------------------------------------------
 * 日历组件（周一开头，点击两个日期选时间段）
 * ------------------------------------------------------------------------ */
function buildBookedMap() {
  const map = new Map();
  const itin = currentItinerary();
  const locs = Object.keys(itin);
  const ordered = [
    ...locs.filter((l) => l !== state.activeLocation),
    ...locs.filter((l) => l === state.activeLocation),
  ];
  for (const loc of ordered) {
    for (const r of itin[loc] || []) {
      for (const ds of iterDays(r.start, r.end)) map.set(ds, loc);
    }
  }
  return map;
}

function renderCalendar() {
  const y = state.year;
  const m = state.month;
  $('#cal-title').textContent = `${y}年${m}月`;

  const first = new Date(y, m - 1, 1);
  const daysInMonth = new Date(y, m, 0).getDate();
  const offset = (first.getDay() + 6) % 7; // 周一开头
  const booked = buildBookedMap();
  const now = new Date();
  const todayStr = dateStr(now.getFullYear(), now.getMonth() + 1, now.getDate());
  const { start: selStart, end: selEnd } = state.calSel;

  let html = '';
  for (const w of ['一', '二', '三', '四', '五', '六', '日']) {
    html += `<div class="cal-dow">${w}</div>`;
  }
  for (let i = 0; i < offset; i++) html += '<div class="cal-cell empty"></div>';

  for (let d = 1; d <= daysInMonth; d++) {
    const ds = dateStr(y, m, d);
    const dow = new Date(y, m - 1, d).getDay();
    let cls = 'cal-cell';
    if (ds === todayStr) cls += ' today';
    if (dow === 0 || dow === 6) cls += ' weekend';

    let styleAttr = '';
    if (booked.has(ds)) {
      const loc = booked.get(ds);
      cls += ' booked' + (loc === state.activeLocation ? ' booked-active' : '');
      styleAttr = ` style="${locColorVars(loc)}"`; // 按地点颜色标注
    }
    if (selStart) {
      if (selEnd) {
        const [a, b] = selStart <= selEnd ? [selStart, selEnd] : [selEnd, selStart];
        if (ds >= a && ds <= b) cls += ' sel-range';
      }
      if (ds === selStart) cls += ' sel-start';
      if (selEnd && ds === selEnd) cls += ' sel-end';
    }
    html += `<div class="${cls}" data-date="${ds}"${styleAttr}>${d}</div>`;
  }
  $('#cal-grid').innerHTML = html;
}

function updateManualDefaults() {
  const last = new Date(state.year, state.month, 0).getDate();
  $('#cal-manual-start').value = dateStr(state.year, state.month, 1);
  $('#cal-manual-end').value = dateStr(state.year, state.month, last);
}

/* --------------------------------------------------------------------------
 * 行程清单
 * ------------------------------------------------------------------------ */
function renderItinerary() {
  const itin = currentItinerary();
  const container = $('#itinerary-list');
  const locs = Object.keys(itin).filter((loc) => itin[loc].length);

  if (!locs.length) {
    container.innerHTML = '<p class="empty">本月暂无行程。请在左侧选择地点，然后在日历上点击两个日期添加时间段（也可使用下方的日期输入框）。</p>';
  } else {
    let html = '';
    for (const loc of locs) {
      const meta = state.meta.locations.find((l) => l.key === loc) || {};
      const ranges = itin[loc];
      const totalDays = ranges.reduce((acc, r) => acc + daysBetween(r.start, r.end), 0);
      const typeLabel = (meta.category === 'travel') ? '旅居' : '定居';
      html += `<div class="itin-group" data-loc="${esc(loc)}" style="${locColorVars(loc)}">
        <div class="itin-head">
          <i class="chip-dot"></i>
          <span class="itin-name">${esc(meta.name || loc)}</span>
          <span class="itin-sub">${esc(loc)} · ${esc(meta.currency || '')} · ${typeLabel}</span>
          <span class="itin-days">共 ${totalDays} 天</span>
          <button class="link danger" data-action="clear-loc" data-loc="${esc(loc)}">清空</button>
        </div>
        <ul class="itin-ranges">`;
      ranges.forEach((r, idx) => {
        html += `<li>
          <span>${esc(r.start)} ~ ${esc(r.end)}</span>
          <span class="range-days">${daysBetween(r.start, r.end)} 天</span>
          <button class="link danger" data-action="del-range" data-loc="${esc(loc)}" data-idx="${idx}">删除</button>
        </li>`;
      });
      html += '</ul></div>';
    }
    container.innerHTML = html;
  }

  const totalDays = locs.reduce(
    (acc, loc) => acc + itin[loc].reduce((a, r) => a + daysBetween(r.start, r.end), 0), 0
  );
  $('#itinerary-summary').innerHTML = locs.length
    ? `本月共 <b>${totalDays}</b> 天行程，覆盖 <b>${locs.length}</b> 个地点`
    : '';
}

/* --------------------------------------------------------------------------
 * 汇率走势（每种货币独立一张折线图）
 * 说明：不同币种兑人民币的量级差异很大（如 USD≈7.2、HKD≈0.92、THB≈0.19），
 * 若画在同一张图上，低量级币种会被压成近似水平的直线。因此按币种拆分，
 * 每张图使用各自独立的纵轴比例尺（scale: true），走势一目了然。
 * ------------------------------------------------------------------------ */
function destroyRateCharts() {
  for (const item of state.rateCharts) {
    if (item.instance && typeof item.instance.dispose === 'function') {
      item.instance.dispose();
    }
  }
  state.rateCharts = [];
}

function resizeRateCharts() {
  state.rateCharts.forEach((item) => {
    if (item.instance) item.instance.resize();
  });
}

function renderRateCharts() {
  if (!state.ratesData) return;
  const showCNY = $('#chk-show-cny').checked;
  const container = $('#rates-charts');
  container.innerHTML = '';
  destroyRateCharts();

  for (const c of Object.keys(state.ratesData.series)) {
    if (c === 'CNY' && !showCNY) continue;

    // 每张图独立容器
    const wrap = document.createElement('div');
    wrap.className = 'rate-chart-wrap';
    const title = document.createElement('div');
    title.className = 'rate-chart-title';
    title.textContent = `${currencyName(c)}（${c}）兑人民币 · 每日走势`;
    const chartBox = document.createElement('div');
    chartBox.className = 'rate-chart';
    wrap.appendChild(title);
    wrap.appendChild(chartBox);
    container.appendChild(wrap);

    const chart = echarts.init(chartBox);
    chart.setOption({
      tooltip: {
        trigger: 'axis',
        valueFormatter: (v) => (v == null ? '-' : Number(v).toFixed(4)),
      },
      grid: { left: 64, right: 24, top: 30, bottom: 48 },
      xAxis: { type: 'category', data: state.ratesData.dates, boundaryGap: false },
      yAxis: { type: 'value', scale: true, name: `${c}/CNY` },
      dataZoom: [
        { type: 'inside' },
        { type: 'slider', height: 16, bottom: 10 },
      ],
      series: [{
        name: currencyName(c),
        type: 'line',
        showSymbol: false,
        connectNulls: true,
        sampling: 'lttb',
        lineStyle: { width: 2 },
        data: state.ratesData.series[c],
      }],
    }, true);
    state.rateCharts.push({ currency: c, instance: chart });
  }
}

function renderRatesStats() {
  const stats = state.ratesData.stats;
  let html = '<table class="detail-table"><thead><tr><th>币种</th><th class="num">起始</th><th class="num">期末</th>' +
    '<th class="num">均值</th><th class="num">最低</th><th class="num">最高</th></tr></thead><tbody>';
  for (const c of Object.keys(stats)) {
    const s = stats[c];
    const f = (v) => (v == null ? '-' : Number(v).toFixed(4));
    html += `<tr>
      <td>${esc(currencyName(c))} <span class="muted">${esc(c)}</span></td>
      <td class="num">${f(s.start)}</td>
      <td class="num">${f(s.end)}</td>
      <td class="num">${f(s.avg)}</td>
      <td class="num">${f(s.min)}</td>
      <td class="num">${f(s.max)}</td>
    </tr>`;
  }
  html += '</tbody></table>';
  $('#rates-stats-table').innerHTML = html;
}

async function loadRates(force = false) {
  // 计算响应附带的汇率可能只是「涉及币种」子集；进入汇率页时若数据来自计算，
  // 仍重新拉取全量币种，保证折线图完整。force 还会让后端跳过内存/磁盘缓存、重新下载。
  if (!force && state.ratesData && state.ratesMonth === monthKey() && !state.ratesFromCalc) {
    renderRateCharts();
    renderRatesStats();
    return;
  }
  const requestYear = state.year;
  const requestMonth = state.month;
  const requestMonthKey = `${requestYear}-${pad2(requestMonth)}`;
  const requestId = state.rateRequestId + 1;
  state.rateRequestId = requestId;
  setLoading(true, force
    ? '正在从 Yahoo Finance 重新下载当月汇率（将覆盖本地缓存）…'
    : '正在获取当月汇率数据（首次拉取可能需要数秒）…');
  try {
    // 币种 = 默认全部 + 当月新建标准产生的自定义币种
    const currs = new Set(state.meta.currencies);
    (activeCustomLocations() || []).forEach((c) => currs.add(c.currency));
    Object.keys(activeCustomCurrencies() || {}).forEach((c) => currs.add(c));
    const query = Array.from(currs).sort().join(',');
    const refreshQ = force ? '&refresh=true' : '';
    const data = await api(`/api/rates?year=${requestYear}&month=${requestMonth}&currencies=${encodeURIComponent(query)}${refreshQ}`, { timeout: 180000 });
    if (state.rateRequestId !== requestId || monthKey() !== requestMonthKey) return;
    state.ratesData = data;
    state.ratesMonth = requestMonthKey;
    state.ratesFromCalc = false;
    renderRateCharts();
    renderRatesStats();
    if (force) toast('已重新下载当月汇率并更新本地缓存', 'success');
  } catch (err) {
    if (state.rateRequestId !== requestId || monthKey() !== requestMonthKey) return;
    state.ratesData = null;
    toast(err.message, 'error');
    maybeShowNetworkWarning(err.message); // 汇率拉取失败 → 同步提示网络异常/VPN
  } finally {
    if (state.rateRequestId === requestId) setLoading(false);
  }
}

/* --------------------------------------------------------------------------
 * 计算结果
 * ------------------------------------------------------------------------ */
const DAILY_DETAIL_HEADERS = ['地点', '类型', '币种', '每日预算(当地)', '天数', '当地金额', '折合人民币'];
const FIXED_DETAIL_HEADERS = ['区域/地点', '类型', '币种', '当地月额', '平均汇率', '折合人民币'];
const EXTRA_DETAIL_HEADERS = ['币种', '当地月额', '平均汇率', '折合人民币'];

function buildTable(container, headers, rows, numericCols = [], options = {}) {
  if (!container) return;
  if (!rows.length) {
    container.innerHTML = `<p class="empty">${esc(options.empty || '无数据')}</p>`;
    return;
  }
  const th = headers.map((h, i) =>
    `<th class="${numericCols.includes(i) ? 'num' : ''}">${esc(h)}</th>`).join('');
  const trs = rows.map((row) => `<tr>${row.map((cell, i) =>
    `<td class="${numericCols.includes(i) ? 'num' : ''}">${esc(cell)}</td>`).join('')}</tr>`).join('');
  container.innerHTML = `<table class="detail-table"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
}

/** 明细里的地点名：居住区域显示中文（内地/境外），其余走地点名 */
function detailPlaceName(key) {
  return (key === 'Mainland' || key === 'Overseas') ? regionName(key) : locName(key);
}

/** 每日预算（定居可变 + 旅居每日，按当日汇率逐日折算）明细行 → 表格单元格。
 *  金额只写数字，币种由「币种」列给出，避免每格重复币种代码。 */
function dailyDetailRow(d) {
  return [
    detailPlaceName(d.location), d.type, d.currency,
    fmtMoney(d.daily_standard_local),
    d.day_count,
    fmtMoney(d.variable_cost_local),
    `¥ ${fmtMoney(d.variable_cost_rmb)}`,
  ];
}

/** 固定预算 / 旅居一次性费用明细行 → 表格单元格 */
function fixedDetailRow(d) {
  return [
    detailPlaceName(d.location), d.type, d.currency,
    fmtMoney(d.local_cost),
    (d.avg_rate == null ? '-' : Number(d.avg_rate).toFixed(4)),
    `¥ ${fmtMoney(d.rmb_cost)}`,
  ];
}

/** 额外预算明细行 → 表格单元格（每行一个币种，卡片标题已说明是额外预算） */
function extraDetailRow(d) {
  return [
    d.currency,
    fmtMoney(d.local_cost),
    (d.avg_rate == null ? '-' : Number(d.avg_rate).toFixed(4)),
    `¥ ${fmtMoney(d.rmb_cost)}`,
  ];
}

/** 是否为额外预算明细行（旧存档只有 fixed_details，用它把额外预算行认出来） */
function isExtraDetail(d) {
  return !!d && (d.type === '额外预算' || d.location === 'Extra');
}

/** 把计算结果拆成固定预算明细与额外预算明细两组；旧存档没有 extra_details 时按行类型兜底 */
function splitFixedExtraDetails(r) {
  const all = Array.isArray(r && r.fixed_details) ? r.fixed_details : [];
  const declared = Array.isArray(r && r.extra_details) ? r.extra_details : [];
  return {
    fixed: all.filter((d) => !isExtraDetail(d)),
    extra: declared.length ? declared : all.filter((d) => isExtraDetail(d)),
  };
}

function renderResult() {
  const r = state.calcResult;
  if (!r) return;
  const s = r.summary;
  const total = Number(s['总预算(人民币)']);

  // 三张明细表与顶部胶囊共用一套合计：可变 + 固定 + 额外 = 本月总预算
  // （固定 = 固定预算 + 旅居一次性；额外预算仍计入 summary 的「固定费用合计」，只是展示上分开）
  const split = splitFixedExtraDetails(r);
  const sumRmb = (rows) => rows.reduce((acc, d) => acc + (Number(d.rmb_cost) || 0), 0);
  const numOrNull = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const round2 = (v) => Math.round(Number(v) * 100) / 100;

  const onceRmb = numOrNull(s['固定费用合计(人民币)']);       // 固定 + 额外 + 旅居一次性
  const declaredExtraRmb = numOrNull(s['额外预算合计(人民币)']);
  const extraRmb = split.extra.length
    ? (declaredExtraRmb === null ? sumRmb(split.extra) : declaredExtraRmb)
    : 0;
  // 固定 + 额外 必须正好等于「固定费用合计」，三个数字相加才等于总预算
  const fixedRmb = onceRmb === null ? sumRmb(split.fixed) : round2(onceRmb - extraRmb);
  const variableRmb = (() => {
    const fromSummary = numOrNull(s['可变费用合计(人民币)']);
    return fromSummary === null ? sumRmb(r.daily_details || []) : fromSummary;
  })();

  $('#result-title').textContent = `计算结果：${esc(s['计算月份'] || '')}`;
  $('#result-summary').innerHTML = `
    <div class="hero">
      <div class="hero-label">本月总预算</div>
      <div class="hero-amount">¥ ${fmtMoney(total)}</div>
      <div class="hero-pills">
        <span>可变 ¥ ${fmtMoney(variableRmb)}</span>
        <span>固定 ¥ ${fmtMoney(fixedRmb)}</span>
        <span>额外 ¥ ${fmtMoney(extraRmb)}</span>
        <span>${esc(regionName(s['居住区域']))} · ${esc(s['计算月份'] || '')}</span>
      </div>
    </div>`;

  const warns = $('#result-warnings');
  const resultWarnings = r.stale
    ? [`旧结果：${r.staleReason || '预算输入已更改'}，请重新计算后再用于月度比较。`, ...(r.warnings || [])]
    : (r.warnings || []);
  warns.innerHTML = resultWarnings.map((w) =>
    `<div class="warn-item">⚠ ${esc(w)}</div>`).join('');

  // 过期结果仍保留供追溯，但不能伪装成当前输入的有效计算结果。
  const meta = $('#result-meta');
  if (meta) {
    if (r.stale) {
      meta.textContent = `⚠ 这是输入变更前保存的旧结果${r.savedAt ? `（${r.savedAt}）` : ''}`;
    } else {
      meta.textContent = r.savedAt
        ? `✓ 该月计算结果已保存到项目数据（${r.savedAt}）`
        : '✓ 该月计算结果已保存到项目数据';
    }
  }

  // 三张明细表：每日预算明细通栏，固定/额外各一张卡片；合计显示在卡片标题右侧
  buildTable(
    $('#daily-details-table'),
    DAILY_DETAIL_HEADERS,
    (Array.isArray(r.daily_details) ? r.daily_details : []).map(dailyDetailRow),
    [3, 4, 5, 6],
    { empty: '本月还没有行程明细，请先在「行程安排」里添加行程' }
  );

  buildTable(
    $('#fixed-details-table'),
    FIXED_DETAIL_HEADERS,
    split.fixed.map(fixedDetailRow),
    [3, 4, 5],
    { empty: '本月没有固定预算明细' }
  );

  buildTable(
    $('#extra-details-table'),
    EXTRA_DETAIL_HEADERS,
    split.extra.map(extraDetailRow),
    [1, 2, 3],
    { empty: '本月没有额外预算（默认均为 0）' }
  );

  setDetailTotal('#daily-details-total', variableRmb);
  setDetailTotal('#fixed-details-total', fixedRmb);
  setDetailTotal('#extra-details-total', extraRmb);
}

/** 把某张明细表的合计写到卡片标题右侧 */
function setDetailTotal(selector, amount) {
  const el = $(selector);
  if (el) el.textContent = `¥ ${fmtMoney(amount)}`;
}

/** 清空结果区（无结果时的占位提示） */
function clearResult() {
  state.calcResult = null;
  const title = $('#result-title');
  if (title) title.textContent = '计算结果';
  const meta = $('#result-meta');
  if (meta) meta.textContent = '';
  const summary = $('#result-summary');
  if (summary) summary.innerHTML = `<div class="empty-card">
    <div class="empty-title">还没有计算结果</div>
    <p>先确认预算标准，添加行程，再点「计算预算」。</p>
  </div>`;
  const warns = $('#result-warnings');
  if (warns) warns.innerHTML = '';
  const d = $('#daily-details-table');
  if (d) d.innerHTML = '';
  const f = $('#fixed-details-table');
  if (f) f.innerHTML = '';
  const x = $('#extra-details-table');
  if (x) x.innerHTML = '';
  ['#daily-details-total', '#fixed-details-total', '#extra-details-total'].forEach((sel) => {
    const el = $(sel);
    if (el) el.textContent = '';
  });
}

/* --------------------------------------------------------------------------
 * 计算
 * ------------------------------------------------------------------------ */
async function calculate() {
  if (state.busy) return;

  // 门禁 1：必须先确认预算标准无误（标准被修改/区域被切换后需重新确认）
  if (!state.standardsConfirmed) {
    toast('请先确认预算标准无误', 'warn');
    switchTab('standards');
    const panel = $('#options-panel');
    if (panel) {
      panel.classList.add('attention');
      if (typeof panel.scrollIntoView === 'function') {
        panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
    return;
  }

  // 从发起请求的月份捕获完整计算上下文。等待后端响应期间用户可以切月，
  // 结果必须仍归档到原月份，且不能覆盖新月份当前展示的结果/汇率。
  const requestYear = state.year;
  const requestMonth = state.month;
  const requestMonthKey = monthKey();
  const requestRegion = state.region === 'Overseas' ? 'Overseas' : 'Mainland';
  const requestIncludeTravel = !!state.includeTravel;
  const requestTravelLocations = requestIncludeTravel ? selectedTravelList() : [];
  const requestStandards = activeStandardsOverride();
  const itin = currentItinerary();
  const entries = Object.keys(itin)
    .filter((loc) => itin[loc].length)
    .map((loc) => ({ location: loc, ranges: itin[loc] }));

  if (!entries.length) {
    toast('请先在「行程安排」中添加行程', 'warn');
    switchTab('itinerary');
    return;
  }

  state.busy = true;
  setLoading(true, '正在计算预算（需获取当月汇率，首次拉取可能需要数秒）…');
  try {
    const result = await api('/api/calculate', {
      method: 'POST',
      body: {
        year: requestYear,
        month: requestMonth,
        region: requestRegion,
        itinerary: entries,
        // 发送用户已确认的完整标准快照（含当月新建地点/币种元数据），
        // 避免并发默认值变更改变本次计算输入。
        standards_override: requestStandards,
        include_travel: requestIncludeTravel,
        travel_locations: requestTravelLocations,
      },
      timeout: 180000,
    });
    const saved = await saveResult(result, 'now', {
      monthKey: requestMonthKey,
      region: requestRegion,
      includeTravel: requestIncludeTravel,
    }); // 先确认项目状态是否真正落盘
    if (monthKey() === requestMonthKey) {
      // 顺带缓存汇率数据（仅涉及币种子集，进入汇率页时会自动拉全量）
      state.ratesData = result.rates;
      state.ratesMonth = requestMonthKey;
      state.ratesFromCalc = true;
      renderResult();
      switchTab('result');
    }
    const stayedOnMonth = monthKey() === requestMonthKey;
    const calculatedMonth = `${requestYear}年${pad2(requestMonth)}月`;
    toast(
      saved
        ? (stayedOnMonth ? '计算完成，该月结果已保存' : `${calculatedMonth}预算计算完成并已保存`)
        : (stayedOnMonth ? '计算完成，但保存到服务器失败' : `${calculatedMonth}计算完成，但保存到服务器失败`),
      saved ? 'success' : 'warn',
    );
  } catch (err) {
    toast(err.message, 'error');
    maybeShowNetworkWarning(err.message); // 计算中的汇率拉取失败 → 同步提示网络异常/VPN
  } finally {
    state.busy = false;
    setLoading(false);
  }
}

/* --------------------------------------------------------------------------
 * 全年预算：年初至截止日的实际交易日 Close 算术平均
 * 全年金额与紧凑结果复用唯一 app-state 持久化管线；原始行情不进状态。
 * ------------------------------------------------------------------------ */
function annualYearKey() { return String(state.annualYear || new Date().getFullYear()); }

function annualBudgetAmounts() {
  const year = annualYearKey();
  if (!state.annualBudgetsByYear || typeof state.annualBudgetsByYear !== 'object') {
    state.annualBudgetsByYear = {};
  }
  if (!state.annualBudgetsByYear[year] || typeof state.annualBudgetsByYear[year] !== 'object') {
    state.annualBudgetsByYear[year] = {};
  }
  return state.annualBudgetsByYear[year];
}

function addStandardsCurrencies(target, standards) {
  if (!standards || typeof standards !== 'object') return;
  for (const category of ['variable', 'fixed', 'travel']) {
    for (const values of Object.values(standards[category] || {})) {
      if (!values || typeof values !== 'object') continue;
      Object.keys(values).forEach((currency) => {
        if (/^[A-Z]{2,6}$/.test(currency)) target.add(currency);
      });
    }
  }
  Object.keys(standards.extra || {}).forEach((currency) => {
    if (/^[A-Z]{2,6}$/.test(currency)) target.add(currency);
  });
  (standards.custom_locations || []).forEach((item) => {
    if (item && /^[A-Z]{2,6}$/.test(item.currency || '')) target.add(item.currency);
  });
  Object.keys(standards.custom_currencies || {}).forEach((currency) => {
    if (/^[A-Z]{2,6}$/.test(currency)) target.add(currency);
  });
}

function annualCurrencies() {
  const currencies = new Set((state.meta && state.meta.currencies) || []);
  Object.keys((state.meta && state.meta.currency_names) || {}).forEach((currency) => currencies.add(currency));
  addStandardsCurrencies(currencies, state.meta && state.meta.default_standards);
  Object.keys(annualBudgetAmounts()).forEach((currency) => currencies.add(currency));
  return Array.from(currencies)
    .filter((currency) => /^[A-Z]{2,6}$/.test(currency))
    .sort((a, b) => (a === 'CNY' ? -1 : b === 'CNY' ? 1 : a.localeCompare(b)));
}

function availableAnnualYears() {
  const nowYear = new Date().getFullYear();
  return Array.from({ length: nowYear - 1999 }, (_, index) => nowYear - index);
}

function fillAnnualYearSelect() {
  const select = $('#annual-year');
  if (!select) return;
  const years = availableAnnualYears();
  if (!years.includes(Number(state.annualYear))) state.annualYear = years[0];
  select.innerHTML = years.map((year) => `<option value="${year}">${year}年</option>`).join('');
  select.value = String(state.annualYear);
}

function annualRateStat(currency) {
  if (!state.annualRatesData || state.annualRatesYear !== annualYearKey()) return null;
  return (state.annualRatesData.stats || {})[currency] || null;
}

function annualResultForYear() {
  const result = (state.annualResultsByYear && state.annualResultsByYear[annualYearKey()]) || null;
  return result && !result.stale ? result : null;
}

function renderAnnualBudget() {
  fillAnnualYearSelect();
  const rowsHost = $('#annual-budget-rows');
  if (!rowsHost) return;
  const year = annualYearKey();
  const amounts = annualBudgetAmounts();
  const storedResult = (state.annualResultsByYear && state.annualResultsByYear[year]) || null;
  const result = annualResultForYear();
  const resultRows = new Map(((result && result.details) || []).map((row) => [row.currency, row]));
  const liveRates = state.annualRatesData && state.annualRatesYear === year
    ? state.annualRatesData
    : null;
  // 有有效计算结果时，汇率/样本/覆盖日期必须与生成该总额的同一快照一致。
  // 页面后台加载到的更新行情只在结果失效后用于下一次计算提示。
  const rateContext = result || liveRates;
  const errors = (rateContext && rateContext.errors) || {};

  $('#annual-budget-title').textContent = `${year}年 全年预算计算`;
  const range = $('#annual-budget-range');
  if (rateContext && rateContext.start_date && rateContext.requested_through) {
    const d = rateContext;
    range.textContent = `${d.start_date} 至 ${d.requested_through}；最新可用收盘日 ${d.observed_through || '暂无'}`;
  } else {
    range.textContent = `将读取 ${year} 年实际交易日收盘汇率`;
  }

  rowsHost.innerHTML = annualCurrencies().map((currency) => {
    const row = resultRows.get(currency);
    const stat = (row && row.average_rate != null ? {
      average: row.average_rate,
      observation_count: row.observation_count || 0,
    } : null) || annualRateStat(currency);
    const error = errors[currency];
    const rateText = stat ? Number(stat.average).toFixed(6) : (error ? '获取失败' : '—');
    const sampleText = stat ? `${stat.observation_count} 日` : '—';
    const cnyText = row ? `¥ ${fmtMoney(row.cny_amount)}` : '待计算';
    const amount = Number(amounts[currency]);
    return `<tr data-annual-row="${esc(currency)}">
      <td><strong>${esc(currencyName(currency))}</strong> <span class="muted">${esc(currency)}</span></td>
      <td class="num"><input type="number" min="0" step="any" inputmode="decimal"
        data-annual-currency="${esc(currency)}" aria-label="${esc(currency)} 全年当地金额"
        value="${Number.isFinite(amount) ? amount : 0}"></td>
      <td class="num ${error ? 'rate-missing' : ''}" data-annual-rate>${esc(rateText)}</td>
      <td class="num">${esc(sampleText)}</td>
      <td class="num" data-annual-cny>${esc(cnyText)}</td>
    </tr>`;
  }).join('');

  const total = result && result.summary ? Number(result.summary['全年预算合计(人民币)']) : NaN;
  $('#annual-budget-total').textContent = Number.isFinite(total) ? `¥ ${fmtMoney(total)}` : '¥ —';
  const meta = $('#annual-budget-meta');
  meta.textContent = result
    ? `已计算至 ${result.observed_through || result.requested_through || '最新收盘日'}${result.calculatedAt ? ` · ${result.calculatedAt}` : ''}`
    : (storedResult && storedResult.stale
      ? `${storedResult.staleReason || '全年输入或汇率已变化'}，请重新计算`
      : '输入各币种全年金额后计算');

  const errorCurrencies = Object.keys(errors);
  const note = $('#annual-budget-note');
  if (errorCurrencies.length) {
    note.textContent = `以下币种暂时缺少收盘汇率：${errorCurrencies.join(', ')}。其金额为 0 时不影响总额；非 0 时将拒绝计算。`;
    note.classList.add('is-warning');
  } else {
    note.textContent = '非交易日不填充；年平均按 Yahoo Finance 实际 Close 观测直接求算术平均。';
    note.classList.remove('is-warning');
  }
  const status = $('#annual-budget-status');
  status.textContent = state.annualLoading
    ? '正在获取汇率…'
    : (result ? '已计算' : (storedResult && storedResult.stale ? '待重新计算' : '待计算'));
  status.classList.toggle('dirty', !result && !state.annualLoading);
  const calculateButton = $('#btn-calculate-annual');
  if (calculateButton) calculateButton.disabled = !!state.annualLoading;
}

function invalidateAnnualResult(reason = '全年金额已修改') {
  const year = annualYearKey();
  const existing = state.annualResultsByYear && state.annualResultsByYear[year];
  // 年度映射与月度映射一样采用“未提交的 key 保留磁盘值”的合并语义。
  // 不能直接 delete 唯一结果，否则空映射会被解释为“没有更新”，旧总额会在重载时复活。
  if (existing && typeof existing === 'object') {
    existing.stale = true;
    existing.staleReason = reason;
    existing.staleAt = new Date().toISOString();
  }
  $$('#annual-budget-rows [data-annual-cny]').forEach((cell) => { cell.textContent = '待计算'; });
  const total = $('#annual-budget-total');
  if (total) total.textContent = '¥ —';
  const meta = $('#annual-budget-meta');
  if (meta) meta.textContent = '金额已修改，请重新计算';
  const status = $('#annual-budget-status');
  if (status) { status.textContent = '待重新计算'; status.classList.add('dirty'); }
}

function annualRatesDifferFromResult(rates, result) {
  if (!rates || !result) return false;
  if ((rates.requested_through || null) !== (result.requested_through || null)) return true;
  if ((rates.observed_through || null) !== (result.observed_through || null)) return true;
  const resultRows = new Map((result.details || []).map((row) => [row.currency, row]));
  for (const [currency, row] of resultRows) {
    const stat = (rates.stats || {})[currency];
    if (!stat && Number(row.amount) > 0) return true;
    if (!stat) continue;
    if (Math.abs(Number(stat.average) - Number(row.average_rate)) > 1e-12) return true;
    if (Number(stat.observation_count) !== Number(row.observation_count || 0)) return true;
  }
  return false;
}

async function loadAnnualRates(force = false) {
  const year = annualYearKey();
  if (state.annualLoading && state.annualLoadingYear === year) return;
  if (!force && state.annualRatesData && state.annualRatesYear === year) {
    renderAnnualBudget();
    return;
  }
  const requestId = state.annualRateRequestId + 1;
  state.annualRateRequestId = requestId;
  state.annualLoading = true;
  state.annualLoadingYear = year;
  renderAnnualBudget();
  const button = $('#btn-refresh-annual-rates');
  if (button) button.disabled = true;
  try {
    const query = annualCurrencies().join(',');
    const refresh = force ? '&refresh=true' : '';
    const data = await api(`/api/annual-rates?year=${year}&currencies=${encodeURIComponent(query)}${refresh}`, { timeout: 180000 });
    if (state.annualRateRequestId !== requestId || annualYearKey() !== year) return;
    const priorResult = annualResultForYear();
    state.annualRatesData = data;
    state.annualRatesYear = year;
    const failedCurrencies = Object.keys((data && data.errors) || {});
    const refreshComplete = !!data && data.complete !== false && failedCurrencies.length === 0;
    const invalidated = !!priorResult && refreshComplete
      && (force || annualRatesDifferFromResult(data, priorResult));
    if (invalidated) {
      invalidateAnnualResult(force ? '全年收盘汇率已手动刷新' : '全年收盘汇率覆盖范围已更新');
      persist('debounce', 'annual');
    }
    if (force) {
      if (!refreshComplete) {
        toast(`全年收盘汇率刷新不完整（${failedCurrencies.join(', ') || '未知币种'}），已保留原计算结果`, 'warn');
      } else {
        toast(invalidated ? '已刷新全年收盘汇率，请重新计算全年预算' : '已刷新全年收盘汇率', 'success');
      }
    }
  } catch (err) {
    if (state.annualRateRequestId === requestId && annualYearKey() === year) {
      state.annualRatesData = null;
      state.annualRatesYear = null;
      toast(err.message, 'error');
      maybeShowNetworkWarning(err.message);
    }
  } finally {
    if (state.annualRateRequestId === requestId) {
      state.annualLoading = false;
      state.annualLoadingYear = null;
      if (button) button.disabled = false;
      renderAnnualBudget();
    }
  }
}

async function calculateAnnualBudget() {
  if (state.busy) return;
  if (state.annualLoading) {
    toast('全年收盘汇率仍在刷新，请完成后再计算', 'warn');
    return;
  }
  const year = annualYearKey();
  const amounts = {};
  let invalid = false;
  $$('#annual-budget-rows input[data-annual-currency]').forEach((input) => {
    const amount = Number(input.value);
    if (!Number.isFinite(amount) || amount < 0) {
      input.classList.add('invalid');
      invalid = true;
    } else {
      input.classList.remove('invalid');
      amounts[input.dataset.annualCurrency] = amount;
    }
  });
  if (invalid) { toast('全年金额必须是非负有限数', 'warn'); return; }

  state.busy = true;
  setLoading(true, `正在计算 ${year} 年全年预算…`);
  try {
    const result = await api('/api/annual-budget', {
      method: 'POST', body: { year: Number(year), amounts }, timeout: 180000,
    });
    result.calculatedAt = new Date().toLocaleString('zh-CN', { hour12: false });
    state.annualBudgetsByYear[year] = amounts;
    state.annualResultsByYear[year] = compactAnnualResultsMap({ [year]: result })[year];
    const saved = await persist('now', 'annual');
    renderAnnualBudget();
    toast(saved ? '全年预算计算完成并已保存' : '计算完成，但保存到服务器失败', saved ? 'success' : 'warn');
  } catch (err) {
    toast(err.message, 'error');
    maybeShowNetworkWarning(err.message);
  } finally {
    state.busy = false;
    setLoading(false);
  }
}

/* --------------------------------------------------------------------------
 * 数据分析：各月总预算折线图
 * 横轴 = 已保存计算结果的月份；纵轴 = 总预算（人民币）。
 * 两组标签（境内/境外、是否旅居）：未勾选 = 不筛选并在横轴注释；勾选后按勾选项筛选，该组注释隐藏。
 * ------------------------------------------------------------------------ */
function monthKeyToLabel(key) {
  const [y, m] = String(key).split('-');
  return `${y}年${m}月`;
}

function collectAnalysisMonths() {
  const results = loadResultsMap();
  const options = state.optionsByMonth || {};
  return Object.keys(results).sort().map((key) => {
    const r = results[key];
    if (r && r.stale) return null;
    const total = r && r.summary ? Number(r.summary['总预算(人民币)']) : NaN;
    if (!Number.isFinite(total)) return null;
    const opt = options[key] || {};
    const regionRaw = r.region || opt.region || (r.summary && r.summary['居住区域']) || 'Mainland';
    const region = regionRaw === 'Overseas' ? 'Overseas' : 'Mainland';
    let includeTravel;
    if (r.includeTravel != null) includeTravel = !!r.includeTravel;
    else if (opt.includeTravel != null) includeTravel = !!opt.includeTravel;
    else includeTravel = false;
    return { key, label: monthKeyToLabel(key), amount: total, region, includeTravel };
  }).filter(Boolean);
}

function readAnalysisFilters() {
  const regionVals = $$('#analysis-tags-region input:checked').map((el) => el.value);
  const travelVals = $$('#analysis-tags-travel input:checked').map((el) => el.value);
  return {
    from: ($('#analysis-from') && $('#analysis-from').value) || '',
    to: ($('#analysis-to') && $('#analysis-to').value) || '',
    regions: regionVals,
    hideRegionAnno: regionVals.length > 0,
    travels: travelVals.map((v) => v === '1'),
    hideTravelAnno: travelVals.length > 0,
  };
}

function fillAnalysisRangeSelects(allKeys) {
  const fromSel = $('#analysis-from');
  const toSel = $('#analysis-to');
  if (!fromSel || !toSel) return;
  const prevFrom = fromSel.value;
  const prevTo = toSel.value;
  const opts = allKeys.map((k) => `<option value="${esc(k)}">${esc(monthKeyToLabel(k))}</option>`).join('');
  fromSel.innerHTML = opts;
  toSel.innerHTML = opts;
  if (!allKeys.length) return;
  fromSel.value = allKeys.includes(prevFrom) ? prevFrom : allKeys[0];
  toSel.value = allKeys.includes(prevTo) ? prevTo : allKeys[allKeys.length - 1];
  if (fromSel.value > toSel.value) {
    const tmp = fromSel.value;
    fromSel.value = toSel.value;
    toSel.value = tmp;
  }
}

function destroyAnalysisChart() {
  if (state.analysisChart && typeof state.analysisChart.dispose === 'function') {
    state.analysisChart.dispose();
  }
  state.analysisChart = null;
}

function resizeAnalysisChart() {
  if (state.analysisChart) state.analysisChart.resize();
}

function renderAnalysis() {
  const host = $('#analysis-chart');
  const empty = $('#analysis-empty');
  const legend = $('#analysis-legend');
  if (!host) return;

  const all = collectAnalysisMonths();
  fillAnalysisRangeSelects(all.map((m) => m.key));
  const filters = readAnalysisFilters();

  let rows = all.filter((m) => {
    if (filters.from && m.key < filters.from) return false;
    if (filters.to && m.key > filters.to) return false;
    if (filters.regions.length && !filters.regions.includes(m.region)) return false;
    if (filters.travels.length && !filters.travels.includes(m.includeTravel)) return false;
    return true;
  });

  const total = rows.reduce((sum, row) => sum + row.amount, 0);
  const countEl = $('#analysis-month-count');
  const totalEl = $('#analysis-month-total');
  const averageEl = $('#analysis-month-average');
  if (countEl) countEl.textContent = String(rows.length);
  if (totalEl) totalEl.textContent = `¥ ${fmtMoney(total)}`;
  if (averageEl) averageEl.textContent = `¥ ${fmtMoney(rows.length ? total / rows.length : 0)}`;
  buildTable(
    $('#analysis-data-table'),
    ['月份', '总预算（人民币）', '区域', '旅居'],
    rows.map((row) => [
      row.label,
      fmtMoney(row.amount),
      row.region === 'Overseas' ? '境外' : '内地',
      row.includeTravel ? '含旅居' : '不含旅居',
    ]),
    [1],
    { empty: '当前筛选下没有已计算的月份' },
  );

  const showRegion = !filters.hideRegionAnno;
  const showTravel = !filters.hideTravelAnno;

  if (legend) {
    const bits = [];
    if (showRegion) {
      bits.push('<span class="lg-item"><i class="lg-dot" style="background:#00c48c"></i>内地</span>');
      bits.push('<span class="lg-item"><i class="lg-dot" style="background:#3d7eff"></i>境外</span>');
    }
    if (showTravel) {
      bits.push('<span class="lg-item"><i class="lg-dot" style="background:#8a9299"></i>不含旅居</span>');
      bits.push('<span class="lg-item"><i class="lg-dia"></i>含旅居</span>');
    }
    legend.innerHTML = bits.join('');
  }

  if (!rows.length) {
    destroyAnalysisChart();
    host.classList.add('is-empty');
    host.style.height = '0px';
    setElVisible(empty, true);
    if (empty) {
      empty.textContent = all.length
        ? '当前时间段或标签下没有月份。请调整筛选后再试。'
        : '还没有可绘制的月份。请先在各月添加行程并点击「计算预算」，本页会自动读取已保存结果。';
    }
    return;
  }

  setElVisible(empty, false);
  host.classList.remove('is-empty');
  host.style.height = '';

  const data = rows.map((m) => ({
    value: m.amount,
    itemStyle: { color: showRegion ? (m.region === 'Overseas' ? '#3d7eff' : '#00c48c') : '#00c48c' },
    symbol: showTravel ? (m.includeTravel ? 'diamond' : 'circle') : 'circle',
    symbolSize: showTravel && m.includeTravel ? 14 : 9,
  }));

  if (!state.analysisChart) {
    state.analysisChart = echarts.init(host);
  }

  state.analysisChart.setOption({
    tooltip: {
      trigger: 'axis',
      formatter: (params) => {
        const p = params && params[0];
        if (!p) return '';
        const row = rows[p.dataIndex];
        if (!row) return '';
        const tags = [
          row.region === 'Overseas' ? '境外' : '内地',
          row.includeTravel ? '含旅居' : '不含旅居',
        ];
        return `${row.label}<br/>总预算 ¥ ${fmtMoney(row.amount)}<br/>${tags.join(' · ')}`;
      },
    },
    grid: { left: 64, right: 28, top: 28, bottom: showRegion || showTravel ? 72 : 48 },
    xAxis: {
      type: 'category',
      data: rows.map((m) => m.key),
      axisLabel: {
        interval: 0,
        hideOverlap: true,
        formatter: (value, idx) => {
          const row = rows[idx];
          const title = row ? row.label : monthKeyToLabel(value);
          if (!row) return title;
          const extra = [];
          if (showRegion) extra.push(row.region === 'Overseas' ? '境外' : '内地');
          if (showTravel) extra.push(row.includeTravel ? '旅居' : '定居');
          return extra.length ? `${title}\n${extra.join(' · ')}` : title;
        },
      },
    },
    yAxis: {
      type: 'value',
      name: '总预算（人民币）',
      axisLabel: { formatter: (v) => (v >= 10000 ? `${(v / 10000).toFixed(1)}万` : String(v)) },
    },
    series: [{
      name: '总预算',
      type: 'line',
      smooth: true,
      showSymbol: true,
      symbol: 'circle',
      lineStyle: { width: 3, color: '#00c48c' },
      data,
    }],
  }, true);
}

/* --------------------------------------------------------------------------
 * 页签与月份切换
 * ------------------------------------------------------------------------ */
function switchTab(name) {
  $$('.side-nav-item').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
  if (document.body && document.body.classList) document.body.classList.toggle('annual-view', name === 'analysis');
  if (name === 'rates') {
    loadRates();
    setTimeout(resizeRateCharts, 60);
  }
  if (name === 'analysis') {
    renderAnnualBudget();
    loadAnnualRates();
    renderAnalysis();
    setTimeout(resizeAnalysisChart, 60);
  }
}

function renderAll() {
  $('#month-label').textContent = `${state.year}年${pad2(state.month)}月`;
  syncOptionsUI();
  $('#itinerary-month').textContent = `${state.year}年${state.month}月`;
  $('#rates-title').textContent = `${state.year}年${state.month}月 汇率走势（兑人民币）`;
  if (state.ratesMonth !== monthKey()) {
    state.ratesData = null;
    state.ratesFromCalc = false;
    destroyRateCharts();
    const charts = $('#rates-charts');
    if (charts) charts.innerHTML = '';
    const stats = $('#rates-stats-table');
    if (stats) stats.innerHTML = '';
  }
  renderCalendar();
  renderItinerary();
  updateManualDefaults();
  // 正在汇率页时切换月份，立即重新拉取当月汇率
  if ($('#tab-rates').classList.contains('active') && !state.ratesData) {
    loadRates();
  }
  if ($('#tab-analysis') && $('#tab-analysis').classList.contains('active')) {
    renderAnnualBudget();
    renderAnalysis();
  }
}

/** 切换月份时同步切换当月全部页面数据：预算标准、行程、汇率、计算结果，
 *  以及该月保存的居住区域 / 是否包含旅居 / 旅居地点勾选。 */
function switchMonthData() {
  applyMonthOptions(monthKey());
  syncOptionsUI();

  // 注意：默认标准编辑区是独立区域，换月时保持展开状态与草稿，且不会碰当月覆盖
  resetStandardsToDefault();
  state.customLocations = [];
  state.customCurrencies = {};
  loadOverrides();                                  // 该月保存的标准修改（含自定义地点/币种）
  state.calcResult = loadResultForMonth(monthKey()); // 该月保存的计算结果
  renderStandards();
  renderLocChips();
  renderTravelPicker();
  if (state.calcResult) renderResult();
  else clearResult();
  invalidateConfirmation(); // 该月标准可能不同，需重新确认
  renderAll();
}

function changeMonth(delta) {
  let m = state.month + delta;
  let y = state.year;
  if (m < 1) { m = 12; y -= 1; }
  if (m > 12) { m = 1; y += 1; }
  if (y < 2000 || y > 2100) { toast('超出支持年份范围（2000-2100）', 'warn'); return; }
  saveMonthOptions();
  snapshotOverridesIntoState();
  persist('debounce');
  state.year = y;
  state.month = m;
  state.calSel = { start: null, end: null };
  switchMonthData();
}

function goThisMonth() {
  const now = new Date();
  saveMonthOptions();
  snapshotOverridesIntoState();
  persist('debounce');
  state.year = now.getFullYear();
  state.month = now.getMonth() + 1;
  state.calSel = { start: null, end: null };
  switchMonthData();
}

/* --------------------------------------------------------------------------
 * 数据管理（批量查看/删除已保存的行程、标准修改、计算结果与汇率缓存）
 * ------------------------------------------------------------------------ */
function hasItineraryMonth(m) {
  const itin = state.itineraryByMonth[m];
  return !!itin && Object.values(itin).some((ranges) => ranges.length > 0);
}

async function openDataManager() {
  setElVisible($('#data-modal'), true);
  const listBox = $('#data-modal-list');
  if (listBox) listBox.innerHTML = '<p class="empty">正在读取已保存数据…</p>';

  const months = new Set();
  Object.keys(state.itineraryByMonth).forEach((m) => months.add(m));
  Object.keys(state.optionsByMonth || {}).forEach((m) => months.add(m));
  Object.keys(loadOverridesMap()).forEach((m) => months.add(m));
  Object.keys(loadResultsMap()).forEach((m) => months.add(m));
  let rateMonths = [];
  try {
    const d = await api('/api/data/rates', { timeout: 10000 });
    rateMonths = (d && d.months) || [];
    rateMonths.forEach((m) => months.add(m));
  } catch (_) { /* 后端不可达时仅展示本地数据 */ }

  const list = Array.from(months).sort();
  const annualYears = Array.from(new Set([
    ...Object.keys(state.annualBudgetsByYear || {}),
    ...Object.keys(state.annualResultsByYear || {}),
  ])).sort();
  if (!listBox) return;
  if (!list.length && !annualYears.length) {
    listBox.innerHTML = '<p class="empty">暂无已保存的数据</p>';
  } else {
    const annualHtml = annualYears.map((year) => {
      const tags = [];
      if (state.annualBudgetsByYear && state.annualBudgetsByYear[year]) tags.push('全年金额');
      if (state.annualResultsByYear && state.annualResultsByYear[year]) {
        tags.push(state.annualResultsByYear[year].stale ? '全年结果待重算' : '全年结果');
      }
      return `<div class="data-row" data-year="${esc(year)}">
        <span class="data-month">${esc(year)} 年</span>
        <span class="data-tags">${tags.map((t) => `<i class="tag">${esc(t)}</i>`).join('')}</span>
        <span class="data-mark">全年预算</span>
      </div>`;
    }).join('');
    const monthlyHtml = list.map((m) => {
      const tags = [];
      if (hasItineraryMonth(m)) tags.push('行程');
      if (state.optionsByMonth && state.optionsByMonth[m]) tags.push('计算选项');
      if (loadOverridesMap()[m]) tags.push('标准修改');
      if (loadResultsMap()[m]) tags.push('计算结果');
      if (rateMonths.includes(m)) tags.push('汇率数据');
      const cur = m === monthKey() ? '<span class="data-mark">（当前月）</span>' : '';
      return `<div class="data-row" data-month="${esc(m)}">
        <span class="data-month">${esc(m)}</span>
        <span class="data-tags">${tags.map((t) => `<i class="tag">${esc(t)}</i>`).join('')}</span>
        ${cur}
        <button class="link danger" data-action="del-month" data-month="${esc(m)}">删除该月</button>
      </div>`;
    }).join('');
    listBox.innerHTML = annualHtml + monthlyHtml;
  }
  setElVisible($('#data-modal'), true);
}

function closeDataManager() {
  setElVisible($('#data-modal'), false);
}

/** 完整保存当前状态，再将 data/ 提交并推送到已配置的 Git 远程仓库。 */
async function uploadAllData() {
  if (!window.confirm('确定保存当前全部数据，并提交、上传到远程仓库吗？\n\n上传仅包含项目 data/ 目录。')) return;
  const button = $('#btn-data-upload');
  const status = $('#data-upload-status');
  if (button) button.disabled = true;
  if (status) status.textContent = '正在保存本地数据…';
  setLoading(true, '正在保存并上传全部数据…');
  try {
    saveMonthOptions();
    snapshotOverridesIntoState();
    const saved = await persist('now');
    if (!saved) throw new Error('本地数据保存失败，请确认后端服务正常');

    if (status) status.textContent = '本地数据已保存，正在提交并推送…';
    const result = await api('/api/data/upload', { method: 'POST', timeout: 180000 });
    const target = `${result.remote}/${result.branch}`;
    const message = `${result.message}（${target}，${result.commit}）`;
    if (status) status.textContent = message;
    toast(message, 'success');
  } catch (err) {
    const message = `上传失败：${err.message}`;
    if (status) status.textContent = message;
    toast(message, 'error');
  } finally {
    setLoading(false);
    if (button) button.disabled = false;
  }
}

/** 删除某个月的全部保存数据（行程/标准修改/结果 + 服务端汇率缓存） */
async function deleteMonthData(m) {
  const backup = deepClone(snapshotBundle());
  state.itineraryByMonth[m] = {};
  if (!state.optionsByMonth || typeof state.optionsByMonth !== 'object') state.optionsByMonth = {};
  state.optionsByMonth[m] = {};
  if (m === monthKey()) {
    state.region = 'Mainland';
    state.includeTravel = false;
    state.travelSelected = null;
  }
  const ovMap = loadOverridesMap();
  ovMap[m] = {};
  state.overridesByMonth = ovMap;
  const resMap = loadResultsMap();
  resMap[m] = {};
  state.resultsByMonth = compactResultsMap(resMap);
  const stateDeleted = await persist('now');
  if (!stateDeleted) {
    applyBundle(backup);
    writeLocalCache(backup);
    syncOptionsUI();
    resetStandardsToDefault();
    state.customLocations = [];
    state.customCurrencies = {};
    loadOverrides();
    state.calcResult = loadResultForMonth(monthKey());
    renderStandards();
    renderLocChips();
    renderTravelPicker();
    if (state.calcResult) renderResult(); else clearResult();
    renderCalendar();
    renderItinerary();
    await openDataManager();
    toast(`删除 ${m} 失败，页面数据已恢复；请确认后端服务正常后重试`, 'error');
    return;
  }

  // 空对象只用于向后端表达“删除该月”。写盘成功后移除本机墓碑，
  // 否则数据管理会继续把已删除月份显示成一行空数据。
  delete state.itineraryByMonth[m];
  delete state.optionsByMonth[m];
  delete state.overridesByMonth[m];
  delete state.resultsByMonth[m];
  writeLocalCache(snapshotBundle());

  let ratesDeleted = true;
  try {
    await api('/api/data/rates/delete', { method: 'POST', body: { months: [m] }, timeout: 10000 });
  } catch (_) {
    ratesDeleted = false;
  }

  if (m === monthKey()) {
    // 删除的是当前月：重置界面为默认状态
    applyMonthOptions(monthKey());
    syncOptionsUI();
    resetStandardsToDefault();
    state.customLocations = [];
    state.customCurrencies = {};
    state.calcResult = null;
    renderStandards();
    renderLocChips();
    renderTravelPicker();
    clearResult();
    renderCalendar();
    renderItinerary();
    invalidateConfirmation();
  }
  await openDataManager();
  if (ratesDeleted) toast(`已删除 ${m} 的保存数据`, 'success');
  else toast(`${m} 的行程等数据已删除，但汇率缓存删除失败，请重试`, 'warn');
}

/** 清空全部保存数据（所有月份与全年预算状态 + 服务端全部汇率缓存） */
async function clearAllData() {
  if (!window.confirm('确定清空所有保存的数据吗？包括全年预算、全部月份的行程、预算标准修改、计算结果与汇率缓存，删除后不可恢复。')) return;
  const backup = snapshotBundle();
  state.itineraryByMonth = {};
  state.optionsByMonth = {};
  state.overridesByMonth = {};
  state.resultsByMonth = {};
  state.annualBudgetsByYear = {};
  state.annualResultsByYear = {};
  resetStandardsToDefault();
  state.customLocations = [];
  state.customCurrencies = {};
  state.calcResult = null;
  applyMonthOptions(monthKey());
  syncOptionsUI();
  let stateCleared = false;
  try {
    clearTimeout(persistTimer);
    const bundle = snapshotBundle();
    stateCleared = await flushPersist(Object.assign(bundle, { replace: true }));
    if (!stateCleared) throw new Error('清空服务器状态失败');
    localStorage.removeItem(STORE_KEY);
    localStorage.removeItem(OVERRIDES_KEY);
    localStorage.removeItem(RESULTS_KEY);
    writeLocalCache(bundle);
  } catch (err) {
    applyBundle(backup);
    resetStandardsToDefault();
    loadOverrides();
    state.calcResult = loadResultForMonth(monthKey());
    renderStandards();
    renderLocChips();
    renderTravelPicker();
    if (state.calcResult) renderResult(); else clearResult();
    renderCalendar();
    renderItinerary();
    toast(`清空失败：${err.message}；已恢复页面数据`, 'error');
    return;
  }
  let ratesError = null;
  try {
    const d = await api('/api/data/rates', { timeout: 10000 });
    const months = (d && d.months) || [];
    if (months.length) {
      await api('/api/data/rates/delete', { method: 'POST', body: { months }, timeout: 15000 });
    }
  } catch (err) {
    ratesError = err;
  }
  renderStandards();
  renderLocChips();
  renderTravelPicker();
  clearResult();
  renderCalendar();
  renderItinerary();
  renderAnnualBudget();
  renderAnalysis();
  invalidateConfirmation();
  closeDataManager();
  if (ratesError) {
    toast(`状态已清空，但汇率缓存删除失败：${ratesError.message}`, 'warn');
  } else if (stateCleared) {
    toast('已清空全部保存数据', 'success');
  }
}

/* --------------------------------------------------------------------------
 * 旅居开关与旅居地点选择（本次计算选项）
 * includeTravel=false → 不包含任何旅居；true 时 travelSelected=null 表示全部，
 * 否则为选中的旅居地点 key 集合。
 * ------------------------------------------------------------------------ */
function travelLocations() {
  const defs = state.monthStandardsSnapshot ? state.standards : state.meta.default_standards;
  const keys = new Set([
    ...Object.keys(defs.travel),
    ...activeCustomLocations().filter((c) => c.category === 'travel').map((c) => c.key),
  ]);
  return Array.from(keys);
}

/** 该旅居地点是否在本次计算中被勾选（未勾选「包含旅居」时一律为 false） */
function isTravelLocationSelected(loc) {
  if (!state.includeTravel) return false;
  if (state.travelSelected === null) return true;
  return state.travelSelected.has(loc);
}

/** 本次计算实际包含的旅居地点：null=全部；数组=仅这些 */
function selectedTravelList() {
  if (!state.includeTravel) return [];
  if (state.travelSelected === null) return null;
  return travelLocations().filter((k) => state.travelSelected.has(k));
}

function renderTravelPicker() {
  const wrap = $('#travel-picker-wrap');
  const btn = $('#travel-picker-btn');
  const list = $('#tp-list');
  if (!wrap || !btn || !list) return;
  if (!state.includeTravel) return;

  const locs = travelLocations();
  const sel = state.travelSelected;
  const count = sel === null ? locs.length : locs.filter((k) => sel.has(k)).length;
  if (!locs.length) {
    btn.textContent = '旅居地点：无';
  } else if (sel === null || count === locs.length) {
    btn.textContent = `旅居地点：全部（${locs.length}）▾`;
  } else if (count === 0) {
    btn.textContent = '旅居地点：无 ▾';
  } else {
    btn.textContent = `旅居地点：部分（${count}/${locs.length}）▾`;
  }

  list.innerHTML = locs.map((k) => {
    const sub = state.standards.travel[k];
    const curr = locationCurrency(k);
    const amt = sub && sub[curr]
      ? `每日 ${sub[curr].daily} · 单次 ${sub[curr].once} ${curr}`
      : curr;
    const checked = sel === null || sel.has(k);
    return `<label class="tp-item"><input type="checkbox" data-tp-loc="${esc(k)}" ${checked ? 'checked' : ''}>
      <span>${esc(locName(k))}</span><span class="tp-amt">${esc(amt)}</span></label>`;
  }).join('');
}

function toggleTravelLocation(key, on) {
  if (state.travelSelected === null) {
    state.travelSelected = new Set(travelLocations());
  }
  if (on) state.travelSelected.add(key);
  else state.travelSelected.delete(key);
  saveState(true);
  renderTravelPicker();
  renderStandards();
  renderLocChips();
  invalidateConfirmation();
}

function selectAllTravel(on) {
  state.travelSelected = on ? null : new Set();
  saveState(true);
  renderTravelPicker();
  renderStandards();
  renderLocChips();
  invalidateConfirmation();
}

function toggleTravelPicker(show) {
  const menu = $('#travel-picker-menu');
  if (menu) menu.hidden = !show;
}

/* --------------------------------------------------------------------------
 * 新建预算标准（自定义定居地点 / 旅居地点 / 固定预算币种）
 * ------------------------------------------------------------------------ */
let addStdCategory = 'variable'; // variable | travel | fixed
let addStdToDefaults = false;    // 本次「＋ 新建」是给默认标准还是当月标准（打开弹窗时锁定）
let addStdRegion = 'Mainland';   // 固定预算币种的目标区域（默认标准弹窗里按分组按钮决定）

function openAddStandard(category, region) {
  addStdCategory = category;
  addStdToDefaults = !!state.editingDefaults && !!state.defaultsDraft;
  addStdRegion = (region === 'Overseas' || region === 'Mainland') ? region : state.region;
  const form = $('#add-std-form');
  const title = $('#add-std-title');
  const note = $('#add-std-note');
  const scopeNote = addStdToDefaults
    ? '（将加入服务器默认标准，点「保存默认标准」后生效，不影响当月）'
    : '（仅当月生效）';
  if (category === 'variable') {
    title.textContent = addStdToDefaults ? '新建默认标准 · 定居地点' : '新建定居地点（可变预算）';
    note.textContent = `新增一个定居地点及其每日预算（按日汇率折算人民币）${scopeNote}。`;
    form.innerHTML = `
      <div class="af-row"><label>地点名称</label><input type="text" id="af-name" placeholder="如：东京" maxlength="20"></div>
      <div class="af-row"><label>币种代码</label><input type="text" id="af-currency" placeholder="如：JPY" maxlength="6" style="text-transform:uppercase"></div>
      <div class="af-row"><label>每日预算</label><input type="number" id="af-daily" min="0" step="0.01" placeholder="当地货币金额"></div>
      <p class="af-hint">提示：币种为 2-6 位字母代码（如 JPY、EUR）；汇率将从 Yahoo Finance 按 币种CNY=X 获取。</p>`;
  } else if (category === 'travel') {
    title.textContent = addStdToDefaults ? '新建默认标准 · 旅居地点' : '新建旅居地点（旅游预算）';
    note.textContent = `新增一个旅居地点：每日预算 × 旅游天数 + 单次预算（每月一次）${scopeNote}。`;
    form.innerHTML = `
      <div class="af-row"><label>地点名称</label><input type="text" id="af-name" placeholder="如：巴黎" maxlength="20"></div>
      <div class="af-row"><label>币种代码</label><input type="text" id="af-currency" placeholder="如：EUR" maxlength="6" style="text-transform:uppercase"></div>
      <div class="af-row"><label>每日预算</label><input type="number" id="af-daily" min="0" step="0.01" placeholder="当地货币金额"></div>
      <div class="af-row"><label>单次预算</label><input type="number" id="af-once" min="0" step="0.01" placeholder="每月一次的费用"></div>
      <p class="af-hint">提示：币种为 2-6 位字母代码（如 EUR）；汇率将从 Yahoo Finance 按 币种CNY=X 获取。</p>`;
  } else {
    title.textContent = addStdToDefaults ? '新建默认标准 · 固定预算币种' : '新建固定预算币种';
    note.textContent = `为居住区域（${regionName(addStdRegion)}）新增一个固定预算币种：月额 × 当月平均汇率，每月只计算一次${scopeNote}。`;
    form.innerHTML = `
      <div class="af-row"><label>币种代码</label><input type="text" id="af-currency" placeholder="如：EUR" maxlength="6" style="text-transform:uppercase"></div>
      <div class="af-row"><label>币种名称</label><input type="text" id="af-name" placeholder="如：欧元（可留空）" maxlength="20"></div>
      <div class="af-row"><label>每月金额</label><input type="number" id="af-daily" min="0" step="0.01" placeholder="当地货币金额"></div>
      <p class="af-hint">提示：该币种仅添加到 ${regionName(addStdRegion)}；汇率将从 Yahoo Finance 按 币种CNY=X 获取。</p>`;
  }
  setElVisible($('#add-std-modal'), true);
  const first = form.querySelector('input');
  if (first) first.focus();
}

function closeAddStandard() {
  setElVisible($('#add-std-modal'), false);
}

function confirmAddStandard() {
  const val = (id) => ($(id) ? String($(id).value).trim() : '');
  const name = val('#af-name');
  const currency = val('#af-currency').toUpperCase();
  const daily = Number(val('#af-daily'));
  const once = Number(val('#af-once') || 0);
  const currs = state.meta.currencies.concat(Object.keys(state.customCurrencies || {}));
  const currTaken = (c) => currs.some((x) => x === c);

  if (addStdCategory !== 'fixed' && !name) { toast('请填写地点名称', 'warn'); return; }
  if (!/^[A-Z]{2,6}$/.test(currency)) { toast('币种代码应为 2-6 位字母（如 EUR）', 'warn'); return; }
  if (!Number.isFinite(daily) || daily < 0) { toast('请填写有效的非负金额', 'warn'); return; }

  if (addStdToDefaults && state.defaultsDraft) {
    // 目标在打开弹窗时已锁定，避免期间收起编辑区导致写错区域
    confirmAddDefaultStandard({ name, currency, daily, once });
    return;
  }

  if (addStdCategory === 'variable') {
    const key = uniqueLocationKey('var');
    state.customLocations.push({ key, name, category: 'variable', currency });
    if (!state.standards.variable[key]) state.standards.variable[key] = {};
    state.standards.variable[key][currency] = daily;
  } else if (addStdCategory === 'travel') {
    if (!Number.isFinite(once) || once < 0) { toast('请填写有效的单次预算', 'warn'); return; }
    const key = uniqueLocationKey('trv');
    state.customLocations.push({ key, name, category: 'travel', currency });
    if (!state.standards.travel[key]) state.standards.travel[key] = {};
    state.standards.travel[key][currency] = { daily, once };
    // 已部分勾选时，新建地点默认纳入本次计算，以便立刻出现在旅居预算表中
    if (state.travelSelected instanceof Set) state.travelSelected.add(key);
  } else {
    if (!currTaken(currency) && !(state.standards.fixed[state.region] && currency in state.standards.fixed[state.region])) {
      if (!state.customCurrencies[currency]) state.customCurrencies[currency] = name || currency;
      if (!state.standards.fixed[state.region]) state.standards.fixed[state.region] = {};
      state.standards.fixed[state.region][currency] = daily;
    } else {
      toast(`币种 ${currency} 已存在`, 'warn');
      return;
    }
  }

  saveOverrides();
  saveState();
  renderStandards();
  renderLocChips();
  renderTravelPicker();
  invalidateConfirmation();
  closeAddStandard();
  toast('已新建预算标准（仅当月生效）', 'success');
}

/** 生成不与现有地点冲突的 key */
function uniqueLocationKey(prefix) {
  const taken = new Set(allLocations().map((l) => l.key));
  let key = `${prefix}_${Date.now().toString(36)}`;
  let i = 1;
  while (taken.has(key)) key = `${prefix}_${Date.now().toString(36)}_${i++}`;
  return key;
}

/* ---------- 默认标准编辑模式下的新建 / 删除（改草稿，不落盘） ---------- */

/** 在默认标准草稿中新建定居/旅居地点或固定预算币种 */
function confirmAddDefaultStandard({ name, currency, daily, once }) {
  const draft = state.defaultsDraft;
  const ds = draft.standards;

  if (addStdCategory === 'variable') {
    const key = uniqueLocationKey('var');
    draft.locations.push({ key, name, category: 'variable', currency });
    ds.variable[key] = { [currency]: daily };
    draft.locationNames[key] = name;
  } else if (addStdCategory === 'travel') {
    if (!Number.isFinite(once) || once < 0) { toast('请填写有效的单次预算', 'warn'); return; }
    const key = uniqueLocationKey('trv');
    draft.locations.push({ key, name, category: 'travel', currency });
    ds.travel[key] = { [currency]: { daily, once } };
    draft.locationNames[key] = name;
  } else {
    // 目标区域在打开新建弹窗时按分组按钮锁定；重复判断只看该区域，便于同一币种加到境内与境外
    const region = addStdRegion === 'Overseas' ? 'Overseas' : 'Mainland';
    if (!ds.fixed[region]) ds.fixed[region] = {};
    if (ds.fixed[region][currency] === undefined) {
      draft.currencyNames[currency] = name || currency;
      ds.fixed[region][currency] = daily;
    } else {
      toast(`币种 ${currency} 已在${regionName(region)}固定预算中`, 'warn');
      return;
    }
  }
  renderStandards();
  renderLocChips();
  renderTravelPicker();
  closeAddStandard();
  toast('已加入默认标准（尚未保存，点「保存默认标准」生效）', 'success');
}

/** 从默认标准草稿中删除新建的地点/币种 */
function deleteCustomDefaultStandard(locOrCurr) {
  const draft = state.defaultsDraft;
  if (!draft) return;
  const idx = draft.locations.findIndex((c) => c.key === locOrCurr);
  if (idx >= 0) {
    const c = draft.locations[idx];
    if (c.category === 'variable') delete draft.standards.variable[c.key];
    else {
      delete draft.standards.travel[c.key];
    }
    draft.locations.splice(idx, 1);
    delete draft.locationNames[c.key];
  } else {
    const region = state.region === 'Overseas' ? 'Overseas' : 'Mainland';
    if (draft.standards.fixed[region]) delete draft.standards.fixed[region][locOrCurr];
    delete draft.currencyNames[locOrCurr];
  }
  renderStandards();
  renderLocChips();
  renderTravelPicker();
  toast('已从默认标准草稿中删除（尚未保存）', 'info');
}

/** 删除当月新建的标准（自定义定居/旅居地点、自定义固定币种） */
function deleteCustomStandard(locOrCurr) {
  if (state.editingDefaults && state.defaultsDraft) {
    deleteCustomDefaultStandard(locOrCurr);
    return;
  }
  const customs = state.customLocations;
  const idx = customs.findIndex((c) => c.key === locOrCurr);
  if (idx >= 0) {
    const c = customs[idx];
    if (c.category === 'variable') delete state.standards.variable[c.key];
    else {
      delete state.standards.travel[c.key];
      if (state.travelSelected instanceof Set) state.travelSelected.delete(c.key);
    }
    customs.splice(idx, 1);
  } else {
    // 固定预算自定义币种
    delete state.standards.fixed[state.region][locOrCurr];
    delete state.customCurrencies[locOrCurr];
  }
  saveOverrides();
  saveState();
  renderStandards();
  renderLocChips();
  renderTravelPicker();
  invalidateConfirmation();
  toast('已删除该新建标准（仅当月）', 'info');
}

function snapshotLocationNames() {
  const names = { Extra: '额外预算', ...((state.meta && state.meta.location_names) || {}) };
  for (const loc of Object.keys(state.standards.variable || {})) names[loc] = locName(loc);
  for (const loc of Object.keys(state.standards.travel || {})) names[loc] = locName(loc);
  for (const c of state.customLocations || []) names[c.key] = c.name;
  return names;
}

function snapshotCurrencyNames() {
  const names = { ...((state.meta && state.meta.currency_names) || {}) };
  Object.assign(names, state.customCurrencies || {});
  return names;
}

/** 应用服务器返回的新默认标准：只刷新默认标准基准与草稿，绝不改动当月数值 */
function refreshDefaultsAfterServerChange(meta) {
  state.meta = meta;
  const wasOpen = !!state.editingDefaults;
  state.defaultsDraft = null;
  state.editingDefaults = false;
  beginDefaultsDraft();
  state.editingDefaults = wasOpen;
  renderStandards();
  renderLocChips();
  renderTravelPicker();
  renderStandardsHint();
}

/** 把草稿里的默认标准提交到服务器（data/defaults.json），不影响当月与已保存月份 */
async function saveDefaultStandardsToServer() {
  if (defaultsSaveInFlight) return;
  if (!state.editingDefaults || !state.defaultsDraft) {
    toast('请先用顶栏「⚙ 默认预算标准」按钮打开默认标准弹窗', 'warn');
    return;
  }
  const draft = state.defaultsDraft.standards;
  if (!Object.keys(draft.variable || {}).length) {
    toast('默认标准至少需要一个定居地点', 'warn');
    return;
  }
  const diffs = countStandardsDiffs(draft, state.meta.default_standards);
  if (!diffs) { toast('默认标准没有改动', 'info'); return; }
  if (!confirm(`将把默认预算标准写入服务器 data/defaults.json（共 ${diffs} 处改动）。`
    + '之后的新月份会使用这套标准；已保存的其它月份会固化为完整快照，'
    + '当前月份的预算不会被改动。是否继续？')) return;
  const defaultsPayload = deepClone({
    base_revision: state.meta.defaults_revision,
    variable: draft.variable,
    fixed: draft.fixed,
    travel: draft.travel,
    extra: draft.extra,
    location_names: snapshotDraftLocationNames(),
    currency_names: snapshotDraftCurrencyNames(),
  });
  defaultsSaveInFlight = true;
  syncStandardsModeUI();
  setLoading(true, '正在保存默认标准…');
  try {
    preserveExistingMonthsBeforeDefaultChange();
    const snapshotsSaved = await persist('now');
    if (!snapshotsSaved) {
      toast('当前及历史月份快照保存失败，已取消修改服务器默认标准', 'error');
      return;
    }
    const meta = await api('/api/defaults', {
      method: 'POST',
      body: defaultsPayload,
    });
    refreshDefaultsAfterServerChange(meta);
    toast('已保存默认预算标准（当月预算保持不变）', 'success');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    defaultsSaveInFlight = false;
    setLoading(false);
    syncStandardsModeUI();
  }
}

function snapshotDraftLocationNames() {
  const names = { Extra: '额外预算', ...((state.meta && state.meta.location_names) || {}) };
  for (const loc of Object.keys((state.defaultsDraft && state.defaultsDraft.standards.variable) || {})) {
    names[loc] = locName(loc);
  }
  for (const loc of Object.keys((state.defaultsDraft && state.defaultsDraft.standards.travel) || {})) {
    names[loc] = locName(loc);
  }
  for (const c of (state.defaultsDraft && state.defaultsDraft.locations) || []) names[c.key] = c.name;
  return names;
}

function snapshotDraftCurrencyNames() {
  const names = { ...((state.meta && state.meta.currency_names) || {}) };
  Object.assign(names, (state.defaultsDraft && state.defaultsDraft.currencyNames) || {});
  return names;
}

async function restoreFactoryDefaults() {
  if (!confirm('将删除 data/defaults.json，把服务器默认标准恢复为 functions.py 出厂值。'
    + '当前月份的预算数值不会被改动（如需按出厂值重算，请点「恢复默认」）。是否继续？')) return;
  setLoading(true, '正在恢复出厂默认…');
  try {
    preserveExistingMonthsBeforeDefaultChange();
    const snapshotsSaved = await persist('now');
    if (!snapshotsSaved) {
      throw new Error('当前及历史月份快照保存失败，已取消恢复出厂默认');
    }
    const meta = await api('/api/defaults/reset', {
      method: 'POST',
      body: { base_revision: state.meta.defaults_revision },
    });
    refreshDefaultsAfterServerChange(meta);
    toast('已恢复出厂默认预算标准（当月预算保持不变）', 'info');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    setLoading(false);
  }
}

/** 当月数值改回当前生效的默认标准（显式操作，只影响本月） */
function resetMonthToDefaults() {
  resetStandardsToDefault();
  state.customLocations = [];
  state.customCurrencies = {};
  saveOverrides();        // 无修改项时先移除统一状态里的覆盖 key
  saveState();
  renderStandards();
  renderLocChips();
  renderTravelPicker();
  invalidateConfirmation(); // 标准被重置，需重新确认
  toast('本月预算已改回当前默认标准（含清除本月新建项），请重新确认', 'info');
}

/* --------------------------------------------------------------------------
 * 事件绑定
 * ------------------------------------------------------------------------ */
function bindEvents() {
  $$('.side-nav-item').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  // 月份导航
  $('#btn-prev-month').addEventListener('click', () => changeMonth(-1));
  $('#btn-next-month').addEventListener('click', () => changeMonth(1));
  $('#btn-this-month').addEventListener('click', goThisMonth);

  // 区域选择（选项面板分段按钮；固定预算表按区域过滤显示）
  $('#region-seg').addEventListener('click', (ev) => {
    const btn = ev.target.closest('.seg-btn[data-region]');
    if (!btn || btn.dataset.region === state.region) return;
    state.region = btn.dataset.region;
    saveState(true);
    // 分段高亮即时更新
    $$('#region-seg .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.region === state.region));
    renderStandards();          // 刷新固定预算表（仅显示新区域）
    invalidateConfirmation();   // 应用的标准集发生变化，需重新确认
  });

  // 计算
  $('#btn-calculate').addEventListener('click', calculate);
  $('#btn-recalc').addEventListener('click', calculate);

  // 预算标准输入（事件委托）
  // 关键：按输入框所在的区域决定改哪一份数据——默认标准区改草稿，其余改当月标准。
  // 两个区域同时可见，不能用全局展开状态判断。
  $('#tab-standards').addEventListener('input', (ev) => {
    const el = ev.target;
    if (!el.matches('input[data-cat]')) return;
    const { cat, loc, curr, field } = el.dataset;
    const v = Number(el.value);
    if (!Number.isFinite(v) || v < 0) {
      el.classList.add('invalid');
      return;
    }
    el.classList.remove('invalid');
    const inDefaultsEditor = !!el.closest('.defaults-editor');
    if (inDefaultsEditor && state.defaultsDraft) {
      applyDefaultsInput(cat, loc, curr, field, v);
      refreshRowChip(cat, loc, curr, field, el);
      return;
    }
    applyMonthInput(cat, loc, curr, field, v);
    refreshRowChip(cat, loc, curr, field, el); // 「与默认值不同」标记即时出现/消失
  });

  // 新建 / 删除自定义标准；差异标记上的「存入默认 / 还原」；默认标准区的「＋ 新建」
  $('#tab-standards').addEventListener('click', (ev) => {
    const addBtn = ev.target.closest('[data-action="add-std"]');
    if (addBtn) { openAddStandard(addBtn.dataset.cat, addBtn.dataset.region); return; }
    if (ev.target.closest('#btn-add-variable')) { openAddStandard('variable'); return; }
    if (ev.target.closest('#btn-add-fixed')) { openAddStandard('fixed', state.region); return; }
    if (ev.target.closest('#btn-add-travel')) { openAddStandard('travel'); return; }
    const rowBtn = ev.target.closest('button[data-action="revert-row"]');
    if (rowBtn) {
      const holder = rowBtn.closest('.chip-diff');
      const ds = (holder && holder.dataset) || rowBtn.dataset;
      restoreDefaultEntry(ds.cat, ds.loc, ds.curr, ds.field || null);
      return;
    }
    const btn = ev.target.closest('button[data-action="del-custom"]');
    if (btn && btn.dataset.loc) deleteCustomStandard(btn.dataset.loc);
  });

  // 默认预算标准弹窗：顶栏按钮打开，✕ / 点击遮罩关闭，弹窗内保存或放弃
  $('#btn-defaults-modal').addEventListener('click', openDefaultsModal);
  $('#btn-defaults-close').addEventListener('click', requestCloseDefaultsModal);
  $('#defaults-modal').addEventListener('click', (ev) => {
    if (ev.target === ev.currentTarget) requestCloseDefaultsModal(); // 点击遮罩关闭
  });
  $('#btn-save-defaults').addEventListener('click', saveDefaultStandardsToServer);
  // 默认标准弹窗的显示范围开关：纯界面过滤，只重绘弹窗，绝不触发持久化
  $('#chk-defaults-show-all').addEventListener('change', (ev) => {
    state.defaultsShowAll = !!ev.target.checked;
    renderDefaultsPanel();
    updateDefaultsScopeHint();
  });
  $('#btn-discard-defaults').addEventListener('click', () => {
    if (!defaultsDraftDirty()) { toast('默认标准没有未保存的改动', 'info'); return; }
    if (!confirm('放弃对默认标准的未保存修改，恢复为服务器上已保存的默认值？')) return;
    reconstructDefaultsDraft();
    renderStandards();
    renderLocChips();
    renderTravelPicker();
    toast('已放弃未保存的默认标准修改', 'info');
  });
  $('#btn-add-ok').addEventListener('click', confirmAddStandard);
  $('#btn-add-cancel').addEventListener('click', closeAddStandard);
  $('#btn-add-close').addEventListener('click', closeAddStandard);
  $('#add-std-modal').addEventListener('click', (ev) => {
    if (ev.target === ev.currentTarget) closeAddStandard();
  });
  $('#add-std-form').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') confirmAddStandard();
  });

  // 「恢复默认」只作用于本月；「恢复出厂默认」只改服务器默认标准
  $('#btn-reset-standards').addEventListener('click', resetMonthToDefaults);
  $('#btn-reset-factory').addEventListener('click', restoreFactoryDefaults);

  // 确认预算标准（选项面板）
  $('#chk-standards-confirmed').addEventListener('change', (ev) => {
    state.standardsConfirmed = ev.target.checked;
    const panel = $('#options-panel');
    if (panel) {
      panel.classList.toggle('confirmed', ev.target.checked);
      panel.classList.remove('attention');
    }
    if (ev.target.checked) toast('已确认预算标准，可以添加行程并计算', 'success');
  });

  // 旅居开关与选择
  $('#chk-include-travel').addEventListener('change', (ev) => {
    state.includeTravel = !!ev.target.checked;
    saveState(true);
    updateTravelUiVisibility();
    renderTravelPicker();
    renderLocChips();
    invalidateConfirmation();
  });
  $('#travel-picker-btn').addEventListener('click', (ev) => {
    ev.stopPropagation();
    const menu = $('#travel-picker-menu');
    toggleTravelPicker(!!(menu && menu.hidden));
  });
  $('#tp-all').addEventListener('click', () => selectAllTravel(true));
  $('#tp-none').addEventListener('click', () => selectAllTravel(false));
  $('#tp-list').addEventListener('change', (ev) => {
    const chk = ev.target.closest('input[data-tp-loc]');
    if (chk) toggleTravelLocation(chk.dataset.tpLoc, chk.checked);
  });
  document.addEventListener('click', (ev) => {
    const picker = $('#travel-picker-wrap');
    if (picker && !picker.contains(ev.target)) toggleTravelPicker(false);
  });

  // 地点 chips（事件委托）
  $('#tab-itinerary').addEventListener('click', (ev) => {
    const chip = ev.target.closest('.chip');
    if (chip) selectLocation(chip.dataset.location);
  });

  // 日历选段
  $('#cal-grid').addEventListener('click', (ev) => {
    const cell = ev.target.closest('.cal-cell:not(.empty)');
    if (!cell) return;
    if (!state.activeLocation) { toast('请先选择地点', 'warn'); return; }
    const ds = cell.dataset.date;
    if (!state.calSel.start) {
      state.calSel = { start: ds, end: null };
    } else if (!state.calSel.end) {
      const [a, b] = state.calSel.start <= ds ? [state.calSel.start, ds] : [ds, state.calSel.start];
      addRange(state.activeLocation, a, b);
      state.calSel = { start: null, end: null };
    } else {
      state.calSel = { start: ds, end: null };
    }
    renderCalendar();
  });

  // 日历悬停预览（选中开始日期后预览区间）
  $('#cal-grid').addEventListener('mouseover', (ev) => {
    const cell = ev.target.closest('.cal-cell:not(.empty)');
    if (!cell || !state.calSel.start || state.calSel.end) return;
    $$('#cal-grid .cal-cell.preview').forEach((c) => c.classList.remove('preview'));
    const s = state.calSel.start;
    const e = cell.dataset.date;
    const [a, b] = s <= e ? [s, e] : [e, s];
    $$('#cal-grid .cal-cell').forEach((c) => {
      const ds = c.dataset.date;
      if (ds && ds >= a && ds <= b) c.classList.add('preview');
    });
  });
  $('#cal-grid').addEventListener('mouseleave', () => {
    $$('#cal-grid .cal-cell.preview').forEach((c) => c.classList.remove('preview'));
  });

  // 手动输入时间段
  $('#btn-add-range').addEventListener('click', () => {
    if (!state.activeLocation) { toast('请先选择地点', 'warn'); return; }
    const s = $('#cal-manual-start').value;
    const e = $('#cal-manual-end').value;
    if (!s || !e) { toast('请填写开始与结束日期', 'warn'); return; }
    if (s > e) { toast('开始日期不能晚于结束日期', 'warn'); return; }
    if (!s.startsWith(monthKey()) || !e.startsWith(monthKey())) {
      toast(`日期必须属于当前计算月份（${state.year}年${state.month}月）`, 'warn');
      return;
    }
    addRange(state.activeLocation, s, e);
  });

  // 行程清单操作（删除区间 / 清空地点）
  $('#itinerary-list').addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-action]');
    if (!btn) return;
    const { action, loc, idx } = btn.dataset;
    const itin = currentItinerary();
    if (action === 'del-range') {
      itin[loc].splice(Number(idx), 1);
      if (!itin[loc].length) delete itin[loc];
      toast('已删除时间段', 'info');
    } else if (action === 'clear-loc') {
      delete itin[loc];
      toast(`已清空 ${locName(loc)} 的行程`, 'info');
    }
    saveState();
    renderCalendar();
    renderItinerary();
  });

  // 清空本月全部行程
  $('#btn-clear-all').addEventListener('click', () => {
    const itin = currentItinerary();
    const count = Object.values(itin).reduce((a, r) => a + r.length, 0);
    if (!count) { toast('本月暂无行程', 'warn'); return; }
    if (!window.confirm(`确定清空 ${state.year}年${state.month}月 的全部 ${count} 条时间段吗？`)) return;
    state.itineraryByMonth[monthKey()] = {};
    saveState();
    renderCalendar();
    renderItinerary();
    toast('已清空本月行程', 'success');
  });

  // 汇率重新拉取 / CNY 显隐 / 窗口尺寸自适应 / 网络重检
  $('#btn-refresh-rates').addEventListener('click', () => loadRates(true));
  $('#chk-show-cny').addEventListener('change', () => { if (state.ratesData) renderRateCharts(); });
  window.addEventListener('resize', () => {
    resizeRateCharts();
    resizeAnalysisChart();
  });
  $('#btn-network-retry').addEventListener('click', () => runNetworkCheck(true));

  // 全年预算：年份/行情与月度页独立，金额仍走唯一状态持久化管线。
  $('#annual-year').addEventListener('change', (ev) => {
    state.annualYear = Number(ev.target.value);
    state.annualRatesData = null;
    state.annualRatesYear = null;
    renderAnnualBudget();
    loadAnnualRates();
  });
  $('#btn-refresh-annual-rates').addEventListener('click', () => loadAnnualRates(true));
  $('#btn-calculate-annual').addEventListener('click', calculateAnnualBudget);
  $('#annual-budget-rows').addEventListener('input', (ev) => {
    const input = ev.target.closest('input[data-annual-currency]');
    if (!input) return;
    const amount = Number(input.value);
    if (!Number.isFinite(amount) || amount < 0) {
      input.classList.add('invalid');
      return;
    }
    input.classList.remove('invalid');
    annualBudgetAmounts()[input.dataset.annualCurrency] = amount;
    invalidateAnnualResult();
    persist('debounce', 'annual');
  });

  const analysisToolbar = $('.analysis-toolbar');
  if (analysisToolbar) {
    analysisToolbar.addEventListener('change', (ev) => {
      if (ev.target.closest('.tag-check, select')) renderAnalysis();
    });
  }

  // 数据管理弹窗
  $('#btn-data-manager').addEventListener('click', openDataManager);
  const dataTop = $('#btn-data-manager-top');
  if (dataTop) dataTop.addEventListener('click', openDataManager);
  $('#btn-data-close').addEventListener('click', closeDataManager);
  $('#btn-data-close2').addEventListener('click', closeDataManager);
  $('#data-modal').addEventListener('click', (ev) => {
    if (ev.target === ev.currentTarget) closeDataManager(); // 点击遮罩关闭
  });
  $('#data-modal-list').addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-action="del-month"]');
    if (btn && btn.dataset.month) deleteMonthData(btn.dataset.month);
  });
  $('#btn-data-clear-all').addEventListener('click', clearAllData);
  $('#btn-data-upload').addEventListener('click', uploadAllData);
}

/* --------------------------------------------------------------------------
 * 初始化
 * ------------------------------------------------------------------------ */
async function init() {
  setLoading(false);
  setElVisible($('#data-modal'), false);
  setElVisible($('#add-std-modal'), false);
  setElVisible($('#defaults-modal'), false);
  bindEvents();
  // 打开网页时自动检测 Yahoo Finance 连通性（不阻塞页面初始化，并行执行）
  runNetworkCheck();
  try {
    state.meta = await api('/api/meta', { timeout: 30000 });
  } catch (err) {
    toast(`无法连接后端服务：${err.message}`, 'error');
    $('#month-label').textContent = '连接失败';
    return;
  }

  resetStandardsToDefault();
  state.customLocations = [];
  state.customCurrencies = {};
  state.editingDefaults = false;
  state.defaultsDraft = null;
  syncStandardsModeUI();
  const now = new Date();
  state.year = now.getFullYear();
  state.month = now.getMonth() + 1;

  let serverBundle = null;
  try {
    serverBundle = await api('/api/state', { timeout: 15000 });
  } catch (err) {
    serverStateReady = false;
    console.warn('读取服务器行程数据失败，回退到本机缓存', err);
    toast(`读取项目状态失败：${err.message}。已回退到浏览器缓存；服务器恢复前无法安全保存。`, 'error');
  }
  if (serverBundle && typeof serverBundle === 'object' && !Array.isArray(serverBundle)) {
    serverStateReady = true;
    applyBundle(serverBundle);
    serverBaseline = deepClone(serverBundle);
    writeLocalCache(snapshotBundle());
  } else {
    serverStateReady = false;
    serverBaseline = null;
    applyBundle(readLocalBundle());
  }
  state.annualYear = new Date().getFullYear();

  syncOptionsUI();
  const restoredOverrides = loadOverrides();
  state.calcResult = loadResultForMonth(monthKey());

  renderStandards();
  renderLocChips();
  renderTravelPicker();
  renderAll();
  if (state.calcResult) renderResult();
  else clearResult();
  // 默认选中第一个地点，方便直接开始添加行程
  if (state.meta.locations.length) selectLocation(state.meta.locations[0].key);

  // 提示：恢复本地保存的行程 / 标准修改 / 结果，方便快速回到这个月的数据
  const itin = currentItinerary();
  const hasItinerary = Object.values(itin).some((ranges) => ranges.length > 0);
  if (restoredOverrides || hasItinerary || state.calcResult) {
    toast(
      `已恢复${state.year}年${state.month}月数据（行程/标准修改/计算选项/结果）`,
      'info'
    );
  }
  if (Array.isArray(state.meta.warnings) && state.meta.warnings.length) {
    toast(state.meta.warnings[0], 'error');
  }
}

document.addEventListener('DOMContentLoaded', init);
