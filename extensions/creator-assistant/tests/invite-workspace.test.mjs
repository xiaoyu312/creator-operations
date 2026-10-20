import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyInviteTemplate,
  createInviteTemplateStore,
  filterInviteResults,
  inviteResultsToCSV,
  recipientReadiness,
} from '../lib/invite-workspace.mjs';

const STORAGE_KEY = 'creator-assistant-invite-templates-v1';

function makeTemplate(overrides = {}) {
  return {
    name: '基础邀约',
    platform: 'douyin',
    mode: 'words',
    includeContact: false,
    configuration: {
      message: '你好，想邀请你合作。',
      productIds: ['product-1'],
      categoryIds: [],
      rightIds: [],
    },
    intervalSeconds: 60,
    ...overrides,
  };
}

function makeOptions(overrides = {}) {
  return {
    ready: true,
    platform: 'douyin',
    mode: 'words',
    products: [{ id: 'product-1', name: '商品一' }, { id: 'product-2', name: '商品二' }],
    categories: [{ id: 'category-1', label: '护肤' }],
    rights: [{ id: 'right-1', label: '定向佣金' }],
    ...overrides,
  };
}

function fakeStorage(initial = {}) {
  const data = structuredClone(initial);
  const counts = { get: 0, set: 0, remove: 0 };
  let failSet = null;
  let failRemove = null;
  let failGet = null;
  return {
    data,
    counts,
    failSet(error = new Error('write failed')) { failSet = error; },
    failRemove(error = new Error('remove failed')) { failRemove = error; },
    failGet(error = new Error('read failed')) { failGet = error; },
    async get(key) {
      counts.get += 1;
      if (failGet) throw failGet;
      return Object.hasOwn(data, key) ? { [key]: structuredClone(data[key]) } : {};
    },
    async set(values) {
      counts.set += 1;
      if (failSet) throw failSet;
      Object.assign(data, structuredClone(values));
    },
    async remove(key) {
      counts.remove += 1;
      if (failRemove) throw failRemove;
      delete data[key];
    },
  };
}

function testClock() {
  let value = Date.parse('2026-10-19T03:00:00.000Z');
  return () => value++;
}

test('recipientReadiness requires native string IDs and never substitutes a name', () => {
  assert.deepEqual(recipientReadiness({
    platform: 'douyin', externalId: 'creator-1', name: '有名字', platformData: { accountId: 'account-1' },
  }), { ready: true, reason: '' });
  assert.deepEqual(recipientReadiness({
    platform: 'weixin', externalId: 'finder-1', platformData: { talentAppid: 'appid-1' },
  }), { ready: true, reason: '' });
  assert.equal(recipientReadiness({ platform: 'douyin', name: '仅有姓名', platformData: { accountId: 'account-1' } }).ready, false);
  assert.equal(recipientReadiness({ platform: 'douyin', externalId: 'creator-1', platformData: { accountId: 7 } }).ready, false);
  assert.equal(recipientReadiness({ platform: 'weixin', externalId: 'creator-1', platformData: { accountId: 'wrong-native-id' } }).ready, false);
  assert.equal(recipientReadiness({ platform: 'kuaishou', externalId: 'creator-1' }).ready, false);
  assert.equal(recipientReadiness({ platform: 'douyin', externalId: '   ', platformData: { accountId: 'account-1' } }).ready, false);
});

test('applyInviteTemplate revalidates only against the loaded catalog and omits unrequested contacts', () => {
  const source = makeTemplate({
    includeContact: false,
    configuration: {
      message: '  有效话术  ', productIds: ['product-1', 'stale-product'], categoryIds: [], rightIds: [],
      contactName: 'must not be returned', phone: 'bad', wechat: 'bad', cookie: 'never-return',
    },
  });
  const applied = applyInviteTemplate(source, makeOptions(), [{ id: 'product-1' }]);
  assert.deepEqual(applied, {
    configuration: { message: '有效话术', productIds: ['product-1'], categoryIds: [], rightIds: [] },
    intervalSeconds: 60,
    warnings: ['商品 ID「stale-product」不在当前已加载列表中，已跳过。'],
  });
  assert.equal(JSON.stringify(applied).includes('never-return'), false);
  assert.equal(Object.hasOwn(applied.configuration, 'phone'), false);
  assert.equal(Object.hasOwn(applied.configuration, 'contactName'), false);
});

test('applyInviteTemplate filters stale categories and rights, preserves opted-in contact values, and rejects incompatible options', () => {
  const source = makeTemplate({
    mode: 'category',
    includeContact: true,
    configuration: {
      message: '', productIds: [], categoryIds: ['category-1', 'stale-category'],
      rightIds: ['right-1', 'stale-right'], contactName: '商务小周', phone: '13800138000', wechat: 'wx_user_1',
    },
  });
  const applied = applyInviteTemplate(source, makeOptions({ mode: 'category' }));
  assert.deepEqual(applied.configuration, {
    message: '', productIds: [], categoryIds: ['category-1'], rightIds: ['right-1'],
    contactName: '商务小周', phone: '13800138000', wechat: 'wx_user_1',
  });
  assert.deepEqual(applied.warnings, [
    '类目 ID「stale-category」不在当前已加载列表中，已跳过。',
    '权益 ID「stale-right」不在当前已加载列表中，已跳过。',
  ]);
  assert.throws(() => applyInviteTemplate(source, makeOptions({ platform: 'weixin', mode: 'words' })), /平台不匹配/u);
  assert.throws(() => applyInviteTemplate(source, makeOptions({ mode: 'words' })), /邀约模式/u);
  assert.throws(() => applyInviteTemplate(makeTemplate(), makeOptions({ ready: false, reason: '商品尚未读取' })), /商品尚未读取/u);
});

test('result filters keep platform, manual, legacy, unknown, failed, pending, and skipped states distinct', () => {
  const items = [
    { id: 'platform', status: 'succeeded', resolutionSource: 'platform' },
    { id: 'manual', status: 'succeeded', resolutionSource: 'manual' },
    { id: 'legacy', status: 'succeeded', resolutionSource: '' },
    { id: 'failed', status: 'failed', resolutionSource: 'platform' },
    { id: 'unknown', status: 'unknown', resolutionSource: '' },
    { id: 'pending', status: 'pending', resolutionSource: '' },
    { id: 'sending', status: 'sending', resolutionSource: '' },
    { id: 'skipped', status: 'skipped', resolutionSource: 'manual' },
  ];
  assert.equal(filterInviteResults(items, 'all').length, 8);
  assert.deepEqual(filterInviteResults(items, 'platform-success').map((item) => item.id), ['platform']);
  assert.deepEqual(filterInviteResults(items, 'manual-success').map((item) => item.id), ['manual']);
  assert.deepEqual(filterInviteResults(items, 'failed').map((item) => item.id), ['failed']);
  assert.deepEqual(filterInviteResults(items, 'unknown').map((item) => item.id), ['unknown']);
  assert.deepEqual(filterInviteResults(items, 'pending').map((item) => item.id), ['pending', 'sending']);
  assert.deepEqual(filterInviteResults(items, 'skipped').map((item) => item.id), ['skipped']);
  assert.throws(() => filterInviteResults(items, 'sent'), /filter/u);
  assert.equal(items.length, 8, 'filtering leaves task state untouched');
});

test('CSV is formula-safe, keeps long and leading-zero IDs as text, uses BOM/CRLF, and exports only approved fields', () => {
  const job = {
    platform: 'douyin',
    approvalToken: 'DO_NOT_EXPORT_APPROVAL',
    contextId: 'DO_NOT_EXPORT_CONTEXT',
    session: { cookie: 'DO_NOT_EXPORT_COOKIE' },
    items: [
      {
        externalId: '001234567890123456789',
        name: '=HYPERLINK("https://bad.example")',
        status: 'succeeded', resolutionSource: 'platform', message: '+SUM(1,2)', updatedAt: '2026-10-19T03:04:05.000Z',
        phone: 'DO_NOT_EXPORT_PHONE', wechat: 'DO_NOT_EXPORT_WECHAT', cookie: 'DO_NOT_EXPORT_ITEM_COOKIE',
      },
      {
        externalId: 'creator-manual', name: '人工达人', status: 'succeeded', resolutionSource: 'manual',
        message: '人工确认，非平台回执', updatedAt: '2026-10-19T03:05:05.000Z',
      },
      {
        externalId: 'creator-legacy', name: '旧版达人', status: 'succeeded', resolutionSource: '',
        message: '来源未注明', updatedAt: '2026-10-19T03:06:05.000Z',
      },
      {
        externalId: 'creator-unknown', name: '结果未明达人', status: 'unknown', resolutionSource: '',
        message: '请到平台核对', updatedAt: '2026-10-19T03:07:05.000Z',
      },
    ],
  };
  const csv = inviteResultsToCSV(job);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('\r\n'));
  assert.equal(/(^|[^\r])\n/u.test(csv), false, 'CSV lines use CRLF only');
  assert.ok(csv.includes('"\'001234567890123456789"'));
  assert.ok(csv.includes('"\'=HYPERLINK'));
  assert.ok(csv.includes('"\'+SUM(1,2)"'));
  assert.ok(csv.includes('平台确认'));
  assert.ok(csv.includes('人工确认'));
  assert.ok(csv.includes('结果未明'));
  assert.ok(csv.includes('成功（来源未注明）'));
  for (const secret of [
    'DO_NOT_EXPORT_APPROVAL', 'DO_NOT_EXPORT_CONTEXT', 'DO_NOT_EXPORT_COOKIE', 'DO_NOT_EXPORT_ITEM_COOKIE',
    'DO_NOT_EXPORT_PHONE', 'DO_NOT_EXPORT_WECHAT',
  ]) assert.equal(csv.includes(secret), false, `${secret} is not exported`);

  const manuals = inviteResultsToCSV(job, 'manual-success');
  assert.ok(manuals.includes('人工达人'));
  assert.equal(manuals.includes('旧版达人'), false);
  assert.equal(manuals.includes('结果未明达人'), false);
  assert.deepEqual(filterInviteResults(job.items, 'platform-success').map((item) => item.externalId), ['001234567890123456789']);
});

test('template store reloads, updates, strips opt-out contacts, and returns arrays from each operation', async () => {
  const storage = fakeStorage({ crm: { preserve: true } });
  const store = createInviteTemplateStore({ storage, now: testClock() });
  const saved = await store.save(makeTemplate({
    platform: 'weixin',
    includeContact: false,
    configuration: {
      message: '视频号话术', productIds: [], categoryIds: [], rightIds: [],
      contactName: '不应保存', phone: 'invalid', wechat: 'invalid', authToken: 'never-save',
    },
    contextId: 'never-save-context', ticket: 'never-save-ticket',
    createdAt: '1900-01-01T00:00:00.000Z', updatedAt: '1900-01-01T00:00:00.000Z',
  }));
  assert.equal(Array.isArray(saved), true);
  assert.equal(saved.length, 1);
  const created = saved[0];
  assert.equal(typeof created.id, 'string');
  assert.notEqual(created.id, '');
  assert.notEqual(created.createdAt, '1900-01-01T00:00:00.000Z');
  assert.notEqual(created.updatedAt, '1900-01-01T00:00:00.000Z');
  assert.deepEqual(Object.keys(created).sort(), ['configuration', 'createdAt', 'id', 'includeContact', 'intervalSeconds', 'mode', 'name', 'platform', 'updatedAt'].sort());
  assert.deepEqual(Object.keys(created.configuration).sort(), ['categoryIds', 'message', 'productIds', 'rightIds']);
  assert.equal(JSON.stringify(created).includes('never-save'), false);
  assert.equal(JSON.stringify(created).includes('never-save-context'), false);
  assert.deepEqual(storage.data.crm, { preserve: true });

  const reloaded = await createInviteTemplateStore({ storage, now: testClock() }).list();
  assert.deepEqual(reloaded, saved);
  const applied = applyInviteTemplate(reloaded[0], makeOptions({ platform: 'weixin' }));
  assert.equal(Object.hasOwn(applied.configuration, 'phone'), false);
  assert.deepEqual(applied.configuration.productIds, []);

  const updated = await store.save({
    ...created,
    name: '改名后的模板',
    createdAt: '1901-01-01T00:00:00.000Z',
    updatedAt: '1901-01-01T00:00:00.000Z',
  });
  assert.equal(updated[0].name, '改名后的模板');
  assert.equal(updated[0].createdAt, created.createdAt);
  assert.notEqual(updated[0].updatedAt, '1901-01-01T00:00:00.000Z');
  await assert.rejects(store.save({ ...makeTemplate(), id: 'unknown-template-id' }), /不存在/u);

  const removed = await store.remove(created.id);
  assert.deepEqual(removed, []);
  assert.equal(Object.hasOwn(storage.data, STORAGE_KEY), false);
  assert.deepEqual(storage.data.crm, { preserve: true });
  await assert.rejects(store.remove(created.id), /不存在/u);
});

test('template store validates contacts only after explicit opt-in and validates current form formats', async () => {
  const store = createInviteTemplateStore({ storage: fakeStorage(), now: testClock() });
  const template = makeTemplate({
    includeContact: true,
    configuration: {
      message: '话术', productIds: [], categoryIds: [], rightIds: [],
      contactName: '小周', phone: '13800138000', wechat: 'wx_user_1',
    },
  });
  const saved = await store.save(template);
  assert.equal(saved[0].configuration.contactName, '小周');
  assert.equal(saved[0].configuration.phone, '13800138000');
  await assert.rejects(store.save({
    ...template,
    configuration: { ...template.configuration, phone: '1380000000' },
  }), /11 位/u);
  await assert.rejects(store.save({
    ...template,
    configuration: { ...template.configuration, wechat: 'short' },
  }), /6–20 位/u);
  await assert.rejects(store.save({
    ...template,
    configuration: { ...template.configuration, contactName: '名'.repeat(121) },
  }), /120/u);
  const optedOut = await store.save({
    ...saved[0],
    includeContact: false,
    configuration: { ...saved[0].configuration },
  });
  assert.equal(Object.hasOwn(optedOut[0].configuration, 'phone'), false);
  assert.equal(Object.hasOwn(optedOut[0].configuration, 'wechat'), false);
  assert.equal(Object.hasOwn(optedOut[0].configuration, 'contactName'), false);
});

test('template store serializes concurrent saves, caps at 20 entries, and enforces the 128 KiB byte limit', async () => {
  const storage = fakeStorage();
  const store = createInviteTemplateStore({ storage, now: testClock() });
  const writes = await Promise.all(Array.from({ length: 20 }, (_, index) => store.save(makeTemplate({ name: `模板 ${index + 1}` }))));
  assert.equal(writes.at(-1).length, 20);
  await assert.rejects(store.save(makeTemplate({ name: '第 21 个' })), /20 个/u);
  assert.equal((await store.list()).length, 20);

  const largeStorage = fakeStorage();
  const largeStore = createInviteTemplateStore({ storage: largeStorage, now: testClock() });
  const ids = (prefix) => Array.from({ length: 50 }, (_, index) => `${prefix.repeat(235)}${String(index).padStart(5, '0')}`);
  const large = makeTemplate({
    name: '大模板',
    mode: 'category',
    configuration: { message: '', productIds: [], categoryIds: ids('c'), rightIds: ids('r') },
  });
  for (let index = 0; index < 5; index += 1) {
    await largeStore.save({ ...large, name: `大模板 ${index + 1}` });
  }
  await assert.rejects(largeStore.save({ ...large, name: '超过存储限制' }), /128 KiB/u);
  assert.equal((await largeStore.list()).length, 5, 'failed size check leaves prior templates intact');
});

test('corrupt storage and read/write failures surface without clearing templates or touching CRM data', async () => {
  const corruptStorage = fakeStorage({
    [STORAGE_KEY]: { unsupported: 'corrupt' },
    crm: { keep: 'CRM_SENTINEL' },
  });
  const corruptStore = createInviteTemplateStore({ storage: corruptStorage, now: testClock() });
  await assert.rejects(corruptStore.list(), /损坏/u);
  await assert.rejects(corruptStore.save(makeTemplate()), /损坏/u);
  assert.equal(corruptStorage.counts.set, 0);
  assert.equal(corruptStorage.counts.remove, 0);
  assert.deepEqual(corruptStorage.data.crm, { keep: 'CRM_SENTINEL' });

  const writeStorage = fakeStorage({ crm: { keep: 'CRM_SENTINEL' } });
  const writeStore = createInviteTemplateStore({ storage: writeStorage, now: testClock() });
  writeStorage.failSet(new Error('quota exceeded'));
  await assert.rejects(writeStore.save(makeTemplate()), /quota exceeded/u);
  assert.deepEqual(await writeStore.list(), []);
  assert.deepEqual(writeStorage.data.crm, { keep: 'CRM_SENTINEL' });

  const readStorage = fakeStorage();
  const readStore = createInviteTemplateStore({ storage: readStorage, now: testClock() });
  readStorage.failGet(new Error('storage unavailable'));
  await assert.rejects(readStore.list(), /storage unavailable/u);
  assert.equal(readStorage.counts.set, 0);
  assert.equal(readStorage.counts.remove, 0);
});

test('template validation bounds names, messages, IDs, selections, mode, and interval while allowing partial drafts', async () => {
  const store = createInviteTemplateStore({ storage: fakeStorage(), now: testClock() });
  const partial = await store.save(makeTemplate({
    name: '可稍后补全',
    configuration: { message: '', productIds: [], categoryIds: [], rightIds: [] },
  }));
  assert.equal(partial[0].configuration.productIds.length, 0);
  await assert.rejects(store.save(makeTemplate({ name: ' ' })), /name is required/u);
  await assert.rejects(store.save(makeTemplate({ name: '名'.repeat(81) })), /80/u);
  await assert.rejects(store.save(makeTemplate({ platform: 'weixin', configuration: { message: 'x'.repeat(201), productIds: [], categoryIds: [], rightIds: [] } })), /200/u);
  await assert.rejects(store.save(makeTemplate({ configuration: { message: 'x'.repeat(501), productIds: [], categoryIds: [], rightIds: [] } })), /500/u);
  await assert.rejects(store.save(makeTemplate({ configuration: { message: '', productIds: ['same', 'same'], categoryIds: [], rightIds: [] } })), /duplicate/u);
  await assert.rejects(store.save(makeTemplate({ configuration: { message: '', productIds: ['p'.repeat(257)], categoryIds: [], rightIds: [] } })), /too long/u);
  const fiveDouyinProducts = await store.save(makeTemplate({
    configuration: { message: '', productIds: ['p1', 'p2', 'p3', 'p4', 'p5'], categoryIds: [], rightIds: [] },
  }));
  assert.equal(fiveDouyinProducts.at(-1).configuration.productIds.length, 5);
  await assert.rejects(store.save(makeTemplate({
    configuration: { message: '', productIds: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'], categoryIds: [], rightIds: [] },
  })), /too many/u);
  const tenWeixinProducts = await store.save(makeTemplate({
    platform: 'weixin',
    configuration: { message: '', productIds: Array.from({ length: 10 }, (_, index) => `wx-${index}`), categoryIds: [], rightIds: [] },
  }));
  assert.equal(tenWeixinProducts.at(-1).configuration.productIds.length, 10);
  await assert.rejects(store.save(makeTemplate({
    platform: 'weixin',
    configuration: { message: '', productIds: Array.from({ length: 11 }, (_, index) => `wx-${index}`), categoryIds: [], rightIds: [] },
  })), /too many/u);
  const fiftyCategoriesAndRights = await store.save(makeTemplate({
    mode: 'category',
    configuration: {
      message: '', productIds: [],
      categoryIds: Array.from({ length: 50 }, (_, index) => `category-${index}`),
      rightIds: Array.from({ length: 50 }, (_, index) => `right-${index}`),
    },
  }));
  assert.equal(fiftyCategoriesAndRights.at(-1).configuration.categoryIds.length, 50);
  assert.equal(fiftyCategoriesAndRights.at(-1).configuration.rightIds.length, 50);
  await assert.rejects(store.save(makeTemplate({
    mode: 'category',
    configuration: { message: '', productIds: [], categoryIds: Array.from({ length: 51 }, (_, index) => `category-${index}`), rightIds: [] },
  })), /too many/u);
  await assert.rejects(store.save(makeTemplate({
    mode: 'category',
    configuration: { message: '', productIds: [], categoryIds: [], rightIds: Array.from({ length: 51 }, (_, index) => `right-${index}`) },
  })), /too many/u);
  await assert.rejects(store.save(makeTemplate({ platform: 'weixin', mode: 'category', configuration: { message: '', productIds: [], categoryIds: [], rightIds: [] } })), /视频号/u);
  await assert.rejects(store.save(makeTemplate({ intervalSeconds: 29 })), /30–300/u);
  await assert.rejects(store.save(makeTemplate({ intervalSeconds: 301 })), /30–300/u);
  await assert.rejects(store.save(makeTemplate({ intervalSeconds: 30.5 })), /30–300/u);
});
