'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createApp } = require('./helpers/dom-stub.js');

test('data manager lists immutable backups and restores with the catalog CAS token', async () => {
  const token = 'a'.repeat(64);
  const env = createApp({
    backups: {
      currentToken: token,
      backups: [{
        id: '2026-11-05_10-00-00.000_UTC+0800_run-deadbeef',
        createdAt: '2026-11-05T10:00:00.000+08:00',
        reason: 'pre-user-clear-all',
        fileCount: 4,
        monthCount: 2,
        restorable: true,
        error: null,
      }],
    },
    restoreBackup: { restored: true, months: 2 },
  });
  await env.app.init();
  await env.app.openDataManager();

  const list = env.doc.querySelector('#data-modal-list');
  assert.match(list.textContent, /不可变备份/);
  assert.match(list.textContent, /2 个月/);
  assert.match(list.textContent, /恢复此备份/);

  await env.app.restoreBackup('2026-11-05_10-00-00.000_UTC+0800_run-deadbeef');
  const request = env.requests.find((item) => item.url === '/api/backups/restore');
  assert.ok(request);
  assert.equal(request.method, 'POST');
  assert.deepEqual(request.body, {
    backup_id: '2026-11-05_10-00-00.000_UTC+0800_run-deadbeef',
    base_token: token,
    user_confirmed: true,
  });
  assert.equal(env.reloadCount, 1);
});

test('data manager exposes damaged snapshots as non-restorable evidence', async () => {
  const env = createApp({
    backups: {
      currentToken: 'b'.repeat(64),
      backups: [{
        id: 'broken-snapshot', createdAt: null, reason: null,
        fileCount: 0, monthCount: 0, restorable: false,
        error: '备份文件摘要不匹配',
      }],
    },
  });
  await env.app.init();
  await env.app.openDataManager();

  const list = env.doc.querySelector('#data-modal-list');
  assert.match(list.textContent, /不可恢复/);
  assert.match(list.textContent, /摘要不匹配/);
  assert.equal(list.querySelector('[data-action="restore-backup"]'), null);
});

test('data manager distinguishes intact legacy v1 snapshots from damaged backups', async () => {
  const env = createApp({
    backups: {
      currentToken: 'c'.repeat(64),
      backups: [{
        id: 'legacy-v1', createdAt: '2026-11-04T10:00:00+08:00',
        reason: 'last-browser-tab-closed', fileCount: 2, monthCount: 0,
        kind: 'legacy-v1', restorable: false,
        error: '旧版 v1 快照须使用对应旧版本在隔离目录中人工回滚',
      }],
    },
  });
  await env.app.init();
  await env.app.openDataManager();

  const list = env.doc.querySelector('#data-modal-list');
  assert.match(list.textContent, /旧版 v1/);
  assert.match(list.textContent, /仅供人工回滚/);
  assert.doesNotMatch(list.textContent, /不可恢复/);
  assert.equal(list.querySelector('[data-action="restore-backup"]'), null);
});
