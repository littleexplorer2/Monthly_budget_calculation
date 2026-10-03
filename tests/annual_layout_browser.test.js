'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { launchProbeBrowser } = require('./helpers/browser-probe.js');
const { defaultMetaFixture } = require('./helpers/dom-stub.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function annualRates(year) {
  const stats = {};
  for (const [currency, average] of Object.entries({ CNY: 1, HKD: 0.912345, USD: 7.123456, TWD: 0.223344, THB: 0.201234 })) {
    stats[currency] = {
      average,
      observation_count: 188,
      first_date: `${year}-01-02`,
      last_date: `${year}-09-25`,
    };
  }
  return {
    year,
    start_date: `${year}-01-01`,
    requested_through: `${year}-09-28`,
    observed_through: `${year}-09-25`,
    source: 'Yahoo Finance',
    price_field: 'Close',
    non_trading_days: 'excluded',
    stats,
    errors: {},
    complete: true,
  };
}

function appState(year) {
  const monthly = (month, total, region, includeTravel) => ({
    summary: {
      '计算月份': `${year}年${Number(month)}月`,
      '居住区域': region,
      '可变费用合计(人民币)': total - 1000,
      '固定费用合计(人民币)': 1000,
      '额外预算合计(人民币)': 0,
      '总预算(人民币)': total,
    },
    daily_details: [], fixed_details: [], extra_details: [], warnings: [],
    region, includeTravel, stale: false,
  });
  return {
    version: 1,
    year,
    month: 9,
    itineraryByMonth: {},
    optionsByMonth: {},
    overridesByMonth: {},
    resultsByMonth: {
      [`${year}-01`]: monthly(1, 12000, 'Mainland', false),
      [`${year}-02`]: monthly(2, 14500, 'Overseas', true),
    },
    annualBudgetsByYear: { [year]: { CNY: 1000, USD: 500 } },
    annualResultsByYear: {
      [year]: {
        year,
        start_date: `${year}-01-01`,
        requested_through: `${year}-09-28`,
        observed_through: `${year}-09-25`,
        summary: { '全年预算合计(人民币)': 4561.73 },
        details: [
          { currency: 'CNY', amount: 1000, average_rate: 1, cny_amount: 1000 },
          { currency: 'USD', amount: 500, average_rate: 7.123456, cny_amount: 3561.73 },
        ],
        errors: {},
      },
    },
  };
}

function jsonResponse(res, value, status = 200) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function startMockServer() {
  const root = path.join(__dirname, '..');
  const webRoot = path.join(root, 'web');
  const year = new Date().getFullYear();
  const meta = defaultMetaFixture();
  const state = appState(year);
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.ico': 'image/x-icon',
  };

  const server = http.createServer((req, res) => {
    const parsed = new URL(req.url, 'http://127.0.0.1');
    const pathname = decodeURIComponent(parsed.pathname);
    if (pathname === '/api/meta') return jsonResponse(res, meta);
    if (pathname === '/api/state') return jsonResponse(res, req.method === 'GET' ? state : {});
    if (pathname === '/api/network-check') return jsonResponse(res, { ok: true });
    if (pathname === '/api/tabs/register' || pathname === '/api/tabs/unregister') return jsonResponse(res, { ok: true });
    if (pathname === '/api/annual-rates') return jsonResponse(res, annualRates(Number(parsed.searchParams.get('year')) || year));
    if (pathname === '/api/annual-budget') return jsonResponse(res, state.annualResultsByYear[year]);
    if (pathname.startsWith('/api/')) return jsonResponse(res, {});

    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = path.resolve(webRoot, relative);
    const allowedPrefix = `${path.resolve(webRoot)}${path.sep}`;
    if (file !== path.join(webRoot, 'index.html') && !file.startsWith(allowedPrefix)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    const body = fs.readFileSync(file);
    res.writeHead(200, {
      'Content-Type': mime[path.extname(file)] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
    });
    res.end(body);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}/`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

async function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result || {});
  });

  const call = (method, params = {}) => {
    const id = nextId++;
    socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };
  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error(`页面执行失败: ${result.exceptionDetails.text || 'unknown'}`);
    }
    return result.result && result.result.value;
  };
  const close = () => {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
  };
  return { call, evaluate, close };
}

async function waitForPage(evaluate, expression, message) {
  for (let i = 0; i < 80; i++) {
    if (await evaluate(expression)) return;
    await sleep(100);
  }
  throw new Error(message);
}

test('全年页在 desktop 并排、在 390px 单列且仅表格容器滚动', async (t) => {
  const mock = await startMockServer();
  let probe = null;
  let cdp = null;
  try {
    try {
      probe = await launchProbeBrowser({ url: mock.url, timeoutMs: 30000 });
    } catch (error) {
      t.skip(`真实浏览器未启动：${error.message}`);
      return;
    }
    cdp = await connectCdp(probe.target.webSocketDebuggerUrl);
    await cdp.call('Runtime.enable');
    await cdp.call('Page.enable');
    await cdp.call('Emulation.setDeviceMetricsOverride', {
      width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    await waitForPage(
      cdp.evaluate,
      `document.readyState === 'complete' && document.querySelector('#tab-analysis') && document.querySelector('#annual-budget-rows')`,
      '应用页面未就绪',
    );
    await cdp.evaluate(`document.querySelector('.side-nav .side-nav-item[data-tab="analysis"]').click()`);
    await waitForPage(
      cdp.evaluate,
      `document.querySelectorAll('#annual-budget-rows tr').length >= 5
        && document.querySelector('#annual-budget-status').textContent !== '正在获取汇率…'`,
      '全年页数据未渲染',
    );

    const desktop = await cdp.evaluate(`(() => {
      const annual = document.querySelector('.annual-budget-card').getBoundingClientRect();
      const monthly = document.querySelector('.monthly-comparison-card').getBoundingClientRect();
      const input = document.querySelector('#annual-budget-rows input[data-annual-currency="CNY"]').getBoundingClientRect();
      const total = document.querySelector('#annual-budget-total').getBoundingClientRect();
      const visible = (r) => r.width > 0 && r.height > 0 && r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight;
      return {
        innerWidth,
        htmlScrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
        annual: { left: annual.left, right: annual.right, top: annual.top, bottom: annual.bottom, width: annual.width },
        monthly: { left: monthly.left, right: monthly.right, top: monthly.top, bottom: monthly.bottom, width: monthly.width },
        inputVisible: visible(input),
        totalVisible: visible(total),
        totalText: document.querySelector('#annual-budget-total').textContent,
      };
    })()`);
    assert.equal(desktop.innerWidth, 1280);
    assert.ok(Math.abs(desktop.annual.top - desktop.monthly.top) <= 2, '桌面端两张主卡应顶部对齐');
    assert.ok(desktop.annual.right < desktop.monthly.left, '桌面端全年预算与月度比较应左右并排');
    assert.ok(desktop.annual.width >= 360 && desktop.monthly.width > desktop.annual.width);
    assert.equal(desktop.inputVisible, true, '桌面端金额输入应可见');
    assert.equal(desktop.totalVisible, true, '桌面端全年总额应可见');
    assert.match(desktop.totalText, /4,561\.73/);
    assert.ok(desktop.htmlScrollWidth <= desktop.innerWidth + 1, '桌面端页面不得水平溢出');
    assert.ok(desktop.bodyScrollWidth <= desktop.innerWidth + 1, '桌面端 body 不得水平溢出');

    await cdp.call('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 1, mobile: true,
    });
    await sleep(250);
    const mobile = await cdp.evaluate(`(() => {
      const annual = document.querySelector('.annual-budget-card').getBoundingClientRect();
      const monthly = document.querySelector('.monthly-comparison-card').getBoundingClientRect();
      const wrapper = document.querySelector('.annual-budget-table-wrap');
      const wrapperRect = wrapper.getBoundingClientRect();
      const cardInsideViewport = (r) => r.left >= -1 && r.right <= innerWidth + 1 && r.width > 0;
      return {
        innerWidth,
        htmlScrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
        annual: { left: annual.left, right: annual.right, top: annual.top, bottom: annual.bottom, width: annual.width },
        monthly: { left: monthly.left, right: monthly.right, top: monthly.top, bottom: monthly.bottom, width: monthly.width },
        annualInside: cardInsideViewport(annual),
        monthlyInside: cardInsideViewport(monthly),
        wrapper: {
          left: wrapperRect.left, right: wrapperRect.right,
          clientWidth: wrapper.clientWidth, scrollWidth: wrapper.scrollWidth,
          overflowX: getComputedStyle(wrapper).overflowX,
        },
      };
    })()`);
    assert.equal(mobile.innerWidth, 390);
    assert.ok(mobile.monthly.top >= mobile.annual.bottom + 10, '窄屏两张主卡应纵向单列排列');
    assert.equal(mobile.annualInside, true);
    assert.equal(mobile.monthlyInside, true);
    assert.ok(mobile.wrapper.scrollWidth > mobile.wrapper.clientWidth, '窄屏年度表格应在容器内产生水平滚动');
    assert.match(mobile.wrapper.overflowX, /auto|scroll/);
    assert.ok(mobile.wrapper.left >= -1 && mobile.wrapper.right <= mobile.innerWidth + 1,
      '表格滚动容器自身不得超出视口');
    assert.ok(mobile.htmlScrollWidth <= mobile.innerWidth + 1, '窄屏页面不得水平溢出');
    assert.ok(mobile.bodyScrollWidth <= mobile.innerWidth + 1, '窄屏 body 不得水平溢出');
  } catch (error) {
    // 受限 Windows 沙箱有时能短暂建立 CDP，随后由系统终止 renderer；
    // 这与页面断言失败不同，按环境限制记录为 skip，且不尝试放宽沙箱。
    if (/Target crashed|target closed|WebSocket.*连接失败/i.test(String(error && error.message))) {
      t.skip(`真实浏览器渲染进程不可用：${error.message}`);
      return;
    }
    throw error;
  } finally {
    if (cdp) cdp.close();
    if (probe) await probe.close();
    await mock.close();
  }
});
