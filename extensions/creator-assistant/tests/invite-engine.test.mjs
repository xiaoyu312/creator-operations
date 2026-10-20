import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeCreator } from '../lib/core.mjs';
import {
  beginNext,
  completeItem,
  normalizeJob,
  pauseJob,
  prepareJob,
  recoverJob,
  resolveUnknown,
  startJob,
} from '../lib/invite-engine.mjs';

function creator(platform = 'douyin', externalId = 'creator-1', options = {}) {
  const platformData = platform === 'douyin'
    ? { accountId: options.accountId ?? `account-${externalId}`, searchAccount: options.searchAccount }
    : { talentAppid: options.talentAppid ?? `appid-${externalId}` };
  return normalizeCreator({
    platform,
    externalId,
    name: options.name ?? `达人 ${externalId}`,
    platformData,
  });
}

function configuredDescriptor(platform = 'douyin', options = {}) {
  return {
    ready: true,
    platform,
    contextId: 'shop-context-1',
    templateId: 'configuration-1',
    expiresAt: new Date(Date.now() + (options.ttlMs ?? 60 * 60 * 1000)).toISOString(),
    referenceRecipientId: options.referenceRecipientId ?? '',
    summary: {
      accountLabel: '测试店铺',
      message: '你好，希望邀请你体验新品。',
      productIds: ['spu-1'],
      contactName: '商务联系人',
      phoneMasked: '138****0000',
      wechatMasked: 'wx****1234',
      cardVersion: 'words',
      productNames: ['样例商品'],
    },
    // Unrecognized values are deliberately excluded from the normalized local job.
    session: { token: 'ephemeral-token' },
    cookie: 'never-store-this',
  };
}

function prepare(creators, ids, options = {}) {
  const platform = options.platform ?? creators[0]?.platform ?? 'douyin';
  return prepareJob({
    platform,
    tabId: options.tabId ?? 4,
    template: options.template ?? configuredDescriptor(platform, options),
    creators,
    ids,
    intervalSeconds: options.intervalSeconds,
  });
}

function readyJob(count = 2, options = {}) {
  const platform = options.platform ?? 'douyin';
  const creators = Array.from({ length: count }, (_, index) => creator(platform, `creator-${index + 1}`));
  return prepare(creators, creators.map((row) => row.id), options);
}

test('prepareJob builds a v2 queue from the configured descriptor and includes the first selected recipient', () => {
  const selected = creator('douyin', 'selected', { searchAccount: 'douyin-search-name' });
  const otherPlatform = creator('weixin', 'wrong-platform');
  const missing = creator('douyin', 'missing', { accountId: '' });
  const duplicateDestination = creator('douyin', 'duplicate', { accountId: 'account-selected' });
  const template = configuredDescriptor('douyin');
  const job = prepareJob({
    platform: 'douyin',
    tabId: 8,
    template,
    creators: [selected, otherPlatform, missing, duplicateDestination],
    ids: [selected.id, missing.id, otherPlatform.id, duplicateDestination.id, 'douyin:deleted', selected.id],
  });
  assert.equal(job.status, 'prepared');
  assert.equal(job.flowVersion, 2);
  assert.equal(job.contextId, 'shop-context-1');
  assert.equal(job.intervalSeconds, 30);
  assert.equal(job.tabId, 8);
  assert.deepEqual(job.items.map((item) => item.creatorId), [selected.id]);
  assert.equal(job.items[0].accountId, 'account-selected');
  assert.equal(job.items[0].searchAccount, 'douyin-search-name');
  assert.equal(normalizeJob(JSON.parse(JSON.stringify(job))).items[0].searchAccount, 'douyin-search-name');
  assert.equal(job.excluded.length, 5);
  assert.deepEqual(job.summary.productNames, ['样例商品']);
  assert.equal(job.summary.accountLabel, '测试店铺');
  assert.equal(normalizeJob(JSON.parse(JSON.stringify(job))).summary.accountLabel, '测试店铺');
  assert.equal(JSON.stringify(job).includes('ephemeral-token'), false);
  assert.equal(JSON.stringify(job).includes('never-store-this'), false);
});

test('prepareJob supports Weixin identifiers and excludes recipients without talentAppid', () => {
  const valid = creator('weixin', 'finder-valid', { talentAppid: 'appid-valid' });
  const missing = creator('weixin', 'finder-missing', { talentAppid: '' });
  const template = configuredDescriptor('weixin');
  const job = prepare([valid, missing], [valid.id, missing.id], { platform: 'weixin', template });
  assert.deepEqual(job.items.map((item) => item.creatorId), [valid.id]);
  assert.equal(job.items[0].talentAppid, 'appid-valid');
  assert.match(job.excluded.find((entry) => entry.creatorId === missing.id).reason, /talentAppid/u);
});

test('prepareJob rejects incomplete descriptors, unsupported platforms, mismatches, and expired settings', () => {
  const row = creator();
  assert.throws(() => prepare([row], [row.id], { template: { ...configuredDescriptor(), ready: false, reason: '商品列表未加载' } }), /商品列表未加载/u);
  assert.throws(() => prepareJob({ platform: 'kuaishou', tabId: 1, template: configuredDescriptor('kuaishou'), creators: [], ids: [] }), /douyin and weixin/u);
  assert.throws(() => prepare([row], [row.id], { template: configuredDescriptor('weixin') }), /does not match/u);
  assert.throws(() => prepare([row], [row.id], { template: configuredDescriptor('douyin', { ttlMs: -1000 }) }), /已过期/u);
  assert.throws(() => prepare([row], [row.id], { template: { ...configuredDescriptor(), contextId: '' } }), /contextId is required/u);
  assert.throws(() => prepareJob({ platform: 'douyin', tabId: -1, template: configuredDescriptor(), creators: [row], ids: [row.id] }), /tabId/u);
});

test('prepareJob validates interval bounds, requires recipients, and never truncates batches over 50', () => {
  const row = creator();
  assert.throws(() => prepare([row], [row.id], { intervalSeconds: 29 }), /30 to 300/u);
  assert.throws(() => prepare([row], [row.id], { intervalSeconds: 301 }), /30 to 300/u);
  assert.throws(() => prepare([row], [], {}), /至少选择/u);
  const fiftyOne = Array.from({ length: 51 }, (_, index) => creator('douyin', `many-${index}`));
  assert.throws(() => prepare(fiftyOne, fiftyOne.map((entry) => entry.id)), /超过 50 位/u);
});

test('prepareJob rejects a recipient count that cannot finish before settings expire', () => {
  const creators = Array.from({ length: 4 }, (_, index) => creator('douyin', `ttl-${index}`));
  assert.throws(() => prepare(creators, creators.map((row) => row.id), { ttlMs: 3.5 * 60 * 1000 }), /最多支持 3 位/u);
  const one = prepare([creators[0]], [creators[0].id], { ttlMs: 3.5 * 60 * 1000 });
  assert.equal(one.items.length, 1);
});

test('prepareJob enforces at least 30 seconds and honors the 300 second maximum in TTL capacity', () => {
  const row = creator();
  assert.throws(() => prepare([row], [row.id], { intervalSeconds: 30, ttlMs: 59_000 }), /最多支持 0 位/u);
  const withMaxInterval = prepare([row], [row.id], { intervalSeconds: 300, ttlMs: 6 * 60 * 1000 });
  assert.equal(withMaxInterval.intervalSeconds, 300);
});

test('startJob requires exact approval token, prepared or paused state, and fresh settings', () => {
  const job = readyJob(1);
  assert.throws(() => startJob(job, 'wrong-token'), /令牌不匹配/u);
  assert.throws(() => startJob({ ...job, expiresAt: new Date(Date.now() - 1000).toISOString() }, job.approvalToken), /过期/u);
  const running = startJob(job, job.approvalToken);
  assert.equal(running.status, 'running');
  assert.throws(() => startJob(running, job.approvalToken), /无法从 running/u);
  const paused = pauseJob(running, '人工暂停');
  assert.equal(startJob(paused, job.approvalToken).status, 'running');
});

test('start and each scheduled begin recheck remaining TTL capacity', () => {
  const job = readyJob(2);
  const nearDeadline = { ...job, expiresAt: new Date(Date.now() + 10_000).toISOString() };
  assert.throws(() => startJob(nearDeadline, job.approvalToken), /最多支持 0 位/u);
  const running = startJob(job, job.approvalToken);
  const delayed = { ...running, expiresAt: new Date(Date.now() + 10_000).toISOString() };
  const result = beginNext(delayed);
  assert.equal(result.job.status, 'paused');
  assert.equal(result.item, null);
  assert.equal(result.job.items[0].status, 'pending');
});

test('beginNext persists sending before work, prevents concurrent starts, and completes an empty queue', () => {
  const job = readyJob(1);
  const running = startJob(job, job.approvalToken);
  const first = beginNext(running);
  assert.equal(first.job.items[0].status, 'sending');
  assert.equal(first.item.status, 'sending');
  assert.throws(() => beginNext(first.job), /正在邀约/u);
  const success = completeItem(first.job, first.item.id, { status: 'succeeded', code: 0, message: '平台确认成功' });
  assert.equal(success.items[0].status, 'succeeded');
  assert.equal(success.items[0].resolutionSource, 'platform');
  assert.equal(success.status, 'completed');
  assert.equal(beginNext(success).item, null);
});

test('completeItem requires a persisted sending item and explicit code 0 for platform success', () => {
  const job = readyJob(1);
  const running = startJob(job, job.approvalToken);
  const { job: sending, item } = beginNext(running);
  assert.throws(() => completeItem(sending, item.id, { status: 'succeeded', message: 'ok' }), /code 0/u);
  assert.throws(() => completeItem(running, item.id, { status: 'failed', message: 'denied' }), /当前状态/u);
  assert.throws(() => completeItem(sending, 'missing', { status: 'failed' }), /没有找到/u);
  assert.throws(() => completeItem(sending, item.id, { status: 'skipped' }), /succeeded, failed, or unknown/u);
});

test('explicit failure pauses and resuming never retries the failed recipient', () => {
  const job = readyJob(2);
  const running = startJob(job, job.approvalToken);
  const { job: sending, item } = beginNext(running);
  const failed = completeItem(sending, item.id, { status: 'failed', code: 403, message: '平台拒绝' });
  assert.equal(failed.status, 'paused');
  assert.equal(failed.items[0].status, 'failed');
  assert.equal(failed.items[0].resolutionSource, 'platform');
  const resumed = startJob(failed, job.approvalToken);
  const next = beginNext(resumed);
  assert.notEqual(next.item.creatorId, item.creatorId);
});

test('unknown outcome pauses without retry and only manual resolution can clear it', () => {
  const job = readyJob(2);
  const running = startJob(job, job.approvalToken);
  const first = beginNext(running);
  const unknown = completeItem(first.job, first.item.id, { status: 'unknown', message: 'network timeout' });
  assert.equal(unknown.status, 'paused');
  assert.equal(unknown.items[0].status, 'unknown');
  assert.equal(unknown.items[0].resolutionSource, '');
  assert.throws(() => startJob(unknown, job.approvalToken), /人工核对/u);
  assert.throws(() => resolveUnknown(unknown, first.item.id, 'failed'), /succeeded or skipped/u);
  const resolved = resolveUnknown(unknown, first.item.id, 'succeeded');
  assert.equal(resolved.status, 'paused');
  assert.equal(resolved.items[0].resolutionSource, 'manual');
  assert.match(resolved.items[0].message, /手动标记/u);
  const resumed = startJob(resolved, job.approvalToken);
  const second = beginNext(resumed);
  assert.notEqual(second.item.creatorId, first.item.creatorId);
});

test('pause prevents the next send while still recording an in-flight result', () => {
  const job = readyJob(2);
  const running = startJob(job, job.approvalToken);
  const first = beginNext(running);
  const paused = pauseJob(first.job, '用户暂停');
  const completed = completeItem(paused, first.item.id, { status: 'succeeded', code: 0 });
  assert.equal(completed.status, 'paused');
  assert.equal(completed.items[0].status, 'succeeded');
  assert.equal(completed.items[1].status, 'pending');
  assert.throws(() => beginNext(completed), /未处于运行/u);
});

test('recoverJob converts in-flight sending to unknown and never resumes automatically', () => {
  const job = readyJob(2);
  const running = startJob(job, job.approvalToken);
  const sending = beginNext(running);
  const recovered = recoverJob(sending.job);
  assert.equal(recovered.status, 'paused');
  assert.equal(recovered.items[0].status, 'unknown');
  assert.equal(recovered.items[0].resolutionSource, '');
  assert.throws(() => startJob(recovered, job.approvalToken), /人工核对/u);
  const resolved = resolveUnknown(recovered, sending.item.id, 'skipped');
  assert.equal(resolved.status, 'paused');
  assert.equal(resolved.items[0].status, 'skipped');
  assert.equal(resolved.items[0].resolutionSource, 'manual');
  assert.equal(startJob(resolved, job.approvalToken).status, 'running');

  const recoveredWithoutSending = recoverJob(startJob(job, job.approvalToken));
  assert.equal(recoveredWithoutSending.status, 'paused');
  assert.equal(recoveredWithoutSending.items[0].status, 'pending');
});

test('normalizeJob projects only bounded fields and rejects duplicate or invalid state', () => {
  const job = readyJob(2);
  const normalized = normalizeJob({ ...job, session: { token: 'must-not-survive' }, templateBody: 'must-not-survive' });
  assert.equal(Object.hasOwn(normalized, 'session'), false);
  assert.equal(Object.hasOwn(normalized, 'templateBody'), false);
  assert.equal(JSON.stringify(normalized).includes('must-not-survive'), false);
  const legacyCompleted = normalizeJob({
    ...job,
    status: 'completed',
    flowVersion: undefined,
    contextId: undefined,
    summary: { ...job.summary, accountLabel: '' },
    items: job.items.map((item) => ({ ...item, status: 'succeeded', resolutionSource: undefined })),
  });
  assert.equal(legacyCompleted.flowVersion, 1);
  assert.equal(legacyCompleted.contextId, '');
  assert.equal(legacyCompleted.items[0].resolutionSource, '');
  assert.equal(Object.hasOwn(legacyCompleted.summary, 'accountLabel'), false);
  assert.equal(recoverJob(legacyCompleted).status, 'completed');
  assert.throws(() => normalizeJob({ ...job, status: 'sending' }), /unsupported job status/u);
  assert.throws(() => normalizeJob({ ...job, items: [job.items[0], { ...job.items[1], accountId: job.items[0].accountId }] }), /duplicate invite destination/u);
  assert.throws(() => normalizeJob({ ...job, intervalSeconds: 29 }), /30 to 300/u);
  assert.throws(() => normalizeJob({ ...job, items: [{ ...job.items[0], searchAccount: 123 }] }), /searchAccount must be a string/u);
  assert.throws(() => normalizeJob({ ...job, items: Array.from({ length: 51 }, (_, index) => ({ ...job.items[0], id: `item-${index}`, creatorId: `douyin:creator-${index}`, externalId: `creator-${index}`, accountId: `account-${index}` })) }), /1 to 50/u);
  assert.throws(() => normalizeJob({ ...job, contextId: '' }), /requires contextId/u);
  const tooLarge = {
    ...job,
    excluded: Array.from({ length: 4000 }, (_, index) => ({ creatorId: `unknown-${index}`, name: 'x'.repeat(200), reason: 'y'.repeat(300) })),
  };
  assert.throws(() => normalizeJob(tooLarge), /1 MB/u);
});

test('legacy v1 prepared and running jobs remain readable but can never resume', () => {
  const job = readyJob(2);
  const legacy = {
    ...job,
    flowVersion: undefined,
    contextId: undefined,
    status: 'prepared',
  };
  const normalized = normalizeJob(legacy);
  assert.equal(normalized.flowVersion, 1);
  assert.equal(normalized.status, 'prepared');
  assert.throws(() => startJob(normalized, job.approvalToken), /旧版任务已停止/u);
  assert.throws(() => beginNext({ ...normalized, status: 'running' }), /旧版任务已停止/u);

  const running = normalizeJob({
    ...legacy,
    status: 'running',
    items: legacy.items.map((item, index) => {
      const { searchAccount, ...oldItem } = item;
      return index === 0 ? { ...oldItem, status: 'sending' } : oldItem;
    }),
  });
  assert.equal(running.items[0].searchAccount ?? '', '');
  const recovered = recoverJob(running);
  assert.equal(recovered.status, 'paused');
  assert.equal(recovered.items[0].status, 'unknown');
  assert.equal(recovered.items[1].status, 'pending');
  assert.match(recovered.pauseReason, /旧版任务已停止/u);
  assert.match(recovered.items[0].message, /结果未知/u);
  assert.throws(() => startJob(recovered, job.approvalToken), /旧版任务已停止/u);
});
