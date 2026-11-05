'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createApp } = require('./helpers/dom-stub.js');

test('Yahoo 探测超时只报告数据源响应慢，不误判为网络或 VPN 故障', async () => {
  const { doc, app } = createApp({
    networkCheck: {
      ok: false,
      reason: 'timeout',
      hint: 'Yahoo Finance 响应超时，本次连通性检测未完成；实际汇率请求仍会按正常流程重试。',
    },
  });
  await app.init();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const banner = doc.querySelector('#network-banner');
  const message = doc.querySelector('#network-banner-text').textContent;
  assert.equal(banner.hidden, false);
  assert.match(message, /Yahoo Finance.*响应超时/);
  assert.doesNotMatch(message, /网络异常|VPN/);
});
