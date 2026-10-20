import test from 'node:test';
import assert from 'node:assert/strict';

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}/`;
const TEMPLATE_KEY = 'creator-assistant-invite-templates-v1';
const CRM_KEY = 'creator-assistant-v1';
const ui = { id: EXTENSION_ID, url: EXTENSION_ORIGIN + 'auto-invite.html' };
const content = { id: EXTENSION_ID, url: 'https://buyin.jinritemai.com/dashboard/servicehall/daren-square?token=private-source-token' };
let importSequence = 0;

function fixture({ access, omitAccess = false, neverAccess = false, failTemplateWrite = false } = {}) {
  const disk = {};
  const session = {};
  const calls = { templateReads: 0, templateWrites: 0, templateRemoves: 0 };

  function createChrome() {
    const local = {
      get: async key => {
        if (key === TEMPLATE_KEY) calls.templateReads++;
        return Object.hasOwn(disk, key) ? { [key]: structuredClone(disk[key]) } : {};
      },
      set: async value => {
        if (Object.hasOwn(value, TEMPLATE_KEY)) {
          calls.templateWrites++;
          if (failTemplateWrite) throw new Error('synthetic template storage failure');
        }
        Object.assign(disk, structuredClone(value));
      },
      remove: async key => {
        if (key === TEMPLATE_KEY) calls.templateRemoves++;
        delete disk[key];
      },
    };
    if (!omitAccess) local.setAccessLevel = neverAccess ? () => new Promise(() => {}) : access || (async () => {});
    return {
      runtime: {
        id: EXTENSION_ID,
        getURL: path => EXTENSION_ORIGIN + path,
        getManifest: () => ({ version: '0.3.0' }),
        onMessage: { addListener() {} },
      },
      storage: {
        local,
        session: {
          get: async key => ({ [key]: structuredClone(session[key]) }),
          set: async value => Object.assign(session, structuredClone(value)),
          setAccessLevel: async () => {},
        },
      },
      tabs: { query: async () => [], get: async id => ({ id, url: content.url, title: 'synthetic platform' }), create: async () => {} },
      alarms: { onAlarm: { addListener() {} }, create: async () => {}, clear: async () => true },
      scripting: { executeScript: async () => [] },
    };
  }

  return {
    disk,
    calls,
    async loadBackground() {
      globalThis.chrome = createChrome();
      return import(`../background.mjs?invite-template-test=${++importSequence}`);
    },
    close() { delete globalThis.chrome; },
  };
}

function basicTemplate(overrides = {}) {
  return {
    name: '测试邀约模板',
    platform: 'weixin',
    mode: 'words',
    includeContact: false,
    configuration: { message: '合成话术', productIds: [], categoryIds: [], rightIds: [] },
    intervalSeconds: 30,
    ...overrides,
  };
}

test('invite templates are extension-UI-only and denied content attempts log no payload', async () => {
  const f = fixture();
  try {
    const background = await f.loadBackground();
    const privateTemplate = basicTemplate({
      name: 'private-template-name-marker',
      configuration: { message: 'private-template-message-marker', productIds: [], categoryIds: [], rightIds: [] },
    });
    for (const message of [
      { type: 'INVITE_TEMPLATES_LIST' },
      { type: 'INVITE_TEMPLATE_SAVE', template: privateTemplate },
      { type: 'INVITE_TEMPLATE_DELETE', id: 'private-template-id-marker' },
    ]) {
      await assert.rejects(background.handleMessage(message, content), /不能读取或修改本地邀约模板/);
    }
    await assert.rejects(background.handleMessage({ type: 'INVITE_TEMPLATES_LIST' }, { ...ui, id: 'other-extension' }));
    await assert.rejects(background.handleMessage({ type: 'INVITE_TEMPLATE_SAVE', template: privateTemplate }, { ...ui, url: 'https://example.test/' }));
    assert.equal(f.calls.templateReads, 0);
    assert.equal(f.calls.templateWrites, 0);
    assert.equal(f.disk[TEMPLATE_KEY], undefined);

    const { bundle } = await background.handleMessage({ type: 'DIAGNOSTICS_EXPORT' }, ui);
    const serialized = JSON.stringify(bundle);
    for (const operation of ['INVITE_TEMPLATES_LIST', 'INVITE_TEMPLATE_SAVE', 'INVITE_TEMPLATE_DELETE']) {
      assert.equal(bundle.entries.some(entry => entry.operation === operation && entry.code === 'ACCESS_DENIED'), true, operation);
    }
    for (const marker of ['private-template-name-marker', 'private-template-message-marker', 'private-template-id-marker', 'private-source-token']) {
      assert.equal(serialized.includes(marker), false, marker);
    }
  } finally { f.close(); }
});

test('extension UI can persist, update, reload, and delete templates in the separate key', async () => {
  const f = fixture();
  try {
    let background = await f.loadBackground();
    assert.deepEqual((await background.handleMessage({ type: 'INVITE_TEMPLATES_LIST' }, ui)).templates, []);
    const first = await background.handleMessage({ type: 'INVITE_TEMPLATE_SAVE', template: basicTemplate() }, ui);
    assert.equal(first.templates.length, 1);
    assert.ok(first.templates[0].id);
    assert.ok(first.templates[0].createdAt);
    assert.ok(first.templates[0].updatedAt);
    const second = await background.handleMessage({ type: 'INVITE_TEMPLATE_SAVE', template: basicTemplate({ name: '第二套模板' }) }, ui);
    assert.equal(second.templates.length, 2);

    background = await f.loadBackground();
    const reloaded = await background.handleMessage({ type: 'INVITE_TEMPLATES_LIST' }, ui);
    assert.deepEqual(reloaded.templates.map(template => template.name), ['测试邀约模板', '第二套模板']);
    const removed = await background.handleMessage({ type: 'INVITE_TEMPLATE_DELETE', id: first.templates[0].id }, ui);
    assert.deepEqual(removed.templates.map(template => template.name), ['第二套模板']);
    const emptied = await background.handleMessage({ type: 'INVITE_TEMPLATE_DELETE', id: removed.templates[0].id }, ui);
    assert.deepEqual(emptied.templates, []);
    assert.equal(f.calls.templateWrites >= 2, true);
    assert.equal(f.calls.templateRemoves, 1);
    assert.equal(f.disk[TEMPLATE_KEY], undefined);
    assert.equal(f.disk[CRM_KEY], undefined);

    const { bundle } = await background.handleMessage({ type: 'DIAGNOSTICS_EXPORT' }, ui);
    const serialized = JSON.stringify(bundle);
    assert.equal(bundle.entries.some(entry => entry.operation === 'INVITE_TEMPLATE_SAVE'), true);
    assert.equal(bundle.entries.some(entry => entry.operation === 'INVITE_TEMPLATE_DELETE'), true);
    for (const marker of ['测试邀约模板', '合成话术', '第二套模板']) assert.equal(serialized.includes(marker), false, marker);
  } finally { f.close(); }
});

test('contact values are removed when an update disables contact saving', async () => {
  const f = fixture();
  try {
    const background = await f.loadBackground();
    const input = basicTemplate({
      platform: 'douyin',
      includeContact: true,
      configuration: {
        message: '合成话术', productIds: ['product-1'], categoryIds: [], rightIds: [],
        contactName: 'synthetic-contact-marker', phone: '13800000000', wechat: 'demo_wechat',
      },
    });
    const saved = await background.handleMessage({ type: 'INVITE_TEMPLATE_SAVE', template: input }, ui);
    assert.equal(saved.templates[0].configuration.phone, '13800000000');
    const updated = await background.handleMessage({ type: 'INVITE_TEMPLATE_SAVE', template: {
      ...saved.templates[0],
      includeContact: false,
    } }, ui);
    assert.equal(Object.hasOwn(updated.templates[0].configuration, 'phone'), false);
    assert.equal(Object.hasOwn(updated.templates[0].configuration, 'wechat'), false);
    assert.equal(Object.hasOwn(updated.templates[0].configuration, 'contactName'), false);
  } finally { f.close(); }
});

test('template storage isolation failure times out and does not block CRM or invite status', async () => {
  const f = fixture({ neverAccess: true });
  try {
    const background = await f.loadBackground();
    const started = Date.now();
    await assert.rejects(background.handleMessage({ type: 'INVITE_TEMPLATES_LIST' }, ui), /无法安全隔离/);
    assert.ok(Date.now() - started < 1500);
    assert.equal(f.calls.templateReads, 0);
    assert.equal(f.disk[TEMPLATE_KEY], undefined);

    const saved = await background.handleMessage({ type: 'UPSERT_CREATORS', creators: [{ platform: 'douyin', externalId: 'synthetic-creator', name: '合成达人' }] }, ui);
    assert.equal(saved.state.creators.length, 1);
    const invite = await background.handleMessage({ type: 'INVITE_STATUS' }, ui);
    assert.equal(invite.job, null);
  } finally { f.close(); }
});

test('template write failure leaves CRM state usable and does not mutate its key', async () => {
  const f = fixture({ failTemplateWrite: true });
  try {
    const background = await f.loadBackground();
    const before = structuredClone(f.disk[CRM_KEY]);
    await assert.rejects(background.handleMessage({ type: 'INVITE_TEMPLATE_SAVE', template: basicTemplate() }, ui));
    assert.equal(f.disk[TEMPLATE_KEY], undefined);
    assert.deepEqual(f.disk[CRM_KEY], before);
    const saved = await background.handleMessage({ type: 'UPSERT_CREATORS', creators: [{ platform: 'douyin', externalId: 'still-works', name: '合成达人' }] }, ui);
    assert.equal(saved.state.creators.length, 1);
  } finally { f.close(); }
});
