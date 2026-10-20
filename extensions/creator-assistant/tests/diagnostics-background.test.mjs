import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMessage } from '../background.mjs';

const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
const origin = `chrome-extension://${extensionId}/`;
const ui = { id: extensionId, url: origin + 'app.html' };
const content = { id: extensionId, url: 'https://buyin.jinritemai.com/dashboard/servicehall/daren-square?token=private-source-token' };

function fixture({ access = async () => {}, capture } = {}) {
  let disk = {};
  let logWrites = 0;
  globalThis.chrome = {
    runtime: { id: extensionId, getURL: path => origin + path, getManifest: () => ({ version: '0.2.1' }) },
    storage: { local: {
      setAccessLevel: access,
      get: async key => ({ [key]: structuredClone(disk[key]) }),
      set: async value => { if (Object.hasOwn(value, 'creator-assistant-diagnostics-v1')) logWrites++; disk = { ...disk, ...structuredClone(value) }; },
    } },
    tabs: { query: async () => [], get: async id => ({ id, url: content.url, title: 'private-shop-name' }), sendMessage: async () => capture, create: async () => {} },
  };
  return { read: () => disk, writes: () => logWrites };
}

test('diagnostics API isolates content scripts and never exports business payloads', async () => {
  const f = fixture();
  try {
    const secret = 'private-fixture-cookie-contact-message';
    await handleMessage({ type: 'UPSERT_CREATORS', creators: [{ platform: 'douyin', externalId: 'private-fixture-id', name: 'private-fixture-name', contact: { wechat: secret } }] }, ui);
    await assert.rejects(handleMessage({ type: 'IMPORT_STATE', data: '{broken-private-payload' }, ui));
    await handleMessage({ type: 'DIAGNOSTICS_RECORD', event: {
      source: 'ui', operation: 'UI_GLOBAL', code: 'UI_EXCEPTION', level: 'error',
      error: { name: 'TypeError', message: secret, stack: `TypeError: ${secret}\n    at fake (${origin}app.mjs:123:9)\n    at secret (https://example.test/app.mjs:4:8)` },
      metadata: { cookie: secret }, context: { secret, surface: 'app' },
    } }, ui);
    await handleMessage({ type: 'CONTENT_DIAGNOSTIC', event: { operation: 'content.capture', error: { name: 'Error', message: secret } } }, content);
    for (const type of ['DIAGNOSTICS_RECORD', 'DIAGNOSTICS_EXPORT', 'DIAGNOSTICS_SUMMARY']) {
      await assert.rejects(handleMessage({ type }, content));
      await assert.rejects(handleMessage({ type }, { ...ui, id: 'foreign-extension' }));
      await assert.rejects(handleMessage({ type }, { ...content, url: 'https://example.test/' }));
    }
    const { bundle } = await handleMessage({ type: 'DIAGNOSTICS_EXPORT' }, ui);
    const serialized = JSON.stringify(bundle);
    for (const marker of [secret, 'private-fixture-id', 'private-fixture-name', 'broken-private-payload', 'private-source-token', 'private-shop-name', 'example.test', extensionId]) assert.equal(serialized.includes(marker), false, marker);
    assert.equal(bundle.extensionVersion, '0.2.1');
    assert.ok(bundle.entries.some(e => e.operation === 'IMPORT_STATE' && e.code === 'REQUEST_FAILED'));
    assert.ok(bundle.entries.some(e => e.operation === 'content.capture' && e.code === 'CONTENT_FAILED'));
    assert.ok(serialized.includes('app.mjs'));
    assert.equal(f.read()['creator-assistant-v1'].creators[0].name, 'private-fixture-name');
    assert.ok(f.writes() > 0);
  } finally { delete globalThis.chrome; }
});

test('log persistence waits for trusted-only access and business requests do not wait', async () => {
  let enableAccess;
  const f = fixture({ access: () => new Promise(resolve => { enableAccess = resolve; }) });
  try {
    await handleMessage({ type: 'DIAGNOSTICS_RECORD', event: { source: 'ui', operation: 'UI_GLOBAL', code: 'UI_EXCEPTION', level: 'error' } }, ui);
    await handleMessage({ type: 'UPSERT_CREATORS', creators: [{ platform: 'douyin', externalId: 'demo', name: '合成资料' }] }, ui);
    assert.equal(f.writes(), 0);
    assert.equal(f.read()['creator-assistant-v1'].creators.length, 1);
    enableAccess();
    const { bundle } = await handleMessage({ type: 'DIAGNOSTICS_EXPORT' }, ui);
    assert.ok(bundle.entries.length > 0);
    assert.ok(f.writes() > 0);
  } finally { delete globalThis.chrome; }
});

test('unavailable storage isolation falls back without writing logs or blocking capture', async () => {
  const f = fixture({ access: async () => { throw new Error('access unavailable'); }, capture: { candidates: [], captureStats: { received: 0, rejected: 3, domFound: 0, hookReady: false, secret: 'do-not-log' } } });
  try {
    const captured = await handleMessage({ type: 'GET_ACTIVE_CAPTURE', tabId: 1 }, ui);
    assert.deepEqual(captured.captureStats, { received: 0, rejected: 3, domFound: 0, hookReady: false });
    const { bundle } = await handleMessage({ type: 'DIAGNOSTICS_EXPORT' }, ui);
    assert.equal(f.writes(), 0);
    assert.ok(bundle.entries.some(e => e.code === 'CAPTURE_EMPTY' && e.context.hookReady === false));
    assert.equal(JSON.stringify(bundle).includes('do-not-log'), false);
  } finally { delete globalThis.chrome; }
});
