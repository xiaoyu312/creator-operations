import { emptyState, mergeCreators, patchCreator, createDrafts, normalizePreset, mergeImport, validateState } from './lib/core.mjs';
import { createInviteController, INVITE_ALARM } from './lib/invite-controller.mjs';
import { createInviteTemplateStore } from './lib/invite-workspace.mjs';
import { createDiagnostics } from './lib/diagnostics.mjs';

const STORAGE_KEY = 'creator-assistant-v1';
const HOSTS = { 'buyin.jinritemai.com': 'douyin', 'cps.kwaixiaodian.com': 'kuaishou', 'pgy.xiaohongshu.com': 'xiaohongshu', 'channels.weixin.qq.com': 'weixin', 'store.weixin.qq.com': 'weixin' };
const CONTENT_ACTIONS = new Set(['GET_STATE', 'UPSERT_CREATORS', 'OPEN_WORKBENCH', 'CONTENT_DIAGNOSTIC']);
const QUIET_ACTIONS = new Set(['GET_STATE', 'LIST_TABS', 'INVITE_STATUS', 'INVITE_TEMPLATES_LIST', 'CONTENT_DIAGNOSTIC']);
const INVITE_TEMPLATE_ACTIONS = new Set(['INVITE_TEMPLATES_LIST', 'INVITE_TEMPLATE_SAVE', 'INVITE_TEMPLATE_DELETE']);
const TEMPLATE_STORAGE_ACCESS_TIMEOUT_MS = 1000;
const CONTENT_OPERATIONS = new Set(['content.capture', 'content.save', 'content.state', 'content.open']);
let writeQueue = Promise.resolve();
let inviteController;
let diagnosticStore;
let diagnosticStorage;
let storageAccessReady;
let inviteTemplateStorage;
let inviteTemplateStore;

function environment() {
  const agent = globalThis.navigator?.userAgent || '';
  const edge = agent.match(/Edg\/(\d+)/);
  const chrome = agent.match(/(?:Chrome|Chromium)\/(\d+)/);
  return { browser: edge ? 'edge' : chrome ? 'chrome' : 'unknown', browserMajor: Number((edge || chrome)?.[1]) || 0, os: /Mac/.test(agent) ? 'macos' : /Windows/.test(agent) ? 'windows' : /Linux/.test(agent) ? 'linux' : 'unknown' };
}

function diagnostics() {
  const storage = globalThis.chrome?.storage?.local;
  if (diagnosticStorage !== storage || !diagnosticStore) {
    diagnosticStorage = storage;
    // Logs must never become readable from a platform content script, even briefly.
    try { storageAccessReady = storage?.setAccessLevel ? Promise.resolve(storage.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })).then(() => true, () => false) : Promise.resolve(false); }
    catch { storageAccessReady = Promise.resolve(false); }
    const protectedStorage = Object.fromEntries(['get', 'set'].map(method => [method, async value => {
      if (!(await storageAccessReady)) throw new Error('日志持久保存不可用。');
      return storage[method](value);
    }]));
    diagnosticStore = createDiagnostics({ storage: protectedStorage, version: chrome.runtime.getManifest?.().version || '0.2.1', environment: environment(), extensionOrigin: chrome.runtime.getURL('') });
  }
  return diagnosticStore;
}

function reportDiagnostic(event) {
  try { void Promise.resolve(diagnostics().record(event)).catch(() => {}); } catch { /* Diagnostics must not change business behavior. */ }
}

async function requireTrustedTemplateStorage(storage) {
  let timer = 0;
  let available = false;
  try {
    const readiness = storageAccessReady || Promise.resolve(false);
    available = await Promise.race([
      Promise.resolve(readiness).catch(() => false),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), TEMPLATE_STORAGE_ACCESS_TIMEOUT_MS); }),
    ]);
  } finally { clearTimeout(timer); }
  if (!available || diagnosticStorage !== storage) throw new Error('当前浏览器无法安全隔离本地邀约模板，请升级浏览器后重试。');
}

function getInviteTemplateStore() {
  const storage = globalThis.chrome?.storage?.local;
  if (!storage) throw new Error('本地邀约模板存储不可用。');
  diagnostics();
  if (inviteTemplateStorage !== storage || !inviteTemplateStore) {
    inviteTemplateStorage = storage;
    const protectedStorage = {
      get: async (...args) => { await requireTrustedTemplateStorage(storage); return storage.get(...args); },
      set: async (...args) => { await requireTrustedTemplateStorage(storage); return storage.set(...args); },
      remove: async (...args) => { await requireTrustedTemplateStorage(storage); return storage.remove(...args); },
    };
    inviteTemplateStore = createInviteTemplateStore({ storage: protectedStorage });
  }
  return inviteTemplateStore;
}

async function inviteTemplateOperation(message) {
  const store = getInviteTemplateStore();
  await requireTrustedTemplateStorage(inviteTemplateStorage);
  if (message.type === 'INVITE_TEMPLATES_LIST') return { templates: await store.list() };
  if (message.type === 'INVITE_TEMPLATE_SAVE') return { templates: await store.save(message.template) };
  return { templates: await store.remove(message.id) };
}

function captureStats(value) {
  const stats = {};
  for (const key of ['received', 'rejected', 'domFound', 'truncated', 'orphanDetails']) {
    if (Number.isSafeInteger(value?.[key]) && value[key] >= 0) stats[key] = Math.min(value[key], 1000000);
  }
  if (typeof value?.hookReady === 'boolean') stats.hookReady = value.hookReady;
  return stats;
}

export function platformFor(url) {
  try { const u = new URL(url); return u.protocol === 'https:' ? HOSTS[u.hostname] || null : null; } catch { return null; }
}
function isExtensionPage(sender) {
  return sender.id === chrome.runtime.id && typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));
}
async function readState() {
  const saved = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
  return saved ? validateState(saved) : emptyState();
}
function changeState(operation) {
  const pending = writeQueue.then(async () => {
    const state = await readState();
    const result = await operation(state);
    const safe = validateState(result.state);
    await chrome.storage.local.set({ [STORAGE_KEY]: safe });
    return { ...result, state: safe };
  });
  writeQueue = pending.catch(() => {});
  return pending;
}
async function capture(tabId) {
  let tab;
  if (Number.isInteger(tabId)) tab = await chrome.tabs.get(tabId);
  else [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const platform = platformFor(tab?.url);
  if (!tab || !platform) throw new Error('请先打开并选择抖音、快手、视频号或小红书的达人页面。');
  let result;
  try { result = await chrome.tabs.sendMessage(tab.id, { type: 'CAPTURE_PAGE' }); }
  catch { throw new Error('插件尚未连接此页面。安装后请刷新平台页面，再重新采集。'); }
  if (!result || !Array.isArray(result.candidates)) throw new Error('页面没有返回可识别的达人资料，请刷新平台页面。');
  const { creators } = mergeCreators([], result.candidates.filter(row => row.platform === platform));
  return { candidates: creators, platform, captureStats: captureStats(result.captureStats), diagnostics: Array.isArray(result.diagnostics) ? result.diagnostics.slice(0, 10).map(String) : [], tab: { id: tab.id, title: tab.title || '', url: tab.url } };
}
export async function handleMessage(message, sender) {
  if (message && typeof message.type === 'string' && INVITE_TEMPLATE_ACTIONS.has(message.type) && sender?.id !== chrome.runtime.id) {
    reportDiagnostic({ source: 'background', operation: message.type, level: 'error', code: 'ACCESS_DENIED', error: new Error('外部上下文无权访问本地邀约模板。') });
    throw new Error('无效的插件请求。');
  }
  if (!message || typeof message.type !== 'string' || !sender || sender.id !== chrome.runtime.id) throw new Error('无效的插件请求。');
  const internal = isExtensionPage(sender);
  const platform = platformFor(sender.url);
  if (!internal && INVITE_TEMPLATE_ACTIONS.has(message.type)) {
    reportDiagnostic({ source: 'background', operation: message.type, level: 'error', code: 'ACCESS_DENIED', error: new Error('平台页面无权访问本地邀约模板。') });
    throw new Error('此页面不能读取或修改本地邀约模板。');
  }
  if (!internal && (!platform || !CONTENT_ACTIONS.has(message.type))) throw new Error('此页面不能执行该操作。');
  if (message.type === 'CONTENT_DIAGNOSTIC') {
    if (!platform || !CONTENT_OPERATIONS.has(message.event?.operation)) throw new Error('无效的页面诊断请求。');
    reportDiagnostic({ source: 'content', level: 'error', code: 'CONTENT_FAILED', operation: message.event.operation, platform, error: message.event.error });
    return {};
  }
  if (message.type === 'DIAGNOSTICS_RECORD') {
    reportDiagnostic({ ...message.event, source: 'ui' });
    return {};
  }
  if (message.type === 'DIAGNOSTICS_EXPORT') return { bundle: await diagnostics().exportBundle() };
  if (message.type === 'DIAGNOSTICS_SUMMARY') return { summary: await diagnostics().summary() };
  const traceId = globalThis.crypto?.randomUUID?.();
  const started = Date.now();
  const common = { source: internal ? 'background' : 'content', operation: message.type, platform: message.platform || platform, traceId };
  if (!QUIET_ACTIONS.has(message.type)) reportDiagnostic({ ...common, level: 'info', code: 'REQUEST_STARTED', context: { phase: 'START', outcome: 'STARTED' } });
  try {
    const result = await executeMessage(message, sender, internal, platform);
    if (!QUIET_ACTIONS.has(message.type)) reportDiagnostic({ ...common, platform: result?.platform || common.platform, level: 'info', code: 'REQUEST_COMPLETED', context: { phase: 'RESULT', outcome: 'SUCCEEDED', elapsedMs: Date.now() - started } });
    if (message.type === 'GET_ACTIVE_CAPTURE' && !result.candidates.length) reportDiagnostic({ ...common, platform: result.platform, level: 'warning', code: 'CAPTURE_EMPTY', context: { ...result.captureStats, total: 0, phase: 'RESULT', outcome: 'FAILED' } });
    return result;
  } catch (error) {
    reportDiagnostic({ ...common, level: 'error', code: 'REQUEST_FAILED', error, context: { phase: 'RESULT', outcome: 'FAILED', elapsedMs: Date.now() - started } });
    throw error;
  }
}
async function executeMessage(message, sender, internal, platform) {
  if (INVITE_TEMPLATE_ACTIONS.has(message.type)) {
    if (!internal) throw new Error('此页面不能读取或修改本地邀约模板。');
    return inviteTemplateOperation(message);
  }
  if (message.type.startsWith('INVITE_')) {
    if (!internal || !inviteController) throw new Error('请从自动邀约工作台操作。');
    return inviteController.dispatch(message);
  }
  switch (message.type) {
    case 'GET_STATE': {
      await writeQueue;
      const state = await readState();
      // Content only needs local collection markers; never expose other platforms or contacts.
      return { state: internal ? state : { version: 1, creators: state.creators.filter(c => c.platform === platform).map(c => ({ id: c.id, externalId: c.externalId, name: c.name, platform: c.platform, profileUrl: c.profileUrl, stage: c.stage })), drafts: [], presets: [], settings: {} } };
    }
    case 'LIST_TABS': return { tabs: (await chrome.tabs.query({})).filter(t => platformFor(t.url)).map(t => ({ id: t.id, title: t.title || '', url: t.url, platform: platformFor(t.url) })) };
    case 'GET_ACTIVE_CAPTURE': return capture(message.tabId);
    case 'UPSERT_CREATORS': {
      const result = await changeState(state => {
      if (!Array.isArray(message.creators) || message.creators.length > 5000) throw new Error('每次最多收录 5,000 位达人。');
      const rows = internal ? message.creators : message.creators.filter(c => c?.platform === platform).map(c => ({ platform, externalId: c.externalId, name: c.name, profileUrl: c.profileUrl, sourceUrl: sender.url, followers: c.followers, category: c.category, contact: c.contact, platformData: c.platformData, capturedAt: c.capturedAt }));
      const merged = mergeCreators(state.creators, rows);
      if (merged.creators.length > 5000) throw new Error('本地达人库最多 5,000 条，请导出备份后整理。');
      return { state: { ...state, creators: merged.creators }, added: merged.added, updated: merged.updated };
      });
      return internal ? result : { added: result.added, updated: result.updated };
    }
    case 'UPDATE_CREATOR': return changeState(state => {
      if (!state.creators.some(c => c.id === message.id)) throw new Error('没有找到此达人。');
      return { state: { ...state, creators: state.creators.map(c => c.id === message.id ? patchCreator(c, message.patch) : c) } };
    });
    case 'ADD_DRAFTS': return changeState(state => ({ state: { ...state, drafts: createDrafts(state.creators, message.ids, message.template, state.drafts) } }));
    case 'UPDATE_DRAFT': return changeState(state => {
      if (!['pending', 'copied', 'done', 'skipped'].includes(message.status)) throw new Error('草稿状态无效。');
      if (!state.drafts.some(d => d.id === message.id)) throw new Error('没有找到此草稿。');
      return { state: { ...state, drafts: state.drafts.map(d => d.id === message.id ? { ...d, status: message.status, updatedAt: new Date().toISOString() } : d) } };
    });
    case 'SAVE_PRESET': return changeState(state => {
      const preset = normalizePreset(message.preset);
      const existing = state.presets.findIndex(p => p.url === preset.url && p.name === preset.name);
      const presets = [...state.presets];
      if (existing >= 0) presets[existing] = { ...preset, id: presets[existing].id };
      else presets.push(preset);
      if (presets.length > 200) throw new Error('最多保存 200 个筛选书签。');
      return { state: { ...state, presets } };
    });
    case 'REMOVE_PRESET': return changeState(state => ({ state: { ...state, presets: state.presets.filter(p => p.id !== message.id) } }));
    case 'IMPORT_STATE': return changeState(state => ({ state: mergeImport(state, message.data) }));
    case 'OPEN_WORKBENCH': await chrome.tabs.create({ url: chrome.runtime.getURL('app.html') }); return {};
    default: throw new Error('不支持的操作。');
  }
}
if (globalThis.chrome?.runtime?.onMessage) {
  diagnostics();
  inviteController = createInviteController({ getCreators: async () => { await writeQueue; return (await readState()).creators; }, reportDiagnostic });
  chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === INVITE_ALARM) void inviteController.tick().catch(error => reportDiagnostic({ source: 'background', operation: 'background.alarm', level: 'error', code: 'WORKER_EXCEPTION', error })); });
  globalThis.addEventListener?.('error', event => reportDiagnostic({ source: 'background', operation: 'background.error', level: 'error', code: 'WORKER_EXCEPTION', error: event.error }));
  globalThis.addEventListener?.('unhandledrejection', event => reportDiagnostic({ source: 'background', operation: 'background.rejection', level: 'error', code: 'UNHANDLED_REJECTION', error: event.reason }));
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message, sender).then(result => sendResponse({ ok: true, ...result }), error => sendResponse({ ok: false, error: error?.message || '操作失败，请重试。', diagnosticLogged: true }));
    return true;
  });
}
