import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMessage, platformFor } from '../background.mjs';

test('background serializes local writes and rejects cross-context mutations', async t => {
  let disk = {};
  globalThis.chrome = {
    runtime: { id: 'test-extension', getURL: path => `chrome-extension://test-extension/${path}` },
    storage: { local: { get: async key => ({ [key]: structuredClone(disk[key]) }), set: async value => { await new Promise(resolve => setTimeout(resolve, 2)); disk = { ...disk, ...structuredClone(value) }; } } },
    tabs: { query: async () => [], create: async () => {}, get: async () => ({ id: 1, url: 'https://example.com/' }) },
  };
  const ui = { id: 'test-extension', url: 'chrome-extension://test-extension/app.html' };
  const content = { id: 'test-extension', url: 'https://buyin.jinritemai.com/dashboard/servicehall/daren-square' };
  const creator = (id, platform = 'douyin') => ({ platform, externalId: id, name: `合成达人 ${id}` });

  await t.test('first run empty and platform matching is exact', async () => {
    assert.equal((await handleMessage({ type: 'GET_STATE' }, ui)).state.creators.length, 0);
    assert.equal(platformFor('https://buyin.jinritemai.com.evil.test/'), null);
    assert.equal(platformFor('http://buyin.jinritemai.com/'), null);
  });
  await t.test('parallel captures preserve both writes', async () => {
    await Promise.all(['001', '002'].map(id => handleMessage({ type: 'UPSERT_CREATORS', creators: [creator(id)] }, ui)));
    assert.equal((await handleMessage({ type: 'GET_STATE' }, ui)).state.creators.length, 2);
  });
  await t.test('unsupported page and foreign extension are rejected', async () => {
    await assert.rejects(handleMessage({ type: 'GET_STATE' }, { id: 'other', url: ui.url }));
    await assert.rejects(handleMessage({ type: 'UPSERT_CREATORS', creators: [] }, { ...content, url: 'https://evil.test/' }));
    await assert.rejects(handleMessage({ type: 'IMPORT_STATE', data: {} }, content));
    await assert.rejects(handleMessage({ type: 'UPDATE_CREATOR', id: 'douyin:001', patch: { stage: '已合作' } }, content));
  });
  await t.test('capture cannot alter owner or stage and filtered state hides contacts', async () => {
    await handleMessage({ type: 'UPDATE_CREATOR', id: 'douyin:001', patch: { owner: '测试负责人', stage: '有意向', contact: { wechat: 'synthetic-test-only' }, note: '保留跟进记录' } }, ui);
    const receipt = await handleMessage({ type: 'UPSERT_CREATORS', creators: [{ ...creator('001'), owner: '覆盖', stage: '未跟进', note: '覆盖', contact: {} }, creator('foreign', 'weixin')] }, content);
    assert.equal(Object.hasOwn(receipt, 'state'), false);
    const saved = (await handleMessage({ type: 'GET_STATE' }, ui)).state.creators.find(c => c.id === 'douyin:001');
    assert.equal(saved.owner, '测试负责人');
    assert.equal(saved.stage, '有意向');
    assert.equal(saved.note, '保留跟进记录');
    assert.equal(saved.contact.wechat, 'synthetic-test-only');
    const markers = (await handleMessage({ type: 'GET_STATE' }, content)).state.creators;
    assert.equal(markers.some(c => c.platform === 'weixin'), false);
    assert.equal(markers.some(c => c.contact), false);
  });
  await t.test('failed write or invalid import leaves prior state intact', async () => {
    const before = structuredClone(disk);
    await assert.rejects(handleMessage({ type: 'UPSERT_CREATORS', creators: [creator('ok'), creator(9007199254740992)] }, ui));
    assert.deepEqual(disk, before);
    await assert.rejects(handleMessage({ type: 'IMPORT_STATE', data: '{invalid' }, ui));
    assert.deepEqual(disk, before);
    await handleMessage({ type: 'UPSERT_CREATORS', creators: [creator('003')] }, ui);
    assert.equal((await handleMessage({ type: 'GET_STATE' }, ui)).state.creators.length, 3);
  });
  await t.test('no supported active tab produces actionable capture error', async () => {
    await assert.rejects(handleMessage({ type: 'GET_ACTIVE_CAPTURE' }, ui), /请先打开/);
  });
  delete globalThis.chrome;
});
