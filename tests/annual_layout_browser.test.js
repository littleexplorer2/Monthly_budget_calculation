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

function assetRates(year) {
  return {
    kind: 'trailing_365_day_close_average',
    window_days: 365,
    start_date: `${year - 1}-09-29`,
    requested_through: `${year}-09-28`,
    observed_through: `${year}-09-25`,
    source: 'Yahoo Finance',
    price_field: 'Close',
    non_trading_days: 'excluded',
    stats: {
      HKD: { average: 0.92, observation_count: 250, first_date: `${year - 1}-09-29`, last_date: `${year}-09-25` },
      USD: { average: 7.2, observation_count: 250, first_date: `${year - 1}-09-29`, last_date: `${year}-09-25` },
    },
    errors: {},
    complete: true,
  };
}

function appState(year) {
  // 布局夹具中的已保存结果与本次行情使用同一观测数量，避免正确的过期检测清空总额。
  const rateStats = annualRates(year).stats;
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
    region, includeTravel, budgetModel: 'subscription-fixed-monthly-equivalent-v2', stale: false,
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
    subscriptionsByMonth: {
      [`${year}-09`]: {
        items: [
          { id: 'cny-monthly', name: '本地会员', currency: 'CNY', cycle: 'monthly', amount: 29, included: true, includeByDefault: true },
          { id: 'hkd-yearly', name: '香港年费', currency: 'HKD', cycle: 'yearly', amount: 1200, included: true, includeByDefault: true },
          { id: 'usd-monthly', name: '海外服务', currency: 'USD', cycle: 'monthly', amount: 10, included: true, includeByDefault: true },
        ],
      },
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
          { currency: 'CNY', amount: 1000, average_rate: 1, observation_count: rateStats.CNY.observation_count, cny_amount: 1000 },
          { currency: 'USD', amount: 500, average_rate: 7.123456, observation_count: rateStats.USD.observation_count, cny_amount: 3561.73 },
        ],
        errors: {},
      },
    },
    assetPortfoliosById: {
      current: {
        calculationBase: { CNY: 10000, HKD: 1000, USD: 1000 },
        rates: { CNY: 1, HKD: 999, USD: 999 },
        items: [
          { id: 'cash-cny', kind: 'cash', location: '深圳', name: '活期', purpose: 'reserve', currency: 'CNY', amount: 1000 },
          { id: 'term-usd', kind: 'term', location: '香港', name: '定期', purpose: 'other', currency: 'USD', amount: 1000 },
          { id: 'invest-hkd', kind: 'investment', location: '香港', name: '投资', purpose: 'other', currency: 'HKD', amount: 1000 },
        ],
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
    if (pathname === '/api/asset-rates') return jsonResponse(res, assetRates(year));
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

test('浅色主题保持 desktop / 390px 既有布局且各预算页不水平溢出', async (t) => {
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
      `document.readyState === 'complete' && document.querySelector('#tab-dashboard') && document.querySelector('#annual-budget-rows')`,
      '应用页面未就绪',
    );
    const shell = await cdp.evaluate(`(() => {
      const header = document.querySelector('.site-header');
      const month = document.querySelector('.header-period');
      const context = document.querySelector('#options-panel');
      const options = document.querySelector('.context-options');
      const subnav = document.querySelector('.section-nav');
      const actions = document.querySelector('.context-actions');
      const sheet = document.querySelector('.sheet');
      const primaryButton = document.querySelector('.cta');
      const bodyStyle = getComputedStyle(document.body);
      const headerStyle = getComputedStyle(header);
      const rect = (el) => { const r = el.getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height }; };
      return {
        bodyBackground: bodyStyle.backgroundColor,
        bodyColor: bodyStyle.color,
        headerBackground: headerStyle.backgroundColor,
        headerBackdrop: headerStyle.backdropFilter || headerStyle.webkitBackdropFilter,
        headerShadow: headerStyle.boxShadow,
        headerPosition: headerStyle.position,
        headerRadius: headerStyle.borderRadius,
        sheetBackground: getComputedStyle(sheet).backgroundColor,
        primaryButtonBackground: getComputedStyle(primaryButton).backgroundColor,
        primaryButtonColor: getComputedStyle(primaryButton).color,
        header: rect(header), month: rect(month), context: rect(context), options: rect(options), subnav: rect(subnav), actions: rect(actions),
      };
    })()`);
    assert.equal(shell.bodyBackground, 'rgb(244, 247, 250)', '页面应使用浅灰蓝背景');
    assert.equal(shell.bodyColor, 'rgb(50, 76, 91)', '正文应使用蓝灰前景色');
    assert.equal(shell.headerBackground, 'rgb(255, 255, 255)', '全局栏应使用白色表面');
    assert.ok(shell.headerBackdrop === 'none' || shell.headerBackdrop === '', '浅色全局栏不应保留液态玻璃模糊');
    assert.notEqual(shell.headerShadow, 'none', '全局栏应保留轻量层级阴影');
    assert.equal(shell.sheetBackground, 'rgb(255, 255, 255)', '内容卡片应使用白色表面');
    assert.equal(shell.primaryButtonBackground, 'rgb(0, 128, 95)', '主操作应使用可读的深绿色');
    assert.equal(shell.primaryButtonColor, 'rgb(255, 255, 255)', '主操作应使用白色文字');
    assert.equal(shell.headerPosition, 'sticky', '全局栏应固定在视口顶部');
    assert.match(shell.headerRadius, /1[8-9]px|2[0-9]px/);
    assert.ok(shell.header.left > 0 && shell.header.right < 1280, '全局栏应悬浮并与视口两侧留空');
    assert.ok(shell.month.top >= shell.header.top && shell.month.bottom <= shell.header.bottom, '月份控件应位于全局栏内');
    assert.ok(shell.options.right <= shell.subnav.left + 2, '预算选项应位于子分区左侧');
    assert.ok(shell.subnav.right <= shell.actions.left + 2, '操作按钮应位于子分区右侧');

    await cdp.evaluate(`document.querySelector('.section-nav-item[data-tab="subscriptions"]').click()`);
    await sleep(100);
    const subscriptions = await cdp.evaluate(`(() => {
      const cards = [...document.querySelectorAll('#subscription-list .subscription-currency-card')]
        .map((node) => { const r = node.getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, width:r.width }; });
      const option = document.querySelector('#subscription-list select option');
      const optionStyle = option ? getComputedStyle(option) : null;
      return {
        cards,
        ledeCount: document.querySelectorAll('#tab-subscriptions > .view-head .lede').length,
        toggleTexts: [...document.querySelectorAll('#subscription-list .subscription-toggle span')]
          .slice(0, 2).map((node) => node.textContent),
        togglesFit: [...document.querySelectorAll('#subscription-list .subscription-toggle')]
          .every((node) => node.scrollWidth <= node.clientWidth + 1),
        addButtons: document.querySelectorAll('#subscription-list [data-action="add-subscription"]').length,
        globalAddButton: !!document.querySelector('#btn-add-subscription'),
        currencySelectors: document.querySelectorAll('#subscription-list select[data-subscription-field="currency"]').length,
        regionPickers: document.querySelectorAll('#subscription-list details.subscription-region-picker').length,
        regionLabels: [...document.querySelectorAll('#subscription-list .subscription-region-menu span')]
          .slice(0, 2).map((node) => node.textContent),
        optionColor: optionStyle && optionStyle.color,
        optionBackground: optionStyle && optionStyle.backgroundColor,
        horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    })()`);
    assert.equal(subscriptions.cards.length, 3);
    assert.equal(subscriptions.ledeCount, 0, '订阅管理标题下不应保留已指定删除的说明文字');
    assert.deepEqual(subscriptions.toggleTexts, ['计入默认', '计入当月预算']);
    assert.equal(subscriptions.togglesFit, true, '两个订阅勾选框文案必须完整显示');
    assert.equal(subscriptions.addButtons, 3);
    assert.equal(subscriptions.globalAddButton, false);
    assert.equal(subscriptions.currencySelectors, 0);
    assert.equal(subscriptions.regionPickers, 3);
    assert.deepEqual(subscriptions.regionLabels, ['对内地预算使用', '对海外预算使用']);
    assert.ok(subscriptions.cards.every((card) => Math.abs(card.top - subscriptions.cards[0].top) <= 2),
      `桌面端 CNY / HKD / USD 订阅应并排：${JSON.stringify(subscriptions.cards)}`);
    assert.ok(subscriptions.cards[0].right < subscriptions.cards[1].left
      && subscriptions.cards[1].right < subscriptions.cards[2].left);
    assert.notEqual(subscriptions.optionColor, subscriptions.optionBackground,
      '下拉选项前景色与背景色必须可区分');
    assert.ok(subscriptions.horizontalOverflow <= 1);

    await cdp.evaluate(`document.querySelector('.section-nav-item[data-tab="standards"]').click()`);
    const fixed = await cdp.evaluate(`(() => ({
      rows: document.querySelectorAll('#fixed-standards-table .budget-row').length,
      inputs: document.querySelectorAll('#fixed-standards-table input').length,
      addButton: !!document.querySelector('#btn-add-fixed'),
      text: document.querySelector('#fixed-standards-table').textContent,
    }))()`);
    assert.equal(fixed.rows, 3);
    assert.equal(fixed.inputs, 0);
    assert.equal(fixed.addButton, false);
    assert.match(fixed.text, /29\.00 CNY/);
    assert.match(fixed.text, /100\.00 HKD/);

    await cdp.call('Emulation.setDeviceMetricsOverride', {
      width: 1191, height: 668, deviceScaleFactor: 1, mobile: false,
    });
    await cdp.evaluate(`document.querySelector('.section-nav-item[data-tab="itinerary"]').click()`);
    await sleep(100);
    const calendar = await cdp.evaluate(`(() => {
      const card = document.querySelector('.calendar-sheet').getBoundingClientRect();
      const cells = [...document.querySelectorAll('#cal-grid .cal-cell:not(.empty)')];
      const first = cells[0].getBoundingClientRect();
      return {
        height: card.height,
        cellRatio: first.width / first.height,
        ledeCount: document.querySelectorAll('#tab-itinerary > .view-head .lede').length,
      };
    })()`);
    assert.equal(calendar.ledeCount, 0, '行程安排标题下不应保留已指定删除的说明文字');
    assert.ok(Math.abs(calendar.cellRatio - 1.2) <= 0.03,
      `日历日期格应恢复原有 1.2 宽高比例：${JSON.stringify(calendar)}`);

    await cdp.call('Emulation.setDeviceMetricsOverride', {
      width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    await cdp.evaluate(`document.querySelector('.primary-nav-item[data-section="dashboard"]').click()`);
    await waitForPage(
      cdp.evaluate,
      `document.querySelectorAll('#annual-budget-rows tr').length === 3
        && document.querySelector('#annual-budget-status').textContent !== '正在获取汇率…'`,
      '全年页数据未渲染',
    );

    const dashboardNavigation = await cdp.evaluate(`(() => {
      const bar = document.querySelector('#options-panel').getBoundingClientRect();
      const nav = document.querySelector('.dashboard-nav').getBoundingClientRect();
      const order = [...document.querySelectorAll('.dashboard-nav-item')]
        .map((node) => node.dataset.dashboardTab);
      return { barCenter: (bar.left + bar.right) / 2, navCenter: (nav.left + nav.right) / 2, order };
    })()`);
    assert.ok(Math.abs(dashboardNavigation.barCenter - dashboardNavigation.navCenter) <= 2,
      '统计面板子分区导航应位于上下文栏中间');
    assert.deepEqual(dashboardNavigation.order, ['analysis', 'assets'],
      '数据面板只保留年度总览与资产管理');

    const desktop = await cdp.evaluate(`(() => {
      const annual = document.querySelector('.annual-budget-card').getBoundingClientRect();
      const monthly = document.querySelector('.monthly-comparison-card').getBoundingClientRect();
      const input = document.querySelector('#annual-budget-rows input[data-annual-currency="CNY"]').getBoundingClientRect();
      const total = document.querySelector('#annual-budget-total').getBoundingClientRect();
      const visible = (r) => r.width > 0 && r.height > 0 && r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight;
      return {
        innerWidth,
        clientWidth: document.documentElement.clientWidth,
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
      const clientWidth = document.documentElement.clientWidth;
      const cardInsideViewport = (r) => r.left >= -1 && r.right <= clientWidth + 1 && r.width > 0;
      return {
        innerWidth,
        clientWidth,
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
    assert.equal(mobile.clientWidth, 390);
    assert.equal(mobile.innerWidth, 390);
    assert.ok(mobile.monthly.top >= mobile.annual.bottom + 10, '窄屏两张主卡应纵向单列排列');
    assert.equal(mobile.annualInside, true);
    assert.equal(mobile.monthlyInside, true);
    assert.ok(mobile.wrapper.scrollWidth > mobile.wrapper.clientWidth, '窄屏年度表格应在容器内产生水平滚动');
    assert.match(mobile.wrapper.overflowX, /auto|scroll/);
    assert.ok(mobile.wrapper.left >= -1 && mobile.wrapper.right <= mobile.clientWidth + 1,
      '表格滚动容器自身不得超出视口');
    assert.ok(mobile.htmlScrollWidth <= mobile.clientWidth + 1, '窄屏页面不得水平溢出');
    assert.ok(mobile.bodyScrollWidth <= mobile.clientWidth + 1, '窄屏 body 不得水平溢出');

    for (const tab of ['subscriptions', 'standards', 'itinerary', 'result']) {
      await cdp.evaluate(`document.querySelector('.section-nav-item[data-tab="${tab}"]').click()`);
      await sleep(100);
      const page = await cdp.evaluate(`(() => ({
        clientWidth: document.documentElement.clientWidth,
        innerWidth,
        htmlScrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
      }))()`);
      assert.equal(page.clientWidth, 390, `${tab} 页设备视口宽度应保持 390px`);
      assert.ok(page.htmlScrollWidth <= page.clientWidth + 1,
        `${tab} 页不得产生页面级水平溢出：${JSON.stringify(page)}`);
      assert.ok(page.bodyScrollWidth <= page.clientWidth + 1,
        `${tab} 页 body 不得产生水平溢出：${JSON.stringify(page)}`);
    }

    await cdp.call('Emulation.setDeviceMetricsOverride', {
      width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    await cdp.evaluate(`document.querySelector('.primary-nav-item[data-section="dashboard"]').click()`);
    await cdp.evaluate(`document.querySelector('.dashboard-nav-item[data-dashboard-tab="assets"]').click()`);
    await sleep(120);
    const assets = await cdp.evaluate(`(() => ({
      active: document.querySelector('#tab-assets').classList.contains('active'),
      kpis: document.querySelectorAll('.asset-kpis article').length,
      kpiSlots: [...document.querySelectorAll('.asset-kpi-values')].map((node) => node.children.length),
      kpiCards: [...document.querySelectorAll('.asset-kpi-card')].map((node) => {
        const r = node.getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, width:r.width };
      }),
      kpiAreaRight: document.querySelector('.asset-kpis').getBoundingClientRect().right,
      placeholders: document.querySelectorAll('.asset-kpi-placeholder').length,
      baseInputs: [...document.querySelectorAll('[data-asset-base-currency]')]
        .map((node) => ({ currency: node.dataset.assetBaseCurrency, value: node.value })),
      baseProgress: document.querySelector('#asset-base-progress').textContent,
      rateCardWidths: [...document.querySelectorAll('.asset-rate-readout')]
        .map((node) => node.getBoundingClientRect().width),
      allocationCurrencies: [...document.querySelectorAll('.allocation-segment')]
        .map((node) => node.dataset.allocationCurrency),
      allocationWidths: [...document.querySelectorAll('.allocation-segment')]
        .map((node) => Number.parseFloat(node.style.width)),
      allocationLegends: [...document.querySelectorAll('.allocation-legend-item')]
        .map((node) => node.dataset.allocationLegend),
      rateInputs: document.querySelectorAll('[data-asset-rate]').length,
      rateOutputs: [...document.querySelectorAll('[data-asset-rate-output]')].map((node) => node.textContent),
      currentTotal: document.querySelector('#asset-current-total').textContent,
      depositRate: document.querySelector('#asset-deposit-rate').textContent,
      addButtons: document.querySelectorAll('#tab-assets [data-action="add-asset"]').length,
      sections: [...document.querySelectorAll('.asset-sections-grid .asset-section')].map((node) => {
        const r = node.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, width: r.width };
      }),
      clientWidth: document.documentElement.clientWidth,
      htmlScrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
    }))()`);
    assert.equal(assets.active, true);
    assert.equal(assets.kpis, 2);
    assert.deepEqual(assets.kpiSlots, [2, 3]);
    assert.equal(assets.placeholders, 0);
    assert.deepEqual(assets.baseInputs, [
      { currency: 'CNY', value: '10000' },
      { currency: 'HKD', value: '1000' },
      { currency: 'USD', value: '1000' },
    ]);
    assert.equal(assets.baseProgress, '50.33%');
    assert.ok(assets.rateCardWidths.every((width) => width <= 130),
      `右侧只读汇率卡应保持紧凑：${JSON.stringify(assets.rateCardWidths)}`);
    assert.deepEqual(assets.allocationCurrencies, ['CNY', 'HKD', 'USD']);
    assert.deepEqual(assets.allocationLegends, ['CNY', 'HKD', 'USD']);
    assert.ok(Math.abs(assets.allocationWidths.reduce((sum, value) => sum + value, 0) - 100) <= 0.01,
      `三种货币应共用一个总长为 100% 的堆叠进度条：${JSON.stringify(assets.allocationWidths)}`);
    assert.equal(assets.rateInputs, 0);
    assert.deepEqual(assets.rateOutputs, ['0.920000', '7.200000']);
    assert.match(assets.currentTotal, /9,120\.00/);
    assert.equal(assets.depositRate, '89.91%');
    assert.ok(assets.kpiCards[0].right < assets.kpiCards[1].left,
      `两张组合指标卡应并排：${JSON.stringify(assets.kpiCards)}`);
    assert.ok(assets.kpiAreaRight - assets.kpiCards[1].right >= 120,
      `指标卡右侧应保留整行空白，不应在卡片内部制造占位：${JSON.stringify(assets.kpiCards)}`);
    assert.equal(assets.addButtons, 3);
    assert.equal(assets.sections.length, 3);
    assert.ok(assets.sections.every((section) => Math.abs(section.top - assets.sections[0].top) <= 2),
      `桌面端三个资产板块应等高起排：${JSON.stringify(assets.sections)}`);
    assert.ok(assets.sections[0].right < assets.sections[1].left && assets.sections[1].right < assets.sections[2].left,
      `桌面端三个资产板块应按活期、定期、投资横向分栏：${JSON.stringify(assets.sections)}`);
    assert.ok(assets.htmlScrollWidth <= assets.clientWidth + 1,
      `资产管理页不得产生页面级水平溢出：${JSON.stringify(assets)}`);
    assert.ok(assets.bodyScrollWidth <= assets.clientWidth + 1,
      `资产管理页 body 不得产生水平溢出：${JSON.stringify(assets)}`);

    await cdp.evaluate(`window.scrollTo(0, document.documentElement.scrollHeight)`);
    await sleep(100);
    const stickyHeader = await cdp.evaluate(`(() => {
      const header = document.querySelector('.site-header');
      return { top: header.getBoundingClientRect().top, position: getComputedStyle(header).position, scrollY: window.scrollY };
    })()`);
    assert.ok(stickyHeader.scrollY > 0, `资产页应有足够内容验证粘性导航：${JSON.stringify(stickyHeader)}`);
    assert.equal(stickyHeader.position, 'sticky');
    assert.ok(Math.abs(stickyHeader.top - 12) <= 1,
      `滚动后全局栏仍应悬浮固定在顶部：${JSON.stringify(stickyHeader)}`);
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
