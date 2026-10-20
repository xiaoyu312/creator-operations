import assert from 'node:assert/strict';
import test from 'node:test';
import { createDemoApplication } from '../demo/application.ts';
import { readDemoConfig } from '../demo/config.ts';
import { MemoryDemoStore } from '../demo/memory-store.ts';
import { resolveWorkbookPlatformRole } from '../modules/workbook/identity.ts';
import { EXECUTIVE_DEMO_PRINCIPALS } from '../../shared/synthetic-principals.ts';
import type { ApiRequest } from '../http/router.ts';
import type { SessionResponse } from '../../shared/http.ts';
import type { WorkspaceSnapshot } from '../../shared/types.ts';

async function harness() {
  const app = createDemoApplication({});
  const session = await app.dispatch({ method: 'GET', url: '/api/session', headers: { host: '127.0.0.1:4310' } });
  assert.equal(session.status, 200);
  let cookie = session.headers['Set-Cookie'].split(';')[0];
  let csrf = (session.body as SessionResponse).demoCsrfToken!;
  return {
    ...app,
    session: session.body as SessionResponse,
    async request(method: string, url: string, body?: unknown, headers: ApiRequest['headers'] = {}) {
      const result = await app.dispatch({
        method, url, body,
        headers: { host: '127.0.0.1:4310', cookie, origin: 'http://127.0.0.1:5173', 'x-dabo-csrf': csrf, ...headers },
      });
      if (result.headers['Set-Cookie']) {
        cookie = result.headers['Set-Cookie'].split(';')[0];
        csrf = (result.body as SessionResponse).demoCsrfToken!;
      }
      return result;
    },
  };
}

test('default application exposes only the synthetic domain workspace with demo role switching', async () => {
  const app = await harness();
  assert.equal(app.session.dataMode, 'demo');
  assert.equal(app.session.workbook, undefined);
  assert.equal(app.session.businessWorkspace, undefined);
  const workspace = await app.request('GET', '/api/workspace');
  assert.equal(workspace.status, 200);
  assert.equal((workspace.body as WorkspaceSnapshot).dataMode, 'demo');
  const profile = app.session.allowedDemoProfiles.find((profile) => profile.principalId === 'demo:bd-a');
  assert.ok(profile);
  const selected = await app.request('POST', '/api/demo/session', { principalId: profile.principalId });
  assert.equal(selected.status, 200);
  assert.equal((await app.request('GET', '/api/workspace')).status, 200);
  assert.equal((await app.request('POST', '/api/demo/session', { principalId: 'not-a-demo-person' })).status, 403);
});

test('host, cookie, CSRF and remote-origin checks fail closed before mutations', async () => {
  const app = await harness();
  assert.equal((await app.request('GET', '/api/workspace', undefined, { host: 'untrusted.invalid' })).status, 403);
  assert.equal((await app.request('GET', '/api/workspace', undefined, { cookie: 'dabo-demo=forged' })).status, 401);
  assert.equal((await app.request('POST', '/api/commands', {}, { 'x-dabo-csrf': 'incorrect' })).status, 403);
  assert.equal((await app.request('POST', '/api/commands', {}, { origin: 'https://untrusted.invalid' })).status, 403);
  assert.equal((await app.request('POST', '/api/commands', { type: 'import.commit' })).status, 422);
  assert.equal((await app.request('GET', '/api/member-invitations')).status, 404);
});

test('CSV preview, signed commit and export retain the original API contract', async () => {
  const app = await harness();
  const input = {
    kind: 'creators',
    sourceName: 'synthetic-creators.csv',
    csvText: 'platform,externalAccountId,name\nchannels,SYNTHETIC-NEW-ACCOUNT,Synthetic New Creator',
  };
  const preview = await app.request('POST', '/api/imports/preview', input);
  assert.equal(preview.status, 200);
  const token = (preview.body as { previewHash: string }).previewHash;
  const wrong = await app.request('POST', '/api/imports/commit', { ...input, csvText: input.csvText + ' changed', previewHash: token });
  assert.equal(wrong.status, 409);
  const commit = await app.request('POST', '/api/imports/commit', { ...input, previewHash: token });
  assert.equal(commit.status, 200);
  const exportResult = await app.request('POST', '/api/exports/creators', {});
  assert.equal(exportResult.status, 200);
  assert.match(exportResult.headers['Content-Type'], /text\/csv/u);
  assert.match(String(exportResult.body), /Synthetic New Creator/u);
  assert.match(String(exportResult.body), /合成演示数据/u);
  const template = await app.request('GET', '/api/imports/template/creators');
  assert.equal(template.status, 200);
  assert.match(String(template.body), /externalAccountId/u);
});

test('memory transactions serialize and roll back failed operations without changing the seed contract', async () => {
  const store = new MemoryDemoStore();
  const before = await store.read();
  await assert.rejects(store.transaction((draft) => { draft.dataMode = 'production'; }));
  assert.deepEqual(await store.read(), before);
  await assert.rejects(store.transaction((draft) => { draft.creators.length = 0; throw new Error('cancel'); }));
  assert.deepEqual(await store.read(), before);
  const initialVersion = before.products[0].version;
  await Promise.all([1, 2].map(() => store.transaction(async (draft) => {
    const version = draft.products[0].version;
    await Promise.resolve();
    draft.products[0].version = version + 1;
  })));
  assert.equal((await store.read()).products[0].version, initialVersion + 2);
  const another = new MemoryDemoStore();
  const copy = await another.read();
  copy.creators.length = 0;
  assert.notEqual((await another.read()).creators.length, 0);
});

test('demo config cannot opt into production or external binding', () => {
  assert.deepEqual(readDemoConfig({}), { mode: 'demo', host: '127.0.0.1', port: 4310 });
  assert.throws(() => readDemoConfig({ NODE_ENV: 'production' }));
  assert.throws(() => readDemoConfig({ DABO_MODE: 'production' }));
  assert.throws(() => readDemoConfig({ DABO_ENABLE_PLATFORM: '1' }));
  assert.throws(() => readDemoConfig({ DABO_DEMO_API_PORT: '0' }));
  assert.throws(() => readDemoConfig({ DABO_DEMO_API_PORT: '4310suffix' }));
});

test('extracted reserved synthetic principals remain rejected by the optional platform identity', () => {
  const config = {
    expectedAppId: 'app_test', orgId: 'synthetic-test-org', storeToken: 'a'.repeat(64),
    roleMapping: { manager: ['test-manager'], bd: [], shipping: [], links: [] },
  };
  for (const userId of EXECUTIVE_DEMO_PRINCIPALS) {
    assert.throws(() => resolveWorkbookPlatformRole({ userId, appId: config.expectedAppId, roles: ['test-manager'] }, config),
      /演示成员不能用于登录/u);
  }
});
