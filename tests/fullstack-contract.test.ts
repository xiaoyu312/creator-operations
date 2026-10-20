import assert from 'node:assert/strict';
import test from 'node:test';
import { createDemoApplication } from '../server/demo/application.ts';
import { ApiError, downloadCsvExport, executeCommand, getSession, getWorkspace, switchDemoProfile } from '../client/src/api/index.ts';

test('real frontend API client and synthetic backend share sessions, commands, CSV and role isolation', async () => {
  const app = createDemoApplication({});
  const priorFetch = globalThis.fetch;
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let cookie = '';
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { origin: 'http://127.0.0.1:5173' }, dispatchEvent: () => true },
  });
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), 'http://127.0.0.1:5173');
    assert.equal(url.origin, 'http://127.0.0.1:5173', 'all requests remain in the in-process local adapter');
    const headers = Object.fromEntries(new Headers(init.headers));
    headers.host = '127.0.0.1:5173';
    headers.origin = url.origin;
    if (cookie) headers.cookie = cookie;
    const response = await app.dispatch({
      method: init.method ?? 'GET',
      url: `${url.pathname}${url.search}`,
      headers,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (response.headers['Set-Cookie']) cookie = response.headers['Set-Cookie'].split(';')[0];
    return new Response(typeof response.body === 'string' ? response.body : JSON.stringify(response.body), {
      status: response.status, headers: response.headers,
    });
  };
  try {
    const session = await getSession();
    assert.equal(session.dataMode, 'demo');
    assert.equal(session.actor.principalId, 'demo:manager');
    assert.equal(session.workbook, undefined);
    const before = await getWorkspace();
    await executeCommand({
      type: 'creator.create', name: '虚构达人·端到端契约示例',
      platform: 'douyin', externalAccountId: 'DEMO-CONTRACT-001',
      displayName: '端到端契约示例', source: 'synthetic test',
    });
    assert.equal((await getWorkspace()).creators.length, before.creators.length + 1);
    assert.ok((await (await downloadCsvExport('creators')).text()).includes('DEMO-CONTRACT-001'));
    const previousCookie = cookie;
    const switched = await switchDemoProfile('demo:bd-a');
    assert.equal(switched.actor.role, 'bd');
    assert.notEqual(cookie, previousCookie);
    await getWorkspace();
    await assert.rejects(
      executeCommand({ type: 'product.create', brand: '虚构品牌', name: '未授权商品' }),
      (error: unknown) => error instanceof ApiError && error.code === 'FORBIDDEN',
    );
  } finally {
    globalThis.fetch = priorFetch;
    if (priorWindow) Object.defineProperty(globalThis, 'window', priorWindow);
    else delete (globalThis as unknown as Record<string, unknown>).window;
  }
});
