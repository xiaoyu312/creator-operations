import assert from 'node:assert/strict';
import test from 'node:test';

test('native invitation session query values never enter saved sources or bookmarks', () => {
  const raw = 'https://buyin.jinritemai.com/dashboard?category=beauty&ewid=private&web_did=private&seraph_did=private&x_pigeon_did=private&biz_magic=private';
  assert.equal(safePlatformUrl(raw), 'https://buyin.jinritemai.com/dashboard?category=beauty');
  assert.equal(normalizeCreator({ platform: 'douyin', externalId: 'fixture', name: '合成', sourceUrl: raw }).sourceUrl.includes('private'), false);
  assert.equal(normalizePreset({ platform: 'douyin', name: '合成书签', url: raw }).url.includes('private'), false);
});

import {
  createDrafts,
  emptyState,
  mergeCreators,
  mergeImport,
  normalizeCreator,
  normalizePreset,
  patchCreator,
  safePlatformUrl,
  toCSV,
  validateState,
} from '../lib/core.mjs';

function creator(overrides = {}) {
  return {
    platform: 'douyin',
    externalId: '1234567890123456789',
    name: '样例达人',
    profileUrl: 'https://www.douyin.com/user/creator-1',
    followers: 12000,
    category: '美妆',
    contact: { phone: '13800000000', wechat: 'wx-id', email: 'hello@example.com' },
    sourceUrl: 'https://www.douyin.com/search/beauty',
    capturedAt: '2026-10-15T09:00:00.000Z',
    updatedAt: '2026-10-15T09:00:00.000Z',
    owner: '林',
    stage: '有意向',
    tags: ['美妆', '重点'],
    note: '已确认档期',
    ...overrides,
  };
}

function state(overrides = {}) {
  return { ...emptyState(), ...overrides };
}

test('emptyState returns the versioned empty local data contract', () => {
  assert.deepEqual(emptyState(), {
    version: 1,
    creators: [],
    drafts: [],
    presets: [],
    settings: { owner: '我' },
  });
});

test('normalizeCreator derives string IDs, defaults known fields, and projects only whitelisted fields', () => {
  const result = normalizeCreator({
    ...creator({ externalId: 42, id: 'douyin:42' }),
    ignored: '<script>bad</script>',
    contact: { phone: ' 13800000000 ', unknown: 'nope' },
  });
  assert.equal(result.id, 'douyin:42');
  assert.equal(result.externalId, '42');
  assert.deepEqual(result.contact, { phone: '13800000000', wechat: '', email: '' });
  assert.equal(Object.hasOwn(result, 'ignored'), false);
});

test('unsafe numeric IDs and mismatched canonical IDs are rejected', () => {
  assert.throws(() => normalizeCreator(creator({ externalId: 9007199254740992 })), /safe integer/u);
  assert.throws(() => normalizeCreator(creator({ id: 'douyin:other' })), /platform/u);
  assert.equal(normalizeCreator(creator()).id, 'douyin:1234567890123456789');
});

test('safePlatformUrl permits platform HTTPS hosts, strips query credentials, and rejects unsafe origins', () => {
  assert.equal(
    safePlatformUrl('https://www.douyin.com/search?q=美妆&msToken=secret&access_token=abc&auth_token=private#top'),
    'https://www.douyin.com/search?q=%E7%BE%8E%E5%A6%86',
  );
  assert.equal(safePlatformUrl('https://xhslink.com/a/abc?keyword=护肤'), 'https://xhslink.com/a/abc?keyword=%E6%8A%A4%E8%82%A4');
  assert.equal(safePlatformUrl('https://buyin.jinritemai.com/author/list?token=private'), 'https://buyin.jinritemai.com/author/list');
  assert.equal(safePlatformUrl('https://cps.kwaixiaodian.com/creator/list'), 'https://cps.kwaixiaodian.com/creator/list');
  assert.equal(safePlatformUrl('https://pgy.xiaohongshu.com/buyers'), 'https://pgy.xiaohongshu.com/buyers');
  assert.equal(safePlatformUrl('https://channels.weixin.qq.com/creator/list'), 'https://channels.weixin.qq.com/creator/list');
  assert.equal(safePlatformUrl('https://douyin.com.attacker.example/user/1'), '');
  assert.equal(safePlatformUrl('http://www.douyin.com/user/1'), '');
  assert.equal(safePlatformUrl('https://user:pass@www.douyin.com/user/1'), '');
  assert.equal(safePlatformUrl('javascript:alert(1)'), '');
});

test('mergeCreators preserves richer existing business fields when a capture is blank', () => {
  const existing = normalizeCreator(creator());
  const incoming = {
    platform: 'douyin',
    externalId: existing.externalId,
    name: '样例达人更新',
    followers: null,
    contact: { phone: '', wechat: '', email: '' },
    stage: '未跟进',
    tags: [],
    owner: '',
    note: '',
  };
  const result = mergeCreators([existing], [incoming]);
  assert.equal(result.added, 0);
  assert.equal(result.updated, 1);
  assert.equal(result.creators[0].name, '样例达人更新');
  assert.equal(result.creators[0].followers, 12000);
  assert.deepEqual(result.creators[0].contact, existing.contact);
  assert.equal(result.creators[0].stage, '有意向');
  assert.deepEqual(result.creators[0].tags, ['美妆', '重点']);
  assert.equal(result.creators[0].owner, '林');
  assert.equal(result.creators[0].note, '已确认档期');
});

test('mergeCreators counts unique additions and adds incoming tags without losing prior tags', () => {
  const prior = normalizeCreator(creator());
  const result = mergeCreators([prior], [
    { ...creator(), tags: ['重点', '大促'] },
    { ...creator(), tags: ['美妆', '复核'] },
    creator({ externalId: 'another', id: undefined, name: '新达人' }),
  ]);
  assert.equal(result.added, 1);
  assert.equal(result.updated, 1);
  assert.deepEqual(result.creators[0].tags, ['美妆', '重点', '大促', '复核']);
  assert.equal(result.creators.length, 2);
});

test('platformData is whitelisted and blank metadata never erases known platform IDs', () => {
  const prior = normalizeCreator(creator({ platformData: { accountId: 'account-1', talentAppid: 'appid-1', searchAccount: 'douyin-unique', ignored: 'drop' } }));
  assert.deepEqual(prior.platformData, { accountId: 'account-1', talentAppid: 'appid-1', searchAccount: 'douyin-unique' });
  const merged = mergeCreators([prior], [{
    platform: 'douyin', externalId: prior.externalId, name: prior.name,
    platformData: { accountId: '', talentAppid: 'appid-2', searchAccount: '' },
  }]);
  assert.deepEqual(merged.creators[0].platformData, { accountId: 'account-1', talentAppid: 'appid-2', searchAccount: 'douyin-unique' });
  assert.throws(() => normalizeCreator(creator({ platformData: { accountId: 9007199254740992 } })), /safe integer/u);
});

test('older creator backups without platformData.searchAccount remain readable', () => {
  const older = normalizeCreator(creator({ platformData: { accountId: 'old-account', talentAppid: '' } }));
  assert.deepEqual(older.platformData, { accountId: 'old-account', talentAppid: '' });
  const explicitlyBlank = normalizeCreator(creator({ platformData: { accountId: '', talentAppid: '', searchAccount: '' } }));
  assert.equal(Object.hasOwn(explicitlyBlank.platformData, 'searchAccount'), false);
});

test('patchCreator accepts only editable fields and supports explicit field clearing', () => {
  const prior = normalizeCreator(creator());
  const updated = patchCreator(prior, {
    contact: { phone: '', wechat: 'new-wechat', secret: 'drop' },
    note: '',
    id: 'other:999',
    stage: '已合作',
    injected: true,
  });
  assert.equal(updated.id, prior.id);
  assert.equal(updated.contact.phone, '');
  assert.equal(updated.contact.wechat, 'new-wechat');
  assert.equal(Object.hasOwn(updated.contact, 'secret'), false);
  assert.equal(updated.note, '');
  assert.equal(updated.stage, '已合作');
  assert.equal(Object.hasOwn(updated, 'injected'), false);
});

test('normalizePreset requires a same-platform safe URL and normalizes credential query fields', () => {
  const preset = normalizePreset({
    name: '护肤搜索',
    platform: 'xiaohongshu',
    url: 'https://www.xiaohongshu.com/search_result?keyword=护肤&token=secret',
  });
  assert.match(preset.id, /^preset-/u);
  assert.equal(preset.url, 'https://www.xiaohongshu.com/search_result?keyword=%E6%8A%A4%E8%82%A4');
  assert.equal(normalizePreset({ name: '精选联盟', platform: 'douyin', url: 'https://buyin.jinritemai.com/author/list' }).platform, 'douyin');
  assert.throws(() => normalizePreset({ name: '错误平台', platform: 'douyin', url: 'https://www.kuaishou.com/' }), /platform URL/u);
});

test('createDrafts deduplicates repeated selections and reuses an existing pending invite', () => {
  const row = normalizeCreator(creator());
  const existing = [{
    id: 'draft-1', creatorId: row.id, text: '已经排队', status: 'pending',
    createdAt: '2026-10-15T09:00:00.000Z', updatedAt: '2026-10-15T09:00:00.000Z',
  }];
  const drafts = createDrafts([row], [row.id, row.id, row.id], '你好 {{name}}，平台：{{platform}}', existing);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].text, '已经排队');

  const next = createDrafts([row], [row.id, row.id], '你好 {name}，平台 {{platform}}', []);
  assert.equal(next.length, 1);
  assert.equal(next[0].text, '你好 样例达人，平台 抖音');
  assert.equal(next[0].creatorId, row.id);
  assert.equal(next[0].status, 'pending');
});

test('toCSV adds UTF-8 BOM, quotes fields, and prefixes spreadsheet formulas', () => {
  const output = toCSV([creator({ name: '=HYPERLINK("https://evil.example")', note: ' @SUM(A1:A2)' })]);
  assert.equal(output.charCodeAt(0), 0xfeff);
  assert.match(output, /"'=HYPERLINK\(""https:\/\/evil\.example""\)"/u);
  assert.match(output, /"'@SUM\(A1:A2\)"/u);
  assert.match(output, /\r\n/u);
});

test('toCSV protects long numeric IDs and leading-zero phone numbers as spreadsheet text', () => {
  const output = toCSV([creator({
    externalId: '0012345678901234567',
    contact: { phone: '01234567890', wechat: '', email: '' },
  })]);
  assert.match(output, /,"'0012345678901234567",/u);
  assert.match(output, /,"'01234567890",/u);
});

test('validateState normalizes state and rejects malformed or duplicate rows', () => {
  const valid = validateState(state({ creators: [creator({ extra: 'ignored' })] }));
  assert.equal(valid.creators.length, 1);
  assert.equal(Object.hasOwn(valid.creators[0], 'extra'), false);
  assert.throws(() => validateState(state({ creators: [creator(), { ...creator(), name: 8 }] })), /name must be a string/u);
  assert.throws(() => validateState(state({ creators: [creator(), creator()] })), /duplicate creator/u);
});

test('mergeImport merges records atomically and refuses an import containing any bad row', () => {
  const current = state({ creators: [creator({ contact: { phone: '13800000000', wechat: 'wx-id', email: '' } })] });
  const before = structuredClone(current);
  const incoming = state({ creators: [
    creator({ name: '导入更新', contact: { phone: '', wechat: '', email: '' }, note: '' }),
    creator({ externalId: 'new-id', id: undefined, name: '新达人', contact: {} }),
  ] });
  const merged = mergeImport(current, incoming);
  assert.equal(merged.creators.length, 2);
  assert.equal(merged.creators[0].name, '导入更新');
  assert.equal(merged.creators[0].contact.phone, '13800000000');
  assert.equal(current.creators.length, before.creators.length);
  assert.throws(() => mergeImport(current, state({ creators: [creator({ externalId: 'new-id', id: undefined }), { ...creator(), name: 42 }] })), /name must be a string/u);
  assert.deepEqual(current, before);
});

test('mergeImport keeps one pending invitation per creator when merging backups', () => {
  const row = normalizeCreator(creator());
  const current = state({ drafts: [{
    id: 'draft-local', creatorId: row.id, text: '本地邀约', status: 'pending',
    createdAt: '2026-10-15T09:00:00.000Z', updatedAt: '2026-10-15T09:00:00.000Z',
  }] });
  const imported = state({ drafts: [{
    id: 'draft-imported', creatorId: row.id, text: '备份中的旧邀约', status: 'pending',
    createdAt: '2026-10-14T09:00:00.000Z', updatedAt: '2026-10-14T09:00:00.000Z',
  }] });
  const merged = mergeImport(current, imported);
  assert.equal(merged.drafts.length, 1);
  assert.equal(merged.drafts[0].id, 'draft-local');
  assert.equal(merged.drafts[0].text, '本地邀约');
});

test('mergeImport enforces the backup byte cap and maximum creator count', () => {
  const oversized = `{"padding":"${'x'.repeat(5 * 1024 * 1024)}"}`;
  assert.throws(() => mergeImport(emptyState(), oversized), /5 MB/u);
  const tooMany = state({ creators: Array.from({ length: 5001 }, (_, index) => creator({ externalId: `id-${index}`, id: undefined })) });
  assert.throws(() => mergeImport(emptyState(), tooMany), /5000/u);
});

test('validateState and mergeImport reject a compact state above 5 MB atomically', () => {
  const oversized = state({ creators: Array.from({ length: 1000 }, (_, index) => ({
    platform: 'douyin',
    externalId: `bulk-${index}`,
    name: '样例',
    note: 'x'.repeat(5000),
  })) });
  assert.throws(() => validateState(oversized), /exceeds 5 MB/u);
  const current = emptyState();
  assert.throws(() => mergeImport(current, oversized), /5 MB/u);
  assert.deepEqual(current, emptyState());
});
