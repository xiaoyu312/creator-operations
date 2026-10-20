import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { executeInvitePage } from '../lib/invite-page.mjs';

const SESSION_KEY = 'daboInviteSession_0123456789abcdef012345';
const CAPABILITY = 'a'.repeat(64);
const DOYIN_SEND_PATH = '/connection/pc/im/invite/card/send';
const DOYIN_STATUS_PATH = '/connection/pc/im/chat/batch/status';
const WEIXIN_SEND_PATH = '/shop-faas/mmchannelstradeleague/finderSquare/cgi/createPromotionInvitation';

function jsonResponse(payload, status = 200) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return {
    ok: status >= 200 && status < 300,
    status,
    clone() {
      let read = false;
      return {
        body: {
          getReader() {
            return {
              read: async () => {
                if (read) return { done: true };
                read = true;
                return { done: false, value: bytes };
              },
              cancel: async () => {},
            };
          },
        },
      };
    },
  };
}

function createWorld({ platform, responder, now = Date.now(), withXhr = false }) {
  const hostname = platform === 'douyin' ? 'buyin.jinritemai.com' : 'store.weixin.qq.com';
  const location = {
    href: `https://${hostname}/workbench?ewid=private-session`,
    origin: `https://${hostname}`,
    hostname,
    pathname: '/workbench',
  };
  const calls = [];
  const timers = new Map();
  const listeners = new Map();
  let nextTimerId = 1;
  let clock = now;
  const FakeDate = class extends Date {
    static now() { return clock; }
  };
  const setTimeoutMock = (callback, delay) => {
    const id = nextTimerId++;
    timers.set(id, { callback, delay, cleared: false });
    return id;
  };
  const clearTimeoutMock = (id) => {
    const timer = timers.get(id);
    if (timer) timer.cleared = true;
  };
  const setLocation = (value) => {
    const next = new URL(value, location.href);
    location.href = next.href;
    location.origin = next.origin;
    location.hostname = next.hostname;
    location.pathname = next.pathname;
  };
  const history = {
    pushState(_state, _title, value) { setLocation(value); return 'push-result'; },
    replaceState(_state, _title, value) { setLocation(value); return 'replace-result'; },
  };
  const nativeFetch = async (url, init = {}) => {
    const record = { url: String(url), init: { ...init } };
    calls.push(record);
    return responder(record.url, record.init, calls.length);
  };
  class FakeXHR {
    constructor() { this.headers = Object.create(null); this.status = 200; this.responseType = ''; this.responseText = ''; }
    addEventListener(name, listener) { if (name === 'load') this.loadListener = listener; }
    open(method, url) { this.method = method; this.url = url; return 'open-result'; }
    setRequestHeader(name, value) { this.headers[name] = value; }
    send(body) {
      this.body = body;
      this.responseText = JSON.stringify(this.mockResponse || { code: 0 });
      this.loadListener.call(this);
      return 'send-result';
    }
  }
  const contextValues = {
    URL,
    TextDecoder,
    TextEncoder,
    AbortController,
    Date: FakeDate,
    location,
    history,
    fetch: nativeFetch,
    crypto: { getRandomValues(bytes) { for (let index = 0; index < bytes.length; index += 1) bytes[index] = index + 1; return bytes; } },
    setTimeout: setTimeoutMock,
    clearTimeout: clearTimeoutMock,
    addEventListener: (name, listener) => {
      const list = listeners.get(name) || [];
      list.push(listener);
      listeners.set(name, list);
    },
  };
  if (withXhr) contextValues.XMLHttpRequest = FakeXHR;
  const context = vm.createContext(contextValues);
  const execute = vm.runInContext(`(${executeInvitePage.toString()})`, context, { filename: 'executeInvitePage' });
  const invoke = (operation, args = {}) => {
    const json = JSON.stringify(args);
    const vmArgs = vm.runInContext(`JSON.parse(${JSON.stringify(json)})`, context);
    return execute(operation, vmArgs);
  };
  const fireTimer = (delay) => {
    const match = [...timers.entries()].find(([, timer]) => !timer.cleared && timer.delay === delay);
    if (!match) return false;
    match[1].cleared = true;
    match[1].callback();
    return true;
  };
  const setNow = (value) => { clock = value; };
  return { context, calls, timers, listeners, invoke, fireTimer, setNow, location };
}

async function flushTasks() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function credentials() {
  return { sessionKey: SESSION_KEY, capability: CAPABILITY };
}

function douyinTemplate(accountId = 'ref_account') {
  return {
    account_id: accountId,
    account_type: 1,
    contact_info: { phone: '13912345678', wechat: 'merchantwx' },
    entry_point: 2,
    invite_card: {
      rights: [{ right: '平台官方保障' }],
      product_ids: ['spu_dy_1'],
      product_setting: [{ product_id: 'spu_dy_1', author_sample_status: 0 }],
      content: '新品合作邀约',
      card_version: 1,
      categories: [{ id: 'beauty' }],
    },
    event_param: { client_form: 'pc', web_did: 'native-web-secret', seraph_did: 'native-seraph-secret', x_pigeon_did: '' },
  };
}

function weixinTemplate(finderUsername = 'ref_finder', talentAppid = 'ref_app') {
  return {
    finderUsername,
    talentAppid,
    itemList: { itemInfo: [{ spuId: 'spu_wx_1' }] },
    contactInfo: {
      contactName: '商务联系人',
      contactWxId: 'merchant_wechat',
      contactPhoneNumber: '13800138000',
      invitationIntroduction: '视频号精选合作邀请',
      inviteScene: '1',
    },
  };
}

async function installAndCalibrate(world, platform, body, url, response) {
  const installed = await world.invoke('install', credentials());
  assert.equal(installed.ready, false);
  assert.ok(installed.reason.includes('先连接') || installed.reason.includes('未校准'));
  const result = await world.context.fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'must-not-be-read-or-forwarded',
      Cookie: 'must-not-be-read-or-forwarded',
      ...(platform === 'weixin' ? { biz_magic: 'wx-session-header-secret' } : {}),
    },
    body: JSON.stringify(body),
    credentials: 'include',
  });
  assert.equal(result.ok, true);
  await flushTasks();
  return world.invoke('inspect', credentials());
}

test('MAIN runtime requires a capability and its public object cannot be replaced', async () => {
  const world = createWorld({ platform: 'douyin', responder: async () => jsonResponse({ code: 0 }) });
  const missing = await world.invoke('inspect', credentials());
  assert.equal(missing.ready, false);
  assert.equal(missing.missing, true);
  const first = await world.invoke('install', credentials());
  assert.equal(first.ready, false);
  assert.equal(first.missing, false);
  assert.equal(world.context[SESSION_KEY] !== undefined, true);
  const runtime = world.context[SESSION_KEY];
  assert.equal(Object.isFrozen(runtime), true);
  assert.deepEqual(Object.keys(runtime).sort(), ['inspect', 'preflight', 'send']);
  const descriptor = vm.runInContext(`Object.getOwnPropertyDescriptor(globalThis, ${JSON.stringify(SESSION_KEY)})`, world.context);
  assert.equal(descriptor.writable, false);
  assert.equal(descriptor.configurable, false);
  assert.equal(descriptor.get, undefined);

  const directInspect = await runtime.inspect();
  const directSend = await runtime.send({ templateId: 'fake', recipient: {} });
  assert.equal(directInspect.ready, false);
  assert.equal(directInspect.reason, '页面权限无效，请重新读取邀约配置。');
  assert.equal(directSend.status, 'failed');
  assert.equal(directSend.notSubmitted, true);
  assert.equal(world.calls.length, 0);

  const forged = await world.invoke('send', {
    ...credentials(), templateId: 'fake', recipient: { platform: 'douyin', externalId: 'target', accountId: 'target' },
  });
  assert.equal(forged.status, 'failed');
  assert.equal(world.calls.length, 0);
  assert.equal(world.listeners.has('message'), false);

  const before = world.context[SESSION_KEY];
  try { Object.defineProperty(world.context, SESSION_KEY, { value: { send: () => ({ status: 'succeeded' }) } }); } catch (_) {}
  assert.equal(world.context[SESSION_KEY], before);
});

test('only exact POST endpoint responses with explicit success calibrate a safe, masked template', async () => {
  const world = createWorld({
    platform: 'douyin',
    responder: async (_url, init) => {
      const body = init.body ? JSON.parse(init.body) : {};
      if (body.account_id === 'ref-bad-code') return jsonResponse({ code: 3, msg: 'failure' });
      if (body.account_id === 'ref-conflict') return jsonResponse({ code: 0, data: { response: { baseResp: { errCode: 9, errmsg: 'denied' } } } });
      return jsonResponse({ code: 0, data: {}, baseResp: { errCode: 0, errmsg: 'ok' } });
    },
  });
  await world.invoke('install', credentials());
  const base = 'https://buyin.jinritemai.com';
  const body = douyinTemplate();
  const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  await world.context.fetch(`${base}${DOYIN_SEND_PATH}?ewid=native-session-secret`, { ...init, method: 'GET' });
  await world.context.fetch(`https://buyin.jinritemai.com.evil.test${DOYIN_SEND_PATH}`, init);
  await world.context.fetch(`${base}/connection/pc/im/invite/card/other`, init);
  await world.context.fetch(`${base}${DOYIN_SEND_PATH}`, { ...init, body: JSON.stringify(douyinTemplate('ref-bad-code')) });
  await world.context.fetch(`${base}${DOYIN_SEND_PATH}`, { ...init, body: JSON.stringify(douyinTemplate('ref-conflict')) });
  await flushTasks();
  assert.equal((await world.invoke('inspect', credentials())).ready, false);

  await world.context.fetch(`${base}${DOYIN_SEND_PATH}?ewid=native-session-secret`, init);
  await flushTasks();
  const inspected = await world.invoke('inspect', credentials());
  assert.equal(inspected.ready, true);
  assert.equal(inspected.platform, 'douyin');
  assert.ok(inspected.templateId.startsWith('invite-'));
  assert.equal(inspected.referenceRecipientId, 'ref_account');
  assert.deepEqual(Array.from(inspected.summary.productIds), ['spu_dy_1']);
  assert.equal(inspected.summary.message, '新品合作邀约');
  assert.equal(inspected.summary.phoneMasked, '***5678');
  assert.equal(inspected.summary.wechatMasked, 'm***x');
  assert.equal(typeof inspected.summary.cardVersion, 'string');
  const exposed = JSON.stringify(inspected);
  for (const secret of ['native-session-secret', 'native-web-secret', 'native-seraph-secret', '13912345678', 'merchantwx']) {
    assert.equal(exposed.includes(secret), false);
  }
});

test('XHR manual calibration clones only the approved request headers and schema', async () => {
  const world = createWorld({
    platform: 'weixin',
    withXhr: true,
    responder: async () => jsonResponse({ code: 0 }),
  });
  await world.invoke('install', credentials());
  const xhr = new world.context.XMLHttpRequest();
  xhr.mockResponse = { code: 0, data: { response: { baseResp: { errCode: 0, errmsg: 'ok' } } } };
  const url = `https://store.weixin.qq.com${WEIXIN_SEND_PATH}?token=xhr-session-secret&lang=zh_CN`;
  assert.equal(xhr.open('POST', url), 'open-result');
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.setRequestHeader('biz_magic', 'xhr-biz-magic-secret');
  xhr.setRequestHeader('Authorization', 'xhr-auth-must-not-capture');
  xhr.setRequestHeader('Cookie', 'xhr-cookie-must-not-capture');
  assert.equal(xhr.send(JSON.stringify(weixinTemplate('xhr_reference', 'xhr_app'))), 'send-result');
  const inspected = await world.invoke('inspect', credentials());
  assert.equal(inspected.ready, true);
  assert.equal(inspected.referenceRecipientId, 'xhr_reference');
  const exposed = JSON.stringify(inspected);
  for (const secret of ['xhr-session-secret', 'xhr-biz-magic-secret', 'xhr-auth-must-not-capture', 'xhr-cookie-must-not-capture']) {
    assert.equal(exposed.includes(secret), false);
  }
});

test('Douyin preflight is read-only, checks the exact receiver, and sends the cloned template once', async () => {
  const world = createWorld({
    platform: 'douyin',
    responder: async (url, init) => {
      const parsed = new URL(url);
      if (parsed.pathname === DOYIN_STATUS_PATH) {
        return jsonResponse({ code: 0, data: [{ account_id: 'target_account', account_type: 1, status: 1 }] });
      }
      const body = init.body ? JSON.parse(init.body) : {};
      return jsonResponse({ code: 0, data: { account_id: body.account_id } });
    },
  });
  const source = 'https://buyin.jinritemai.com';
  const original = douyinTemplate();
  const inspected = await installAndCalibrate(world, 'douyin', original,
    `${source}${DOYIN_SEND_PATH}?ewid=private-ewid`, jsonResponse({ code: 0 }));
  assert.equal(inspected.ready, true);
  const templateId = inspected.templateId;
  const recipient = { id: 'douyin:target_uid', platform: 'douyin', name: '青禾', externalId: 'target_uid', accountId: 'target_account' };
  const callArgs = { ...credentials(), templateId, recipient };

  const prepared = await world.invoke('preflight', callArgs);
  assert.deepEqual(JSON.parse(JSON.stringify(prepared)), { ok: true });
  const beforeSend = world.calls.length;
  const preflightCall = world.calls.at(-1);
  assert.equal(new URL(preflightCall.url).pathname, DOYIN_STATUS_PATH);
  assert.equal(new URL(preflightCall.url).searchParams.get('ewid'), 'private-ewid');
  assert.deepEqual(JSON.parse(preflightCall.init.body), { receivers: [{ account_id: 'target_account', account_type: 1 }] });
  assert.equal(preflightCall.init.credentials, 'include');
  assert.deepEqual(Object.keys(preflightCall.init.headers), ['Content-Type']);
  assert.equal(world.calls.slice(1).some((call) => new URL(call.url).pathname === DOYIN_SEND_PATH), false);

  const result = await world.invoke('send', callArgs);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.code, 0);
  assert.equal(result.notSubmitted, undefined);
  const sendCall = world.calls.at(-1);
  assert.equal(new URL(sendCall.url).pathname, DOYIN_SEND_PATH);
  const sent = JSON.parse(sendCall.init.body);
  assert.equal(sent.account_id, 'target_account');
  assert.equal(sent.account_type, 1);
  sent.account_id = 'ref_account';
  assert.deepEqual(sent, original);
  assert.equal(world.calls.length, beforeSend + 1);

  const repeated = await world.invoke('send', callArgs);
  assert.equal(repeated.status, 'failed');
  assert.equal(world.calls.length, beforeSend + 1);
});

test('Weixin preserves contactInfo inviteScene, checks raw code-zero preflight, and replaces only recipient IDs', async () => {
  const world = createWorld({
    platform: 'weixin',
    responder: async (url, init) => {
      assert.equal(new URL(url).pathname, WEIXIN_SEND_PATH);
      const body = JSON.parse(init.body);
      if (body.preCheck === true) return jsonResponse({ code: 0, baseResp: { errCode: 0, errmsg: 'ok' }, data: {} });
      return jsonResponse({ code: 0, baseResp: { errCode: 0, errmsg: 'ok' } });
    },
  });
  const source = 'https://store.weixin.qq.com';
  const original = weixinTemplate();
  const inspected = await installAndCalibrate(world, 'weixin', original,
    `${source}${WEIXIN_SEND_PATH}?token=private-query-session&lang=zh_CN`, jsonResponse({ code: 0 }));
  assert.equal(inspected.ready, true);
  assert.equal(inspected.summary.message, '视频号精选合作邀请');
  assert.deepEqual(Array.from(inspected.summary.productIds), ['spu_wx_1']);
  assert.equal(inspected.summary.contactName, '商务联系人');
  assert.equal(inspected.summary.phoneMasked, '***8000');
  assert.equal(inspected.summary.wechatMasked, 'm***t');
  const visible = JSON.stringify(inspected);
  for (const secret of ['private-query-session', 'wx-session-header-secret', 'merchant_wechat', '13800138000']) {
    assert.equal(visible.includes(secret), false);
  }

  const recipient = { id: 'weixin:target_finder', platform: 'weixin', name: '木棉', externalId: 'target_finder', talentAppid: 'target_app' };
  const args = { ...credentials(), templateId: inspected.templateId, recipient };
  const preflight = await world.invoke('preflight', args);
  assert.deepEqual(JSON.parse(JSON.stringify(preflight)), { ok: true });
  const preflightCall = world.calls.at(-1);
  const checkBody = JSON.parse(preflightCall.init.body);
  assert.deepEqual(checkBody, {
    finderUsername: 'target_finder', inviteScene: 0, preCheck: true, talentAppid: 'target_app',
  });
  assert.equal(preflightCall.init.headers['Content-Type'], 'application/json');
  assert.equal(preflightCall.init.headers.biz_magic, 'wx-session-header-secret');
  assert.equal(preflightCall.init.headers.Authorization, undefined);
  assert.equal(preflightCall.init.headers.Cookie, undefined);

  const sentResult = await world.invoke('send', args);
  assert.equal(sentResult.status, 'succeeded');
  assert.equal(sentResult.code, 0);
  const sendCall = world.calls.at(-1);
  const sentBody = JSON.parse(sendCall.init.body);
  assert.equal(sentBody.finderUsername, 'target_finder');
  assert.equal(sentBody.talentAppid, 'target_app');
  sentBody.finderUsername = 'ref_finder';
  sentBody.talentAppid = 'ref_app';
  assert.deepEqual(sentBody, original);
  assert.equal(sendCall.init.headers.biz_magic, 'wx-session-header-secret');
  assert.equal(sendCall.init.headers.Authorization, undefined);
  assert.equal(sendCall.init.headers.Cookie, undefined);
});

test('Weixin preflight rejects explicit identity mismatch and marks only explicit platform denials', async () => {
  let mode = 'mismatch';
  const world = createWorld({
    platform: 'weixin',
    responder: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.preCheck) {
        if (mode === 'mismatch') return jsonResponse({ code: 0, data: { finderUsername: 'different_finder' } });
        if (mode === 'denied') return jsonResponse({ code: 17, message: 'denied' });
        return jsonResponse({ code: 0, data: {} });
      }
      return jsonResponse({ code: 0 });
    },
  });
  const inspected = await installAndCalibrate(world, 'weixin', weixinTemplate(),
    `https://store.weixin.qq.com${WEIXIN_SEND_PATH}?lang=zh_CN`, jsonResponse({ code: 0 }));
  const args = {
    ...credentials(), templateId: inspected.templateId,
    recipient: { id: 'weixin:target', platform: 'weixin', externalId: 'target', talentAppid: 'target_app' },
  };
  let result = await world.invoke('preflight', args);
  assert.equal(result.ok, false);
  assert.equal(result.platformRejected, undefined);

  mode = 'denied';
  result = await world.invoke('preflight', args);
  assert.equal(result.ok, false);
  assert.equal(result.platformRejected, true);
  assert.equal(result.code, 17);

  mode = 'success';
  result = await world.invoke('preflight', args);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: true });
});

test('post-preflight template expiry returns notSubmitted and performs no native request', async () => {
  const start = Date.UTC(2026, 9, 16, 8, 0, 0);
  const world = createWorld({
    platform: 'douyin',
    now: start,
    responder: async (url) => new URL(url).pathname === DOYIN_STATUS_PATH
      ? jsonResponse({ code: 0, data: [{ account_id: 'target_account', account_type: 1, status: 1 }] })
      : jsonResponse({ code: 0 }),
  });
  const inspected = await installAndCalibrate(world, 'douyin', douyinTemplate(),
    `https://buyin.jinritemai.com${DOYIN_SEND_PATH}?ewid=session`, jsonResponse({ code: 0 }));
  const args = {
    ...credentials(), templateId: inspected.templateId,
    recipient: { id: 'douyin:target', platform: 'douyin', externalId: 'target', accountId: 'target_account' },
  };
  assert.deepEqual(JSON.parse(JSON.stringify(await world.invoke('preflight', args))), { ok: true });
  const beforeExpirySend = world.calls.length;
  world.setNow(start + 16 * 60 * 1000);
  const result = await world.invoke('send', args);
  assert.equal(result.status, 'failed');
  assert.equal(result.notSubmitted, true);
  assert.equal(result.platformRejected, undefined);
  assert.equal(world.calls.length, beforeExpirySend);
});

test('a confirmed send denial is failed and marked as a platform rejection', async () => {
  const world = createWorld({
    platform: 'douyin',
    responder: async (url, init) => {
      const path = new URL(url).pathname;
      if (path === DOYIN_STATUS_PATH) return jsonResponse({ code: 0, data: [{ account_id: 'target_account', status: 1 }] });
      const body = init.body ? JSON.parse(init.body) : {};
      return body.account_id === 'target_account' ? jsonResponse({ code: 11, msg: 'denied' }) : jsonResponse({ code: 0 });
    },
  });
  const inspected = await installAndCalibrate(world, 'douyin', douyinTemplate(),
    `https://buyin.jinritemai.com${DOYIN_SEND_PATH}`, jsonResponse({ code: 0 }));
  const args = {
    ...credentials(), templateId: inspected.templateId,
    recipient: { id: 'douyin:target', platform: 'douyin', externalId: 'target', accountId: 'target_account' },
  };
  await world.invoke('preflight', args);
  const result = await world.invoke('send', args);
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 11);
  assert.equal(result.platformRejected, true);
  assert.equal(result.notSubmitted, undefined);
});

test('network timeout yields unknown once, never retries, and navigation invalidates calibration', async () => {
  let waitOnSend = false;
  const world = createWorld({
    platform: 'douyin',
    responder: async (url, init) => {
      const path = new URL(url).pathname;
      if (path === DOYIN_STATUS_PATH) return jsonResponse({ code: 0, data: [{ account_id: 'target_account', status: 1 }] });
      if (path === DOYIN_SEND_PATH && waitOnSend && JSON.parse(init.body).account_id === 'target_account') return new Promise(() => {});
      return jsonResponse({ code: 0 });
    },
  });
  const inspected = await installAndCalibrate(world, 'douyin', douyinTemplate(),
    `https://buyin.jinritemai.com${DOYIN_SEND_PATH}?ewid=session`, jsonResponse({ code: 0 }));
  const args = {
    ...credentials(), templateId: inspected.templateId,
    recipient: { id: 'douyin:target', platform: 'douyin', externalId: 'target', accountId: 'target_account' },
  };
  assert.deepEqual(JSON.parse(JSON.stringify(await world.invoke('preflight', args))), { ok: true });
  waitOnSend = true;
  const sending = world.invoke('send', args);
  await flushTasks();
  assert.equal(world.fireTimer(15 * 1000), true);
  const outcome = await sending;
  assert.equal(outcome.status, 'unknown');
  assert.equal(outcome.notSubmitted, undefined);
  assert.match(outcome.message, /不会自动重试/);
  const targetSendCalls = world.calls.filter((call) => new URL(call.url).pathname === DOYIN_SEND_PATH
    && JSON.parse(call.init.body).account_id === 'target_account');
  assert.equal(targetSendCalls.length, 1);

  world.context.history.pushState({}, '', '?shop=another-account');
  const afterRoute = await world.invoke('inspect', credentials());
  assert.equal(afterRoute.ready, false);
});

test('expiry is 15 minutes and hash navigation clears the tab memory template', async () => {
  const start = Date.UTC(2026, 9, 16, 8, 0, 0);
  const world = createWorld({ platform: 'douyin', now: start, responder: async () => jsonResponse({ code: 0 }) });
  const inspected = await installAndCalibrate(world, 'douyin', douyinTemplate(),
    `https://buyin.jinritemai.com${DOYIN_SEND_PATH}?ewid=private`, jsonResponse({ code: 0 }));
  const expiresAt = Date.parse(inspected.expiresAt);
  assert.equal(expiresAt - start, 15 * 60 * 1000);
  world.context.history.pushState({}, '', '#another-view');
  assert.equal((await world.invoke('inspect', credentials())).ready, false);
});
