import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiagnostics, DIAGNOSTICS_KEY, sanitizeDiagnostic } from '../lib/diagnostics.mjs';

const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnop/';
const TRACE_ID = '83c0332c-905f-4f8b-9466-b13a020cc003';

function event(overrides = {}) {
  return {
    source: 'invite',
    operation: 'invite.send',
    code: 'SEND_FAILED',
    level: 'error',
    platform: 'douyin',
    traceId: TRACE_ID,
    context: {
      phase: 'SUBMIT',
      outcome: 'FAILED',
      itemIndex: 1,
      total: 3,
      elapsedMs: 24,
      surface: 'auto-invite',
      stage: 'request',
      hookReady: true,
      received: 4,
      rejected: 2,
      domFound: 1,
      truncated: 0,
      orphanDetails: 1,
      metadata: 'MUST_NOT_PERSIST',
    },
    error: {
      name: 'NetworkError',
      message: 'Invite for 陈某 13800138000 failed with token=PRIVATE_TOKEN at https://evil.example/path?phone=13800138000',
      stack: 'Error: stack-user-data\n    at sendInvite (chrome-extension://abcdefghijklmnop/lib/invite-controller.mjs:120:7)\n    at page (https://evil.example/app.mjs:4:3)\n    at stolen (chrome-extension://zzzzzzzzzzzzzzzz/lib/invite-page.mjs:44:2)\n    at secret (file:///Users/synthetic-person/private/lib/invite-engine.mjs:55:1)',
    },
    ...overrides,
  };
}

function fakeStorage(initial = undefined) {
  const values = initial === undefined ? {} : { [DIAGNOSTICS_KEY]: initial };
  const writes = [];
  return {
    writes,
    async get(key) { return { [key]: values[key] }; },
    async set(update) { Object.assign(values, update); writes.push(structuredClone(update)); },
    read() { return structuredClone(values[DIAGNOSTICS_KEY]); },
  };
}

test('sanitizeDiagnostic keeps only enumerated fields and safe local frames', () => {
  const clean = sanitizeDiagnostic(event({
    operation: 'invite.send',
    error: {
      name: 'NetworkError',
      message: 'SENSITIVE_NAME 13800138000 token=PRIVATE_TOKEN https://private.example/invite?secret=1',
      stack: 'Error: PRIVATE_STACK\n at sendInvite (chrome-extension://abcdefghijklmnop/lib/invite-controller.mjs:120:7)\n at site (https://evil.example/lib/invite-page.mjs:90:2)',
      summary: 'DO_NOT_TRUST_THIS_SUMMARY',
    },
    source: 'untrusted-source',
    operationExtra: 'DROP_ME',
    platform: 'not-a-platform',
    traceId: 'not-a-uuid',
  }), { extensionOrigin: EXTENSION_ORIGIN });
  const serialized = JSON.stringify(clean);
  for (const canary of [
    'SENSITIVE_NAME', '13800138000', 'PRIVATE_TOKEN', 'private.example', 'PRIVATE_STACK',
    'DO_NOT_TRUST_THIS_SUMMARY', 'MUST_NOT_PERSIST', 'DROP_ME', 'untrusted-source', 'not-a-uuid',
    'abcdefghijklmnop', 'zzzzzzzzzzzzzzzz', 'Users/liuxiaoyu', 'sendInvite', 'secret=1',
  ]) assert.equal(serialized.includes(canary), false, `leaked ${canary}`);
  assert.equal(clean.source, 'background');
  assert.equal(clean.operation, 'invite.send');
  assert.equal(clean.code, 'SEND_FAILED');
  assert.equal(clean.error.category, 'network');
  assert.equal(clean.error.summary, '网络请求未完成。');
  assert.equal(clean.error.name, 'NetworkError');
  assert.deepEqual(clean.error.location, { file: 'lib/invite-controller.mjs', line: 120, column: 7 });
  assert.deepEqual(clean.error.frames, [{ file: 'lib/invite-controller.mjs', line: 120, column: 7 }]);
  assert.deepEqual(clean.context, {
    phase: 'SUBMIT', outcome: 'FAILED', surface: 'auto-invite', stage: 'request', hookReady: true,
    itemIndex: 1, total: 3, elapsedMs: 24, received: 4, rejected: 2, domFound: 1, truncated: 0, orphanDetails: 1,
  });
  assert.equal(Object.hasOwn(clean.context, 'metadata'), false);
  assert.equal(Object.hasOwn(clean, 'operationExtra'), false);
  assert.equal(clean.error.name, 'NetworkError');
  assert.equal(Object.hasOwn(clean.error, 'message'), false);
  assert.equal(Object.hasOwn(clean.error, 'stack'), false);
});

test('native error names survive only from a fixed whitelist and info events without errors omit error detail', () => {
  const native = sanitizeDiagnostic({ source: 'ui', operation: 'UI_EXCEPTION', code: 'UI_EXCEPTION', error: { name: 'TypeError', message: 'failure' } });
  assert.equal(native.error.name, 'TypeError');
  const arbitrary = sanitizeDiagnostic({ source: 'ui', operation: 'UI_EXCEPTION', code: 'UI_EXCEPTION', error: { name: 'CANARY_NAME', message: 'failure' } });
  assert.equal(Object.hasOwn(arbitrary.error, 'name'), false);
  const info = sanitizeDiagnostic({ source: 'background', operation: 'background.startup', code: 'REQUEST_STARTED', level: 'info' });
  assert.equal(Object.hasOwn(info, 'error'), false);
  assert.deepEqual(sanitizeDiagnostic(info), info);
});

test('exact known platform reasons preserve safe control diagnostics; appended user data never matches', () => {
  const exact = sanitizeDiagnostic({
    source: 'douyin', operation: 'invite.send', code: 'OPTIONS_FAILED', level: 'error',
    error: new Error('官方商品选择器未打开。'),
  });
  assert.equal(exact.error.reasonCode, 'DOUYIN_PRODUCT_PICKER_NOT_OPEN');
  assert.equal(exact.error.summary, '官方商品选择器未打开。');
  assert.deepEqual(sanitizeDiagnostic(exact), exact);

  const tainted = sanitizeDiagnostic({
    source: 'douyin', operation: 'invite.send', code: 'OPTIONS_FAILED', level: 'error',
    error: new Error('官方商品选择器未打开。 customer=CANARY_PHONE_13800138000'),
  });
  assert.equal(Object.hasOwn(tainted.error, 'reasonCode'), false);
  assert.equal(tainted.error.summary, '操作未能完成。');
  assert.equal(JSON.stringify(tainted).includes('CANARY'), false);
  assert.equal(JSON.stringify(tainted).includes('13800138000'), false);
});

test('sanitizeDiagnostic is idempotent and ignores arbitrary summary strings', () => {
  const first = sanitizeDiagnostic(event(), { extensionOrigin: EXTENSION_ORIGIN });
  const second = sanitizeDiagnostic(first);
  assert.deepEqual(second, first);
  assert.equal(second.error.summary, '网络请求未完成。');

  const spoofed = sanitizeDiagnostic({
    source: 'ui', operation: 'DIAGNOSTICS_EXPORT', code: 'UI_EXCEPTION', level: 'warning',
    error: { category: 'timeout', summary: 'PRIVATE SUMMARY', frames: [{ file: 'lib/diagnostics.mjs', line: 12, column: 8 }] },
  });
  assert.equal(spoofed.error.category, 'timeout');
  assert.equal(spoofed.error.summary, '操作等待超时。');
  assert.equal(JSON.stringify(spoofed).includes('PRIVATE SUMMARY'), false);
  assert.deepEqual(sanitizeDiagnostic(spoofed), spoofed);
});

test('raw stack frames require the current extension origin; structured allowlisted frames remain idempotent', () => {
  const wrongOrigin = sanitizeDiagnostic({
    source: 'ui', operation: 'UI_EXCEPTION', code: 'UI_EXCEPTION',
    error: { message: 'failed', stack: 'at fn (chrome-extension://wrongwrongwrong/lib/app.mjs:3:4)' },
  }, { extensionOrigin: EXTENSION_ORIGIN });
  assert.equal(Object.hasOwn(wrongOrigin.error, 'frames'), false);
  const unknownOrigin = sanitizeDiagnostic({
    source: 'ui', operation: 'UI_EXCEPTION', code: 'UI_EXCEPTION',
    error: { message: 'failed', stack: 'at fn (chrome-extension://abcdefghijklmnop/lib/app.mjs:3:4)' },
  });
  assert.equal(Object.hasOwn(unknownOrigin.error, 'frames'), false);
  const structured = sanitizeDiagnostic({
    source: 'ui', operation: 'UI_EXCEPTION', code: 'UI_EXCEPTION',
    error: { category: 'unexpected', frames: [{ file: 'app.mjs', line: 3, column: 4 }] },
  });
  assert.deepEqual(structured.error.location, { file: 'app.mjs', line: 3, column: 4 });

  for (const file of [
    'chrome-extension://foreign-extension-id/app.mjs',
    'https://evil.example/app.mjs',
    'file:///Users/person/extensions/creator-assistant/app.mjs',
  ]) {
    const forged = sanitizeDiagnostic({
      source: 'ui', operation: 'UI_EXCEPTION', code: 'UI_EXCEPTION',
      error: { frames: [{ file, line: 12, column: 2 }] },
    }, { extensionOrigin: EXTENSION_ORIGIN });
    assert.equal(Object.hasOwn(forged.error, 'frames'), false, `accepted forged frame ${file}`);
  }
});

test('unknown values fall back to fixed enums and environment exports only browser major and OS family', () => {
  const diag = createDiagnostics({
    environment: {
      browser: 'edge', browserMajor: 131, os: 'macos',
      userAgent: 'UA_CANARY_TOKEN 13800138000 https://private.example', arbitrary: 'DROP_ENV',
    },
  });
  const clean = sanitizeDiagnostic({ source: 'webpage', operation: 'arbitrary', code: 'PRIVATE_CODE', level: 'verbose', context: { phase: 'private', outcome: 'private', itemIndex: '3', url: 'https://evil' } });
  assert.equal(clean.source, 'background');
  assert.equal(clean.operation, 'unknown');
  assert.equal(clean.code, 'REQUEST_FAILED');
  assert.equal(clean.level, 'error');
  assert.equal(Object.hasOwn(clean, 'context'), false);
  const exported = diag.summary();
  assert.deepEqual(exported.environment, { browser: 'edge', browserMajor: 131, os: 'macos' });
  assert.equal(JSON.stringify(exported).includes('UA_CANARY_TOKEN'), false);
  assert.equal(JSON.stringify(exported).includes('DROP_ENV'), false);
});

test('concurrent records serialize without loss and survive a logger restart', async () => {
  const storage = fakeStorage();
  const logger = createDiagnostics({ storage, version: '0.2.1', now: () => Date.UTC(2026, 9, 16) });
  const writes = Array.from({ length: 60 }, (_, index) => logger.record({
    source: 'background', operation: 'GET_STATE', code: 'REQUEST_FAILED', level: 'warning',
    error: new Error(`secret-${index}`), context: { itemIndex: index },
  }));
  assert.equal(logger.summary().count, 60, 'record must add to memory synchronously');
  await Promise.all(writes);
  const bundle = await logger.exportBundle();
  assert.equal(bundle.entries.length, 60);
  assert.equal(bundle.entries[0].context.itemIndex, 0);
  assert.equal(bundle.entries[59].context.itemIndex, 59);
  assert.equal(storage.writes.length > 0, true);
  const restarted = createDiagnostics({ storage, version: '0.2.1', now: () => Date.UTC(2026, 9, 16) });
  const afterRestart = await restarted.exportBundle();
  assert.equal(afterRestart.entries.length, 60);
  assert.equal(afterRestart.entries[59].context.itemIndex, 59);
  assert.equal(afterRestart.persistence.healthy, true);
});

test('retention keeps only the most recent seven days', async () => {
  let now = Date.UTC(2026, 0, 1);
  const logger = createDiagnostics({ now: () => now });
  await logger.record({ source: 'ui', operation: 'UI_GLOBAL', code: 'UI_EXCEPTION' });
  now += 8 * 24 * 60 * 60 * 1000;
  await logger.record({ source: 'ui', operation: 'UI_GLOBAL', code: 'UI_EXCEPTION' });
  const bundle = await logger.exportBundle();
  assert.equal(bundle.entries.length, 1);
  assert.equal(bundle.entries[0].timestamp, new Date(now).toISOString());
});

test('export prunes expired stored entries even when export is the only operation after retention elapsed', async () => {
  let now = Date.UTC(2026, 0, 1);
  const storage = fakeStorage();
  const first = createDiagnostics({ storage, now: () => now });
  await first.record({ source: 'ui', operation: 'UI_GLOBAL', code: 'UI_EXCEPTION' });
  now += 8 * 24 * 60 * 60 * 1000;
  const restarted = createDiagnostics({ storage, now: () => now });
  const bundle = await restarted.exportBundle();
  assert.equal(bundle.entries.length, 0);
  assert.deepEqual(storage.read().entries, []);
});

test('entry count and complete UTF-8 export envelope stay within bounds', async () => {
  const logger = createDiagnostics({ now: () => Date.UTC(2026, 9, 16), extensionOrigin: EXTENSION_ORIGIN });
  const stack = Array.from({ length: 20 }, (_, index) => ` at f${index} (${EXTENSION_ORIGIN}lib/invite-controller.mjs:${index + 1}:8)`).join('\n');
  await Promise.all(Array.from({ length: 360 }, (_, index) => logger.record({
    source: 'invite', operation: 'invite.send', code: 'SEND_FAILED',
    error: { message: `request failed ${index}`, stack },
  })));
  const bundle = await logger.exportBundle();
  assert.ok(bundle.entries.length <= 300);
  assert.ok(bundle.entries.length < 300, 'pretty export byte budget should evict older entries before the count cap');
  assert.ok(Buffer.byteLength(JSON.stringify(bundle, null, 2), 'utf8') <= 256 * 1024);
  assert.equal(logger.summary().count, bundle.entries.length);
  assert.ok(logger.summary().bytes <= 256 * 1024);
});

test('corrupt storage and rejected storage methods fall back to memory without recursive records', async () => {
  const storage = fakeStorage({ schemaVersion: 99, entries: [{ secret: 'STORAGE_CANARY' }] });
  storage.set = async () => { throw new Error('quota STORAGE_CANARY'); };
  const logger = createDiagnostics({ storage, storageTimeoutMs: 30 });
  const entry = await logger.record({ source: 'background', operation: 'IMPORT_STATE', code: 'STORAGE_FAILED', error: new Error('secret quota failure') });
  const bundle = await logger.exportBundle();
  assert.equal(bundle.entries.length, 1);
  assert.equal(bundle.entries[0].id, entry.id);
  assert.equal(bundle.persistence.droppedEntries, 1);
  assert.equal(bundle.persistence.failedWrites, 1);
  assert.equal(bundle.persistence.mode, 'memory-only');
  assert.equal(JSON.stringify(bundle).includes('STORAGE_CANARY'), false);
});

test('entry retains the version that recorded it across an extension upgrade', async () => {
  const storage = fakeStorage();
  const oldLogger = createDiagnostics({ storage, version: '0.2.1' });
  await oldLogger.record({ source: 'background', operation: 'GET_STATE', code: 'REQUEST_FAILED' });
  const newLogger = createDiagnostics({ storage, version: '0.2.2' });
  const bundle = await newLogger.exportBundle();
  assert.equal(bundle.extensionVersion, '0.2.2');
  assert.equal(bundle.entries[0].extensionVersion, '0.2.1');
});

test('never-resolving get and set time out; records and export still resolve and later writes stop', async () => {
  const never = () => new Promise(() => {});
  const getLogger = createDiagnostics({ storage: { get: never, set: async () => {} }, storageTimeoutMs: 15 });
  const started = Date.now();
  await getLogger.record({ source: 'background', operation: 'background.startup', code: 'WORKER_EXCEPTION' });
  const fromGet = await getLogger.exportBundle();
  assert.equal(fromGet.entries.length, 1);
  assert.equal(fromGet.persistence.timeouts, 1);
  assert.ok(Date.now() - started < 500);

  let setCalls = 0;
  const setLogger = createDiagnostics({
    storage: { async get() { return {}; }, set() { setCalls += 1; return never(); } },
    storageTimeoutMs: 15,
  });
  const recordOne = setLogger.record({ source: 'background', operation: 'background.alarm', code: 'TICK_FAILED' });
  const recordTwo = setLogger.record({ source: 'background', operation: 'background.alarm', code: 'TICK_FAILED' });
  await Promise.all([recordOne, recordTwo]);
  const fromSet = await setLogger.exportBundle();
  assert.equal(fromSet.entries.length, 2);
  assert.equal(fromSet.persistence.timeouts, 1);
  assert.equal(fromSet.persistence.mode, 'memory-only');
  assert.equal(setCalls, 1, 'after a timeout, no overlapping store write is started');
});

test('record tolerates synchronous storage throws and invalid input without throwing', async () => {
  const logger = createDiagnostics({ storage: { get() { throw new Error('get'); }, set() { throw new Error('set'); } }, storageTimeoutMs: 20 });
  const badProxy = new Proxy({}, { get() { throw new Error('proxy'); }, getPrototypeOf() { throw new Error('proxy'); } });
  const result = await logger.record(badProxy);
  assert.equal(result.source, 'background');
  assert.equal((await logger.exportBundle()).entries.length, 1);
});
