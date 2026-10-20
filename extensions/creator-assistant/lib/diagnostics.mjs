export const DIAGNOSTICS_KEY = 'creator-assistant-diagnostics-v1';

const SCHEMA_VERSION = 1;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 300;
const MAX_BYTES = 256 * 1024;
const MAX_FRAMES = 20;
const MAX_STACK_CHARS = 20_000;
const DEFAULT_STORAGE_TIMEOUT_MS = 1000;

const SOURCES = new Set(['background', 'ui', 'invite', 'douyin', 'weixin', 'content']);
const LEVELS = new Set(['error', 'warning', 'info']);
const PLATFORMS = new Set(['douyin', 'kuaishou', 'xiaohongshu', 'weixin']);
const CATEGORIES = new Set(['network', 'timeout', 'permission', 'invalid_response', 'storage', 'cancelled', 'unexpected']);
const PHASES = new Set(['START', 'ACCESS', 'REQUEST', 'PARSE', 'VALIDATE', 'PREFLIGHT', 'SUBMIT', 'RESULT', 'PERSIST', 'RECOVER', 'TICK']);
const OUTCOMES = new Set(['STARTED', 'SUCCEEDED', 'FAILED', 'REJECTED', 'UNKNOWN', 'NOT_SUBMITTED', 'INTERRUPTED', 'MISMATCHED', 'RECOVERED', 'PAUSED']);
const SURFACES = new Set(['app', 'auto-invite', 'popup']);
const STAGES = new Set(['global', 'request', 'download', 'import', 'copy', 'open', 'capture', 'save']);

const OPERATIONS = new Set([
  'GET_STATE', 'LIST_TABS', 'GET_ACTIVE_CAPTURE', 'UPSERT_CREATORS', 'UPDATE_CREATOR', 'ADD_DRAFTS', 'UPDATE_DRAFT',
  'SAVE_PRESET', 'REMOVE_PRESET', 'IMPORT_STATE', 'OPEN_WORKBENCH',
  'INVITE_OPTIONS', 'INVITE_PREPARE', 'INVITE_START', 'INVITE_STATUS', 'INVITE_PAUSE', 'INVITE_RESOLVE', 'INVITE_RELEASE',
  'INVITE_TEMPLATES_LIST', 'INVITE_TEMPLATE_SAVE', 'INVITE_TEMPLATE_DELETE',
  'DIAGNOSTICS_SUMMARY', 'DIAGNOSTICS_EXPORT', 'EXPORT_CSV', 'EXPORT_BACKUP', 'IMPORT_BACKUP', 'EXPORT_INVITE_JOB', 'EXPORT_INVITE_RESULTS_CSV', 'COPY_DRAFT', 'OPEN_PLATFORM', 'UI_GLOBAL',
  'background.alarm', 'background.startup', 'background.error', 'background.rejection',
  'content.capture', 'content.save', 'content.state', 'content.open',
  'invite.options', 'invite.configure', 'invite.preflight', 'invite.send', 'invite.result', 'invite.recovery',
  'weixin.products', 'weixin.precheck', 'weixin.send',
  'initialize', 'read_state', 'write_state', 'capture', 'inspect', 'options', 'configure', 'prepare', 'start', 'preflight', 'send',
  'pause', 'resolve', 'recover', 'persist', 'export', 'schedule', 'alarm', 'message', 'parse_response', 'check_context',
  'search_account', 'product_list', 'form_setup', 'unknown',
]);

const CODES = new Set([
  'REQUEST_STARTED', 'REQUEST_COMPLETED', 'REQUEST_FAILED', 'CAPTURE_EMPTY', 'CONTENT_FAILED', 'WORKER_EXCEPTION',
  'UNHANDLED_REJECTION', 'UI_EXCEPTION', 'INVITE_PREFLIGHT_FAILED', 'INVITE_SEND_FAILED', 'INVITE_RESULT_UNKNOWN',
  'STORAGE_FAILED', 'PLATFORM_REQUEST_FAILED', 'STARTED', 'SUCCEEDED', 'OPTIONS_FAILED', 'CONFIGURE_FAILED',
  'PREFLIGHT_FAILED', 'PLATFORM_REJECTED', 'IDENTITY_MISMATCH', 'SEND_FAILED', 'NOT_SUBMITTED', 'UNKNOWN',
  'STORAGE_ERROR', 'UNEXPECTED_RESULT', 'RECOVERED', 'RECOVERY_FAILED', 'TICK_FAILED', 'HTTP_ERROR', 'TIMEOUT',
  'NETWORK_ERROR', 'INVALID_JSON', 'RESPONSE_TOO_LARGE', 'PLATFORM_ERROR', 'INVALID_PAYLOAD', 'ACCESS_DENIED', 'CONTEXT_CHANGED',
  'CONFIGURATION_INVALID', 'OPTIONS_UNAVAILABLE', 'TAB_UNAVAILABLE', 'DIAGNOSTIC_WRITE_FAILED',
]);

const ERROR_SUMMARIES = {
  network: '网络请求未完成。',
  timeout: '操作等待超时。',
  permission: '当前环境缺少必要权限。',
  invalid_response: '返回数据无法识别。',
  storage: '本地数据读写失败。',
  cancelled: '操作已中断。',
  unexpected: '操作未能完成。',
};

const KNOWN_FILES = new Map([
  ['background.mjs', 'background.mjs'],
  ['ui-api.mjs', 'ui-api.mjs'],
  ['app.mjs', 'app.mjs'],
  ['diagnostics-ui.mjs', 'diagnostics-ui.mjs'],
  ['popup.mjs', 'popup.mjs'],
  ['content.js', 'content.js'],
  ['adapters.js', 'adapters.js'],
  ['page-hook.js', 'page-hook.js'],
  ['auto-invite.mjs', 'auto-invite.mjs'],
  ['core.mjs', 'lib/core.mjs'],
  ['diagnostics.mjs', 'lib/diagnostics.mjs'],
  ['douyin-page.mjs', 'lib/douyin-page.mjs'],
  ['invite-config.mjs', 'lib/invite-config.mjs'],
  ['invite-controller.mjs', 'lib/invite-controller.mjs'],
  ['invite-engine.mjs', 'lib/invite-engine.mjs'],
  ['invite-workspace.mjs', 'lib/invite-workspace.mjs'],
  ['invite-page.mjs', 'lib/invite-page.mjs'],
  ['weixin-client.mjs', 'lib/weixin-client.mjs'],
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ERROR_NAMES = new Set(['Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'URIError', 'EvalError', 'AggregateError', 'DOMException', 'NetworkError', 'TimeoutError', 'AbortError', 'NotAllowedError', 'QuotaExceededError']);
const SAFE_REASONS = new Map([
  ['官方商品选择器未打开。', { reasonCode: 'DOUYIN_PRODUCT_PICKER_NOT_OPEN', category: 'unexpected', summary: '官方商品选择器未打开。' }],
  ['无法打开官方商品选择器。', { reasonCode: 'DOUYIN_PRODUCT_PICKER_OPEN_FAILED', category: 'unexpected', summary: '无法打开官方商品选择器。' }],
  ['官方商品搜索控件无法唯一确认。', { reasonCode: 'DOUYIN_PRODUCT_SEARCH_CONTROL_AMBIGUOUS', category: 'unexpected', summary: '官方商品搜索控件无法唯一确认。' }],
  ['商品搜索词无效或控件不可用。', { reasonCode: 'DOUYIN_PRODUCT_SEARCH_UNAVAILABLE', category: 'unexpected', summary: '商品搜索词无效或控件不可用。' }],
  ['无法提交官方商品搜索。', { reasonCode: 'DOUYIN_PRODUCT_SEARCH_FAILED', category: 'unexpected', summary: '无法提交官方商品搜索。' }],
  ['未收到官方商品列表，请刷新后重试。', { reasonCode: 'DOUYIN_PRODUCT_LIST_UNAVAILABLE', category: 'invalid_response', summary: '未收到官方商品列表，请刷新后重试。' }],
  ['商品列表已变化，请重新搜索后选择。', { reasonCode: 'DOUYIN_PRODUCT_LIST_CHANGED', category: 'cancelled', summary: '商品列表已变化，请重新搜索后选择。' }],
  ['官方商品列表不支持当前分页操作。', { reasonCode: 'DOUYIN_PRODUCT_PAGINATION_UNAVAILABLE', category: 'unexpected', summary: '官方商品列表不支持当前分页操作。' }],
  ['未能读取下一页官方商品。', { reasonCode: 'DOUYIN_PRODUCT_PAGE_UNAVAILABLE', category: 'invalid_response', summary: '未能读取下一页官方商品。' }],
  ['商品搜索结果无法唯一匹配所选商品。', { reasonCode: 'DOUYIN_PRODUCT_MATCH_AMBIGUOUS', category: 'invalid_response', summary: '商品搜索结果无法唯一匹配所选商品。' }],
  ['类目选择控件不存在或不唯一。', { reasonCode: 'DOUYIN_CATEGORY_CONTROL_AMBIGUOUS', category: 'unexpected', summary: '类目选择控件不存在或不唯一。' }],
  ['无法打开官方类目控件。', { reasonCode: 'DOUYIN_CATEGORY_CONTROL_OPEN_FAILED', category: 'unexpected', summary: '无法打开官方类目控件。' }],
  ['官方类目路径未完整显示。', { reasonCode: 'DOUYIN_CATEGORY_PATH_INCOMPLETE', category: 'invalid_response', summary: '官方类目路径未完整显示。' }],
  ['官方类目树与页面原生编号不一致。', { reasonCode: 'DOUYIN_CATEGORY_ID_MISMATCH', category: 'invalid_response', summary: '官方类目树与页面原生编号不一致。' }],
  ['官方类目列表没有可读取的选项。', { reasonCode: 'DOUYIN_CATEGORY_LIST_EMPTY', category: 'invalid_response', summary: '官方类目列表没有可读取的选项。' }],
  ['官方类目没有可核验的原生编号，暂不能安全提交。', { reasonCode: 'DOUYIN_CATEGORY_NATIVE_ID_MISSING', category: 'invalid_response', summary: '官方类目没有可核验的原生编号，暂不能安全提交。' }],
  ['无法清除原有类目选择。', { reasonCode: 'DOUYIN_CATEGORY_CLEAR_FAILED', category: 'unexpected', summary: '无法清除原有类目选择。' }],
  ['官方类目存在未能清除的默认选项。', { reasonCode: 'DOUYIN_CATEGORY_DEFAULT_UNCLEARED', category: 'invalid_response', summary: '官方类目存在未能清除的默认选项。' }],
  ['所选品类缺少可核验的官方路径。', { reasonCode: 'DOUYIN_CATEGORY_PATH_MISSING', category: 'invalid_response', summary: '所选品类缺少可核验的官方路径。' }],
  ['无法按配置设置官方合作权限。', { reasonCode: 'DOUYIN_RIGHTS_SET_FAILED', category: 'unexpected', summary: '无法按配置设置官方合作权限。' }],
  ['无法填写官方邀约话术。', { reasonCode: 'DOUYIN_MESSAGE_INPUT_UNAVAILABLE', category: 'unexpected', summary: '无法填写官方邀约话术。' }],
  ['无法填写官方邀约联系方式。', { reasonCode: 'DOUYIN_CONTACT_INPUT_UNAVAILABLE', category: 'unexpected', summary: '无法填写官方邀约联系方式。' }],
  ['官方提交按钮无法唯一确认。', { reasonCode: 'DOUYIN_SUBMIT_CONTROL_AMBIGUOUS', category: 'unexpected', summary: '官方提交按钮无法唯一确认。' }],
  ['店铺或页面已变化，已停止提交。', { reasonCode: 'DOUYIN_CONTEXT_CHANGED', category: 'cancelled', summary: '店铺或页面已变化，已停止提交。' }],
  ['无法提交官方邀约表单。', { reasonCode: 'DOUYIN_SUBMIT_FAILED', category: 'unexpected', summary: '无法提交官方邀约表单。' }],
]);
let fallbackIdCounter = 0;

function safeGet(value, key) {
  try {
    return value == null ? undefined : value[key];
  } catch {
    return undefined;
  }
}

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null || value instanceof Error;
  } catch {
    return false;
  }
}

function boundedString(value, max = 512) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function enumValue(value, values, fallback) {
  return typeof value === 'string' && values.has(value) ? value : fallback;
}

function safeNow(now = Date.now) {
  try {
    const value = typeof now === 'function' ? now() : Date.now();
    return Number.isFinite(value) ? value : Date.now();
  } catch {
    return Date.now();
  }
}

function normalizeTimestamp(value) {
  const timestamp = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '';
}

function makeUuid() {
  try {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
  } catch {
    // Use the non-sensitive fallback below when Web Crypto is not available.
  }
  fallbackIdCounter = (fallbackIdCounter + 1) % 0xfffff;
  const part = `${Date.now().toString(16).padStart(12, '0')}${fallbackIdCounter.toString(16).padStart(5, '0')}`.slice(-12);
  return `00000000-0000-4000-8000-${part}`;
}

function normalizeExtensionOrigin(value) {
  if (typeof value !== 'string' || !value) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'chrome-extension:' || !url.hostname) return '';
    return `chrome-extension://${url.hostname.toLowerCase()}/`;
  } catch {
    return '';
  }
}

function moduleExtensionOrigin() {
  return normalizeExtensionOrigin(import.meta.url);
}

function canonicalFile(value) {
  if (typeof value !== 'string' || !value || value.length > 1024) return '';
  let path = value.replace(/\\/gu, '/').replace(/^[\s('"`]+|[\s),;'"`]+$/gu, '');
  if (path.includes('://') || path.startsWith('/')) return '';
  const parts = path.split('/').filter(Boolean);
  if (parts.length > 2) return '';
  const basename = parts.at(-1) ?? '';
  const canonical = KNOWN_FILES.get(basename);
  if (!canonical) return '';
  if (canonical.startsWith('lib/')) return parts.length === 2 && parts[0] === 'lib' ? canonical : '';
  return parts.length === 1 ? canonical : '';
}

function safeLine(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 10_000_000 ? value : 0;
}

function normalizeFrame(value) {
  if (!isRecord(value)) return null;
  const rawFile = safeGet(value, 'file');
  if (typeof rawFile !== 'string' || rawFile.includes('://')) return null;
  const file = canonicalFile(rawFile);
  const line = safeLine(safeGet(value, 'line'));
  const column = safeLine(safeGet(value, 'column'));
  return file && line && column ? { file, line, column } : null;
}

function extractStackFrames(stack, extensionOrigin) {
  if (typeof stack !== 'string' || !stack) return [];
  const text = stack.slice(0, MAX_STACK_CHARS);
  const expectedOrigin = normalizeExtensionOrigin(extensionOrigin) || moduleExtensionOrigin();
  if (!expectedOrigin) return [];
  const frames = [];
  const seen = new Set();
  for (const line of text.split('\n')) {
    const pathMatch = /(chrome-extension:\/\/[^\s()]+):(\d+):(\d+)/iu.exec(line);
    if (!pathMatch) continue;
    const sourceOrigin = normalizeExtensionOrigin(pathMatch[1]);
    if (!expectedOrigin || sourceOrigin !== expectedOrigin) continue;
    const rawPath = pathMatch[1].slice(sourceOrigin.length);
    const frame = normalizeFrame({ file: rawPath, line: Number(pathMatch[2]), column: Number(pathMatch[3]) });
    if (!frame) continue;
    const key = `${frame.file}:${frame.line}:${frame.column}`;
    if (seen.has(key)) continue;
    seen.add(key);
    frames.push(frame);
    if (frames.length >= MAX_FRAMES) break;
  }
  return frames;
}

function collectFrames(input, error, extensionOrigin) {
  const frames = [];
  const seen = new Set();
  const append = (frame) => {
    if (!frame) return;
    const key = `${frame.file}:${frame.line}:${frame.column}`;
    if (seen.has(key) || frames.length >= MAX_FRAMES) return;
    seen.add(key);
    frames.push(frame);
  };
  const rawFrames = safeGet(error, 'frames') ?? safeGet(input, 'frames');
  if (Array.isArray(rawFrames)) {
    for (const rawFrame of rawFrames.slice(0, MAX_FRAMES)) append(normalizeFrame(rawFrame));
  }
  append(normalizeFrame(safeGet(error, 'location')));
  append(normalizeFrame(safeGet(input, 'location')));
  const stack = safeGet(error, 'stack') ?? safeGet(input, 'stack');
  for (const frame of extractStackFrames(stack, extensionOrigin)) append(frame);
  return frames;
}

function classifyError(error, code) {
  const suppliedCategory = safeGet(error, 'category');
  if (typeof suppliedCategory === 'string' && CATEGORIES.has(suppliedCategory)) return suppliedCategory;
  if (code === 'STORAGE_FAILED' || code === 'STORAGE_ERROR' || code === 'DIAGNOSTIC_WRITE_FAILED') return 'storage';
  if (code === 'TIMEOUT') return 'timeout';
  if (code === 'ACCESS_DENIED') return 'permission';
  if (code === 'HTTP_ERROR' || code === 'INVALID_JSON' || code === 'UNEXPECTED_RESULT' || code === 'INVALID_PAYLOAD') return 'invalid_response';
  const message = `${boundedString(safeGet(error, 'name'), 80)} ${boundedString(safeGet(error, 'message'), 1000)}`.toLowerCase();
  if (/timeout|timed out|deadline|超时/u.test(message)) return 'timeout';
  if (/permission|not allowed|unauthorized|forbidden|access denied|权限|未授权/u.test(message)) return 'permission';
  if (/storage|quota|disk|存储|本地写入|本地读取/u.test(message)) return 'storage';
  if (/invalid response|unexpected response|malformed|invalid json|parse error|格式错误|解析失败/u.test(message)) return 'invalid_response';
  if (/cancel|abort|取消|中断/u.test(message)) return 'cancelled';
  if (/network|fetch failed|failed to fetch|connection|disconnected|load failed|网络|请求失败/u.test(message)) return 'network';
  if (code === 'PLATFORM_REQUEST_FAILED' || code === 'NETWORK_ERROR' || code === 'INVITE_RESULT_UNKNOWN') return 'network';
  return 'unexpected';
}

function safeReason(error) {
  const reasonCode = safeGet(error, 'reasonCode');
  if (typeof reasonCode === 'string') {
    for (const reason of SAFE_REASONS.values()) if (reason.reasonCode === reasonCode) return reason;
  }
  const message = safeGet(error, 'message');
  return typeof message === 'string' ? SAFE_REASONS.get(message) : undefined;
}

function normalizeContext(value) {
  if (!isRecord(value)) return undefined;
  const context = {};
  const phase = safeGet(value, 'phase');
  const outcome = safeGet(value, 'outcome');
  const surface = safeGet(value, 'surface');
  const stage = safeGet(value, 'stage');
  if (PHASES.has(phase)) context.phase = phase;
  if (OUTCOMES.has(outcome)) context.outcome = outcome;
  if (SURFACES.has(surface)) context.surface = surface;
  if (STAGES.has(stage)) context.stage = stage;
  const numericFields = ['httpStatus', 'itemIndex', 'total', 'elapsedMs', 'received', 'rejected', 'domFound', 'truncated', 'orphanDetails'];
  for (const field of numericFields) {
    const number = safeGet(value, field);
    if (!Number.isFinite(number) || typeof number !== 'number' || number < 0 || number > 1_000_000_000) continue;
    if (field === 'httpStatus' && (!Number.isInteger(number) || number < 100 || number > 599)) continue;
    context[field] = Math.round(number);
  }
  const hookReady = safeGet(value, 'hookReady');
  if (typeof hookReady === 'boolean') context.hookReady = hookReady;
  const ordered = {};
  for (const key of ['phase', 'outcome', 'surface', 'stage', 'hookReady', ...numericFields]) {
    if (Object.hasOwn(context, key)) ordered[key] = context[key];
  }
  return Object.keys(ordered).length ? ordered : undefined;
}

function safeEntry(input, extensionOrigin) {
  const top = isRecord(input) ? input : {};
  const explicitError = safeGet(top, 'error');
  const rawError = explicitError ?? input;
  const rawCode = safeGet(top, 'code');
  const code = enumValue(rawCode, CODES, 'REQUEST_FAILED');
  const level = enumValue(safeGet(top, 'level'), LEVELS, 'error');
  const hasError = explicitError != null || input instanceof Error || safeGet(top, 'message') != null || safeGet(top, 'stack') != null || level !== 'info';
  let error;
  if (hasError) {
    const reason = safeReason(rawError);
    const category = reason?.category ?? classifyError(rawError, code);
    const frames = collectFrames(top, rawError, extensionOrigin);
    error = { category, summary: reason?.summary ?? ERROR_SUMMARIES[category] };
    if (reason) error.reasonCode = reason.reasonCode;
    const errorName = safeGet(rawError, 'name');
    if (ERROR_NAMES.has(errorName)) error.name = errorName;
    if (frames.length) {
      error.location = frames[0];
      error.frames = frames;
    }
  }
  const platform = safeGet(top, 'platform');
  const traceId = safeGet(top, 'traceId');
  const entry = {
    extensionVersion: safeVersion(safeGet(top, 'extensionVersion')),
    level,
    source: enumValue(safeGet(top, 'source'), SOURCES, 'background'),
    operation: enumValue(safeGet(top, 'operation'), OPERATIONS, 'unknown'),
    code,
  };
  const id = safeGet(top, 'id');
  if (typeof id === 'string' && UUID_RE.test(id)) entry.id = id.toLowerCase();
  const timestamp = normalizeTimestamp(safeGet(top, 'timestamp') ?? safeGet(top, 'occurredAt'));
  if (timestamp) entry.timestamp = timestamp;
  if (PLATFORMS.has(platform)) entry.platform = platform;
  if (typeof traceId === 'string' && UUID_RE.test(traceId)) entry.traceId = traceId.toLowerCase();
  if (error) entry.error = error;
  const context = normalizeContext(safeGet(top, 'context'));
  if (context) entry.context = context;
  return entry;
}

export function sanitizeDiagnostic(input, options = {}) {
  try {
    return safeEntry(input, safeGet(options, 'extensionOrigin'));
  } catch {
    return safeEntry({}, safeGet(options, 'extensionOrigin'));
  }
}

function browserName(value) {
  const text = boundedString(value, 100).toLowerCase();
  if (text === 'chrome' || text.includes('chrome/') || text.includes('google chrome')) return 'chrome';
  if (text === 'edge' || text.includes('edge') || text.includes('edg/')) return 'edge';
  return 'unknown';
}

function normalizeEnvironment(value) {
  const environment = isRecord(value) ? value : {};
  let rawBrowser = safeGet(environment, 'browser') ?? safeGet(environment, 'browserName');
  let rawMajor = safeGet(environment, 'browserMajor');
  let rawOS = safeGet(environment, 'os') ?? safeGet(environment, 'osFamily');
  const userAgent = boundedString(safeGet(environment, 'userAgent'), 2048);
  if (!rawBrowser && userAgent) rawBrowser = /edg\//iu.test(userAgent) ? 'edge' : /chrome\//iu.test(userAgent) ? 'chrome' : 'unknown';
  if (!rawMajor && userAgent) rawMajor = /(edg|chrome)\/(\d+)/iu.exec(userAgent)?.[2];
  if (!rawOS && userAgent) rawOS = /macintosh|mac os x/iu.test(userAgent) ? 'macos' : /windows/iu.test(userAgent) ? 'windows' : /linux/iu.test(userAgent) ? 'linux' : 'unknown';
  const browser = browserName(rawBrowser);
  if (!Number.isSafeInteger(rawMajor) && typeof rawMajor === 'string') rawMajor = Number(/^\d{1,3}/u.exec(rawMajor)?.[0]);
  const browserMajor = Number.isSafeInteger(rawMajor) && rawMajor >= 0 && rawMajor <= 999 ? rawMajor : 0;
  const osText = boundedString(rawOS, 100).toLowerCase();
  const os = /mac|darwin/iu.test(osText) ? 'macos' : /win/iu.test(osText) ? 'windows' : /linux/iu.test(osText) ? 'linux' : 'unknown';
  return { browser, browserMajor, os };
}

function localManifestVersion() {
  try {
    const version = globalThis.chrome?.runtime?.getManifest?.()?.version;
    return typeof version === 'string' ? version : '0.2.1';
  } catch {
    return '0.2.1';
  }
}

function safeVersion(value) {
  if (typeof value === 'string' && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u.test(value) && value.length <= 40) return value;
  return 'unknown';
}

function byteLength(value) {
  try {
    return new TextEncoder().encode(value).byteLength;
  } catch {
    return value.length;
  }
}

function entryTime(entry) {
  const timestamp = Date.parse(entry.timestamp);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function safeStoredEntry(value) {
  if (!isRecord(value)) return false;
  const allowed = new Set(['id', 'timestamp', 'extensionVersion', 'level', 'source', 'operation', 'code', 'platform', 'traceId', 'error', 'context']);
  try {
    if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  } catch {
    return false;
  }
  const error = safeGet(value, 'error');
  return typeof safeGet(value, 'timestamp') === 'string'
    && Number.isFinite(Date.parse(safeGet(value, 'timestamp')))
    && typeof safeGet(value, 'id') === 'string'
    && UUID_RE.test(safeGet(value, 'id'))
    && (error == null || isRecord(error))
    && (safeGet(value, 'level') !== 'info' || error == null || isRecord(error));
}

function storagePayload(entries) {
  return { schemaVersion: SCHEMA_VERSION, entries };
}

function storageSize(entries) {
  return byteLength(JSON.stringify(storagePayload(entries)));
}

function pruneEntries(values, nowMs) {
  const minTime = nowMs - RETENTION_MS;
  const byId = new Map();
  for (const entry of values) {
    const at = entryTime(entry);
    if (at < minTime || at > nowMs || !at) continue;
    byId.set(entry.id, entry);
  }
  let entries = [...byId.values()].sort((a, b) => entryTime(a) - entryTime(b));
  if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
  while (entries.length && storageSize(entries) > MAX_BYTES) entries.shift();
  return entries;
}

function persistenceSnapshot(state) {
  return {
    available: state.available,
    healthy: state.healthy,
    mode: state.enabled ? 'persistent' : 'memory-only',
    failedReads: state.failedReads,
    failedWrites: state.failedWrites,
    timeouts: state.timeouts,
    droppedEntries: state.droppedEntries,
  };
}

function storageWait(operation, timeoutMs) {
  return new Promise((resolve) => {
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      resolve({ ok: false, timeout: true });
    }, timeoutMs);
    Promise.resolve()
      .then(operation)
      .then((value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve({ ok: true, value });
      }, () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve({ ok: false, timeout: false });
      });
  });
}

function validNowIso(now) {
  try {
    return new Date(safeNow(now)).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function fitsExport(entries, metadata) {
  const bundle = {
    schemaVersion: SCHEMA_VERSION,
    extensionVersion: metadata.extensionVersion,
    exportedAt: metadata.exportedAt,
    environment: metadata.environment,
    persistence: metadata.persistence,
    entries,
  };
  // Keep margin for metadata counter changes between export sizing and the final storage flush.
  return { bundle, fits: byteLength(JSON.stringify(bundle, null, 2)) <= MAX_BYTES - 1024 };
}

export function createDiagnostics({
  storage,
  now = Date.now,
  version = localManifestVersion(),
  environment = {},
  extensionOrigin = moduleExtensionOrigin(),
  storageTimeoutMs = DEFAULT_STORAGE_TIMEOUT_MS,
} = {}) {
  const extensionVersion = safeVersion(version);
  const safeEnvironment = normalizeEnvironment(environment);
  const safeOrigin = normalizeExtensionOrigin(extensionOrigin);
  const timeoutMs = Number.isFinite(storageTimeoutMs) && storageTimeoutMs > 0 ? Math.min(storageTimeoutMs, 10_000) : DEFAULT_STORAGE_TIMEOUT_MS;
  let available = false;
  try {
    available = Boolean(storage && typeof storage.get === 'function' && typeof storage.set === 'function');
  } catch {
    available = false;
  }
  const persistence = { available, enabled: available, healthy: available, failedReads: 0, failedWrites: 0, timeouts: 0, droppedEntries: 0 };
  let entries = [];
  let queue = Promise.resolve();

  const load = (async () => {
    if (!persistence.enabled) return;
    const result = await storageWait(() => storage.get(DIAGNOSTICS_KEY), timeoutMs);
    if (!result.ok) {
      if (result.timeout) persistence.timeouts += 1;
      else persistence.failedReads += 1;
      persistence.enabled = false;
      persistence.healthy = false;
      return;
    }
    const stored = result.value?.[DIAGNOSTICS_KEY];
    if (stored == null) return;
    if (!isRecord(stored) || safeGet(stored, 'schemaVersion') !== SCHEMA_VERSION || !Array.isArray(safeGet(stored, 'entries'))) {
      persistence.droppedEntries += 1;
      return;
    }
    const rawEntries = safeGet(stored, 'entries');
    const safeEntries = [];
    for (const item of rawEntries.slice(-MAX_ENTRIES * 2)) {
      if (!safeStoredEntry(item)) {
        persistence.droppedEntries += 1;
        continue;
      }
      safeEntries.push(sanitizeDiagnostic(item, { extensionOrigin: safeOrigin }));
    }
    if (rawEntries.length > MAX_ENTRIES * 2) persistence.droppedEntries += rawEntries.length - MAX_ENTRIES * 2;
    entries = pruneEntries([...safeEntries, ...entries], safeNow(now));
  })().catch(() => {
    persistence.failedReads += 1;
    persistence.enabled = false;
    persistence.healthy = false;
  });

  function persistSnapshot() {
    const task = queue.then(async () => {
      await load;
      if (!persistence.enabled) return;
      entries = pruneEntries(entries, safeNow(now));
      const result = await storageWait(() => storage.set({ [DIAGNOSTICS_KEY]: storagePayload(entries) }), timeoutMs);
      if (!result.ok) {
        if (result.timeout) persistence.timeouts += 1;
        else persistence.failedWrites += 1;
        persistence.enabled = false;
        persistence.healthy = false;
        return;
      }
      persistence.healthy = true;
    });
    queue = task.catch(() => {});
    return task.catch(() => {});
  }

  function record(input) {
    let entry;
    try {
      entry = sanitizeDiagnostic(input, { extensionOrigin: safeOrigin });
      entry.id = makeUuid();
      entry.timestamp = validNowIso(now);
      entry.extensionVersion = extensionVersion;
    } catch {
      entry = sanitizeDiagnostic({}, { extensionOrigin: safeOrigin });
      entry.id = makeUuid();
      entry.timestamp = validNowIso(now);
      entry.extensionVersion = extensionVersion;
    }
    entries = pruneEntries([...entries, entry], safeNow(now));
    return persistSnapshot().then(() => entry, () => entry);
  }

  function summary() {
    entries = pruneEntries(entries, safeNow(now));
    return {
      schemaVersion: SCHEMA_VERSION,
      extensionVersion,
      environment: { ...safeEnvironment },
      count: entries.length,
      bytes: storageSize(entries),
      limits: { retentionDays: 7, maxEntries: MAX_ENTRIES, maxBytes: MAX_BYTES },
      persistence: persistenceSnapshot(persistence),
    };
  }

  async function exportBundle() {
    await load;
    await queue;
    entries = pruneEntries(entries, safeNow(now));
    const exportedAt = validNowIso(now);
    let result = fitsExport(entries, {
      extensionVersion,
      exportedAt,
      environment: safeEnvironment,
      persistence: persistenceSnapshot(persistence),
    });
    while (!result.fits && entries.length) {
      entries.shift();
      result = fitsExport(entries, {
        extensionVersion,
        exportedAt,
        environment: safeEnvironment,
        persistence: persistenceSnapshot(persistence),
      });
    }
    await persistSnapshot();
    await queue;
    result = fitsExport(entries, {
      extensionVersion,
      exportedAt,
      environment: safeEnvironment,
      persistence: persistenceSnapshot(persistence),
    });
    return result.bundle;
  }

  return { record, summary, exportBundle };
}
