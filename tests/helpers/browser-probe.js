'use strict';

/**
 * 一次性 headless 浏览器探针（CDP）。
 *
 * 为什么需要它：需要真实渲染或真实按键时，代理过去是先用
 * `Get-Process chrome | Stop-Process -Force` / `taskkill /IM chrome.exe` 清场再启动，
 * 结果把用户正在使用的整个浏览器（连同托管在里面的本地工具界面）一起关掉。
 *
 * 硬性规则：本模块只管理自己 spawn 出来的那一个子进程。
 * 绝不枚举、绝不结束任何不是自己启动的浏览器进程。
 *
 * 用法：
 *   const { launchProbeBrowser } = require('./helpers/browser-probe.js');
 *   const probe = await launchProbeBrowser({ url: `http://127.0.0.1:${PORT}/` });
 *   try {
 *     const ws = new WebSocket(probe.target.webSocketDebuggerUrl);   // Node 22+ 自带 WebSocket
 *     // ... Input.dispatchKeyEvent / Runtime.evaluate 等 CDP 交互 ...
 *   } finally {
 *     await probe.close();   // 结束本次启动的进程并删除一次性配置目录
 *   }
 *
 * 沙箱提示：受限环境里浏览器可能因命名管道（mojo）被拦截而根本起不来。
 * 这时回退到 tests/helpers/dom-stub.js 写用例，不要把「关掉用户的浏览器」当成解决手段。
 */

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

/** 默认查找顺序；环境变量 DSH_BROWSER 可指定绝对路径覆盖。 */
const BROWSER_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 返回本机可用浏览器的可执行文件路径。
 * @returns {string} 可执行文件绝对路径。
 * @throws {Error} 找不到浏览器时抛出，并提示改用 DSH_BROWSER 指定。
 */
function findBrowser() {
  const override = process.env.DSH_BROWSER;
  if (override) {
    if (!fs.existsSync(override)) throw new Error(`DSH_BROWSER 指向的文件不存在: ${override}`);
    return override;
  }
  const found = BROWSER_CANDIDATES.find((candidate) => candidate && fs.existsSync(candidate));
  if (!found) throw new Error('未找到 Edge / Chrome；可用 DSH_BROWSER 指定可执行文件绝对路径');
  return found;
}

/**
 * 让操作系统分配一个空闲的本地端口，避免固定端口被占用后反复重试。
 * @returns {Promise<number>} 空闲端口号。
 */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * 启动一次性浏览器并等待它的调试端点出现目标页面。
 * @param {object} options - 启动参数。
 * @param {string} options.url - 探针要打开的页面地址。
 * @param {number} [options.timeoutMs] - 等待调试端点的上限，默认 30000。
 * @param {string} [options.browserPath] - 覆盖浏览器路径，默认取 findBrowser()。
 * @param {boolean} [options.headless] - 是否使用 headless，默认 true。
 * @returns {Promise<{child: import('node:child_process').ChildProcess, profile: string, debugPort: number, target: object, close: () => Promise<void>}>}
 *   `child` 是本次启动的进程句柄，`profile` 是它的一次性配置目录，`target` 是 CDP 页面目标，
 *   `close()` 结束该进程并删除配置目录（可重复调用）。
 * @throws {Error} 浏览器提前退出或调试端点超时；两种失败都会先回收自己启动的进程。
 */
async function launchProbeBrowser(options = {}) {
  const url = options.url;
  if (!url) throw new Error('launchProbeBrowser 需要 url');
  const timeoutMs = options.timeoutMs === undefined ? 30000 : options.timeoutMs;
  const browserPath = options.browserPath === undefined ? findBrowser() : options.browserPath;
  const headless = options.headless === undefined ? true : options.headless;
  const debugPort = options.debugPort === undefined ? await findFreePort() : options.debugPort;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-browser-probe-'));

  const args = [
    ...(headless ? ['--headless=new'] : []),
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1280,900',
    url,
  ];
  const child = spawn(browserPath, args, { stdio: 'ignore' });
  let exited = null;
  child.on('exit', (code, signal) => {
    exited = { code, signal };
  });

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    if (exited === null) {
      child.kill();
      for (let i = 0; i < 20 && exited === null; i += 1) await sleep(150);
    }
    fs.rmSync(profile, { recursive: true, force: true });
  }

  const deadline = Date.now() + timeoutMs;
  let target = null;
  while (Date.now() < deadline) {
    if (exited !== null) {
      await close();
      throw new Error(
        `浏览器在调试端点就绪前退出（exit=${exited.code} signal=${exited.signal}）：${browserPath}。`
        + '若这是受限沙箱（命名管道被拦截），请改用 tests/helpers/dom-stub.js 写用例，'
        + '不要结束用户已经打开的浏览器进程。',
      );
    }
    try {
      // 调试端口偶尔会接受 TCP 连接却不返回 HTTP；给单次探测独立上限，
      // 否则外层 deadline 无法生效，布局 smoke 会无限挂起。
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1000);
      let response;
      try {
        response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, {
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      const list = await response.json();
      target = list.find((entry) => entry.type === 'page' && entry.url.includes(url));
    } catch {
      /* 调试端点尚未监听，继续等待 */
    }
    if (target) break;
    await sleep(500);
  }
  if (!target) {
    await close();
    throw new Error(`等待 ${timeoutMs}ms 后仍未取到 CDP 页面目标（debugPort=${debugPort}）`);
  }
  return { child, profile, debugPort, target, close };
}

module.exports = { launchProbeBrowser, findBrowser };
