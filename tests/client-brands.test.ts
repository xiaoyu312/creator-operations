import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryClient } from '@tanstack/react-query';
import type { SessionResponse } from '../shared/http.ts';
import type { LocalWorkbookActor } from '../shared/workbook.ts';
import { commitCsvImport, downloadCsvExport, executeCommand, getSession, getWorkspace, previewCsvImport, upsertWorkbookBrandMember } from '../client/src/api/index.ts';
import { createWorkbookRow, getWorkbookRowDetail, getWorkbookSummary, listWorkbookRows, updateWorkbookRow } from '../client/src/lib/workbook-api.ts';
import { brandNavigationUrl, canPreviewLocalRole, getWorkbookContext, workbookQueryKey, workbookSummaryQueryKey } from '../client/src/lib/workbook-context.ts';

const at = '2026-10-14T09:00:00.000Z';

test('native dashboard, commands, imports and exports retain the selected brand and local CSRF transport', async () => {
  const originalFetch = globalThis.fetch;
  const previousWindow = globalThis.window;
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  let selected: string | undefined = 'native-brand-b';
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { csrfToken: 'unused-platform-token', dispatchEvent: () => true } });
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), 'https://client.example');
    calls.push({ url, init });
    return new Response(JSON.stringify(url.pathname === '/api/session' ? selected ? {
      ...localSession(), localCsrfToken: 'native-local-token',
      businessWorkspace: { brandId: selected, brandName: 'Brand B', storage: 'local', role: 'manager', rolePreview: true },
    } : { dataMode: 'production' } : {}), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    await getSession(selected);
    await getWorkspace({ dateFrom: '2026-10-01' });
    await executeCommand({ type: 'product.create', brand: 'Brand B', name: 'Synthetic product' });
    const csv = { kind: 'orders' as const, sourceName: 'synthetic.csv', csvText: 'externalOrderId,externalLineId\norder,line' };
    await previewCsvImport(csv);
    await commitCsvImport({ ...csv, previewHash: 'synthetic-preview' });
    await downloadCsvExport('orders');
    for (const call of calls.slice(1)) {
      assert.equal(call.url.searchParams.get('brandId'), selected);
      assert.equal(new Headers(call.init.headers).get('x-dabo-csrf'), 'native-local-token');
      assert.equal(new Headers(call.init.headers).has('x-suda-csrf-token'), false);
      if (call.init.body) assert.equal(JSON.parse(String(call.init.body)).brandId, undefined);
    }
  } finally {
    selected = undefined;
    await getSession();
    globalThis.fetch = originalFetch;
    if (previousWindow === undefined) Reflect.deleteProperty(globalThis, 'window');
    else Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow });
  }
});

function cloudWorkbook(brandId: string, identity: { principalId?: string; role?: LocalWorkbookActor['role']; businessOwnerName?: string | null } = {}) {
  return {
    storage: 'cloud' as const,
    principalId: identity.principalId ?? 'principal-a',
    brandId,
    brandName: `Brand ${brandId}`,
    label: `Brand ${brandId}`,
    sourceFileName: 'source.xlsx',
    sourceSha256: 'same-source-sha',
    readAt: at,
    role: identity.role ?? 'local_manager',
    businessOwnerName: identity.businessOwnerName ?? null,
    availableBusinessOwners: ['商务甲'],
    rolePreview: false,
  };
}

function localSession() {
  return {
    dataMode: 'local',
    actor: { memberId: 'local-owner', principalId: 'local:owner', displayName: '本机管理员', role: 'manager', capabilities: [], teamId: 'local-team' },
    allowedDemoProfiles: [],
    appName: 'Synthetic brand',
    localWorkbook: {
      label: 'Synthetic brand', sourceFileName: 'source.xlsx', sourceSha256: 'same-source-sha', readAt: at,
      role: 'local_manager', businessOwnerName: null, availableBusinessOwners: ['商务甲'], rolePreview: true,
    },
  } as SessionResponse;
}

test('cloud workbook requests carry the canonical brand scope while local requests stay local', async () => {
  const originalFetch = globalThis.fetch;
  const previousWindow = globalThis.window;
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { csrfToken: 'host-csrf-token', dispatchEvent: () => true } });
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: new URL(String(input), 'https://client.example'), init });
    const body = calls.at(-1)?.url.pathname === '/api/session' ? { dataMode: 'production' } : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const brandA = cloudWorkbook('brand-a');
    await getSession('brand-a');
    await getWorkspace({}, 'brand-a');
    await getWorkbookSummary({ sourceSha256: 'same-source-sha' }, brandA);
    await listWorkbookRows({ sourceSha256: 'same-source-sha' }, brandA);
    await getWorkbookRowDetail({ recordOrigin: 'source', sourceSha256: 'same-source-sha', sheetName: '寄样', sourceRow: 2 }, brandA, true);
    await createWorkbookRow({ templateSourceSha256: 'same-source-sha', sheetName: '寄样', cells: {}, reason: '测试' }, brandA);
    await updateWorkbookRow({ recordOrigin: 'source', sourceSha256: 'same-source-sha', sheetName: '寄样', sourceRow: 2, expectedVersion: 1, reason: '测试', patch: {} }, brandA);
    await upsertWorkbookBrandMember('brand-a', { principalId: '123456', displayName: '商务甲', businessOwnerName: '小王', active: true, expectedVersion: 0 });
    await getWorkbookSummary({}, getWorkbookContext(localSession())!);

    const brandScopedCalls = calls.filter(({ url }) => url.pathname.startsWith('/api/workbook/'));
    assert.equal(brandScopedCalls.length, 6);
    for (const call of calls.filter(({ url }) => ['/api/session', '/api/workspace'].includes(url.pathname) || (url.pathname.startsWith('/api/workbook/') && !url.pathname.endsWith('/members')))) {
      assert.equal(call.url.searchParams.get('brandId'), 'brand-a', `${call.url.pathname} should be brand scoped`);
    }
    const localCall = calls.at(-1)!;
    assert.equal(localCall.url.pathname, '/api/local-workbook/summary');
    assert.equal(localCall.url.searchParams.has('brandId'), false);
    const readCalls = calls.filter(({ init }) => init.method === 'GET');
    assert.ok(readCalls.some(({ url }) => url.pathname === '/api/session'));
    for (const call of readCalls) assert.equal(new Headers(call.init.headers).get('x-suda-csrf-token'), 'host-csrf-token', 'Miaoda gateway requires CSRF on the initial GET session and later reads');
    const writeCalls = calls.filter(({ init }) => init.method === 'POST');
    assert.equal(writeCalls.length, 3);
    for (const call of writeCalls) assert.equal(new Headers(call.init.headers).get('x-suda-csrf-token'), 'host-csrf-token');
    assert.equal(JSON.parse(String(writeCalls[0].init.body)).brandId, undefined, 'brand scope is carried in query, not workbook row input');
    const memberCall = writeCalls.find(({ url }) => url.pathname.endsWith('/members'));
    assert.ok(memberCall);
    assert.equal(memberCall.url.pathname, '/api/workbook/brands/brand-a/members');
    assert.equal(memberCall.url.searchParams.has('brandId'), false, 'brand member scope is carried in the route parameter');
    assert.deepEqual(JSON.parse(String(memberCall.init.body)), {
      principalId: '123456', displayName: '商务甲', businessOwnerName: '小王', active: true, expectedVersion: 0,
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (previousWindow === undefined) Reflect.deleteProperty(globalThis, 'window');
    else Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow });
  }
});

test('same source hashes in different brands have different query scopes', () => {
  const keyA = workbookQueryKey('summary', cloudWorkbook('brand-a'), 'home', 2026);
  const keyB = workbookQueryKey('summary', cloudWorkbook('brand-b'), 'home', 2026);
  assert.notDeepEqual(keyA, keyB);

  const target = new URL(brandNavigationUrl('https://client.example/app/samples?year=2026&platform=douyin&brandId=brand-a#rows', 'brand-b'), 'https://client.example');
  assert.equal(target.pathname, '/app/samples');
  assert.equal(target.searchParams.get('brandId'), 'brand-b');
  assert.equal(target.searchParams.get('year'), '2026');
  assert.equal(target.searchParams.get('platform'), 'douyin');
  assert.equal(target.hash, '#rows');
});

test('summary keys share equivalent filters and isolate principal, brand, role, and business owner', () => {
  const manager = cloudWorkbook('brand-a');
  const filters = { sourceSha256: 'same-source-sha', year: 2026 };
  const homeKey = workbookSummaryQueryKey(manager, filters);
  const navigationKey = workbookSummaryQueryKey(manager, {
    includeHidden: false,
    query: '   ',
    year: 2026,
    sourceSha256: 'same-source-sha',
    page: 2,
    pageSize: 20,
  });
  assert.deepEqual(homeKey, navigationKey, 'summary aliases, empty search, and pagination do not split an equivalent aggregate request');

  assert.notDeepEqual(homeKey, workbookSummaryQueryKey(cloudWorkbook('brand-b'), filters), 'another brand has a different scope');
  assert.notDeepEqual(homeKey, workbookSummaryQueryKey(cloudWorkbook('brand-a', { principalId: 'principal-b' }), filters), 'another authenticated principal has a different scope');
  assert.notDeepEqual(homeKey, workbookSummaryQueryKey(cloudWorkbook('brand-a', { role: 'local_shipping' }), filters), 'another role has a different permission scope');
  assert.notDeepEqual(homeKey, workbookSummaryQueryKey(cloudWorkbook('brand-a', { role: 'local_bd', businessOwnerName: '商务甲' }), filters), 'another owner has a different permission scope');
  assert.notDeepEqual(homeKey, workbookSummaryQueryKey(manager, { ...filters, platform: 'douyin' }), 'platform changes the returned summary');
  assert.notDeepEqual(homeKey, workbookSummaryQueryKey(manager, { ...filters, year: 2025 }), 'year changes the returned summary');
});

test('equivalent home and navigation summary keys share one in-flight request', async () => {
  const context = cloudWorkbook('brand-a');
  const filters = { sourceSha256: 'same-source-sha', year: 2026 };
  const homeKey = workbookSummaryQueryKey(context, filters);
  const navigationKey = workbookSummaryQueryKey(context, { year: 2026, sourceSha256: 'same-source-sha' });
  const queryClient = new QueryClient();
  let calls = 0;
  let finish: (value: number) => void = () => {};
  const pendingResult = new Promise<number>((resolve) => { finish = resolve; });
  const queryFn = () => { calls += 1; return pendingResult; };

  const homeRequest = queryClient.fetchQuery({ queryKey: homeKey, queryFn, staleTime: 30_000 });
  const navigationRequest = queryClient.fetchQuery({ queryKey: navigationKey, queryFn, staleTime: 30_000 });
  finish(2);
  assert.deepEqual(await Promise.all([homeRequest, navigationRequest]), [2, 2]);
  assert.equal(calls, 1);
  queryClient.clear();
});

test('role preview is restricted to a local session even if a production response carries local-looking fields', () => {
  const local = localSession();
  assert.equal(canPreviewLocalRole(local), true);
  assert.equal(getWorkbookContext(local)?.principalId, 'local:owner');
  assert.equal(canPreviewLocalRole({ ...local, dataMode: 'production' }), false);
});
