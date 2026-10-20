import test from 'node:test';
import assert from 'node:assert/strict';
import {
  exportDiagnostics,
  installGlobalErrorListeners,
  isDiagnosticLogged,
  reportError,
  sanitizeUiDiagnostic,
} from '../diagnostics-ui.mjs';

const runtime = (sendMessage) => ({ id: 'test-extension', getURL: () => 'chrome-extension://test-extension/', sendMessage });

test('UI diagnostics sanitize before send and keep only fixed surface context', async () => {
  let message;
  const sourceError = new Error('unexpected failure with private@example.com https://example.com/path?token=secret 13812345678');
  const result = await reportError(sourceError, {
    operation: 'GET_STATE',
    code: 'REQUEST_FAILED',
    surface: 'app',
    stage: 'request',
    context: { surface: 'app', stage: 'request', pageUrl: 'https://example.com/private', name: 'private name' },
    runtime: runtime(async (value) => { message = value; return { ok: true }; }),
  });

  assert.equal(result, true);
  assert.equal(message.type, 'DIAGNOSTICS_RECORD');
  assert.equal(message.event.source, 'ui');
  assert.equal(message.event.operation, 'GET_STATE');
  assert.equal(message.event.code, 'REQUEST_FAILED');
  assert.deepEqual(message.event.context, { surface: 'app', stage: 'request' });
  assert.equal(Object.hasOwn(message.event.error, 'message'), false);
  assert.equal(Object.hasOwn(message.event.error, 'stack'), false);
  assert.doesNotMatch(JSON.stringify(message.event), /private@example|example\.com|13812345678|private name|secret/u);
  assert.equal(isDiagnosticLogged(sourceError), true);
});

test('global error listeners record exception and rejection codes without forwarding event objects', async () => {
  const target = new EventTarget();
  const messages = [];
  const uninstall = installGlobalErrorListeners(target, {
    surface: 'popup',
    runtime: runtime(async (value) => { messages.push(value); return { ok: true }; }),
  });
  const errorEvent = new Event('error');
  Object.defineProperty(errorEvent, 'error', { value: new TypeError('broken handler') });
  target.dispatchEvent(errorEvent);
  const rejectionEvent = new Event('unhandledrejection');
  Object.defineProperty(rejectionEvent, 'reason', { value: new Error('async task failed') });
  target.dispatchEvent(rejectionEvent);
  await new Promise((resolve) => setTimeout(resolve, 0));
  uninstall();

  assert.deepEqual(messages.map((item) => item.event.code).sort(), ['UI_EXCEPTION', 'UNHANDLED_REJECTION']);
  assert.ok(messages.every((item) => item.type === 'DIAGNOSTICS_RECORD' && item.event.context.surface === 'popup'));
  assert.ok(messages.every((item) => !Object.hasOwn(item, 'target') && !Object.hasOwn(item, 'reason')));
});

test('throwing error and rejection getters cannot make the logger recurse', async () => {
  const target = new EventTarget();
  const messages = [];
  const uninstall = installGlobalErrorListeners(target, {
    surface: 'app',
    runtime: runtime(async (value) => { messages.push(value); return { ok: true }; }),
  });
  const errorEvent = new Event('error');
  Object.defineProperty(errorEvent, 'error', { get() { throw new Error('getter failure'); } });
  const rejectionEvent = new Event('unhandledrejection');
  Object.defineProperty(rejectionEvent, 'reason', { get() { throw new Error('reason getter failure'); } });

  assert.doesNotThrow(() => target.dispatchEvent(errorEvent));
  assert.doesNotThrow(() => target.dispatchEvent(rejectionEvent));
  await new Promise((resolve) => setTimeout(resolve, 0));
  uninstall();

  assert.equal(messages.length, 2);
  assert.deepEqual(messages.map((item) => item.event.code).sort(), ['UI_EXCEPTION', 'UNHANDLED_REJECTION']);
  assert.doesNotMatch(JSON.stringify(messages), /getter failure|reason getter failure/u);
});

test('diagnostics export downloads JSON and reports Chinese success feedback', async () => {
  const bundle = { schemaVersion: 1, entries: [] };
  const notices = [];
  let downloaded;
  const button = { disabled: false };
  const result = await exportDiagnostics({
    runtime: runtime(async (message) => { assert.deepEqual(message, { type: 'DIAGNOSTICS_EXPORT' }); return { ok: true, bundle }; }),
    button,
    download: (value) => { downloaded = value; },
    notify: (...args) => notices.push(args),
  });

  assert.equal(result, true);
  assert.equal(downloaded, bundle);
  assert.deepEqual(notices, [['错误日志已下载。', 'success']]);
  assert.equal(button.disabled, false);
});

test('memory-only diagnostics export succeeds with a local retention notice', async () => {
  const notices = [];
  let downloaded;
  const result = await exportDiagnostics({
    runtime: runtime(async () => ({ ok: true, bundle: { persistence: { mode: 'memory-only' }, entries: [] } })),
    download: (bundle) => { downloaded = bundle; },
    notify: (...args) => notices.push(args),
  });

  assert.equal(result, true);
  assert.ok(downloaded);
  assert.deepEqual(notices, [['错误日志已下载。当前日志只能临时保留，可能丢失，请及时导出。', 'success']]);
});

test('default diagnostics download creates a JSON file with the returned bundle', async () => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const previousURL = globalThis.URL;
  const bundle = { schemaVersion: 1, entries: [{ source: 'ui', operation: 'GET_STATE' }] };
  let blob;
  let revokeId = '';
  let revokeCallback;
  const anchor = { href: '', download: '', hidden: false, clicked: false, removed: false, click() { this.clicked = true; }, remove() { this.removed = true; } };
  globalThis.document = { body: { append: (element) => assert.equal(element, anchor) }, createElement: (tag) => { assert.equal(tag, 'a'); return anchor; } };
  globalThis.window = { setTimeout: (callback, delay) => { revokeCallback = callback; assert.equal(delay, 1000); return 1; } };
  globalThis.URL = { createObjectURL: (value) => { blob = value; return 'blob:diagnostics-test'; }, revokeObjectURL: (value) => { revokeId = value; } };
  try {
    const result = await exportDiagnostics({ runtime: runtime(async () => ({ ok: true, bundle })) });
    assert.equal(result, true);
    assert.equal(anchor.href, 'blob:diagnostics-test');
    assert.match(anchor.download, /^creator-assistant-error-log-\d{4}-\d{2}-\d{2}\.json$/u);
    assert.equal(anchor.hidden, true);
    assert.equal(anchor.clicked, true);
    assert.equal(anchor.removed, true);
    assert.equal(blob.type, 'application/json;charset=utf-8');
    assert.deepEqual(JSON.parse(await blob.text()), bundle);
    revokeCallback();
    assert.equal(revokeId, 'blob:diagnostics-test');
  } finally {
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
    globalThis.URL = previousURL;
  }
});

test('diagnostics export failure is friendly and never recursively records diagnostics', async () => {
  const notices = [];
  const sentTypes = [];
  const result = await exportDiagnostics({
    runtime: runtime(async (message) => { sentTypes.push(message.type); throw new Error('transport down'); }),
    notify: (...args) => notices.push(args),
  });

  assert.equal(result, false);
  assert.deepEqual(sentTypes, ['DIAGNOSTICS_EXPORT']);
  assert.deepEqual(notices, [['导出错误日志失败，请稍后重试。', 'error']]);
});

test('invalid diagnostic operation is rejected before runtime messaging', async () => {
  let calls = 0;
  const event = sanitizeUiDiagnostic(new Error('failed'), {
    operation: 'UNTRUSTED_INPUT',
    runtime: runtime(async () => { calls += 1; return { ok: true }; }),
  });

  assert.equal(event, null);
  assert.equal(calls, 0);
});

test('a diagnostic record transport failure is swallowed without recursive logging', async () => {
  let calls = 0;
  const result = await reportError(new Error('diagnostic write failed'), {
    operation: 'GET_STATE',
    code: 'REQUEST_FAILED',
    runtime: runtime(async (message) => {
      calls += 1;
      assert.equal(message.type, 'DIAGNOSTICS_RECORD');
      throw new Error('logger unavailable');
    }),
  });

  assert.equal(result, false);
  assert.equal(calls, 1);
});
