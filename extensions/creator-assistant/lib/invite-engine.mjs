import { normalizeCreator } from './core.mjs';

const PLATFORMS = new Set(['douyin', 'weixin']);
const JOB_STATUSES = new Set(['prepared', 'running', 'paused', 'completed']);
const ITEM_STATUSES = new Set(['pending', 'sending', 'succeeded', 'failed', 'unknown', 'skipped']);
const RESOLUTION_SOURCES = new Set(['', 'platform', 'manual']);
const MAX_RECIPIENTS = 50;
const MAX_SELECTED = 5000;
const MAX_JOB_BYTES = 1 * 1024 * 1024;
const MAX_SUMMARY_PRODUCTS = 100;

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireRecord(value, label) {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

function readString(value, label, { required = false, max = 1000 } = {}) {
  if (value == null) {
    if (required) throw new TypeError(`${label} is required`);
    return '';
  }
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  const text = value.trim();
  if (required && !text) throw new TypeError(`${label} is required`);
  if (text.length > max) throw new RangeError(`${label} is too long`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
    throw new TypeError(`${label} contains control characters`);
  }
  return text;
}

function readIdentifier(value, label, { optional = false } = {}) {
  if (value == null) {
    if (optional) return '';
    throw new TypeError(`${label} is required`);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a safe integer or a string`);
    value = String(value);
  }
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  const id = value.trim();
  if (!id && !optional) throw new TypeError(`${label} is required`);
  if (id.length > 256) throw new RangeError(`${label} is too long`);
  if (/[\u0000-\u001f\u007f]/u.test(id)) throw new TypeError(`${label} contains control characters`);
  return id;
}

function readOptionalStringId(value, label) {
  if (value == null) return '';
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  return readIdentifier(value, label, { optional: true });
}

function readDate(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a date string`);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new TypeError(`${label} must be a valid date`);
  return new Date(timestamp).toISOString();
}

function readPlatform(value) {
  const platform = readString(value, 'platform', { required: true, max: 32 });
  if (!PLATFORMS.has(platform)) throw new TypeError('automatic invites support only douyin and weixin');
  return platform;
}

function readInteger(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${label} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function makeId(prefix) {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi || typeof cryptoApi.randomUUID !== 'function') throw new Error('secure random ID generation is unavailable');
  return `${prefix}-${cryptoApi.randomUUID()}`;
}

function nowIso() {
  return new Date().toISOString();
}

function executableCapacity(expiresAt, intervalSeconds, now = Date.now()) {
  return Math.max(0, Math.floor((Date.parse(expiresAt) - now) / ((intervalSeconds + 30) * 1000)));
}

function normalizeSummary(value) {
  const summary = value == null ? {} : requireRecord(value, 'template.summary');
  const rawProductIds = summary.productIds == null ? [] : requireArray(summary.productIds, 'template.summary.productIds');
  if (rawProductIds.length > MAX_SUMMARY_PRODUCTS) throw new RangeError('template summary has too many products');
  const productIds = [];
  const seen = new Set();
  for (const productId of rawProductIds) {
    const id = readIdentifier(productId, 'template.summary.productId');
    if (!seen.has(id)) {
      seen.add(id);
      productIds.push(id);
    }
  }
  const normalized = {
    message: readString(summary.message, 'template.summary.message', { max: 3000 }),
    productIds,
    contactName: readString(summary.contactName, 'template.summary.contactName', { max: 120 }),
    phoneMasked: readString(summary.phoneMasked, 'template.summary.phoneMasked', { max: 80 }),
    wechatMasked: readString(summary.wechatMasked, 'template.summary.wechatMasked', { max: 120 }),
    cardVersion: readString(summary.cardVersion, 'template.summary.cardVersion', { max: 80 }),
  };
  const accountLabel = readString(summary.accountLabel, 'template.summary.accountLabel', { max: 120 });
  if (accountLabel) normalized.accountLabel = accountLabel;
  if (summary.productNames != null) {
    const productNames = requireArray(summary.productNames, 'template.summary.productNames');
    if (productNames.length > MAX_SUMMARY_PRODUCTS || productNames.length !== productIds.length) {
      throw new RangeError('template summary productNames must match productIds');
    }
    normalized.productNames = productNames.map((name) => readString(name, 'template.summary.productName', { required: true, max: 200 }));
  }
  return normalized;
}

function normalizeItem(value, platform) {
  const item = requireRecord(value, 'job item');
  const externalId = readIdentifier(item.externalId, 'item.externalId');
  const creatorId = readIdentifier(item.creatorId, 'item.creatorId');
  if (creatorId !== `${platform}:${externalId}`) throw new TypeError('item.creatorId must match platform and externalId');
  const status = readString(item.status, 'item.status', { required: true, max: 32 });
  if (!ITEM_STATUSES.has(status)) throw new TypeError(`unsupported item status: ${status}`);
  const searchAccount = readOptionalStringId(item.searchAccount, 'item.searchAccount');
  const normalized = {
    id: readIdentifier(item.id, 'item.id'),
    creatorId,
    name: readString(item.name, 'item.name', { required: true, max: 200 }),
    externalId,
    accountId: readIdentifier(item.accountId, 'item.accountId', { optional: true }),
    talentAppid: readIdentifier(item.talentAppid, 'item.talentAppid', { optional: true }),
    status,
    resolutionSource: readString(item.resolutionSource, 'item.resolutionSource', { max: 16 }),
    message: readString(item.message, 'item.message', { max: 1000 }),
    updatedAt: readDate(item.updatedAt, 'item.updatedAt'),
  };
  if (searchAccount) normalized.searchAccount = searchAccount;
  if (!RESOLUTION_SOURCES.has(normalized.resolutionSource)) throw new TypeError('item.resolutionSource is invalid');
  if (['pending', 'sending', 'unknown'].includes(status) && normalized.resolutionSource !== '') {
    throw new TypeError(`${status} item cannot have a resolution source`);
  }
  if (normalized.resolutionSource === 'platform' && !['succeeded', 'failed'].includes(status)) {
    throw new TypeError('platform resolutionSource requires a platform result');
  }
  if (normalized.resolutionSource === 'manual' && !['succeeded', 'skipped'].includes(status)) {
    throw new TypeError('manual resolutionSource requires a manual resolution');
  }
  if (platform === 'douyin' && !normalized.accountId) throw new TypeError('Douyin item requires accountId');
  if (platform === 'weixin' && !normalized.talentAppid) throw new TypeError('Weixin item requires talentAppid');
  return normalized;
}

function normalizeExcluded(value) {
  const excluded = requireRecord(value, 'excluded item');
  return {
    creatorId: readIdentifier(excluded.creatorId, 'excluded.creatorId'),
    name: readString(excluded.name, 'excluded.name', { max: 200 }),
    reason: readString(excluded.reason, 'excluded.reason', { required: true, max: 300 }),
  };
}

function assertJobBound(job) {
  if (new TextEncoder().encode(JSON.stringify(job)).byteLength > MAX_JOB_BYTES) {
    throw new RangeError('invite job exceeds the 1 MB state limit');
  }
  return job;
}

export function normalizeJob(value) {
  const raw = requireRecord(value, 'job');
  const platform = readPlatform(raw.platform);
  const flowVersion = raw.flowVersion == null ? 1 : readInteger(raw.flowVersion, 'flowVersion', 1, 2);
  if (![1, 2].includes(flowVersion)) throw new TypeError('flowVersion must be 1 or 2');
  if (flowVersion === 2 && (typeof raw.contextId !== 'string' || !raw.contextId.trim())) {
    throw new TypeError('flowVersion 2 requires contextId');
  }
  const contextId = flowVersion === 1 && (raw.contextId == null || raw.contextId === '')
    ? ''
    : readIdentifier(raw.contextId, 'contextId');
  const status = readString(raw.status, 'job.status', { required: true, max: 32 });
  if (!JOB_STATUSES.has(status)) throw new TypeError(`unsupported job status: ${status}`);
  const rawItems = requireArray(raw.items, 'job.items');
  const rawExcluded = raw.excluded == null ? [] : requireArray(raw.excluded, 'job.excluded');
  if (rawItems.length < 1 || rawItems.length > MAX_RECIPIENTS) throw new RangeError(`job must contain 1 to ${MAX_RECIPIENTS} recipients`);
  if (rawExcluded.length > MAX_SELECTED) throw new RangeError(`job may contain at most ${MAX_SELECTED} exclusions`);

  const items = rawItems.map((item) => normalizeItem(item, platform));
  const itemIds = new Set();
  const creatorIds = new Set();
  const destinations = new Set();
  let sendingCount = 0;
  for (const item of items) {
    if (itemIds.has(item.id)) throw new TypeError(`duplicate item id: ${item.id}`);
    if (creatorIds.has(item.creatorId)) throw new TypeError(`duplicate creator in job: ${item.creatorId}`);
    itemIds.add(item.id);
    creatorIds.add(item.creatorId);
    const destinationId = platform === 'douyin' ? item.accountId : item.externalId;
    if (destinations.has(destinationId)) throw new TypeError(`duplicate invite destination: ${destinationId}`);
    destinations.add(destinationId);
    if (item.status === 'sending') sendingCount += 1;
  }
  if (sendingCount > 1) throw new TypeError('job cannot have more than one sending item');
  if (status === 'prepared' && items.some((item) => item.status !== 'pending')) {
    throw new TypeError('prepared job items must all be pending');
  }
  if (status === 'running' && items.some((item) => item.status === 'unknown')) {
    throw new TypeError('running job cannot contain unresolved unknown items');
  }
  if (status === 'completed' && items.some((item) => ['pending', 'sending', 'unknown'].includes(item.status))) {
    throw new TypeError('completed job cannot contain unfinished or unknown items');
  }

  const job = {
    id: readIdentifier(raw.id, 'job.id'),
    flowVersion,
    contextId,
    platform,
    tabId: readInteger(raw.tabId, 'tabId', 0, Number.MAX_SAFE_INTEGER),
    templateId: readIdentifier(raw.templateId, 'job.templateId'),
    summary: normalizeSummary(raw.summary),
    expiresAt: readDate(raw.expiresAt, 'job.expiresAt'),
    createdAt: readDate(raw.createdAt, 'job.createdAt'),
    updatedAt: readDate(raw.updatedAt, 'job.updatedAt'),
    status,
    approvalToken: readString(raw.approvalToken, 'approvalToken', { required: true, max: 256 }),
    intervalSeconds: readInteger(raw.intervalSeconds, 'intervalSeconds', 30, 300),
    items,
    excluded: rawExcluded.map(normalizeExcluded),
    pauseReason: readString(raw.pauseReason, 'pauseReason', { max: 500 }),
  };
  return assertJobBound(job);
}

function addExcluded(excluded, creatorId, name, reason) {
  excluded.push({ creatorId, name, reason });
}

export function prepareJob({ platform: rawPlatform, tabId, template, creators, ids, intervalSeconds } = {}) {
  const platform = readPlatform(rawPlatform);
  const numericTabId = readInteger(tabId, 'tabId', 0, Number.MAX_SAFE_INTEGER);
  const interval = intervalSeconds == null ? 30 : readInteger(intervalSeconds, 'intervalSeconds', 30, 300);
  const descriptor = requireRecord(template, 'configured descriptor');
  if (descriptor.ready !== true) throw new Error(readString(descriptor.reason, 'configured descriptor.reason', { max: 300 }) || '邀约设置尚未就绪，请检查商品与联系信息。');
  if (readPlatform(descriptor.platform) !== platform) throw new TypeError('configured descriptor platform does not match selected platform');
  const templateId = readIdentifier(descriptor.templateId, 'configured descriptor.templateId');
  const contextId = readIdentifier(descriptor.contextId, 'configured descriptor.contextId');
  const expiresAt = readDate(descriptor.expiresAt, 'configured descriptor.expiresAt');
  if (Date.parse(expiresAt) <= Date.now()) throw new Error('邀约设置已过期，请重新读取当前页面选项。');
  const referenceRecipientId = readIdentifier(descriptor.referenceRecipientId, 'configured descriptor.referenceRecipientId', { optional: true });
  const summary = normalizeSummary(descriptor.summary);
  const sourceCreators = requireArray(creators, 'creators');
  if (sourceCreators.length > MAX_SELECTED) throw new RangeError(`creator directory may contain at most ${MAX_SELECTED} rows`);
  const selectedIds = requireArray(ids, 'ids');
  if (selectedIds.length > MAX_SELECTED) throw new RangeError(`at most ${MAX_SELECTED} recipients may be selected`);
  const byId = new Map();
  for (const rawCreator of sourceCreators) {
    const creator = normalizeCreator(rawCreator);
    if (byId.has(creator.id)) throw new TypeError(`duplicate creator in directory: ${creator.id}`);
    byId.set(creator.id, creator);
  }

  const items = [];
  const excluded = [];
  const selected = new Set();
  const destinations = new Set();
  const timestamp = nowIso();
  for (const rawId of selectedIds) {
    const creatorId = readIdentifier(rawId, 'selected creator id');
    if (selected.has(creatorId)) {
      addExcluded(excluded, creatorId, '', '重复选择，已跳过。');
      continue;
    }
    selected.add(creatorId);
    const creator = byId.get(creatorId);
    if (!creator) {
      addExcluded(excluded, creatorId, '', '达人不在当前本地达人库中。');
      continue;
    }
    if (creator.platform !== platform) {
      addExcluded(excluded, creator.id, creator.name, '达人所属平台与当前邀约平台不一致。');
      continue;
    }
    const accountId = creator.platformData.accountId;
    const talentAppid = creator.platformData.talentAppid;
    if (platform === 'douyin' && !accountId) {
      addExcluded(excluded, creator.id, creator.name, '缺少抖音 account_id，无法确认邀约对象。');
      continue;
    }
    if (platform === 'weixin' && !talentAppid) {
      addExcluded(excluded, creator.id, creator.name, '缺少视频号 talentAppid，无法确认邀约对象。');
      continue;
    }
    const destinationId = platform === 'douyin' ? accountId : creator.externalId;
    if (referenceRecipientId && destinationId === referenceRecipientId) {
      addExcluded(excluded, creator.id, creator.name, '此达人是配置模板的参考对象，已从批次中排除。');
      continue;
    }
    if (destinations.has(destinationId)) {
      addExcluded(excluded, creator.id, creator.name, '平台目标 ID 与本批次其他达人重复。');
      continue;
    }
    if (items.length >= MAX_RECIPIENTS) {
      throw new RangeError(`本批符合条件的达人超过 ${MAX_RECIPIENTS} 位，请缩小名单后再准备。`);
    }
    destinations.add(destinationId);
    items.push({
      id: makeId('invite-item'),
      creatorId: creator.id,
      name: creator.name,
      externalId: creator.externalId,
      accountId,
      searchAccount: creator.platformData.searchAccount,
      talentAppid,
      status: 'pending',
      resolutionSource: '',
      message: '',
      updatedAt: timestamp,
    });
  }
  if (items.length === 0) {
    const detail = excluded.slice(0, 3).map((entry) => entry.reason).join('；');
    throw new Error(detail ? `没有可邀约的达人：${detail}` : '请至少选择一位符合条件的达人。');
  }
  const capacity = executableCapacity(expiresAt, interval);
  if (items.length > capacity) {
    throw new RangeError(`官方邀约配置剩余时间最多支持 ${Math.max(0, capacity)} 位达人；请减少名单或重新读取配置。`);
  }

  return normalizeJob({
    id: makeId('invite-job'),
    flowVersion: 2,
    contextId,
    platform,
    tabId: numericTabId,
    templateId,
    summary,
    expiresAt,
    createdAt: timestamp,
    updatedAt: timestamp,
    status: 'prepared',
    approvalToken: makeId('approval'),
    intervalSeconds: interval,
    items,
    excluded,
  });
}

export function startJob(value, approvalToken) {
  const job = normalizeJob(value);
  if (job.flowVersion !== 2) throw new Error('旧版任务已停止，请重新设置。');
  const token = readString(approvalToken, 'approvalToken', { required: true, max: 256 });
  if (token !== job.approvalToken) throw new Error('审批令牌不匹配，未启动邀约队列。');
  if (!['prepared', 'paused'].includes(job.status)) throw new Error(`无法从 ${job.status} 状态启动邀约队列。`);
  if (Date.parse(job.expiresAt) <= Date.now()) throw new Error('邀约设置已过期，请重新设置批次。');
  if (job.items.some((item) => item.status === 'unknown')) throw new Error('存在结果未知的邀约，请先人工核对并处理。');
  if (job.items.some((item) => item.status === 'sending')) throw new Error('存在尚未返回结果的邀约，请等待结果或恢复后人工核对。');
  const pendingCount = job.items.filter((item) => item.status === 'pending').length;
  const capacity = executableCapacity(job.expiresAt, job.intervalSeconds);
  if (pendingCount > capacity) throw new Error(`配置剩余时间最多支持 ${capacity} 位待邀约达人，请减少名单或重新读取配置。`);
  job.status = 'running';
  job.updatedAt = nowIso();
  job.pauseReason = '';
  return normalizeJob(job);
}

export function pauseJob(value, reason = '已暂停。') {
  const job = normalizeJob(value);
  if (job.status === 'completed') throw new Error('已完成的邀约队列不能暂停。');
  job.status = 'paused';
  job.pauseReason = readString(reason, 'pause reason', { max: 500 }) || '已暂停。';
  job.updatedAt = nowIso();
  return normalizeJob(job);
}

export function beginNext(value) {
  const job = normalizeJob(value);
  if (job.status === 'completed') return { job, item: null };
  if (job.flowVersion !== 2) throw new Error('旧版任务已停止，请重新设置。');
  if (job.status !== 'running') throw new Error('邀约队列未处于运行状态。');
  if (job.items.some((item) => item.status === 'sending')) throw new Error('已有一位达人正在邀约，不能重复开始。');
  const item = job.items.find((candidate) => candidate.status === 'pending');
  if (!item) {
    job.status = 'completed';
    job.pauseReason = '';
    job.updatedAt = nowIso();
    return { job: normalizeJob(job), item: null };
  }
  const pendingCount = job.items.filter((candidate) => candidate.status === 'pending').length;
  const capacity = executableCapacity(job.expiresAt, job.intervalSeconds);
  if (pendingCount > capacity) {
    job.status = 'paused';
    job.pauseReason = `邀约设置剩余时间最多支持 ${capacity} 位待邀约达人；请重新读取页面选项或缩小剩余名单。`;
    job.updatedAt = nowIso();
    return { job: normalizeJob(job), item: null };
  }
  const updatedAt = nowIso();
  item.status = 'sending';
  item.message = '';
  item.updatedAt = updatedAt;
  job.updatedAt = updatedAt;
  const normalizedJob = normalizeJob(job);
  return { job: normalizedJob, item: { ...normalizedJob.items.find((candidate) => candidate.id === item.id) } };
}

export function completeItem(value, itemId, result) {
  const job = normalizeJob(value);
  const targetId = readIdentifier(itemId, 'itemId');
  const outcome = requireRecord(result, 'result');
  const status = readString(outcome.status, 'result.status', { required: true, max: 32 });
  if (!['succeeded', 'failed', 'unknown'].includes(status)) throw new TypeError('result.status must be succeeded, failed, or unknown');
  if (status === 'succeeded' && outcome.code !== 0) throw new Error('platform success requires an explicit code 0 result');
  const item = job.items.find((candidate) => candidate.id === targetId);
  if (!item) throw new Error('没有找到正在处理的邀约对象。');
  if (item.status !== 'sending') throw new Error(`邀约对象当前状态为 ${item.status}，不能写入发送结果。`);
  const defaults = {
    succeeded: '平台已明确返回邀约成功。',
    failed: '平台明确拒绝邀约，队列已暂停。',
    unknown: '发送结果未知，请先在平台核对；系统不会自动重试。',
  };
  item.status = status;
  item.resolutionSource = status === 'unknown' ? '' : 'platform';
  item.message = readString(outcome.message, 'result.message', { max: 1000 }) || defaults[status];
  item.updatedAt = nowIso();
  job.updatedAt = item.updatedAt;
  if (status === 'failed' || status === 'unknown') {
    job.status = 'paused';
    job.pauseReason = item.message;
  } else if (job.status === 'running' && !job.items.some((candidate) => candidate.status === 'pending')) {
    job.status = 'completed';
    job.pauseReason = '';
  }
  return normalizeJob(job);
}

export function recoverJob(value) {
  const job = normalizeJob(value);
  if (job.flowVersion === 1) {
    const recoveredAt = nowIso();
    for (const item of job.items) {
      if (item.status === 'sending') {
        item.status = 'unknown';
        item.resolutionSource = '';
        item.message = '旧版任务恢复时仍在发送，结果未知；请先在平台核对。系统不会自动重试。';
        item.updatedAt = recoveredAt;
      }
    }
    if (job.status !== 'completed') {
      job.status = 'paused';
      job.pauseReason = '旧版任务已停止，请重新设置。';
      job.updatedAt = recoveredAt;
    }
    return normalizeJob(job);
  }
  const recoveredAt = nowIso();
  let foundSending = false;
  for (const item of job.items) {
    if (item.status === 'sending') {
      item.status = 'unknown';
      item.resolutionSource = '';
      item.message = '工作进程恢复时仍在发送，结果未知；请先在平台核对。系统不会自动重试。';
      item.updatedAt = recoveredAt;
      foundSending = true;
    }
  }
  if (job.status === 'running' || foundSending) {
    job.status = 'paused';
    job.pauseReason = foundSending
      ? '恢复时发现发送结果未知，请人工核对并处理后再恢复。'
      : '工作进程已恢复，队列已暂停；请手动确认后继续。';
    job.updatedAt = recoveredAt;
  }
  return normalizeJob(job);
}

export function resolveUnknown(value, itemId, status) {
  const job = normalizeJob(value);
  const targetId = readIdentifier(itemId, 'itemId');
  const resolution = readString(status, 'resolution status', { required: true, max: 32 });
  if (!['succeeded', 'skipped'].includes(resolution)) throw new TypeError('unknown item can only be resolved as succeeded or skipped');
  const item = job.items.find((candidate) => candidate.id === targetId);
  if (!item) throw new Error('没有找到邀约对象。');
  if (item.status !== 'unknown') throw new Error('只有结果未知的邀约可以人工处理。');
  item.status = resolution;
  item.resolutionSource = 'manual';
  item.message = resolution === 'succeeded'
    ? '用户已在平台核对并手动标记为成功。'
    : '用户已在平台核对并手动标记为跳过。';
  item.updatedAt = nowIso();
  job.pauseReason = '结果未知项已人工处理；请再次确认名单后手动恢复队列。';
  job.updatedAt = item.updatedAt;
  job.status = 'paused';
  return normalizeJob(job);
}
