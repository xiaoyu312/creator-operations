const PLATFORMS = new Set(['douyin', 'weixin']);
const MODES = new Set(['words', 'category']);
const FILTERS = new Set([
  'all',
  'platform-success',
  'manual-success',
  'failed',
  'unknown',
  'pending',
  'skipped',
]);
const TEMPLATE_STORAGE_KEY = 'creator-assistant-invite-templates-v1';
const MAX_TEMPLATES = 20;
const MAX_STORAGE_BYTES = 128 * 1024;
const MAX_ID_LENGTH = 256;
const CONTACT_KEYS = ['contactName', 'phone', 'wechat'];
const TEMPLATE_KEYS = ['id', 'name', 'platform', 'mode', 'includeContact', 'configuration', 'intervalSeconds', 'createdAt', 'updatedAt'];
const CONFIGURATION_KEYS = ['message', 'productIds', 'categoryIds', 'rightIds', ...CONTACT_KEYS];

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireRecord(value, label) {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function readText(value, label, { required = false, max = 1000, countCodePoints = false } = {}) {
  if (value == null) {
    if (required) throw new TypeError(`${label} is required`);
    return '';
  }
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  const text = value.trim();
  const length = countCodePoints ? Array.from(text).length : text.length;
  if (required && !text) throw new TypeError(`${label} is required`);
  if (length > max) throw new RangeError(`${label} exceeds ${max} characters`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
    throw new TypeError(`${label} contains control characters`);
  }
  return text;
}

function readIdentifier(value, label) {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  const id = value.trim();
  if (!id) throw new TypeError(`${label} is required`);
  if (id.length > MAX_ID_LENGTH) throw new RangeError(`${label} is too long`);
  if (/[\u0000-\u001f\u007f]/u.test(id)) throw new TypeError(`${label} contains control characters`);
  return id;
}

function readIdList(value, label, maxCount) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  if (value.length > maxCount) throw new RangeError(`${label} contains too many IDs`);
  const seen = new Set();
  const result = value.map((rawId) => {
    const id = readIdentifier(rawId, `${label} item`);
    if (seen.has(id)) throw new TypeError(`${label} must not contain duplicate IDs`);
    seen.add(id);
    return id;
  });
  return result;
}

function validatePlatform(value) {
  const platform = readText(value, 'platform', { required: true, max: 16 });
  if (!PLATFORMS.has(platform)) throw new TypeError('platform must be douyin or weixin');
  return platform;
}

function validateMode(value, platform) {
  const mode = readText(value, 'mode', { required: true, max: 16 });
  if (!MODES.has(mode)) throw new TypeError('mode must be words or category');
  if (platform === 'weixin' && mode !== 'words') throw new TypeError('视频号模板只支持话术模式。');
  return mode;
}

function validateInterval(value) {
  if (!Number.isInteger(value) || value < 30 || value > 300) {
    throw new RangeError('发送间隔需为 30–300 秒的整数。');
  }
  return value;
}

function validateConfiguration(input, platform, mode, includeContact) {
  const source = requireRecord(input, 'configuration');
  const messageMax = platform === 'weixin' ? 200 : 500;
  const message = readText(source.message, 'configuration.message', { max: messageMax, countCodePoints: true });
  if (mode === 'category' && message) throw new TypeError('品类模式不能保存自定义话术。');

  const productIds = readIdList(source.productIds, 'configuration.productIds', platform === 'douyin' ? 5 : 10);
  const categoryIds = readIdList(source.categoryIds, 'configuration.categoryIds', 50);
  const rightIds = readIdList(source.rightIds, 'configuration.rightIds', 50);
  if ((mode !== 'category' || platform !== 'douyin') && (categoryIds.length || rightIds.length)) {
    throw new TypeError('当前模板模式不能保存品类或合作权益。');
  }

  const configuration = { message, productIds, categoryIds, rightIds };
  if (!includeContact) return configuration;

  for (const key of CONTACT_KEYS) {
    if (!Object.hasOwn(source, key)) continue;
    const max = key === 'contactName' ? 120 : key === 'phone' ? 40 : 80;
    const value = readText(source[key], `configuration.${key}`, { max });
    if (key === 'phone' && value && !/^1[3-9]\d{9}$/u.test(value)) {
      throw new TypeError('手机号需为 11 位中国大陆手机号。');
    }
    if (key === 'wechat' && value && !/^[A-Za-z0-9_-]{6,20}$/u.test(value)) {
      throw new TypeError('微信号需为 6–20 位字母、数字、下划线或连字符。');
    }
    configuration[key] = value;
  }
  return configuration;
}

function normalizeTemplateFields(input) {
  const source = requireRecord(input, 'template');
  const name = readText(source.name, 'name', { required: true, max: 80, countCodePoints: true });
  const platform = validatePlatform(source.platform);
  const mode = validateMode(source.mode, platform);
  if (typeof source.includeContact !== 'boolean') throw new TypeError('includeContact must be a boolean');
  const configuration = validateConfiguration(source.configuration, platform, mode, source.includeContact);
  const intervalSeconds = validateInterval(source.intervalSeconds);
  return { name, platform, mode, includeContact: source.includeContact, configuration, intervalSeconds };
}

function normalizeStoredTemplate(value) {
  const source = requireRecord(value, 'stored template');
  assertExactKeys(source, TEMPLATE_KEYS, 'stored template');
  const id = readIdentifier(source.id, 'template.id');
  const fields = normalizeTemplateFields(source);
  const createdAt = readIsoTimestamp(source.createdAt, 'template.createdAt');
  const updatedAt = readIsoTimestamp(source.updatedAt, 'template.updatedAt');
  return { id, ...fields, createdAt, updatedAt };
}

function assertExactKeys(value, allowed, label) {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new TypeError(`${label} contains an unsupported field`);
  }
}

function assertAllowedConfigurationKeys(value) {
  const configuration = requireRecord(value, 'stored template configuration');
  assertExactKeys(configuration, CONFIGURATION_KEYS, 'stored template configuration');
}

function readIsoTimestamp(value, label) {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a timestamp`);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new TypeError(`${label} must be a valid ISO timestamp`);
  }
  return value;
}

function cloneTemplates(templates) {
  return templates.map((template) => ({
    ...template,
    configuration: { ...template.configuration,
      productIds: [...template.configuration.productIds],
      categoryIds: [...template.configuration.categoryIds],
      rightIds: [...template.configuration.rightIds],
    },
  }));
}

function serializeUtf8(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function timestampFrom(now) {
  const value = now();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('now must return a valid timestamp');
  return date.toISOString();
}

function makeTemplateId(existingIds) {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi || typeof cryptoApi.randomUUID !== 'function') {
    throw new Error('secure random template ID generation is unavailable');
  }
  let id;
  do {
    id = `invite-template-${cryptoApi.randomUUID()}`;
  } while (existingIds.has(id));
  return id;
}

function statusMatches(item, filter) {
  switch (filter) {
    case 'all': return true;
    case 'platform-success': return item?.status === 'succeeded' && item?.resolutionSource === 'platform';
    case 'manual-success': return item?.status === 'succeeded' && item?.resolutionSource === 'manual';
    case 'failed': return item?.status === 'failed';
    case 'unknown': return item?.status === 'unknown';
    case 'pending': return item?.status === 'pending' || item?.status === 'sending';
    case 'skipped': return item?.status === 'skipped';
    default: throw new TypeError('unsupported invite result filter');
  }
}

function csvText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function protectCsvFormula(value) {
  const text = csvText(value);
  return /^[\u0000-\u0020\uFEFF]*[=+\-@]/u.test(text) ? `'${text}` : text;
}

function preserveIdentifierText(value) {
  const text = csvText(value);
  if (/^\d+$/u.test(text) && (text.startsWith('0') || text.length >= 15)) return `'${text}`;
  return text;
}

function csvCell(value, { identifier = false } = {}) {
  const raw = identifier ? preserveIdentifierText(value) : csvText(value);
  const safe = protectCsvFormula(raw);
  return `"${safe.replace(/"/gu, '""')}"`;
}

function statusLabel(item) {
  if (item?.status === 'succeeded') {
    if (item.resolutionSource === 'platform') return '成功';
    if (item.resolutionSource === 'manual') return '成功';
    return '成功（来源未注明）';
  }
  return ({
    pending: '待处理',
    sending: '发送中',
    failed: '失败',
    unknown: '结果未明',
    skipped: '已跳过',
  })[item?.status] || csvText(item?.status);
}

function provenanceLabel(item) {
  if (item?.status === 'succeeded' && item?.resolutionSource === 'platform') return '平台确认';
  if ((item?.status === 'succeeded' || item?.status === 'skipped') && item?.resolutionSource === 'manual') return '人工确认';
  if (item?.status === 'unknown') return '结果未明';
  if (item?.status === 'succeeded') return '未注明';
  if (item?.resolutionSource === 'platform') return '平台确认';
  return '';
}

function csvRows(job, filter) {
  const items = Array.isArray(job?.items) ? job.items : [];
  return filterInviteResults(items, filter).map((item) => [
    csvCell(item?.externalId, { identifier: true }),
    csvCell(item?.name),
    csvCell(job?.platform),
    csvCell(statusLabel(item)),
    csvCell(provenanceLabel(item)),
    csvCell(item?.message),
    csvCell(item?.updatedAt),
  ]);
}

export function recipientReadiness(creator) {
  if (!isRecord(creator)) return { ready: false, reason: '达人资料无效。' };
  if (creator.platform !== 'douyin' && creator.platform !== 'weixin') {
    return { ready: false, reason: '当前平台暂不支持批量邀约。' };
  }
  try {
    readIdentifier(creator.externalId, 'externalId');
  } catch {
    return { ready: false, reason: '缺少有效的平台达人 ID。' };
  }
  const nativeKey = creator.platform === 'douyin' ? 'accountId' : 'talentAppid';
  const nativeLabel = creator.platform === 'douyin' ? '抖音账号 ID' : '视频号达人 AppID';
  try {
    const platformData = requireRecord(creator.platformData, 'platformData');
    readIdentifier(platformData[nativeKey], nativeKey);
  } catch {
    return { ready: false, reason: `缺少有效的${nativeLabel}。` };
  }
  return { ready: true, reason: '' };
}

export function applyInviteTemplate(template, options, products = options?.products) {
  const fields = normalizeTemplateFields(template);
  const current = requireRecord(options, 'options');
  if (fields.platform !== current.platform) {
    throw new Error(`该模板适用于 ${fields.platform === 'douyin' ? '抖音' : '视频号'}，当前平台不匹配。`);
  }
  if (fields.mode !== current.mode) throw new Error('该模板的邀约模式与当前平台设置不匹配。');
  if (current.ready !== true) {
    const reason = typeof current.reason === 'string' && current.reason.trim() ? current.reason.trim() : '请先读取当前平台的邀约选项。';
    throw new Error(reason);
  }
  const productCatalog = catalogIds(products, 'products');
  const categories = catalogIds(current.categories, 'categories');
  const rights = catalogIds(current.rights, 'rights');
  const warnings = [];
  const retainKnown = (ids, known, label) => ids.filter((id) => {
    if (known.has(id)) return true;
    warnings.push(`${label} ID「${id}」不在当前已加载列表中，已跳过。`);
    return false;
  });
  const configuration = {
    message: fields.configuration.message,
    productIds: retainKnown(fields.configuration.productIds, productCatalog, '商品'),
    categoryIds: retainKnown(fields.configuration.categoryIds, categories, '类目'),
    rightIds: retainKnown(fields.configuration.rightIds, rights, '权益'),
  };
  if (fields.includeContact) {
    for (const key of CONTACT_KEYS) {
      if (Object.hasOwn(fields.configuration, key)) configuration[key] = fields.configuration[key];
    }
  }
  return { configuration, intervalSeconds: fields.intervalSeconds, warnings };
}

function catalogIds(rows, label) {
  if (!Array.isArray(rows)) throw new TypeError(`options.${label} must be an array`);
  const ids = new Set();
  for (const row of rows) {
    const item = requireRecord(row, `options.${label} item`);
    ids.add(readIdentifier(item.id, `options.${label}.id`));
  }
  return ids;
}

export function filterInviteResults(items, filter = 'all') {
  if (!FILTERS.has(filter)) throw new TypeError('unsupported invite result filter');
  if (!Array.isArray(items)) throw new TypeError('invite results must be an array');
  return items.filter((item) => statusMatches(item, filter));
}

export function inviteResultsToCSV(job, filter = 'all') {
  if (!FILTERS.has(filter)) throw new TypeError('unsupported invite result filter');
  const header = ['达人 ID', '达人名称', '平台', '结果状态', '结果来源', '结果说明', '更新时间'];
  return `\uFEFF${[header.map((value) => csvCell(value)), ...csvRows(job, filter)].map((row) => row.join(',')).join('\r\n')}`;
}

export function createInviteTemplateStore({ storage, now = Date.now } = {}) {
  if (!storage || typeof storage.get !== 'function' || typeof storage.set !== 'function' || typeof storage.remove !== 'function') {
    throw new TypeError('storage must provide get, set, and remove methods');
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function');

  let queue = Promise.resolve();

  async function readTemplates() {
    const stored = await storage.get(TEMPLATE_STORAGE_KEY);
    if (!isRecord(stored)) throw new TypeError('邀约模板存储返回了无效数据。');
    const value = Object.hasOwn(stored, TEMPLATE_STORAGE_KEY) ? stored[TEMPLATE_STORAGE_KEY] : [];
    if (!Array.isArray(value)) throw new TypeError('邀约模板存储已损坏，未修改原有数据。');
    if (value.length > MAX_TEMPLATES) throw new RangeError('邀约模板存储超过 20 条上限，未修改原有数据。');
    const templates = value.map((template) => {
      assertAllowedConfigurationKeys(template?.configuration);
      return normalizeStoredTemplate(template);
    });
    const ids = new Set();
    for (const template of templates) {
      if (ids.has(template.id)) throw new TypeError('邀约模板存储包含重复 ID，未修改原有数据。');
      ids.add(template.id);
    }
    if (serializeUtf8(templates) > MAX_STORAGE_BYTES) throw new RangeError('邀约模板存储超过 128 KiB，未修改原有数据。');
    return templates;
  }

  function enqueueMutation(operation) {
    const pending = queue.then(operation);
    queue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  async function writeTemplates(templates) {
    const normalized = templates.map((template) => normalizeStoredTemplate(template));
    if (normalized.length > MAX_TEMPLATES) throw new RangeError('最多保存 20 个邀约模板。');
    if (serializeUtf8(normalized) > MAX_STORAGE_BYTES) throw new RangeError('邀约模板总大小不能超过 128 KiB。');
    await storage.set({ [TEMPLATE_STORAGE_KEY]: normalized });
    return cloneTemplates(normalized);
  }

  return {
    async list() {
      await queue;
      return cloneTemplates(await readTemplates());
    },

    save(template) {
      return enqueueMutation(async () => {
        const existing = await readTemplates();
        const source = requireRecord(template, 'template');
        let id;
        let createdAt;
        let replacingIndex = -1;
        if (Object.hasOwn(source, 'id')) {
          id = readIdentifier(source.id, 'template.id');
          replacingIndex = existing.findIndex((entry) => entry.id === id);
          if (replacingIndex < 0) throw new TypeError('要更新的邀约模板不存在。');
          createdAt = existing[replacingIndex].createdAt;
        } else {
          if (existing.length >= MAX_TEMPLATES) throw new RangeError('最多保存 20 个邀约模板，请先删除一个。');
          id = makeTemplateId(new Set(existing.map((entry) => entry.id)));
          createdAt = timestampFrom(now);
        }
        const fields = normalizeTemplateFields(source);
        const updatedAt = timestampFrom(now);
        const nextTemplate = { id, ...fields, createdAt, updatedAt };
        const next = existing.slice();
        if (replacingIndex < 0) next.push(nextTemplate);
        else next[replacingIndex] = nextTemplate;
        return writeTemplates(next);
      });
    },

    remove(idValue) {
      return enqueueMutation(async () => {
        const existing = await readTemplates();
        const id = readIdentifier(idValue, 'template.id');
        const index = existing.findIndex((entry) => entry.id === id);
        if (index < 0) throw new TypeError('要删除的邀约模板不存在。');
        const next = existing.filter((entry) => entry.id !== id);
        if (next.length === 0) await storage.remove(TEMPLATE_STORAGE_KEY);
        else return writeTemplates(next);
        return cloneTemplates(next);
      });
    },
  };
}
