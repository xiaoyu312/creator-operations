import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

const directory = new URL('../', import.meta.url);
const adaptersSource = await readFile(new URL('adapters.js', directory), 'utf8');

function loadAdapters(location = 'https://buyin.jinritemai.com/') {
  const context = vm.createContext({ URL, location: { href: location } });
  vm.runInContext(adaptersSource, context, { filename: 'adapters.js' });
  return context.DaboAdapters;
}

test('platform and API scope stays on four explicit hosts and accepts query parameters', () => {
  const adapters = loadAdapters();
  const urls = [
    ['douyin', 'https://buyin.jinritemai.com/api/authorStatData/authorListRec?limit=20'],
    ['kuaishou', 'https://cps.kwaixiaodian.com/distribute/pc/seller/promoter/list?page=1'],
    ['xiaohongshu', 'https://pgy.xiaohongshu.com/api/solar/cooperator/blogger/v2?keyword=skin'],
    ['weixin', 'https://channels.weixin.qq.com/api/getSquareFinderList?finderUsername=finder_1'],
    ['weixin', 'https://store.weixin.qq.com/shop-faas/mmchannelstradeleague/finderSquare/cgi/getSquareFinderList?limit=20'],
  ];
  for (const [platform, url] of urls) {
    assert.equal(adapters.detectPlatform(url), platform);
    assert.equal(adapters.isCaptureUrl(url, platform), true);
  }
  assert.equal(adapters.detectPlatform('https://creator.douyin.com/'), '');
  assert.equal(adapters.detectPlatform('https://other.weixin.qq.com/'), '');
  assert.equal(adapters.isCaptureUrl('https://evil.example/api/authorStatData/authorListRec?limit=20', 'douyin'), false);
  assert.equal(adapters.isCaptureUrl('http://buyin.jinritemai.com/api/authorStatData/authorListRec', 'douyin'), false);
});

test('Weixin list and detail extraction only accepts response IDs and keeps safe finder ID links', () => {
  const adapters = loadAdapters('https://channels.weixin.qq.com/shop/findersquare');
  const sourceUrl = 'https://channels.weixin.qq.com/shop/findersquare?finderUsername=finder_1&token=private';
  const apiUrl = 'https://channels.weixin.qq.com/api/getSquareFinderList?page=1&token=private';
  const found = adapters.extractCandidates('weixin', {
    response: {
      finderList: [{
        finderUsername: 'finder_1',
        finderNickname: '青禾',
        finderInfo: { anchor_name: '青禾账号', fans_num_text: '1.2万粉丝', talentAppid: 'wx_app_1' },
      }],
    },
  }, sourceUrl, { apiUrl, requestId: 'wrong_request_id' });
  assert.equal(found.length, 1);
  assert.equal(found[0].externalId, 'finder_1');
  assert.equal(found[0].name, '青禾');
  assert.equal(found[0].followers, 12000);
  assert.equal(found[0].platformData.talentAppid, 'wx_app_1');
  assert.equal(found[0].profileUrl, '');
  assert.equal(found[0].sourceUrl, 'https://channels.weixin.qq.com/shop/findersquare?finderUsername=finder_1');

  const infoUrl = 'https://channels.weixin.qq.com/api/getFinderInfo';
  assert.equal(adapters.extractCandidates('weixin', {
    response: { finderUsername: 'different_id', finderInfo: { anchor_name: '错配详情' } },
  }, sourceUrl, { apiUrl: infoUrl, requestId: 'finder_1' }).length, 0);
});

test('Xiaohongshu uses internal creator IDs and refuses mismatched contact detail IDs', () => {
  const adapters = loadAdapters('https://pgy.xiaohongshu.com/solar/pre-trade/kol');
  const sourceUrl = 'https://pgy.xiaohongshu.com/solar/pre-trade/kol';
  const listUrl = 'https://pgy.xiaohongshu.com/api/solar/cooperator/blogger/v2?keyword=beauty';
  const list = adapters.extractCandidates('xiaohongshu', {
    data: { kols: [{ userId: 'internal_123', redId: 'red_456', name: '小禾', fans: '2.3万' }] },
  }, sourceUrl, { apiUrl: listUrl, requestId: 'should_not_replace_list_id' });
  assert.equal(list.length, 1);
  assert.equal(list[0].externalId, 'internal_123');
  assert.equal(list[0].followers, 23000);

  const contactUrl = 'https://pgy.xiaohongshu.com/api/draco/selection-center/contact/info/query?trace=opaque';
  const contact = adapters.extractCandidates('xiaohongshu', {
    data: { userId: 'internal_123', redId: 'red_456', contact_info: { phone: '13800000000', wechat: '', email: '' } },
  }, sourceUrl, { apiUrl: contactUrl, requestId: 'red_456', requestIdField: 'red_id' });
  assert.equal(contact.length, 1);
  assert.equal(contact[0].externalId, 'internal_123');
  assert.equal(contact[0].contact.phone, '13800000000');
  assert.equal(adapters.extractCandidates('xiaohongshu', {
    data: { buyer_id: 'another_buyer', contact_info: { phone: '13900000000' } },
  }, sourceUrl, { apiUrl: contactUrl, requestId: 'internal_123', requestIdField: 'buyer_id' }).length, 0);
});

test('Douyin IDs are preserved without inventing a profile route or retaining query secrets', () => {
  const adapters = loadAdapters('https://buyin.jinritemai.com/dashboard');
  const sourceUrl = 'https://buyin.jinritemai.com/dashboard?token=secret';
  const apiUrl = 'https://buyin.jinritemai.com/square_pc_api/square/search_feed_author?cursor=4';
  const found = adapters.extractCandidates('douyin', {
    data: { list: [{ author_data: { author_base: {
      sec_author_id: 'sec_user_7', nickname: '山茶', follower_count: '8.5万',
      profile_url: 'https://www.douyin.com/user/sec_user_7?token=secret&source=private',
    } } }] },
  }, sourceUrl, { apiUrl });
  assert.equal(found.length, 1);
  assert.equal(found[0].externalId, 'sec_user_7');
  assert.equal(found[0].profileUrl, 'https://www.douyin.com/user/sec_user_7');
  assert.equal(found[0].sourceUrl, 'https://buyin.jinritemai.com/dashboard');

  const platformMetadata = adapters.extractCandidates('douyin', {
    data: { list: [{ author_base: { uid: 'dy_uid_7', account_id: 'dy_account_7', nickname: '山茶' } }] },
  }, sourceUrl, { apiUrl });
  assert.equal(platformMetadata[0].externalId, 'dy_uid_7');
  assert.equal(platformMetadata[0].platformData.accountId, 'dy_account_7');

  const withoutProfile = adapters.extractCandidates('douyin', {
    data: { list: [{ author_base: { uid: 'numeric_string_7', nickname: '山茶' } }] },
  }, sourceUrl, { apiUrl });
  assert.equal(withoutProfile[0].profileUrl, '');
  assert.equal(withoutProfile[0].platformData.accountId, 'numeric_string_7');
  assert.equal(adapters.extractCandidates('douyin', {
    data: { list: [{ author_base: { uid: Number.MAX_SAFE_INTEGER + 1, nickname: '无效' } }] },
  }, sourceUrl, { apiUrl }).length, 0);
});

test('Douyin searchAccount preserves the native search identity independently of accountId', () => {
  const adapters = loadAdapters('https://buyin.jinritemai.com/dashboard');
  const apiUrl = 'https://buyin.jinritemai.com/square_pc_api/square/search_feed_author?cursor=1';
  const sourceUrl = 'https://buyin.jinritemai.com/dashboard';
  const found = adapters.extractCandidates('douyin', {
    data: { list: [{ author_base: {
      uid: 'creator_uid_1', account_id: 'account_id_1', aweme_id: 'aweme_search_1',
      account_douyin: 'account_search_1', unique_id: 'unique_search_1', nickname: '白露',
    } }] },
  }, sourceUrl, { apiUrl });
  assert.equal(found.length, 1);
  assert.equal(found[0].externalId, 'creator_uid_1');
  assert.deepEqual({ ...found[0].platformData }, {
    accountId: 'account_id_1', talentAppid: '', searchAccount: 'aweme_search_1',
  });

  const fallback = adapters.extractCandidates('douyin', {
    data: { list: [{ author_base: {
      uid: 'creator_uid_2', account_douyin: 'account_search_2', unique_id: 'unique_search_2', nickname: '小满',
    } }] },
  }, sourceUrl, { apiUrl });
  assert.equal(fallback[0].platformData.searchAccount, 'account_search_2');
});

test('Kuaishou and Xiaohongshu buyer fixtures map only approved fields', () => {
  const adapters = loadAdapters('https://cps.kwaixiaodian.com/distribute/pc/seller/promoter');
  const ks = adapters.extractCandidates('kuaishou', {
    data: { promoterList: [{ promoterId: 'ks_42', promoterNickName: '南风', fanNum: 9876, phone: 'must-not-capture' }] },
  }, 'https://cps.kwaixiaodian.com/distribute/pc/seller/promoter', {
    apiUrl: 'https://cps.kwaixiaodian.com/distribute/pc/seller/promoter/list?page=1',
  });
  assert.equal(ks.length, 1);
  assert.equal(ks[0].externalId, 'ks_42');
  assert.equal(ks[0].followers, 9876);
  assert.equal(ks[0].contact.phone, '');

  const xhs = adapters.extractCandidates('xiaohongshu', {
    data: { distributor_info_list: [{ distributor_data_info: {
      distributor_id: 'xhs_internal', red_id: 'xhs_red', name: '木棉', fans_num: '3万', email: 'ignored',
    } }] },
  }, 'https://pgy.xiaohongshu.com/microapp/distribution/live/buyers', {
    apiUrl: 'https://pgy.xiaohongshu.com/api/draco/distributor-square/live/buyers?page=1',
  });
  assert.equal(xhs.length, 1);
  assert.equal(xhs[0].externalId, 'xhs_internal');
  assert.equal(xhs[0].name, '木棉');
  assert.equal(xhs[0].followers, 30000);
  assert.equal(xhs[0].contact.email, '');
});

test('merge preserves rich contacts when a later capture has blank contact fields', () => {
  const adapters = loadAdapters('https://buyin.jinritemai.com/');
  const existing = [{
    platform: 'douyin', externalId: 'creator_1', name: '阿宁',
    profileUrl: 'https://www.douyin.com/user/creator_1',
    followers: 5000, category: '', contact: { phone: '13800000000', wechat: 'an-creator', email: '' },
    platformData: { accountId: 'dy_account_saved', talentAppid: '', searchAccount: 'dy_search_saved' },
    sourceUrl: 'https://buyin.jinritemai.com/dashboard',
  }];
  const incoming = [{
    platform: 'douyin', externalId: 'creator_1', name: '', profileUrl: '',
    followers: null, category: '', contact: { phone: '', wechat: '', email: '' },
    platformData: { accountId: '', talentAppid: '', searchAccount: '' },
    sourceUrl: 'https://buyin.jinritemai.com/dashboard',
  }];
  const merged = adapters.mergeCandidates(existing, incoming);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].name, '阿宁');
  assert.equal(merged[0].contact.phone, '13800000000');
  assert.equal(merged[0].contact.wechat, 'an-creator');
  assert.equal(merged[0].profileUrl, 'https://www.douyin.com/user/creator_1');
  assert.equal(merged[0].platformData.accountId, 'dy_account_saved');
  assert.equal(merged[0].platformData.searchAccount, 'dy_search_saved');
  assert.equal(adapters.sanitizeCandidate({ ...existing[0], externalId: 'bad:id' }), null);
});

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.className = '';
    this.textContent = '';
    this.isConnected = true;
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] || null; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
  attachShadow() { this.shadow = new FakeShadowRoot(); return this.shadow; }
  click() { for (const fn of this.listeners.click || []) fn({ isTrusted: false, target: this }); }
  trustedClick() { for (const fn of this.listeners.click || []) fn({ isTrusted: true, target: this }); }
  querySelector(selector) {
    const classes = selector.split('.').filter(Boolean);
    const matches = (item) => classes.every((name) => String(item.className || '').split(/\s+/).includes(name));
    const visit = (item) => {
      for (const child of item.children || []) {
        if (matches(child)) return child;
        const nested = visit(child);
        if (nested) return nested;
      }
      return null;
    };
    return visit(this);
  }
}

class FakeShadowRoot extends FakeElement {}

test('synthetic page click cannot write captured candidates to local storage', async () => {
  const contentSource = await readFile(new URL('../content.js', import.meta.url), 'utf8');
  const eventListeners = new Map();
  const runtimeListeners = [];
  const sent = [];
  const documentElement = new FakeElement('html');
  const document = {
    documentElement,
    createElement: (tag) => new FakeElement(tag),
    getElementById: (id) => documentElement.children.find((child) => child.id === id) || null,
    querySelectorAll: () => [],
    addEventListener() {},
  };
  const location = new URL('https://buyin.jinritemai.com/dashboard?token=page-secret');
  const chrome = {
    runtime: {
      onMessage: { addListener: (listener) => runtimeListeners.push(listener) },
      sendMessage: async (message) => {
        sent.push(message);
        if (message.type === 'GET_STATE') return { ok: true, state: { version: 1, creators: [] } };
        return { ok: true, state: { version: 1, creators: message.creators || [] } };
      },
    },
  };
  const context = vm.createContext({
    URL,
    Map,
    Set,
    Promise,
    Intl,
    location,
    document,
    chrome,
    setTimeout: () => 1,
    clearTimeout() {},
    addEventListener: (type, listener) => {
      const listeners = eventListeners.get(type) || [];
      listeners.push(listener);
      eventListeners.set(type, listeners);
    },
    postMessage() {},
  });
  context.DaboAdapters = loadAdapters(location.href);
  vm.runInContext(contentSource, context, { filename: 'content.js' });
  const windowObject = vm.runInContext('globalThis', context);
  const root = documentElement.children.find((child) => child.id === 'dabo-creator-assistant-panel').shadow;
  for (const listener of eventListeners.get('message') || []) {
    listener({
      source: windowObject,
      origin: location.origin,
      data: {
        channel: 'dabo-creator-assistant', version: 1, type: 'CAPTURE_RESPONSE', platform: 'douyin',
        candidates: [{ platform: 'douyin', externalId: 'dy_007', name: '合成候选', followers: 1234,
          sourceUrl: location.href, profileUrl: 'https://buyin.jinritemai.com/dashboard?token=fake' }],
      },
    });
  }
  const save = root.querySelector('.action.primary');
  assert.ok(save);
  const findByText = (node, text) => {
    if (node.textContent === text) return node;
    for (const child of node.children || []) {
      const match = findByText(child, text);
      if (match) return match;
    }
    return null;
  };
  const open = findByText(root, '打开工作台');
  assert.ok(open);
  save.click();
  open.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.some((message) => message.type === 'UPSERT_CREATORS'), false);
  assert.equal(sent.some((message) => message.type === 'OPEN_WORKBENCH'), false);

  save.trustedClick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.some((message) => message.type === 'UPSERT_CREATORS'), true);
  assert.equal(runtimeListeners.length, 1);
});

test('contact-only detail waits in memory until the same ID has a name', async () => {
  const contentSource = await readFile(new URL('../content.js', import.meta.url), 'utf8');
  const eventListeners = new Map();
  const runtimeListeners = [];
  const sent = [];
  const documentElement = new FakeElement('html');
  const document = {
    documentElement,
    createElement: (tag) => new FakeElement(tag),
    getElementById: (id) => documentElement.children.find((child) => child.id === id) || null,
    querySelectorAll: () => [],
    addEventListener() {},
  };
  const location = new URL('https://pgy.xiaohongshu.com/solar/pre-trade/kol');
  const chrome = {
    runtime: {
      onMessage: { addListener: (listener) => runtimeListeners.push(listener) },
      sendMessage: async (message) => {
        sent.push(message);
        return { ok: true, state: { version: 1, creators: [] } };
      },
    },
  };
  const context = vm.createContext({
    URL, Map, Set, Promise, Intl, location, document, chrome,
    setTimeout: () => 1, clearTimeout() {},
    addEventListener: (type, listener) => {
      const listeners = eventListeners.get(type) || [];
      listeners.push(listener);
      eventListeners.set(type, listeners);
    },
    postMessage() {},
  });
  context.DaboAdapters = loadAdapters(location.href);
  vm.runInContext(contentSource, context, { filename: 'content.js' });
  const windowObject = vm.runInContext('globalThis', context);
  const send = (candidate) => {
    for (const listener of eventListeners.get('message') || []) {
      listener({
        source: windowObject,
        origin: location.origin,
        data: { channel: 'dabo-creator-assistant', version: 1, type: 'CAPTURE_RESPONSE', platform: 'xiaohongshu', candidates: [candidate] },
      });
    }
  };
  await new Promise((resolve) => setImmediate(resolve));
  send({ platform: 'xiaohongshu', externalId: 'xhs_internal_9', name: '', followers: null,
    contact: { phone: '13800000000', wechat: '', email: '' }, sourceUrl: location.href });
  let captured;
  runtimeListeners[0]({ type: 'CAPTURE_PAGE' }, null, (response) => { captured = response; });
  assert.equal(captured.candidates.length, 0);
  assert.ok(captured.diagnostics.some((entry) => entry.includes('待关联联系详情 1 条')));
  assert.equal(sent.some((message) => message.type === 'UPSERT_CREATORS'), false);

  send({ platform: 'xiaohongshu', externalId: 'xhs_internal_9', name: '清禾', followers: 9000,
    contact: { phone: '', wechat: '', email: '' }, sourceUrl: location.href });
  runtimeListeners[0]({ type: 'CAPTURE_PAGE' }, null, (response) => { captured = response; });
  assert.equal(captured.candidates.length, 1);
  assert.equal(captured.candidates[0].name, '清禾');
  assert.equal(captured.candidates[0].contact.phone, '13800000000');
});

test('document scan reads only allowlisted profile anchors and visible name/follower text', () => {
  const adapters = loadAdapters('https://pgy.xiaohongshu.com/solar/pre-trade/kol');
  const anchor = {
    href: 'https://www.xiaohongshu.com/user/profile/red_9?token=page-secret',
    textContent: '木棉',
    parentElement: { textContent: '木棉 3.2万粉丝' },
    getAttribute(name) { return name === 'title' ? '木棉' : null; },
  };
  const document = { querySelectorAll: () => [anchor] };
  const found = adapters.scanDocument(document, 'https://pgy.xiaohongshu.com/solar/pre-trade/kol?token=page-secret');
  assert.equal(found.length, 1);
  assert.equal(found[0].externalId, 'red_9');
  assert.equal(found[0].name, '木棉');
  assert.equal(found[0].followers, 32000);
  assert.equal(found[0].profileUrl, 'https://www.xiaohongshu.com/user/profile/red_9');
});

test('MAIN hook emits only bounded whitelisted candidates and queues before content is ready', async () => {
  const pageHookSource = await readFile(new URL('../page-hook.js', import.meta.url), 'utf8');
  const listeners = [];
  const posted = [];
  const location = new URL('https://buyin.jinritemai.com/dashboard?token=page-secret');
  const payload = JSON.stringify({ data: { list: [{ author_base: {
    uid: 'dy_901', nickname: '山茶', follower_count: 18000, phone: 'must-not-forward',
    internal_token: 'must-not-forward-either',
  } }] } });
  const encoded = new TextEncoder().encode(payload);
  const chunks = [encoded.slice(0, 25), encoded.slice(25)];
  let chunkIndex = 0;
  const response = {
    ok: true,
    clone() {
      return { body: { getReader: () => ({
        read: async () => chunkIndex < chunks.length ? { done: false, value: chunks[chunkIndex++] } : { done: true },
        cancel: async () => {},
      }) } };
    },
  };
  const originalFetch = async () => response;
  const context = vm.createContext({
    URL,
    TextDecoder,
    Promise,
    WeakMap,
    WeakSet,
    location,
    fetch: originalFetch,
    addEventListener: (_type, listener) => listeners.push(listener),
    postMessage: (message, targetOrigin) => posted.push({ message, targetOrigin }),
  });
  context.DaboAdapters = loadAdapters(location.href);
  vm.runInContext(pageHookSource, context, { filename: 'page-hook.js' });
  const hookedFetch = context.fetch;
  const apiUrl = 'https://buyin.jinritemai.com/api/authorStatData/authorListRec?limit=20&token=api-secret';
  const result = hookedFetch(apiUrl);
  assert.equal(result instanceof Promise, true);
  await result;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(posted.length, 0);

  const windowObject = vm.runInContext('globalThis', context);
  listeners[0]({
    source: windowObject,
    origin: location.origin,
    data: { channel: 'dabo-creator-assistant', version: 1, type: 'CONTENT_READY' },
  });
  assert.equal(posted.length, 2);
  assert.equal(posted[0].targetOrigin, location.origin);
  assert.equal(posted[0].message.type, 'CONTENT_ACK');
  const captureMessage = posted[1].message;
  assert.deepEqual(Object.keys(captureMessage).sort(), ['candidates', 'channel', 'platform', 'type', 'version']);
  assert.equal(captureMessage.candidates.length, 1);
  assert.deepEqual(Object.keys(captureMessage.candidates[0]).sort(), [
    'category', 'contact', 'externalId', 'followers', 'name', 'platform', 'platformData', 'profileUrl', 'sourceUrl',
  ]);
  assert.equal(captureMessage.candidates[0].platformData.accountId, 'dy_901');
  assert.equal(JSON.stringify(posted).includes('api-secret'), false);
  assert.equal(JSON.stringify(posted).includes('must-not-forward'), false);
});

test('XHR hook keeps only the permitted record ID and response contact fields', async () => {
  const pageHookSource = await readFile(new URL('../page-hook.js', import.meta.url), 'utf8');
  const listeners = [];
  const posted = [];
  const location = new URL('https://pgy.xiaohongshu.com/solar/pre-trade/kol');
  const response = { data: { buyer_id: 'xhs_internal_5', contact_info: { phone: '13800000000', email: 'contact@example.test' } } };
  class FakeXHR {
    constructor() {
      this.status = 200;
      this.responseType = 'json';
      this.response = response;
      this.loadListener = null;
    }
    addEventListener(type, listener) { if (type === 'load') this.loadListener = listener; }
    open(method, url) { this.method = method; this.url = url; return 'opened'; }
    send(body) { this.body = body; this.loadListener.call(this); return 'sent'; }
    setRequestHeader() { throw new Error('headers must not be read or changed'); }
    getAllResponseHeaders() { throw new Error('response headers must not be read'); }
  }
  const context = vm.createContext({
    URL, TextDecoder, Promise, location, XMLHttpRequest: FakeXHR,
    addEventListener: (_type, listener) => listeners.push(listener),
    postMessage: (message, targetOrigin) => posted.push({ message, targetOrigin }),
  });
  context.DaboAdapters = loadAdapters(location.href);
  vm.runInContext(pageHookSource, context, { filename: 'page-hook.js' });
  const xhr = new context.XMLHttpRequest();
  assert.equal(xhr.open('POST', 'https://pgy.xiaohongshu.com/api/draco/selection-center/contact/info/query?trace=private'), 'opened');
  assert.equal(xhr.send(JSON.stringify({ buyer_id: 'xhs_internal_5', token: 'request-secret', filter: 'not-forwarded' })), 'sent');
  const windowObject = vm.runInContext('globalThis', context);
  listeners[0]({ source: windowObject, origin: location.origin,
    data: { channel: 'dabo-creator-assistant', version: 1, type: 'CONTENT_READY' } });
  const capture = posted.find((item) => item.message.type === 'CAPTURE_RESPONSE').message;
  assert.equal(capture.candidates.length, 1);
  assert.equal(capture.candidates[0].externalId, 'xhs_internal_5');
  assert.equal(capture.candidates[0].name, '');
  assert.equal(capture.candidates[0].contact.phone, '13800000000');
  assert.equal(JSON.stringify(posted).includes('request-secret'), false);
  assert.equal(JSON.stringify(posted).includes('not-forwarded'), false);
});
