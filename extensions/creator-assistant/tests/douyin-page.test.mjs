import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { executeDouyinPage } from '../lib/douyin-page.mjs';

const SESSION_KEY = 'daboPageRuntime_0123456789abcdef';
const CAPABILITY = 'c'.repeat(64);
const HOST = 'https://buyin.jinritemai.com';
const SEND_PATH = '/connection/pc/im/invite/card/send';
const ACCOUNT_ID = 'native_account_1';
const RIGHT_IDS = { '源头工厂': '2001', '免费样品': '5002' };
const RECIPIENT = {
  id: 'douyin:legacy_creator_1',
  platform: 'douyin',
  name: '桔子 Zoe',
  externalId: 'legacy_creator_1',
  accountId: ACCOUNT_ID,
  searchAccount: '',
};

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

class FakeElement {
  constructor({ tagName = 'div', text = '', attrs = {}, onClick = null, onKey = null } = {}) {
    this.tagName = tagName.toUpperCase();
    this.textContent = text;
    this.innerText = text;
    this.attributes = { ...attrs };
    this.listeners = new Map();
    this.selectors = new Map();
    this.onClick = onClick;
    this.onKey = onKey;
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = '';
    this.isConnected = true;
    this.className = '';
  }
  getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getClientRects() { return [{ width: 10, height: 10 }]; }
  querySelectorAll(selector) { return [...(this.selectors.get(selector) || [])]; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return this.closestMap?.get(selector) || null; }
  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) || [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }
  dispatchEvent(event) {
    if (event?.key === 'Escape' && this.onKey) this.onKey(event);
    for (const listener of this.listeners.get(event.type) || []) listener(event);
    return true;
  }
  click() {
    this.onClick?.();
    for (const listener of this.listeners.get('click') || []) listener({ isTrusted: false, target: this });
  }
}

class FakeXhr {
  open(method, url) { this.method = method; this.url = url; }
  setRequestHeader() {}
  addEventListener(name, listener) { if (name === 'load') this.loadListener = listener; }
  send(body) { this.body = body; this.constructor.sent.push({ method: this.method, url: this.url, body }); }
  abort() { this.aborted = true; }
}
function createWorld({ preflightPassed = true, preflightCode = 0, accountCheckResponses = [], holdAccountCheckCalls = [], cardVersion = 0, sendBodyOverride = null, sendMethodOverride = 'POST', rightWireMode = 'label', rightWireOverride = null, loginJson, onPromotion = null, speedTimers = false, productPages, categoryFixture = false, categoryTree = [{ id: 110, name: '食品饮料', sub_cates: [{ id: 111, name: '休闲零食' }] }], hangCategoryApi = false } = {}) {
  let drawerContainer = null;
  let modal = null;
  let submitCount = 0;
  let promotionCalls = 0;
  let accountCheckCalls = 0;
  const heldAccountChecks = new Map();
  const catalogPages = productPages || [{ rows: [{ product_id: 'spu_1', product_name: '新品精华', price: '99' }], hasMore: false }];
  let currentProductPage = 0;
  let login = loginJson || '{"data":{"shop_id":"shop_1","user_id":"user_1","shop_name":"青禾 A1"}}';
  let activeFetch;
  const calls = [];
  let fastNow = Date.now();
  const FastDate = class extends Date { static now() { fastNow += 1000; return fastNow; } };
  const XhrClass = class PageFakeXhr extends FakeXhr {};
  XhrClass.sent = [];
  const phone = new FakeElement({ tagName: 'input' });
  const wechat = new FakeElement({ tagName: 'input' });
  const message = new FakeElement({ tagName: 'textarea' });
  const productInput = new FakeElement({ tagName: 'input' });
  const productCheckbox = new FakeElement({ tagName: 'input', attrs: { type: 'checkbox' }, onClick: () => { productCheckbox.checked = !productCheckbox.checked; } });
  const productRow = new FakeElement({ text: '新品精华', attrs: { 'data-row-key': 'spu_1' } });
  productRow.selectors.set('.auxo-checkbox-input', [productCheckbox]);
  let categoryMenuOpen = false;
  let categoryMenuDepth = 0;
  const categoryInput = new FakeElement({ tagName: 'input', attrs: { type: 'checkbox' } });
  categoryInput.value = 'on';
  categoryInput.onClick = () => { categoryInput.checked = !categoryInput.checked; };
  const categoryItem = new FakeElement({ text: '休闲零食', attrs: { title: '休闲零食' } });
  categoryItem.selectors.set('input[type="checkbox"]', [categoryInput]);
  const categoryExpand = new FakeElement({ onClick: () => { categoryMenuDepth = 1; } });
  const categoryParent = new FakeElement({ text: '食品饮料', attrs: { title: '食品饮料' } });
  categoryParent.selectors.set('.auxo-cascader-menu-item-expand, [aria-haspopup="true"]', [categoryExpand]);
  const categoryMainMenu = new FakeElement();
  categoryMainMenu.selectors.set('li[title]', [categoryParent]);
  const categoryLeafMenu = new FakeElement();
  categoryLeafMenu.selectors.set('li[title]', [categoryItem]);
  const categoryWrapper = new FakeElement({ onClick: () => { categoryMenuOpen = true; categoryMenuDepth = 0; }, onKey: () => { categoryMenuOpen = false; categoryMenuDepth = 0; } });
  const rightInputFactory = new FakeElement({ tagName: 'input', attrs: { type: 'checkbox' } });
  rightInputFactory.value = 'on';
  rightInputFactory.onClick = () => { rightInputFactory.checked = !rightInputFactory.checked; };
  const rightInputSample = new FakeElement({ tagName: 'input', attrs: { type: 'checkbox' } });
  rightInputSample.value = 'on';
  rightInputSample.onClick = () => { rightInputSample.checked = !rightInputSample.checked; };
  const rightLabelFactory = new FakeElement({ text: '源头工厂' });
  rightLabelFactory.selectors.set('input', [rightInputFactory]);
  rightLabelFactory.selectors.set('input[type="checkbox"]', [rightInputFactory]);
  const rightLabelSample = new FakeElement({ text: '免费样品' });
  rightLabelSample.selectors.set('input', [rightInputSample]);
  rightLabelSample.selectors.set('input[type="checkbox"]', [rightInputSample]);
  const rightLabels = [rightLabelFactory, rightLabelSample];
  const rightsTitle = new FakeElement({ text: '合作权益' });
  const rightsGroup = new FakeElement();
  rightsGroup.selectors.set('.auxo-form-item-label', [rightsTitle]);
  for (const label of rightLabels) label.closestMap = new Map([['.auxo-form-item-row, .auxo-form-item', rightsGroup]]);
  const updateProductRow = () => {
    const rows = catalogPages[currentProductPage]?.rows || [];
    const first = rows[0] || {};
    productRow.textContent = first.product_name || first.name || '';
    productRow.innerText = productRow.textContent;
    productRow.setAttribute('data-row-key', first.product_id || first.id || '');
    productCheckbox.checked = false;
  };

  let pageFetch;
  function createDrawer() {
    const drawer = new FakeElement();
    const addProduct = new FakeElement({ text: '添加商品', onClick: () => { modal = createModal(); } });
    drawer.selectors.set('.auxo-btn', [addProduct]);
    drawer.selectors.set('#phone', [phone]);
    drawer.selectors.set('#wechat', [wechat]);
    drawer.selectors.set('.auxo-form-item .auxo-sp-textarea textarea', [message]);
    drawer.selectors.set('.auxo-checkbox-group label', categoryFixture ? rightLabels : []);

    const submit = new FakeElement({ text: '发送邀约', onClick: () => {
      submitCount += 1;
      const body = sendBodyOverride ? sendBodyOverride({ phone, wechat, message }) : {
        account_id: ACCOUNT_ID,
        account_type: 1,
        contact_info: { phone: phone.value, wechat: wechat.value },
        entry_point: 1,
        invite_card: {
          rights: categoryFixture ? rightLabels.filter((label) => label.querySelector('input').checked).map((label) => ({
            right: rightWireOverride ?? (rightWireMode === 'number'
              ? Number(RIGHT_IDS[label.textContent])
              : rightWireMode === 'string-id' ? RIGHT_IDS[label.textContent] : label.textContent),
          })) : [],
          product_ids: ['spu_1'],
          product_setting: [{ product_id: 'spu_1' }],
          content: cardVersion === 1 ? 'from buyin' : message.value,
          card_version: cardVersion,
          ...(cardVersion === 1 ? { categories: categoryInput.checked ? [{ id: String(categoryTree[0].sub_cates[0].id) }] : [] } : {}),
        },
        event_param: { client_form: 'pc' },
      };
      void activeFetch(`${HOST}${SEND_PATH}`, { method: sendMethodOverride, body: JSON.stringify(body) });
    } });
    const footer = new FakeElement();
    footer.selectors.set('.auxo-drawer-footer .auxo-btn-primary', [submit]);
    const close = new FakeElement({ text: '关闭', onClick: () => {
      if (drawerContainer) {
        drawerContainer.isConnected = false;
        drawerContainer = null;
      }
    } });
    const container = new FakeElement();
    container.selectors.set('.auxo-drawer-body', [drawer]);
    container.selectors.set('.auxo-drawer-footer .auxo-btn-primary', [submit]);
    container.closestMap = new Map([['.auxo-drawer', container]]);
    drawer.closestMap = new Map([['.auxo-drawer', container]]);
    drawer.selectors.set('.auxo-drawer-close', [close]);
    container.selectors.set('.auxo-drawer-close', [close]);
    drawerContainer = container;
    return drawer;
  }

  function createModal() {
    const content = new FakeElement();
    const requestProductPage = () => {
      const page = catalogPages[currentProductPage] || catalogPages.at(-1);
      void activeFetch(`${HOST}/connection/pc/im/promotion/list`, { method: 'POST', body: JSON.stringify({ product_id: productInput.value, page: currentProductPage }) });
      return page;
    };
    const search = new FakeElement({ className: 'auxo-btn auxo-btn-icon-only', onClick: () => {
      currentProductPage = 0;
      updateProductRow();
      promotionCalls += 1;
      onPromotion?.(promotionCalls);
      requestProductPage();
    } });
    const next = new FakeElement({ onClick: () => {
      currentProductPage = Math.min(currentProductPage + 1, catalogPages.length - 1);
      updateProductRow();
      promotionCalls += 1;
      onPromotion?.(promotionCalls);
      requestProductPage();
    } });
    const close = new FakeElement({ text: '关闭', onClick: () => { modal = null; } });
    const add = new FakeElement({ text: '添加', onClick: () => {} });
    content.selectors.set('.auxo-input-search .auxo-input-wrapper input', [productInput]);
    content.selectors.set('.auxo-input-search .auxo-input-group-addon .auxo-btn.auxo-btn-icon-only', [search]);
    content.selectors.set('.auxo-table-tbody tr', [productRow]);
    content.selectors.set('.auxo-modal-close', [close]);
    content.selectors.set('.auxo-modal-footer .auxo-btn-primary', [add]);
    content.selectors.set('.auxo-pagination-next', [next]);
    return content;
  }

  const online = new FakeElement({ text: '在线沟通', onClick: () => {
    createDrawer();
    void activeFetch(`${HOST}/connection/pc/im/account_check`, { method: 'POST', body: JSON.stringify({ account_id: ACCOUNT_ID }) });
    void activeFetch(`${HOST}/connection/pc/im/card/sender/msg`, { method: 'POST', body: '{}' });
  } });
  const onlineSpan = new FakeElement({ tagName: 'span', text: '在线沟通' });
  onlineSpan.closestMap = new Map([['.auxo-btn', online]]);
  const row = new FakeElement({ attrs: { 'data-row-key': 'legacy_creator_1' } });
  row.selectors.set('.auxo-btn span', [onlineSpan]);

  const document = {
    querySelectorAll(selector) {
      if (selector === '.virtual-list .auxo-table-tbody tr[data-row-key]') return [row];
      if (selector === '.auxo-drawer-body') return drawerContainer ? drawerContainer.querySelectorAll(selector) : [];
      if (selector === '.auxo-modal-content') return modal ? [modal] : [];
      if (selector === '.auxo-drawer-close') return drawerContainer ? drawerContainer.querySelectorAll(selector) : [];
      if (selector === '.auxo-checkbox-group label') return drawerContainer ? drawerContainer.querySelectorAll('.auxo-drawer-body')[0]?.querySelectorAll('.auxo-checkbox-group label') || [] : [];
      if (selector === '.auxo-cascader-multiple-wrapper') return categoryFixture ? [categoryWrapper] : [];
      if (selector === '.auxo-cascader-menu') return categoryMenuOpen ? (categoryMenuDepth === 0 ? [categoryMainMenu] : [categoryMainMenu, categoryLeafMenu]) : [];
      if (selector === '.auxo-drawer') return drawerContainer ? [drawerContainer] : [];
      if (selector === '.auxo-drawer-footer .auxo-btn-primary') return drawerContainer ? drawerContainer.querySelectorAll(selector) : [];
      if (selector === '.auxo-drawer-body .auxo-btn') return drawerContainer ? drawerContainer.querySelectorAll('.auxo-drawer-body')[0].querySelectorAll('.auxo-btn') : [];
      return [];
    },
  };

  pageFetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, HOST);
    const call = { path: url.pathname, search: url.search, method: String(init.method || 'GET').toUpperCase(), body: init.body || '', headers: { ...(init.headers || {}) }, credentials: init.credentials || '' };
    calls.push(call);
    if (url.pathname === '/connection/pc/im/account_check') {
      accountCheckCalls += 1;
      const configured = accountCheckResponses[accountCheckCalls - 1];
      const payload = configured
        ? { code: configured.code ?? 0, data: { is_passed: configured.isPassed, popwindow_text: configured.reason || (configured.isPassed ? '' : '不可邀请') } }
        : { code: preflightCode, data: { is_passed: preflightPassed, popwindow_text: preflightPassed ? '' : '不可邀请' } };
      if (holdAccountCheckCalls.includes(accountCheckCalls)) {
        return new Promise((resolve) => heldAccountChecks.set(accountCheckCalls, () => resolve(response(payload))));
      }
      return response(payload);
    }
    if (url.pathname === '/connection/pc/im/card/sender/msg') return response({ code: 0, data: { invite_card_info: { card_version: cardVersion } } });
    if (url.pathname === '/square_pc_api/common/square/squareConf') {
      if (hangCategoryApi) return new Promise(() => {});
      return response({ code: 0, data: { main_cates: categoryTree } });
    }
    if (url.pathname === '/connection/pc/im/promotion/list') {
      const request = JSON.parse(call.body || '{}');
      if (request.product_id) {
        const rows = catalogPages.flatMap((page) => page.rows).filter((row) => (row.product_id || row.id) === request.product_id);
        return response({ code: 0, data: { promotion_list: rows, has_more: false } });
      }
      const page = catalogPages[Number(request.page) || 0] || catalogPages.at(-1);
      return response({ code: 0, data: { promotion_list: page.rows, has_more: page.hasMore } });
    }
    if (url.pathname === SEND_PATH) return response({ code: 0 });
    if (url.pathname === '/connection/pc/im/shangda/msgs/send') return response({ code: 0 });
    return response({ code: 0, data: {} });
  };

  const storage = {
    getItem(key) { return key === 'BUYIN_USER_LOGIN_STORAGE' ? login : null; },
  };
  const location = { href: `${HOST}/dashboard`, hostname: 'buyin.jinritemai.com', protocol: 'https:' };
  const context = vm.createContext({
    URL,
    Response,
    AbortController,
    TextDecoder,
    TextEncoder,
    Date: speedTimers ? FastDate : Date,
    Event,
    KeyboardEvent: class KeyboardEvent { constructor(type, init = {}) { this.type = type; this.key = init.key; } },
    location,
    document,
    localStorage: storage,
    sessionStorage: { getItem: () => null },
    fetch: pageFetch,
    XMLHttpRequest: XhrClass,
    history: { pushState() {}, replaceState() {} },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    addEventListener() {},
    setTimeout: speedTimers ? ((callback) => setTimeout(callback, 1)) : setTimeout,
    clearTimeout,
  });
  activeFetch = (...args) => context.fetch(...args);
  const serialized = vm.runInContext(`(${executeDouyinPage.toString()})`, context, { filename: 'executeDouyinPage' });
  const toPageValue = (value) => vm.runInContext(`JSON.parse(${JSON.stringify(JSON.stringify(value))})`, context);
  const invoke = (operation, payload = {}) => serialized(operation, toPageValue({
    sessionKey: SESSION_KEY,
    capability: CAPABILITY,
    ...payload,
  }));
  return {
    context, calls, invoke, toPageValue, xhrClass: XhrClass,
    setLogin(value) { login = value; },
    releaseAccountCheck(callNumber) { heldAccountChecks.get(callNumber)?.(); },
    get submitCount() { return submitCount; },
    get promotionCalls() { return promotionCalls; },
    get categoryChecked() { return categoryInput.checked; },
    get rightChecked() { return rightInputSample.checked; },
    get rightsChecked() { return rightLabels.filter((label) => label.querySelector('input').checked).map((label) => label.textContent); },
  };
}

async function prepare(world) {
  const installed = await world.invoke('install');
  assert.equal(installed.ready, true);
  assert.equal(installed.accountLabel, '青禾 A1');
  assert.match(installed.contextId, /^shop:shop_1\|user:user_1$/);
  const options = await world.invoke('options', { recipient: RECIPIENT });
  assert.equal(options.ready, true, `${options.reason} calls=${JSON.stringify(world.calls)}`);
  assert.equal(options.mode, 'words');
  assert.deepEqual(Array.from(options.products, (product) => product.id), ['spu_1']);
  assert.equal(Object.hasOwn(options.products[0], 'priceText'), false);
  return options;
}

test('serialized runtime preserves Chinese and ASCII identity text and frozen capability API', async () => {
  const world = createWorld();
  const result = await world.invoke('install');
  assert.equal(result.ready, true);
  assert.equal(result.accountLabel, '青禾 A1');
  const runtime = world.context[SESSION_KEY];
  assert.equal(vm.runInContext(`Object.isFrozen(globalThis[${JSON.stringify(SESSION_KEY)}])`, world.context), true);
  assert.equal(Object.getOwnPropertyDescriptor(world.context, SESSION_KEY).writable, false);
  const bad = await runtime.options('wrong-capability', world.toPageValue({ recipient: RECIPIENT }));
  assert.equal(bad.ok, false);
  assert.equal(world.calls.length, 0);
});

test('visible legacy creator row opens native options without searchAccount or any send', async () => {
  const world = createWorld();
  const options = await prepare(world);
  assert.equal(options.ready, true);
  assert.equal(world.calls.some((call) => [SEND_PATH, '/connection/pc/im/shangda/msgs/send'].includes(call.path)), false);
  assert.equal(world.calls.some((call) => call.path === '/square_pc_api/square/search_feed_author'), false);
  assert.deepEqual(world.calls.filter((call) => call.path === '/connection/pc/im/promotion/list').length, 1);
});

test('native product cursor reads three pages and configuration retains previously read product IDs', async () => {
  const world = createWorld({ productPages: [
    { rows: [{ product_id: 'spu_1', product_name: '第一页商品' }], hasMore: true },
    { rows: [{ product_id: 'spu_2', product_name: '第二页商品' }], hasMore: true },
    { rows: [{ product_id: 'spu_3', product_name: '第三页商品' }], hasMore: false },
  ] });
  const first = await prepare(world);
  assert.equal(first.cursor, 'page:2');
  const second = await world.invoke('options', { recipient: RECIPIENT, cursor: first.cursor });
  assert.equal(second.ready, true, second.reason);
  assert.deepEqual(Array.from(second.products, (product) => product.id), ['spu_2']);
  assert.equal(second.cursor, 'page:3');
  const third = await world.invoke('options', { recipient: RECIPIENT, cursor: second.cursor });
  assert.equal(third.ready, true, third.reason);
  assert.deepEqual(Array.from(third.products, (product) => product.id), ['spu_3']);
  const configured = await world.invoke('configure', {
    contextId: third.contextId,
    configuration: { message: '合作邀约', contactName: '', phone: '', wechat: 'merchant_1', productIds: ['spu_1'], categoryIds: [], rightIds: [] },
  });
  assert.equal(configured.ready, true, configured.reason);
  assert.equal(configured.summary.accountLabel, '青禾 A1');
  assert.equal(configured.summary.cardVersion, 'words');
  assert.deepEqual(Array.from(configured.summary.productIds), ['spu_1']);
});

test('native XHR invitation passes through while assistant guard is idle', async () => {
  const world = createWorld();
  const installed = await world.invoke('install');
  world.xhrClass.sent = [];
  const xhr = new world.context.XMLHttpRequest();
  xhr.open('POST', `${HOST}${SEND_PATH}`);
  xhr.send('{"manual":"page-native"}');
  assert.equal(world.xhrClass.sent.length, 1, `installed=${JSON.stringify(installed)} send=${world.xhrClass.sent.length} xhr=${JSON.stringify({ method: xhr.method, url: xhr.url, body: xhr.body, aborted: xhr.aborted, methodName: world.context.XMLHttpRequest.prototype.send.name })}`);
  assert.equal(world.xhrClass.sent[0].url, `${HOST}${SEND_PATH}`);
});

test('options and preflight remain read-only; successful start sends one exact native invite', async () => {
  const world = createWorld();
  const options = await prepare(world);
  const blocked = await world.context.fetch(`${HOST}${SEND_PATH}`, { method: 'POST', body: '{}' });
  assert.equal(blocked.status, 403);
  assert.equal(world.calls.some((call) => call.path === SEND_PATH), false);

  const configured = await world.invoke('configure', {
    contextId: options.contextId,
    configuration: {
      message: '新品合作邀约', contactName: '', phone: '13912345678', wechat: '',
      productIds: ['spu_1'], categoryIds: [], rightIds: [],
    },
  });
  assert.equal(configured.ready, true, configured.reason);
  const preflight = await world.invoke('preflight', { templateId: configured.templateId, recipient: RECIPIENT });
  assert.equal(preflight.ok, true);
  const sent = await world.invoke('send', { templateId: configured.templateId, recipient: RECIPIENT });
  assert.equal(sent.status, 'succeeded');
  assert.equal(sent.code, 0);
  assert.equal(world.submitCount, 1);
  const native = world.calls.filter((call) => call.path === SEND_PATH);
  assert.equal(native.length, 1);
  const body = JSON.parse(native[0].body);
  assert.equal(body.account_id, ACCOUNT_ID);
  assert.equal(body.account_type, 1);
  assert.equal(body.entry_point, 1);
  assert.deepEqual(body.invite_card.product_ids, ['spu_1']);
  assert.equal(body.invite_card.content, '新品合作邀约');
  assert.equal(body.contact_info.phone, '13912345678');
});

test('wrong native recipient is blocked before fetch and is never reported as submitted', async () => {
  const world = createWorld({ sendBodyOverride: ({ phone, wechat, message }) => ({
    account_id: 'other_account', account_type: 1,
    contact_info: { phone: phone.value, wechat: wechat.value },
    entry_point: 1,
    invite_card: { rights: [], product_ids: ['spu_1'], product_setting: [{ product_id: 'spu_1' }], content: message.value, card_version: 0 },
    event_param: {},
  }) });
  const options = await prepare(world);
  const configured = await world.invoke('configure', {
    contextId: options.contextId,
    configuration: { message: '新品合作邀约', contactName: '', phone: '13912345678', wechat: '', productIds: ['spu_1'], categoryIds: [], rightIds: [] },
  });
  const preflight = await world.invoke('preflight', { templateId: configured.templateId, recipient: RECIPIENT });
  assert.equal(preflight.ok, true);
  const sent = await world.invoke('send', { templateId: configured.templateId, recipient: RECIPIENT });
  assert.equal(sent.status, 'failed');
  assert.equal(sent.notSubmitted, true);
  assert.equal(world.calls.some((call) => call.path === SEND_PATH), false);
  assert.equal(world.submitCount, 1);
});

test('a matching invitation body sent with a non-POST method is blocked before fetch', async () => {
  const world = createWorld({ sendMethodOverride: 'GET' });
  const options = await prepare(world);
  const configured = await world.invoke('configure', {
    contextId: options.contextId,
    configuration: { message: '合作邀约', contactName: '', phone: '13912345678', wechat: '', productIds: ['spu_1'], categoryIds: [], rightIds: [] },
  });
  const preflight = await world.invoke('preflight', { templateId: configured.templateId, recipient: RECIPIENT });
  assert.equal(preflight.ok, true);
  const sent = await world.invoke('send', { templateId: configured.templateId, recipient: RECIPIENT });
  assert.equal(sent.status, 'failed');
  assert.equal(sent.notSubmitted, true);
  assert.equal(world.calls.some((call) => call.path === SEND_PATH), false);
});

test('account_check rejection is explicit and read-only', async () => {
  const world = createWorld({ preflightPassed: false });
  const options = await prepare(world);
  const configured = await world.invoke('configure', {
    contextId: options.contextId,
    configuration: { message: '新品合作邀约', contactName: '', phone: '13912345678', wechat: '', productIds: ['spu_1'], categoryIds: [], rightIds: [] },
  });
  const result = await world.invoke('preflight', { templateId: configured.templateId, recipient: RECIPIENT });
  assert.equal(result.ok, false);
  assert.equal(result.platformRejected, true);
  assert.equal(result.reason, '不可邀请');
  assert.equal(world.calls.some((call) => call.path === SEND_PATH), false);
});

test('nonzero account_check with a contradictory pass flag does not grant a preflight ticket', async () => {
  const world = createWorld({ preflightPassed: true, preflightCode: 17 });
  const options = await prepare(world);
  const configured = await world.invoke('configure', {
    contextId: options.contextId,
    configuration: { message: '合作邀约', contactName: '', phone: '13912345678', wechat: '', productIds: ['spu_1'], categoryIds: [], rightIds: [] },
  });
  const result = await world.invoke('preflight', { templateId: configured.templateId, recipient: RECIPIENT });
  assert.equal(result.ok, false);
  assert.equal(result.platformRejected, false);
  assert.equal(world.calls.some((call) => call.path === SEND_PATH), false);
});

test('a delayed account_check from an expired preflight cannot authorize a later attempt', async () => {
  const world = createWorld({
    speedTimers: true,
    holdAccountCheckCalls: [2],
    accountCheckResponses: [
      { isPassed: true },
      { isPassed: false, reason: '旧预检拒绝' },
      { isPassed: true },
    ],
  });
  const options = await prepare(world);
  const configured = await world.invoke('configure', {
    contextId: options.contextId,
    configuration: { message: '合作邀约', contactName: '', phone: '13912345678', wechat: '', productIds: ['spu_1'], categoryIds: [], rightIds: [] },
  });
  const expired = await world.invoke('preflight', { templateId: configured.templateId, recipient: RECIPIENT });
  assert.equal(expired.ok, false);
  assert.equal(expired.platformRejected, false);
  const current = await world.invoke('preflight', { templateId: configured.templateId, recipient: RECIPIENT });
  assert.equal(current.ok, true);
  world.releaseAccountCheck(2);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const sent = await world.invoke('send', { templateId: configured.templateId, recipient: RECIPIENT });
  assert.equal(sent.status, 'succeeded');
  assert.equal(world.calls.filter((call) => call.path === SEND_PATH).length, 1);
});

test('category mode maps default-on checkboxes through the official tree and sends verified IDs', async () => {
  const world = createWorld({ cardVersion: 1, categoryFixture: true });
  const installed = await world.invoke('install');
  assert.equal(installed.ready, true);
  const options = await world.invoke('options', { recipient: RECIPIENT });
  assert.equal(options.ready, true, options.reason);
  assert.deepEqual(Array.from(options.categories, (item) => item.id), ['native:111']);
  assert.deepEqual(Array.from(options.categories[0].path), ['食品饮料', '休闲零食']);
  assert.deepEqual(Array.from(options.rights, (item) => item.id), ['native:2001', 'native:5002']);
  assert.equal(world.categoryChecked, false);
  assert.equal(world.rightChecked, false);
  const categoryRead = world.calls.find((call) => call.path === '/square_pc_api/common/square/squareConf');
  assert.ok(categoryRead);
  assert.equal(categoryRead.method, 'GET');
  assert.equal(new URLSearchParams(categoryRead.search).get('type'), '2');
  assert.equal(categoryRead.headers.applicationId, '2');
  assert.equal(categoryRead.headers['data-view-id'], '');
  assert.equal(categoryRead.credentials, 'include');
  assert.equal(world.calls.some((call) => call.path === SEND_PATH), false);
  const configured = await world.invoke('configure', {
    contextId: options.contextId,
    configuration: { message: '', contactName: '', phone: '13912345678', wechat: '', productIds: ['spu_1'], categoryIds: ['native:111'], rightIds: ['native:5002', 'native:2001'] },
  });
  assert.equal(configured.ready, true, configured.reason);
  const preflight = await world.invoke('preflight', { templateId: configured.templateId, recipient: RECIPIENT });
  assert.equal(preflight.ok, true);
  const sent = await world.invoke('send', { templateId: configured.templateId, recipient: RECIPIENT });
  assert.equal(sent.status, 'succeeded');
  assert.equal(world.categoryChecked, true);
  assert.equal(world.rightChecked, true);
  const body = JSON.parse(world.calls.find((call) => call.path === SEND_PATH).body);
  assert.equal(body.invite_card.content, 'from buyin');
  assert.equal(body.invite_card.card_version, 1);
  assert.deepEqual(body.invite_card.categories, [{ id: '111' }]);
  assert.deepEqual(body.invite_card.rights, [{ right: '源头工厂' }, { right: '免费样品' }]);
});

test('verified numeric or string right IDs are accepted independent of native checkbox ordering', async () => {
  for (const rightWireMode of ['number', 'string-id']) {
    const world = createWorld({ cardVersion: 1, categoryFixture: true, rightWireMode });
    await world.invoke('install');
    const options = await world.invoke('options', { recipient: RECIPIENT });
    const configured = await world.invoke('configure', {
      contextId: options.contextId,
      configuration: { message: '', contactName: '', phone: '13912345678', wechat: '', productIds: ['spu_1'], categoryIds: ['native:111'], rightIds: ['native:5002'] },
    });
    const preflight = await world.invoke('preflight', { templateId: configured.templateId, recipient: RECIPIENT });
    assert.equal(preflight.ok, true);
    const sent = await world.invoke('send', { templateId: configured.templateId, recipient: RECIPIENT });
    assert.equal(sent.status, 'succeeded', rightWireMode);
  }
});

test('unrecognized native right IDs are blocked before the send endpoint', async () => {
  const world = createWorld({ cardVersion: 1, categoryFixture: true, rightWireOverride: 9999 });
  await world.invoke('install');
  const options = await world.invoke('options', { recipient: RECIPIENT });
  const configured = await world.invoke('configure', {
    contextId: options.contextId,
    configuration: { message: '', contactName: '', phone: '13912345678', wechat: '', productIds: ['spu_1'], categoryIds: ['native:111'], rightIds: ['native:5002'] },
  });
  const preflight = await world.invoke('preflight', { templateId: configured.templateId, recipient: RECIPIENT });
  assert.equal(preflight.ok, true);
  const sent = await world.invoke('send', { templateId: configured.templateId, recipient: RECIPIENT });
  assert.equal(sent.status, 'failed');
  assert.equal(sent.notSubmitted, true);
  assert.equal(world.calls.some((call) => call.path === SEND_PATH), false);
});

test('unknown official category tree fails closed without submitting', async () => {
  const world = createWorld({ cardVersion: 1, categoryFixture: true, categoryTree: [] });
  await world.invoke('install');
  const options = await world.invoke('options', { recipient: RECIPIENT });
  assert.equal(options.ready, false);
  assert.match(options.reason, /官方类目数据格式无法确认/u);
  assert.equal(world.calls.some((call) => call.path === SEND_PATH), false);
});

test('official category tree timeout returns a retryable read error and sends nothing', async () => {
  const world = createWorld({ cardVersion: 1, categoryFixture: true, hangCategoryApi: true, speedTimers: true });
  await world.invoke('install');
  const options = await world.invoke('options', { recipient: RECIPIENT });
  assert.equal(options.ready, false);
  assert.match(options.reason, /超时/u);
  assert.equal(world.calls.some((call) => call.path === SEND_PATH), false);
});

test('native form preserves multiline and repeated-space message text exactly', async () => {
  const world = createWorld();
  const options = await prepare(world);
  const message = '第一行  保留\n第二行\t继续';
  const configured = await world.invoke('configure', {
    contextId: options.contextId,
    configuration: { message, contactName: '', phone: '13912345678', wechat: '', productIds: ['spu_1'], categoryIds: [], rightIds: [] },
  });
  assert.equal(configured.ready, true, configured.reason);
  const preflight = await world.invoke('preflight', { templateId: configured.templateId, recipient: RECIPIENT });
  assert.equal(preflight.ok, true);
  const sent = await world.invoke('send', { templateId: configured.templateId, recipient: RECIPIENT });
  assert.equal(sent.status, 'succeeded');
  assert.equal(JSON.parse(world.calls.find((call) => call.path === SEND_PATH).body).invite_card.content, message);
});

test('a shop change during product selection blocks the native submit', async () => {
  let world;
  world = createWorld({ onPromotion: (count) => {
    if (count === 2) world.setLogin('{"data":{"shop_id":"shop_2","user_id":"user_2","shop_name":"其他店"}}');
  } });
  const options = await prepare(world);
  const configured = await world.invoke('configure', {
    contextId: options.contextId,
    configuration: { message: '合作邀约', contactName: '', phone: '13912345678', wechat: '', productIds: ['spu_1'], categoryIds: [], rightIds: [] },
  });
  const preflight = await world.invoke('preflight', { templateId: configured.templateId, recipient: RECIPIENT });
  assert.equal(preflight.ok, true);
  const sent = await world.invoke('send', { templateId: configured.templateId, recipient: RECIPIENT });
  assert.equal(sent.status, 'failed');
  assert.equal(sent.notSubmitted, true);
  assert.equal(world.submitCount, 0);
  assert.equal(world.calls.some((call) => call.path === SEND_PATH), false);
});

test('missing MAIN runtime asks the controller to reinstall, and read completion can release idle', async () => {
  const world = createWorld();
  const missing = await world.invoke('inspect');
  assert.equal(missing.ready, false);
  assert.equal(missing.missing, true);
  await prepare(world);
  const released = await world.invoke('release');
  assert.equal(released.ok, true);
  world.xhrClass.sent = [];
  const xhr = new world.context.XMLHttpRequest();
  xhr.open('POST', `${HOST}${SEND_PATH}`);
  xhr.send('{"manual":"page-native"}');
  assert.equal(world.xhrClass.sent.length, 1);
});
