const VERSION = 1;
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const MAX_CREATORS = 5000;
const MAX_TEXT = 5000;

const PLATFORMS = new Set(['douyin', 'kuaishou', 'xiaohongshu', 'weixin']);
const STAGES = new Set(['未跟进', '已联系', '有意向', '已寄样', '已合作', '暂不合作']);
const DRAFT_STATUSES = new Set(['pending', 'copied', 'done', 'skipped']);
const PLATFORM_LABELS = { douyin: '抖音', kuaishou: '快手', xiaohongshu: '小红书', weixin: '视频号' };
const PATCH_FIELDS = new Set([
  'name', 'profileUrl', 'followers', 'category', 'contact', 'sourceUrl', 'owner', 'stage', 'tags', 'note',
]);
const SENSITIVE_QUERY_KEY = /^(?:(?:(?:access|refresh|id|auth|bearer)[_-]?)?token|auth[_-]?(?:token|code|key)|authorization|session(?:[_-]?(?:id|key|token))?|sid(?:[_-]?(?:guard|token))?|cookie|password|passwd|secret|client[_-]?secret|signature|sign|ticket|credential|csrf(?:[_-]?token)?|nonce|api[_-]?key|key|ms[_-]?token|odin[_-]?tt|verify[_-]?fp|webid|device[_-]?id|ttwid|uid[_-]?tt(?:[_-]?ss)?|passport[_-]?csrf[_-]?token|s[_-]?v[_-]?web[_-]?id|a[_-]?bogus|x[_-]?bogus|ewid|web_did|seraph_did|x_pigeon_did|biz_magic)$/i;
const PLATFORM_HOSTS = {
  douyin: ['douyin.com', 'iesdouyin.com', 'buyin.jinritemai.com'],
  kuaishou: ['kuaishou.com', 'gifshow.com', 'cps.kwaixiaodian.com'],
  xiaohongshu: ['xiaohongshu.com', 'xhslink.com', 'pgy.xiaohongshu.com'],
  weixin: ['weixin.qq.com', 'mp.weixin.qq.com', 'channels.weixin.qq.com'],
};

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

function readString(value, label, { required = false, max = MAX_TEXT, trim = true } = {}) {
  if (value == null) {
    if (required) throw new TypeError(`${label} is required`);
    return '';
  }
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  const result = trim ? value.trim() : value;
  if (required && result.length === 0) throw new TypeError(`${label} is required`);
  if (result.length > max) throw new RangeError(`${label} is too long`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(result)) {
    throw new TypeError(`${label} contains control characters`);
  }
  return result;
}

function readIdentifier(value, label, { optional = false } = {}) {
  if (value == null) {
    if (optional) return '';
    throw new TypeError(`${label} is required`);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`${label} must be a safe integer or a string`);
    }
    value = String(value);
  }
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  const result = value.trim();
  if (!result && !optional) throw new TypeError(`${label} is required`);
  if (result.length > 256) throw new RangeError(`${label} is too long`);
  if (/[:\u0000-\u001f\u007f]/u.test(result) && label === 'externalId') {
    throw new TypeError(`${label} contains invalid characters`);
  }
  return result;
}

function readDate(value, label, fallback = true) {
  if (value == null || value === '') {
    if (!fallback) throw new TypeError(`${label} is required`);
    return new Date().toISOString();
  }
  if (typeof value !== 'string') throw new TypeError(`${label} must be an ISO date string`);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new TypeError(`${label} must be a valid date`);
  return new Date(timestamp).toISOString();
}

function normalizePlatform(value) {
  const platform = readString(value, 'platform', { required: true, max: 32 });
  if (!PLATFORMS.has(platform)) throw new TypeError(`unsupported platform: ${platform}`);
  return platform;
}

function hostMatchesPlatform(hostname, platform) {
  const host = hostname.toLowerCase().replace(/\.$/u, '');
  const roots = platform ? PLATFORM_HOSTS[platform] ?? [] : Object.values(PLATFORM_HOSTS).flat();
  return roots.some((root) => host === root || host.endsWith(`.${root}`));
}

function sanitizePlatformUrl(value, platform) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) return '';
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return '';
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return '';
  if (!hostMatchesPlatform(url.hostname, platform)) return '';

  for (const key of [...url.searchParams.keys()]) {
    if (SENSITIVE_QUERY_KEY.test(key)) url.searchParams.delete(key);
  }
  url.hash = '';
  return url.toString();
}

function normalizeTags(value) {
  if (value == null) return [];
  const tags = requireArray(value, 'tags');
  if (tags.length > 100) throw new RangeError('tags has too many items');
  const result = [];
  const seen = new Set();
  for (const item of tags) {
    const tag = readString(item, 'tag', { max: 80 });
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      result.push(tag);
    }
  }
  return result;
}

function normalizeContact(value) {
  if (value == null) return { phone: '', wechat: '', email: '' };
  const contact = requireRecord(value, 'contact');
  return {
    phone: readString(contact.phone, 'contact.phone', { max: 120 }),
    wechat: readString(contact.wechat, 'contact.wechat', { max: 120 }),
    email: readString(contact.email, 'contact.email', { max: 254 }),
  };
}

function normalizePlatformData(value) {
  if (value == null) return { accountId: '', talentAppid: '' };
  const data = requireRecord(value, 'platformData');
  const normalized = {
    accountId: readIdentifier(data.accountId, 'platformData.accountId', { optional: true }),
    talentAppid: readIdentifier(data.talentAppid, 'platformData.talentAppid', { optional: true }),
  };
  const searchAccount = readIdentifier(data.searchAccount, 'platformData.searchAccount', { optional: true });
  if (searchAccount) normalized.searchAccount = searchAccount;
  return normalized;
}

function validateOptionalUrl(value, label, platform) {
  const raw = readString(value, label, { max: 4096 });
  if (!raw) return '';
  const safe = sanitizePlatformUrl(raw, platform);
  if (!safe) throw new TypeError(`${label} must use a supported HTTPS platform URL`);
  return safe;
}

function makeId(prefix) {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return `${prefix}-${cryptoApi.randomUUID()}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function utf8ByteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

function assertStateSize(state) {
  const bytes = utf8ByteLength(JSON.stringify(state));
  if (bytes > MAX_IMPORT_BYTES) throw new RangeError('normalized state exceeds 5 MB');
  return state;
}

function normalizeDraft(input) {
  const draft = requireRecord(input, 'draft');
  const id = readIdentifier(draft.id, 'draft.id');
  const creatorId = readIdentifier(draft.creatorId, 'draft.creatorId');
  const text = readString(draft.text, 'draft.text', { max: MAX_TEXT });
  const status = readString(draft.status, 'draft.status', { required: true, max: 32 });
  if (!DRAFT_STATUSES.has(status)) throw new TypeError(`unsupported draft status: ${status}`);
  return {
    id,
    creatorId,
    text,
    status,
    createdAt: readDate(draft.createdAt, 'draft.createdAt'),
    updatedAt: readDate(draft.updatedAt, 'draft.updatedAt'),
  };
}

export function normalizePreset(input) {
  const preset = requireRecord(input, 'preset');
  const platform = normalizePlatform(preset.platform);
  const name = readString(preset.name, 'preset.name', { required: true, max: 120 });
  const url = validateOptionalUrl(preset.url, 'preset.url', platform);
  if (!url) throw new TypeError('preset.url must use a supported HTTPS platform URL');
  const id = preset.id == null || preset.id === '' ? makeId('preset') : readIdentifier(preset.id, 'preset.id');
  return {
    id,
    name,
    platform,
    url,
    createdAt: readDate(preset.createdAt, 'preset.createdAt'),
  };
}

export function emptyState() {
  return { version: VERSION, creators: [], drafts: [], presets: [], settings: { owner: '我' } };
}

export function safePlatformUrl(url) {
  return sanitizePlatformUrl(url);
}

export function normalizeCreator(input) {
  const creator = requireRecord(input, 'creator');
  const platform = normalizePlatform(creator.platform);
  const externalId = readIdentifier(creator.externalId, 'externalId');
  const id = `${platform}:${externalId}`;
  if (creator.id != null && readIdentifier(creator.id, 'id') !== id) {
    throw new TypeError('id must equal platform + ":" + externalId');
  }
  const stage = creator.stage == null || creator.stage === ''
    ? '未跟进'
    : readString(creator.stage, 'stage', { max: 32 });
  if (!STAGES.has(stage)) throw new TypeError(`unsupported creator stage: ${stage}`);

  let followers = null;
  if (creator.followers != null) {
    if (typeof creator.followers !== 'number' || !Number.isSafeInteger(creator.followers) || creator.followers < 0) {
      throw new TypeError('followers must be a non-negative safe integer or null');
    }
    followers = creator.followers;
  }

  return {
    id,
    platform,
    externalId,
    name: readString(creator.name, 'name', { required: true, max: 200 }),
    profileUrl: validateOptionalUrl(creator.profileUrl, 'profileUrl', platform),
    followers,
    category: readString(creator.category, 'category', { max: 120 }),
    contact: normalizeContact(creator.contact),
    platformData: normalizePlatformData(creator.platformData),
    sourceUrl: validateOptionalUrl(creator.sourceUrl, 'sourceUrl', platform),
    capturedAt: readDate(creator.capturedAt, 'capturedAt'),
    updatedAt: readDate(creator.updatedAt, 'updatedAt'),
    owner: readString(creator.owner, 'owner', { max: 120 }),
    stage,
    tags: normalizeTags(creator.tags),
    note: readString(creator.note, 'note', { max: MAX_TEXT }),
  };
}

function mergeCreatorRecord(previous, rawIncoming) {
  const incoming = normalizeCreator(rawIncoming);
  const next = { ...previous, contact: { ...previous.contact }, tags: [...previous.tags] };
  next.platformData = { ...previous.platformData };
  let changed = false;
  const assign = (key, value) => {
    if (value !== next[key]) {
      next[key] = value;
      changed = true;
    }
  };

  if (incoming.name) assign('name', incoming.name);
  if (incoming.profileUrl) assign('profileUrl', incoming.profileUrl);
  if (incoming.followers !== null) assign('followers', incoming.followers);
  if (incoming.category) assign('category', incoming.category);
  if (incoming.sourceUrl) assign('sourceUrl', incoming.sourceUrl);
  if (incoming.owner) assign('owner', incoming.owner);
  if (incoming.note) assign('note', incoming.note);
  if (incoming.stage !== '未跟进') assign('stage', incoming.stage);

  for (const field of ['phone', 'wechat', 'email']) {
    if (incoming.contact[field] && incoming.contact[field] !== next.contact[field]) {
      next.contact[field] = incoming.contact[field];
      changed = true;
    }
  }
  for (const field of ['accountId', 'talentAppid', 'searchAccount']) {
    if (incoming.platformData[field] && incoming.platformData[field] !== next.platformData[field]) {
      next.platformData[field] = incoming.platformData[field];
      changed = true;
    }
  }
  for (const tag of incoming.tags) {
    if (!next.tags.includes(tag)) {
      next.tags.push(tag);
      changed = true;
    }
  }
  if (Object.hasOwn(rawIncoming, 'capturedAt')) {
    const capturedAt = incoming.capturedAt;
    if (capturedAt !== next.capturedAt) assign('capturedAt', capturedAt);
  }
  if (changed) {
    next.updatedAt = Object.hasOwn(rawIncoming, 'updatedAt')
      ? incoming.updatedAt
      : new Date().toISOString();
  }
  return { creator: next, changed };
}

export function mergeCreators(existing, incoming) {
  requireArray(existing, 'existing creators');
  requireArray(incoming, 'incoming creators');
  if (existing.length > MAX_CREATORS || incoming.length > MAX_CREATORS) {
    throw new RangeError(`creator limit is ${MAX_CREATORS}`);
  }

  const creators = [];
  const index = new Map();
  for (const row of existing) {
    const creator = normalizeCreator(row);
    if (index.has(creator.id)) throw new TypeError(`duplicate existing creator id: ${creator.id}`);
    index.set(creator.id, creators.length);
    creators.push(creator);
  }

  let added = 0;
  const updatedExisting = new Set();
  const initialIds = new Set(index.keys());
  for (const row of incoming) {
    const creator = normalizeCreator(row);
    if (!index.has(creator.id)) {
      index.set(creator.id, creators.length);
      creators.push(creator);
      added += 1;
      continue;
    }
    const position = index.get(creator.id);
    const result = mergeCreatorRecord(creators[position], row);
    creators[position] = result.creator;
    if (result.changed && initialIds.has(creator.id)) updatedExisting.add(creator.id);
  }
  return { creators, added, updated: updatedExisting.size };
}

export function patchCreator(creator, patch) {
  const current = normalizeCreator(creator);
  const changes = requireRecord(patch, 'patch');
  const projected = {};
  for (const [key, value] of Object.entries(changes)) {
    if (PATCH_FIELDS.has(key)) projected[key] = value;
  }
  if (Object.hasOwn(projected, 'contact')) {
    const incomingContact = requireRecord(projected.contact, 'patch.contact');
    projected.contact = { ...current.contact };
    for (const field of ['phone', 'wechat', 'email']) {
      if (Object.hasOwn(incomingContact, field)) projected.contact[field] = incomingContact[field];
    }
  }
  const normalized = normalizeCreator({ ...current, ...projected, id: current.id, platform: current.platform, externalId: current.externalId, updatedAt: new Date().toISOString() });
  return normalized;
}

function renderTemplate(template, creator) {
  const substitutions = {
    name: creator.name,
    platform: PLATFORM_LABELS[creator.platform],
    followers: creator.followers == null ? '' : String(creator.followers),
    owner: creator.owner,
    stage: creator.stage,
  };
  return template.replace(/\{\{\s*(name|platform|followers|owner|stage)\s*\}\}|\{\s*(name|platform|followers|owner|stage)\s*\}/giu,
    (_match, doubleBraceKey, singleBraceKey) => substitutions[(doubleBraceKey ?? singleBraceKey).toLowerCase()]);
}

export function createDrafts(creators, ids, template, existing = []) {
  requireArray(creators, 'creators');
  requireArray(ids, 'ids');
  requireArray(existing, 'existing drafts');
  const bodyTemplate = readString(template, 'template', { max: MAX_TEXT });
  const normalizedCreators = creators.map(normalizeCreator);
  const creatorById = new Map(normalizedCreators.map((creator) => [creator.id, creator]));
  const drafts = existing.map(normalizeDraft);
  const pendingCreators = new Set(drafts.filter((draft) => draft.status === 'pending').map((draft) => draft.creatorId));
  const selected = new Set();

  for (const rawId of ids) {
    const id = readIdentifier(rawId, 'creator id');
    if (selected.has(id)) continue;
    selected.add(id);
    const creator = creatorById.get(id);
    if (!creator || pendingCreators.has(id)) continue;
    const now = new Date().toISOString();
    drafts.push({
      id: makeId('draft'),
      creatorId: id,
      text: renderTemplate(bodyTemplate, creator),
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    });
    pendingCreators.add(id);
  }
  return drafts;
}

function parseBackup(data) {
  if (typeof data === 'string') {
    if (new TextEncoder().encode(data).byteLength > MAX_IMPORT_BYTES) throw new RangeError('backup exceeds 5 MB');
    try {
      return JSON.parse(data);
    } catch {
      throw new TypeError('backup must be valid JSON');
    }
  }
  let serialized;
  try {
    serialized = JSON.stringify(data);
  } catch {
    throw new TypeError('backup must be JSON serializable');
  }
  if (typeof serialized !== 'string') throw new TypeError('backup must be JSON serializable');
  if (new TextEncoder().encode(serialized).byteLength > MAX_IMPORT_BYTES) throw new RangeError('backup exceeds 5 MB');
  return data;
}

export function validateState(data) {
  const state = requireRecord(data, 'state');
  if (state.version !== VERSION) throw new TypeError(`state.version must be ${VERSION}`);
  const rawCreators = requireArray(state.creators, 'state.creators');
  const rawDrafts = requireArray(state.drafts, 'state.drafts');
  const rawPresets = requireArray(state.presets, 'state.presets');
  if (rawCreators.length > MAX_CREATORS) throw new RangeError(`creator limit is ${MAX_CREATORS}`);
  if (rawDrafts.length > MAX_CREATORS || rawPresets.length > MAX_CREATORS) throw new RangeError('backup contains too many records');

  const creators = [];
  const seenCreatorIds = new Set();
  for (const row of rawCreators) {
    const creator = normalizeCreator(row);
    if (seenCreatorIds.has(creator.id)) throw new TypeError(`duplicate creator id: ${creator.id}`);
    seenCreatorIds.add(creator.id);
    creators.push(creator);
  }
  const drafts = rawDrafts.map(normalizeDraft);
  const draftIds = new Set();
  for (const draft of drafts) {
    if (draftIds.has(draft.id)) throw new TypeError(`duplicate draft id: ${draft.id}`);
    draftIds.add(draft.id);
  }
  const presets = rawPresets.map(normalizePreset);
  const presetIds = new Set();
  for (const preset of presets) {
    if (presetIds.has(preset.id)) throw new TypeError(`duplicate preset id: ${preset.id}`);
    presetIds.add(preset.id);
  }
  const settings = state.settings == null ? { owner: '我' } : requireRecord(state.settings, 'state.settings');
  const owner = settings.owner == null ? '我' : readString(settings.owner, 'settings.owner', { max: 120 });
  return assertStateSize({ version: VERSION, creators, drafts, presets, settings: { owner: owner || '我' } });
}

function mergeById(currentRows, incomingRows, normalize, identity) {
  const merged = [...currentRows];
  const ids = new Set(merged.map((row) => row.id));
  const semanticKeys = new Set(merged.map(identity));
  for (const raw of incomingRows) {
    const item = normalize(raw);
    const semanticKey = identity(item);
    if (ids.has(item.id) || semanticKeys.has(semanticKey)) continue;
    ids.add(item.id);
    semanticKeys.add(semanticKey);
    merged.push(item);
  }
  return merged;
}

export function mergeImport(state, data) {
  const current = validateState(state);
  const parsed = parseBackup(data);
  const imported = validateState(parsed);
  const creatorMerge = mergeCreators(current.creators, imported.creators);
  const drafts = mergeById(current.drafts, imported.drafts, normalizeDraft, (item) => item.status === 'pending'
    ? `pending\u0000${item.creatorId}`
    : `${item.creatorId}\u0000${item.status}\u0000${item.text}`);
  const presets = mergeById(current.presets, imported.presets, normalizePreset, (item) => `${item.platform}\u0000${item.name}\u0000${item.url}`);
  const owner = current.settings.owner && current.settings.owner !== '我'
    ? current.settings.owner
    : (imported.settings.owner || current.settings.owner);
  return validateState({ version: VERSION, creators: creatorMerge.creators, drafts, presets, settings: { owner: owner || '我' } });
}

const CSV_COLUMNS = [
  ['id', (creator) => creator.id, true],
  ['platform', (creator) => creator.platform],
  ['externalId', (creator) => creator.externalId, true],
  ['name', (creator) => creator.name],
  ['profileUrl', (creator) => creator.profileUrl],
  ['followers', (creator) => creator.followers ?? ''],
  ['category', (creator) => creator.category],
  ['contact.phone', (creator) => creator.contact.phone, true],
  ['contact.wechat', (creator) => creator.contact.wechat],
  ['contact.email', (creator) => creator.contact.email],
  ['platformData.accountId', (creator) => creator.platformData.accountId, true],
  ['platformData.talentAppid', (creator) => creator.platformData.talentAppid, true],
  ['platformData.searchAccount', (creator) => creator.platformData.searchAccount, true],
  ['sourceUrl', (creator) => creator.sourceUrl],
  ['capturedAt', (creator) => creator.capturedAt],
  ['updatedAt', (creator) => creator.updatedAt],
  ['owner', (creator) => creator.owner],
  ['stage', (creator) => creator.stage],
  ['tags', (creator) => creator.tags.join('|')],
  ['note', (creator) => creator.note],
];

function csvCell(value, protectNumericText = false) {
  let text = String(value ?? '');
  // Apostrophe prefix is the CSV text convention for Excel: keep long numeric IDs and leading zeros exact.
  if ((protectNumericText && /^(?:0\d+|\d{16,})$/u.test(text)) || /^[\t\r\n ]*[=+\-@]/u.test(text)) {
    text = `'${text}`;
  }
  return `"${text.replace(/"/gu, '""')}"`;
}

export function toCSV(creators) {
  requireArray(creators, 'creators');
  const rows = [CSV_COLUMNS.map(([name]) => csvCell(name)).join(',')];
  for (const raw of creators) {
    const creator = normalizeCreator(raw);
    rows.push(CSV_COLUMNS.map(([, getValue, protectNumericText]) => csvCell(getValue(creator), protectNumericText)).join(','));
  }
  return `\uFEFF${rows.join('\r\n')}`;
}
