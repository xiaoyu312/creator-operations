import test from 'node:test';
import assert from 'node:assert/strict';
import { createWeixinClient } from '../lib/weixin-client.mjs';

function harness(overrides = {}) {
  const disk = {}, calls = [], cookieReads = [], diagnostics = [];
  let cookie = 'synthetic-private-session';
  let accountId = 'shop-A';
  let documentId = 'doc-A';
  const chromeApi = {
    tabs: { get: async id => ({ id, url: 'https://channels.weixin.qq.com/shop/findersquare', incognito: false }) },
    storage: { session: { get: async key => ({ [key]: structuredClone(disk[key]) }), set: async data => Object.assign(disk, structuredClone(data)) } },
    cookies: {
      getAllCookieStores: async () => [{ id: 'unrelated', tabIds: [33] }, { id: 'correct-store', tabIds: [7] }],
      get: async query => { cookieReads.push(query); return { value: cookie, storeId: 'correct-store' }; },
    },
  };
  const defaultFetch = async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, method: options.method, body, headers: options.headers });
    if (overrides.responseText !== undefined) return new Response(overrides.responseText, { status: overrides.httpStatus || 200, headers: { 'Content-Type': 'application/json' } });
    if (overrides.httpStatus) return new Response('synthetic response', { status: overrides.httpStatus });
    let data;
    if (url.includes('getMergedItemList')) data = { itemList: [{ spuId: '1001', productInfo: { title: '演示商品', price: 9900 } }], hasMore: false };
    else data = body?.preCheck ? { code: 0 } : (overrides.sendResult || { code: 0 });
    if (overrides.rejectSend && body && !body.preCheck) throw new Error('synthetic timeout');
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const fetchImpl = overrides.fetchImpl || defaultFetch;
  const reportDiagnostic = event => {
    diagnostics.push(event);
    if (overrides.diagnosticFailure === 'throw') throw new Error('synthetic logger failure');
    if (overrides.diagnosticFailure === 'reject') return Promise.reject(new Error('synthetic logger rejection'));
    return overrides.reportDiagnostic?.(event);
  };
  const make = () => createWeixinClient({ chromeApi, fetchImpl, timeoutMs: overrides.timeoutMs ?? 15000, reportDiagnostic, readAccount: async () => ({ accountId, accountLabel: '演示店铺', documentId }) });
  const client = make();
  const recipient = { id: 'weixin:creator-A', platform: 'weixin', externalId: 'creator-A', name: '演示达人', talentAppid: 'talent-A' };
  const config = { message: '你好，想邀请你合作', contactName: '测试联系人', phone: '13800000000', wechat: 'demo_wechat', productIds: ['1001'], categoryIds: [], rightIds: [] };
  return { client, make, calls, diagnostics, disk, cookieReads, recipient, config, changeCookie(v) { cookie = v; }, changeAccount(v) { accountId = v; }, changeDocument(v) { documentId = v; }, async job() { await client.options(7, recipient); return { ...(await client.configure(7, config)), tabId: 7 }; } };
}
test('zero prior invitations: read catalog, type settings, preflight and send exact first recipient', async () => {
  const h = harness(); const options = await h.client.options(7, h.recipient);
  assert.equal(options.products[0].name, '演示商品');
  assert.equal(options.products[0].priceText, '¥99.00');
  assert.equal(h.calls.some(c => c.body), false);
  const descriptor = await h.client.configure(7, h.config);
  assert.equal(descriptor.referenceRecipientId, '');
  assert.equal(descriptor.flowVersion, 2);
  assert.equal(h.calls.filter(c => c.body).length, 0);
  const job = { ...descriptor, tabId: 7 };
  assert.equal((await h.client.preflight(job, h.recipient)).ok, true);
  const send = await h.client.prepareSend(job, h.recipient);
  assert.equal((await send()).status, 'succeeded');
  const body = h.calls.at(-1).body;
  assert.deepEqual(body, { finderUsername: 'creator-A', talentAppid: 'talent-A', itemList: { itemInfo: [{ spuId: '1001' }] }, contactInfo: { contactName: '测试联系人', contactWxId: 'demo_wechat', contactPhoneNumber: '13800000000', invitationIntroduction: '你好，想邀请你合作', inviteScene: '1' } });
  assert.equal((await send()).notSubmitted, true);
  assert.equal(h.cookieReads.every(q => q.name === 'biz_magic' && q.storeId === 'correct-store'), true);
  assert.equal(JSON.stringify(h.disk).includes('synthetic-private-session'), false);
  assert.equal(JSON.stringify(descriptor).includes('13800000000'), false);
});
test('settings reject unknown products and no send without preflight', async () => {
  const h = harness(); await h.client.options(7, h.recipient);
  await assert.rejects(h.client.configure(7, { ...h.config, productIds: ['not-a-product'] }));
  const job = await h.job();
  const send = await h.client.prepareSend(job, h.recipient);
  assert.equal((await send()).notSubmitted, true);
  assert.equal(h.calls.some(c => c.body && !c.body.preCheck), false);
});
test('shop, document or session changes invalidate previous frozen configuration', async () => {
  for (const change of ['changeCookie', 'changeAccount', 'changeDocument']) {
    const h = harness(); const job = await h.job(); h[change]('different-value');
    assert.equal((await h.client.inspect(job)).ready, false);
    assert.equal((await h.client.preflight(job, h.recipient)).ok, false);
    assert.equal(h.calls.some(c => c.body && !c.body.preCheck), false);
  }
});
test('natural worker restart preserves user settings but never stores raw cookie', async () => {
  const h = harness(); const job = await h.job();
  const fresh = h.make();
  assert.equal((await fresh.inspect(job)).templateId, job.templateId);
  assert.equal((await fresh.preflight(job, h.recipient)).ok, true);
  assert.equal((await (await fresh.prepareSend(job, h.recipient))()).status, 'succeeded');
  assert.equal(JSON.stringify(h.disk).includes('synthetic-private-session'), false);
});
test('top-level success cannot hide nested platform refusal', async () => {
  for (const sendResult of [
    { code: 0, baseResp: { errCode: 17 } },
    { code: 0, data: { response: { baseResp: { errCode: 17, errmsg: 'denied' } } } },
    { code: 0, data: { base_resp: { ret: 17 } } },
  ]) {
    const h = harness({ sendResult }); const job = await h.job();
    await h.client.preflight(job, h.recipient);
    const result = await (await h.client.prepareSend(job, h.recipient))();
    assert.equal(result.status, 'failed'); assert.equal(result.code, 17);
  }
});
test('send interruption is unknown and does not retry', async () => {
  const h = harness({ rejectSend: true }); const job = await h.job();
  await h.client.preflight(job, h.recipient);
  const send = await h.client.prepareSend(job, h.recipient);
  assert.equal((await send()).status, 'unknown');
  assert.equal((await send()).notSubmitted, true);
  assert.equal(h.calls.filter(c => c.body && !c.body.preCheck).length, 1);
});

test('code zero with contradictory error text cannot become success', async () => {
  const h = harness({ sendResult: { code: 0, baseResp: { errmsg: 'denied' } } });
  const job = await h.job(); await h.client.preflight(job, h.recipient);
  assert.equal((await (await h.client.prepareSend(job, h.recipient))()).status, 'unknown');
});

test('request diagnostics classify non-2xx, timeout, and invalid JSON with bounded HTTP status', async () => {
  const http = harness({ httpStatus: 503 });
  await assert.rejects(http.client.options(7, http.recipient));
  const httpEvent = http.diagnostics.find(e => e.source === 'weixin' && e.code === 'HTTP_ERROR');
  assert.equal(httpEvent.context.httpStatus, 503);
  assert.equal(httpEvent.operation, 'weixin.products');

  const timeout = harness({ timeoutMs: 5, fetchImpl: async () => new Promise(() => {}) });
  await assert.rejects(timeout.client.options(7, timeout.recipient));
  assert.equal(timeout.diagnostics.some(e => e.code === 'TIMEOUT' && e.context.outcome === 'UNKNOWN'), true);

  const bodyTimeout = harness({ timeoutMs: 5, fetchImpl: async () => ({ ok: true, status: 202, text: () => new Promise(() => {}) }) });
  await assert.rejects(bodyTimeout.client.options(7, bodyTimeout.recipient));
  assert.equal(bodyTimeout.diagnostics.find(e => e.code === 'TIMEOUT').context.httpStatus, 202);

  const invalid = harness({ responseText: '{bad json', httpStatus: 200 });
  await assert.rejects(invalid.client.options(7, invalid.recipient));
  const jsonEvent = invalid.diagnostics.find(e => e.code === 'INVALID_JSON');
  assert.equal(jsonEvent.context.httpStatus, 200);
  assert.equal(jsonEvent.context.phase, 'PARSE');
  assert.equal(JSON.stringify(http.diagnostics).includes('biz_magic'), false);
  assert.equal(JSON.stringify(http.diagnostics).includes('creator-A'), false);
});

test('precheck and send emit start and result events while logger failures remain isolated', async () => {
  for (const diagnosticFailure of [undefined, 'throw', 'reject']) {
    const h = harness({ diagnosticFailure }); const job = await h.job();
    assert.equal((await h.client.preflight(job, h.recipient)).ok, true);
    const send = await h.client.prepareSend(job, h.recipient);
    assert.equal((await send()).status, 'succeeded');
    if (!diagnosticFailure) {
      assert.equal(h.diagnostics.some(e => e.operation === 'weixin.precheck' && e.code === 'STARTED'), true);
      assert.equal(h.diagnostics.some(e => e.operation === 'weixin.precheck' && e.code === 'SUCCEEDED'), true);
      assert.equal(h.diagnostics.some(e => e.operation === 'weixin.send' && e.code === 'STARTED'), true);
      assert.equal(h.diagnostics.some(e => e.operation === 'weixin.send' && e.code === 'SUCCEEDED'), true);
    }
  }
});

test('client forwards structured send uncertainty without private request data', async () => {
  const h = harness({ rejectSend: true }); const job = await h.job();
  await h.client.preflight(job, h.recipient);
  const result = await (await h.client.prepareSend(job, h.recipient))();
  assert.equal(result.status, 'unknown');
  assert.equal(h.diagnostics.some(e => e.operation === 'weixin.send' && e.code === 'UNKNOWN'), true);
  const diagnosticText = JSON.stringify(h.diagnostics);
  assert.equal(diagnosticText.includes('creator-A'), false);
  assert.equal(diagnosticText.includes('synthetic-private-session'), false);
  assert.equal(diagnosticText.includes('/shop-faas/'), false);
});
