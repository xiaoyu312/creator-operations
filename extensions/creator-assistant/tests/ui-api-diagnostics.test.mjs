import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from '../ui-api.mjs';

test('request does not duplicate a backend diagnosticLogged error', async () => {
  const sent = [];
  const previousChrome = globalThis.chrome;
  globalThis.chrome = {
    runtime: {
      id: 'test-extension',
      getURL: () => 'chrome-extension://test-extension/',
      async sendMessage(message) {
        sent.push(message);
        return { ok: false, error: 'already recorded', diagnosticLogged: true };
      },
    },
  };
  try {
    await assert.rejects(request('GET_STATE'), /already recorded/u);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(sent.map((message) => message.type), ['GET_STATE']);
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
});

test('request transport failures are recorded with the command and no payload', async () => {
  const sent = [];
  const previousChrome = globalThis.chrome;
  globalThis.chrome = {
    runtime: {
      id: 'test-extension',
      getURL: () => 'chrome-extension://test-extension/',
      async sendMessage(message) {
        sent.push(message);
        if (message.type === 'GET_STATE') throw new Error('transport down');
        return { ok: true };
      },
    },
  };
  try {
    await assert.rejects(request('GET_STATE', { secret: 'user supplied data' }), /transport down/u);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(sent.map((message) => message.type), ['GET_STATE', 'DIAGNOSTICS_RECORD']);
    const record = sent[1];
    assert.equal(record.event.source, 'ui');
    assert.equal(record.event.operation, 'GET_STATE');
    assert.equal(record.event.code, 'REQUEST_FAILED');
    assert.doesNotMatch(JSON.stringify(record), /user supplied data|secret/u);
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
});

test('diagnostic command failures never trigger another diagnostics record', async () => {
  const sent = [];
  const previousChrome = globalThis.chrome;
  globalThis.chrome = {
    runtime: {
      id: 'test-extension',
      getURL: () => 'chrome-extension://test-extension/',
      async sendMessage(message) { sent.push(message); throw new Error('diagnostic transport down'); },
    },
  };
  try {
    for (const type of ['DIAGNOSTICS_EXPORT', 'DIAGNOSTICS_SUMMARY', 'DIAGNOSTICS_RECORD']) {
      await assert.rejects(request(type), /diagnostic transport down/u);
    }
    assert.deepEqual(sent.map((message) => message.type), ['DIAGNOSTICS_EXPORT', 'DIAGNOSTICS_SUMMARY', 'DIAGNOSTICS_RECORD']);
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
});
