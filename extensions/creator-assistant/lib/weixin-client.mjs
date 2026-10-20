import { normalizeInviteConfig, summarizeInviteConfig } from './invite-config.mjs';

const KEY = 'creator-assistant-wx-contexts-v2';
const PREFIX = '/shop-faas/mmchannelstradeleague/finderSquare/cgi/';
const HOSTS = new Set(['channels.weixin.qq.com', 'store.weixin.qq.com']);
const DIAGNOSTIC_OPERATIONS = new Set(['weixin.products', 'weixin.precheck', 'weixin.send']);
const DIAGNOSTIC_PHASES = new Set(['START', 'ACCESS', 'REQUEST', 'PARSE', 'VALIDATE', 'PREFLIGHT', 'SUBMIT', 'RESULT', 'PERSIST', 'RECOVER', 'TICK']);
const DIAGNOSTIC_OUTCOMES = new Set(['STARTED', 'SUCCEEDED', 'FAILED', 'REJECTED', 'UNKNOWN', 'NOT_SUBMITTED', 'INTERRUPTED', 'MISMATCHED', 'RECOVERED', 'PAUSED']);
const DIAGNOSTIC_CODES = new Set(['STARTED', 'SUCCEEDED', 'OPTIONS_FAILED', 'CONFIGURE_FAILED', 'PREFLIGHT_FAILED', 'PLATFORM_REJECTED', 'IDENTITY_MISMATCH', 'SEND_FAILED', 'NOT_SUBMITTED', 'UNKNOWN', 'STORAGE_ERROR', 'UNEXPECTED_RESULT', 'RECOVERED', 'RECOVERY_FAILED', 'TICK_FAILED', 'HTTP_ERROR', 'TIMEOUT', 'NETWORK_ERROR', 'INVALID_JSON', 'RESPONSE_TOO_LARGE', 'PLATFORM_ERROR', 'INVALID_PAYLOAD', 'ACCESS_DENIED', 'CONTEXT_CHANGED']);
const clean = (value, max = 200) => typeof value === 'string' ? value.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max) : '';
const id = value => typeof value === 'string' && /^[A-Za-z0-9._-]{1,256}$/.test(value) ? value : '';
class WeixinDiagnosticError extends Error {
  constructor(code, message, httpStatus) {
    super(message);
    this.name = 'WeixinDiagnosticError';
    this.diagnosticCode = code;
    if (Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599) this.httpStatus = httpStatus;
  }
}
function emitDiagnostic(reportDiagnostic, operation, code, level, context = {}, error) {
  if (!DIAGNOSTIC_OPERATIONS.has(operation) || !DIAGNOSTIC_CODES.has(code) || !['error', 'warning', 'info'].includes(level)) return;
  const safeContext = {};
  if (DIAGNOSTIC_PHASES.has(context.phase)) safeContext.phase = context.phase;
  if (DIAGNOSTIC_OUTCOMES.has(context.outcome)) safeContext.outcome = context.outcome;
  for (const key of ['httpStatus', 'itemIndex', 'total', 'elapsedMs']) {
    const value = context[key];
    if (Number.isFinite(value) && value >= 0) safeContext[key] = Math.floor(value);
  }
  const event = { source: 'weixin', operation, code, level, platform: 'weixin', context: safeContext };
  if (error instanceof Error) event.error = error;
  else if (typeof error === 'string') event.error = { message: error };
  try {
    const result = reportDiagnostic(event);
    if (result && typeof result.then === 'function') void Promise.resolve(result).catch(() => {});
  } catch { /* Diagnostics never affect platform flow. */ }
}
function platformError(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 6) return undefined;
  for (const key of ['code', 'ret', 'errcode', 'errCode', 'errno', 'err_code']) {
    if (value[key] != null && Number.isFinite(Number(value[key])) && Number(value[key]) !== 0) return Number(value[key]);
  }
  for (const key of ['data', 'response', 'baseResp', 'base_resp']) {
    const error = platformError(value[key], depth + 1);
    if (error !== undefined) return error;
  }
  return undefined;
}
function contradictoryMessage(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 6) return false;
  const message = String(value.errmsg || value.errMsg || value.error_message || '').trim().toLowerCase();
  if (message && !['ok', 'success', '成功', '请求成功'].includes(message)) return true;
  return ['data', 'response', 'baseResp', 'base_resp'].some(key => contradictoryMessage(value[key], depth + 1));
}
const good = value => value?.code === 0 && platformError(value) === undefined && !contradictoryMessage(value);
function matchesRecipient(value, recipient, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 6) return true;
  if (value.finderUsername && value.finderUsername !== recipient.externalId) return false;
  if (value.talentAppid && value.talentAppid !== recipient.talentAppid) return false;
  return ['data', 'response', 'baseResp', 'base_resp'].every(key => matchesRecipient(value[key], recipient, depth + 1));
}
const uuid = () => crypto.randomUUID();
const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), n => n.toString(16).padStart(2, '0')).join('');

// Executed in the platform's MAIN world. Only public account identity is returned.
export function readWechatAccount() {
  const state = globalThis.__INITIAL_STATE__;
  const accountId = state?.userInfo?.appid;
  return {
    accountId: typeof accountId === 'string' ? accountId : '',
    accountLabel: typeof state?.accountInfo?.nickName === 'string' ? state.accountInfo.nickName : '当前店铺',
    documentId: String(performance.timeOrigin),
  };
}

export function createWeixinClient({ chromeApi = globalThis.chrome, fetchImpl = globalThis.fetch, readAccount, now = () => Date.now(), timeoutMs = 15000, reportDiagnostic = () => {} } = {}) {
  let writes = Promise.resolve();
  const accountReader = readAccount || (async tabId => {
    const result = await chromeApi.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: 'MAIN', func: readWechatAccount });
    return { ...result?.[0]?.result, documentId: result?.[0]?.documentId || result?.[0]?.result?.documentId };
  });
  const load = async () => (await chromeApi.storage.session.get(KEY))[KEY] || {};
  async function save(tabId, context) {
    const pending = writes.then(async () => {
      try {
        const all = await load();
        all[tabId] = context;
        const keys = Object.keys(all);
        for (const key of keys.slice(0, Math.max(0, keys.length - 10))) if (key !== String(tabId)) delete all[key];
        await chromeApi.storage.session.set({ [KEY]: all });
      } catch { throw new WeixinDiagnosticError('STORAGE_ERROR', '店铺状态保存失败。'); }
    });
    writes = pending.catch(() => {});
    return pending;
  }
  async function access(tabId) {
    if (!Number.isInteger(tabId)) throw new WeixinDiagnosticError('ACCESS_DENIED', '请选择视频号店铺页面。');
    let tab;
    try { tab = await chromeApi.tabs.get(tabId); }
    catch { throw new WeixinDiagnosticError('ACCESS_DENIED', '视频号店铺页面不可用。'); }
    let url;
    try { url = new URL(tab.url); }
    catch { throw new WeixinDiagnosticError('ACCESS_DENIED', '无法读取视频号店铺页面。'); }
    if (tab.incognito || url.protocol !== 'https:' || !HOSTS.has(url.hostname) || url.username || url.password || url.port) throw new WeixinDiagnosticError('ACCESS_DENIED', '请在普通浏览窗口中打开视频号店铺页面。');
    let before;
    try { before = await accountReader(tabId); }
    catch { throw new WeixinDiagnosticError('ACCESS_DENIED', '无法读取视频号店铺身份。'); }
    if (!id(before?.accountId) || !clean(before?.documentId)) throw new WeixinDiagnosticError('ACCESS_DENIED', '请先在视频号店铺后台登录并打开达人页面。');
    let stores;
    try { stores = await chromeApi.cookies.getAllCookieStores(); }
    catch { throw new WeixinDiagnosticError('ACCESS_DENIED', '无法读取当前店铺登录状态。'); }
    const store = stores.find(s => Array.isArray(s.tabIds) && s.tabIds.includes(tabId));
    if (!store) throw new WeixinDiagnosticError('ACCESS_DENIED', '无法读取当前店铺登录状态。');
    let cookie;
    try { cookie = await chromeApi.cookies.get({ url: url.origin + PREFIX, name: 'biz_magic', storeId: store.id }); }
    catch { throw new WeixinDiagnosticError('ACCESS_DENIED', '视频号登录状态不可用。'); }
    if (!cookie?.value || cookie.value.length > 8192 || /[\r\n]/.test(cookie.value)) throw new WeixinDiagnosticError('ACCESS_DENIED', '视频号登录状态不可用，请重新登录后再试。');
    let after;
    try { after = await accountReader(tabId); }
    catch { throw new WeixinDiagnosticError('CONTEXT_CHANGED', '店铺页面已变化，请重新设置邀约。'); }
    if (after.accountId !== before.accountId || after.documentId !== before.documentId) throw new WeixinDiagnosticError('CONTEXT_CHANGED', '店铺页面已变化，请重新设置邀约。');
    const fingerprint = await digest(cookie.value);
    return { tabId, origin: url.origin, accountId: before.accountId, accountLabel: clean(before.accountLabel, 120) || '当前店铺', documentId: before.documentId, cookieDigest: fingerprint, cookieValue: cookie.value, storeId: store.id };
  }
  function same(context, current) {
    return context && context.origin === current.origin && context.accountId === current.accountId && context.documentId === current.documentId && context.cookieDigest === current.cookieDigest && context.storeId === current.storeId;
  }
  async function contextFor(tabId, allowNew = true) {
    const current = await access(tabId);
    await writes;
    let context = (await load())[tabId];
    if (!same(context, current)) {
      if (!allowNew) throw new WeixinDiagnosticError('CONTEXT_CHANGED', '店铺或登录状态已变化，请重新设置本批邀约。');
      context = { contextId: uuid(), origin: current.origin, accountId: current.accountId, accountLabel: current.accountLabel, documentId: current.documentId, cookieDigest: current.cookieDigest, storeId: current.storeId, products: [], configurations: {}, tickets: {} };
      await save(tabId, context);
    }
    return { context, current };
  }
  async function request(current, name, { method = 'GET', params = {}, body } = {}) {
    const operation = name === 'getMergedItemList' ? 'weixin.products' : body?.preCheck === true ? 'weixin.precheck' : 'weixin.send';
    const url = new URL(current.origin + PREFIX + name);
    url.search = new URLSearchParams({ token: '', lang: 'zh_CN', ...params }).toString();
    const abort = new AbortController();
    const startedAt = now();
    let timer = 0;
    let timedOut = false;
    let lastHttpStatus;
    try {
      const work = (async () => {
        let response;
        try {
          response = await fetchImpl(url.href, {
            method, credentials: 'include', redirect: 'error', signal: abort.signal,
            headers: { 'Content-Type': 'application/json', biz_magic: current.cookieValue },
            ...(body ? { body: JSON.stringify(body) } : {}),
          });
        } catch {
          throw new WeixinDiagnosticError(timedOut ? 'TIMEOUT' : 'NETWORK_ERROR', timedOut ? '平台请求超时，请稍后查看结果。' : '平台请求中断，请稍后重试。');
        }
        const httpStatus = Number.isInteger(response?.status) ? response.status : undefined;
        lastHttpStatus = httpStatus;
        if (!response?.ok) throw new WeixinDiagnosticError('HTTP_ERROR', '平台请求未完成，请检查店铺登录状态。', httpStatus);
        let text;
        try { text = await response.text(); }
        catch { throw new WeixinDiagnosticError(timedOut ? 'TIMEOUT' : 'NETWORK_ERROR', timedOut ? '平台请求超时，请稍后查看结果。' : '读取平台响应失败。', httpStatus); }
        if (text.length > 1024 * 1024) throw new WeixinDiagnosticError('RESPONSE_TOO_LARGE', '平台返回内容过多，请缩小查询范围。', httpStatus);
        try { return JSON.parse(text); }
        catch { throw new WeixinDiagnosticError('INVALID_JSON', '平台返回内容暂时无法识别。', httpStatus); }
      })();
      return await Promise.race([
        work,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            abort.abort();
          reject(new WeixinDiagnosticError('TIMEOUT', '平台请求超时，请稍后查看结果。', lastHttpStatus));
          }, timeoutMs);
        }),
      ]);
    } catch (rawError) {
      const error = rawError instanceof WeixinDiagnosticError
        ? rawError
        : new WeixinDiagnosticError(timedOut ? 'TIMEOUT' : 'NETWORK_ERROR', timedOut ? '平台请求超时，请稍后查看结果。' : '平台请求中断，请稍后重试。');
      error.diagnosticReported = true;
      emitDiagnostic(reportDiagnostic, operation, error.diagnosticCode, 'error', {
        phase: error.diagnosticCode === 'INVALID_JSON' || error.diagnosticCode === 'RESPONSE_TOO_LARGE' ? 'PARSE' : 'REQUEST',
        outcome: error.diagnosticCode === 'TIMEOUT' ? 'UNKNOWN' : 'FAILED',
        httpStatus: error.httpStatus,
        elapsedMs: Math.max(0, now() - startedAt),
      }, error);
      throw error;
    } finally { clearTimeout(timer); }
  }
  const rejection = raw => clean(raw?.baseResp?.errmsg || raw?.message || raw?.msg, 180) || '平台暂不允许邀请。';
  function productsFrom(raw) {
    const source = raw?.itemList || raw?.data?.itemList;
  if (!Array.isArray(source)) throw new WeixinDiagnosticError('INVALID_PAYLOAD', '没有读取到商品列表，请打开店铺商品页面后重试。');
    const products = [];
    for (const item of source.slice(0, 200)) {
      const productId = id(typeof item?.spuId === 'number' && Number.isSafeInteger(item.spuId) ? String(item.spuId) : item?.spuId);
      const name = clean(item?.productInfo?.title);
      if (!productId || !name) continue;
      const price = item.productInfo.price;
      products.push({ id: productId, name, priceText: Number.isFinite(Number(price)) && price !== null && price !== '' && Number(price) >= 0 ? '¥' + (Number(price) / 100).toFixed(2) : '' });
    }
    return products;
  }
  function optionsDTO(context, { products = context.products, hasMore = false, cursor = '', reason = '' } = {}) {
    return { ready: true, platform: 'weixin', contextId: context.contextId, accountLabel: context.accountLabel, mode: 'words', products, hasMore, cursor, categories: [], rights: [], reason };
  }
  async function options(tabId, recipient, { keyword = '', cursor = '' } = {}) {
    const startedAt = now();
    emitDiagnostic(reportDiagnostic, 'weixin.products', 'STARTED', 'info', { phase: 'START', outcome: 'STARTED' });
    try {
      if (!id(recipient?.talentAppid)) throw new WeixinDiagnosticError('INVALID_PAYLOAD', '该达人资料不完整，请从平台页面重新收录。');
      const { context, current } = await contextFor(tabId);
      // The observed platform endpoint supports exact SPU search, not an assumed keyword API.
      const query = clean(keyword, 200);
      const params = { pageSize: '10', talentAppid: recipient.talentAppid };
      if (cursor) params.lastBuf = clean(cursor, 256);
      if (/^\d{1,30}$/.test(query)) params.spuId = query;
      const raw = await request(current, 'getMergedItemList', { params });
      if ((raw?.code != null && !good(raw)) || platformError(raw) !== undefined || contradictoryMessage(raw)) {
        throw new WeixinDiagnosticError('PLATFORM_ERROR', rejection(raw));
      }
      const all = new Map(context.products.map(p => [p.id, p]));
      const found = productsFrom(raw);
      for (const product of found) all.set(product.id, product);
      context.products = [...all.values()].slice(-500);
      await save(tabId, context);
      const data = raw.data && Array.isArray(raw.data.itemList) ? raw.data : raw;
      const listed = query && !/^\d{1,30}$/.test(query) ? context.products.filter(p => p.name.includes(query)) : found;
      const result = optionsDTO(context, { products: listed, hasMore: data.hasMore === true && !!data.lastBuf, cursor: clean(data.lastBuf, 256), reason: query && !/^\d{1,30}$/.test(query) ? '在已读取的商品中搜索；未找到时可继续加载商品。' : '' });
      emitDiagnostic(reportDiagnostic, 'weixin.products', 'SUCCEEDED', 'info', { phase: 'RESULT', outcome: 'SUCCEEDED', elapsedMs: Math.max(0, now() - startedAt) });
      return result;
    } catch (rawError) {
      const error = rawError instanceof WeixinDiagnosticError ? rawError : new WeixinDiagnosticError('ACCESS_DENIED', '读取视频号商品列表失败。');
      if (!error.diagnosticReported) {
        emitDiagnostic(reportDiagnostic, 'weixin.products', error.diagnosticCode || 'ACCESS_DENIED', 'error', {
          phase: error.diagnosticCode === 'STORAGE_ERROR' ? 'PERSIST' : error.diagnosticCode === 'INVALID_PAYLOAD' || error.diagnosticCode === 'PLATFORM_ERROR' ? 'PARSE' : 'ACCESS',
          outcome: 'FAILED', httpStatus: error.httpStatus, elapsedMs: Math.max(0, now() - startedAt),
        }, error);
      }
      throw error;
    }
  }
  async function configure(tabId, configuration) {
    const { context } = await contextFor(tabId, false);
    const options = optionsDTO(context);
    const config = normalizeInviteConfig('weixin', configuration, options);
    const descriptor = { ready: true, platform: 'weixin', contextId: context.contextId, flowVersion: 2, templateId: uuid(), expiresAt: new Date(now() + 24 * 60 * 60 * 1000).toISOString(), referenceRecipientId: '', summary: summarizeInviteConfig('weixin', config, options) };
    context.configurations = { [descriptor.templateId]: { descriptor, configuration: config } };
    context.tickets = {};
    await save(tabId, context);
    return descriptor;
  }
  async function configured(job) {
    const { context, current } = await contextFor(job.tabId, false);
    const stored = context.configurations[job.templateId];
    if (context.contextId !== job.contextId || !stored || Date.parse(stored.descriptor.expiresAt) <= now()) throw new Error('本批邀约设置已失效，请重新设置。');
    return { context, current, ...stored };
  }
  function recipientId(recipient) {
    if (recipient?.platform !== 'weixin' || !id(recipient.externalId) || !id(recipient.talentAppid)) throw new Error('达人资料不完整，请重新读取平台页面。');
    return recipient.externalId + ':' + recipient.talentAppid;
  }
  async function preflight(job, recipient) {
    const startedAt = now();
    emitDiagnostic(reportDiagnostic, 'weixin.precheck', 'STARTED', 'info', { phase: 'START', outcome: 'STARTED' });
    try {
      const key = recipientId(recipient);
      const { context, current } = await configured(job);
      const raw = await request(current, 'createPromotionInvitation', { method: 'POST', body: { finderUsername: recipient.externalId, talentAppid: recipient.talentAppid, inviteScene: 0, preCheck: true } });
      if (!good(raw)) {
        const code = platformError(raw) !== undefined ? 'PLATFORM_REJECTED' : 'PREFLIGHT_FAILED';
        emitDiagnostic(reportDiagnostic, 'weixin.precheck', code, code === 'PLATFORM_REJECTED' ? 'warning' : 'error', {
          phase: 'PREFLIGHT', outcome: code === 'PLATFORM_REJECTED' ? 'REJECTED' : 'FAILED', elapsedMs: Math.max(0, now() - startedAt),
        }, rejection(raw));
        return { ok: false, platformRejected: platformError(raw) !== undefined, code: platformError(raw), reason: rejection(raw) };
      }
      if (!matchesRecipient(raw, recipient)) {
        const reason = '平台返回的达人与当前选择不一致，已停止。';
        emitDiagnostic(reportDiagnostic, 'weixin.precheck', 'IDENTITY_MISMATCH', 'error', { phase: 'VALIDATE', outcome: 'MISMATCHED', elapsedMs: Math.max(0, now() - startedAt) }, reason);
        return { ok: false, reason };
      }
      context.tickets[key] = { templateId: job.templateId, until: now() + 60000 };
      await save(job.tabId, context);
      emitDiagnostic(reportDiagnostic, 'weixin.precheck', 'SUCCEEDED', 'info', { phase: 'RESULT', outcome: 'SUCCEEDED', elapsedMs: Math.max(0, now() - startedAt) });
      return { ok: true };
    } catch (rawError) {
      const error = rawError instanceof WeixinDiagnosticError ? rawError : new WeixinDiagnosticError('PREFLIGHT_FAILED', '视频号邀约预检失败。');
      if (!error.diagnosticReported) emitDiagnostic(reportDiagnostic, 'weixin.precheck', error.diagnosticCode || 'PREFLIGHT_FAILED', 'error', {
        phase: error.diagnosticCode === 'STORAGE_ERROR' ? 'PERSIST' : error.diagnosticCode === 'ACCESS_DENIED' || error.diagnosticCode === 'CONTEXT_CHANGED' ? 'ACCESS' : 'PREFLIGHT',
        outcome: 'FAILED', httpStatus: error.httpStatus, elapsedMs: Math.max(0, now() - startedAt),
      }, error);
      return { ok: false, reason: error.message };
    }
  }
  // All asynchronous account/cookie checks happen before controller's final short state lock.
  async function prepareSend(job, recipient) {
    let accessResult, key;
    try { key = recipientId(recipient); accessResult = await configured(job); }
    catch (rawError) {
      const error = rawError instanceof WeixinDiagnosticError ? rawError : new WeixinDiagnosticError('ACCESS_DENIED', '视频号邀约设置已失效。');
      return () => {
        emitDiagnostic(reportDiagnostic, 'weixin.send', 'NOT_SUBMITTED', 'warning', { phase: 'ACCESS', outcome: 'NOT_SUBMITTED' }, error);
        return Promise.resolve({ status: 'failed', notSubmitted: true, message: error.message });
      };
    }
    const { context, current, configuration } = accessResult;
    const ticket = context.tickets[key];
    if (!ticket || ticket.templateId !== job.templateId || ticket.until < now()) return () => {
      const message = '请先完成本位达人的检查。';
      emitDiagnostic(reportDiagnostic, 'weixin.send', 'NOT_SUBMITTED', 'warning', { phase: 'VALIDATE', outcome: 'NOT_SUBMITTED' }, message);
      return Promise.resolve({ status: 'failed', notSubmitted: true, message });
    };
    delete context.tickets[key];
    try { await save(job.tabId, context); }
    catch (error) {
      emitDiagnostic(reportDiagnostic, 'weixin.send', 'STORAGE_ERROR', 'error', { phase: 'PERSIST', outcome: 'NOT_SUBMITTED' }, error);
      throw error;
    }
    const body = {
      finderUsername: recipient.externalId, talentAppid: recipient.talentAppid,
      itemList: { itemInfo: configuration.productIds.map(spuId => ({ spuId })) },
      contactInfo: { contactName: configuration.contactName, contactWxId: configuration.wechat, contactPhoneNumber: configuration.phone, invitationIntroduction: configuration.message, inviteScene: '1' },
    };
    let used = false;
    return async () => {
      const startedAt = now();
      emitDiagnostic(reportDiagnostic, 'weixin.send', 'STARTED', 'info', { phase: 'START', outcome: 'STARTED' });
      if (used) {
        const message = '这次邀请已提交，请先核对结果。';
        emitDiagnostic(reportDiagnostic, 'weixin.send', 'NOT_SUBMITTED', 'warning', { phase: 'VALIDATE', outcome: 'NOT_SUBMITTED' }, message);
        return { status: 'failed', notSubmitted: true, message };
      }
      used = true;
      try {
        const raw = await request(current, 'createPromotionInvitation', { method: 'POST', body });
        if (good(raw) && matchesRecipient(raw, recipient)) {
          emitDiagnostic(reportDiagnostic, 'weixin.send', 'SUCCEEDED', 'info', { phase: 'RESULT', outcome: 'SUCCEEDED', elapsedMs: Math.max(0, now() - startedAt) });
          return { status: 'succeeded', code: 0, message: '平台明确返回邀请成功。' };
        }
        if (platformError(raw) !== undefined) {
          const message = rejection(raw);
          emitDiagnostic(reportDiagnostic, 'weixin.send', 'PLATFORM_REJECTED', 'warning', { phase: 'RESULT', outcome: 'REJECTED', elapsedMs: Math.max(0, now() - startedAt) }, message);
          return { status: 'failed', platformRejected: true, code: platformError(raw), message };
        }
        const message = !matchesRecipient(raw, recipient) ? '平台返回的达人与当前选择不一致，已停止。' : '平台未返回明确结果，请在平台核对，系统不会重发。';
        if (!matchesRecipient(raw, recipient)) emitDiagnostic(reportDiagnostic, 'weixin.send', 'IDENTITY_MISMATCH', 'error', { phase: 'VALIDATE', outcome: 'MISMATCHED', elapsedMs: Math.max(0, now() - startedAt) }, message);
        else emitDiagnostic(reportDiagnostic, 'weixin.send', 'PLATFORM_ERROR', 'warning', { phase: 'RESULT', outcome: 'UNKNOWN', elapsedMs: Math.max(0, now() - startedAt) }, message);
        emitDiagnostic(reportDiagnostic, 'weixin.send', 'UNKNOWN', 'error', { phase: 'RESULT', outcome: 'UNKNOWN', elapsedMs: Math.max(0, now() - startedAt) }, message);
        return { status: 'unknown', message };
      } catch (rawError) {
        const error = rawError instanceof WeixinDiagnosticError ? rawError : new WeixinDiagnosticError('NETWORK_ERROR', '邀请请求中断，结果未明。');
        emitDiagnostic(reportDiagnostic, 'weixin.send', 'UNKNOWN', 'error', { phase: 'RESULT', outcome: 'UNKNOWN', httpStatus: error.httpStatus, elapsedMs: Math.max(0, now() - startedAt) }, error);
        return { status: 'unknown', message: '邀请请求中断，结果未明，请在平台核对，系统不会重发。' };
      }
    };
  }
  async function inspect(job) {
    try { return (await configured(job)).descriptor; }
    catch (error) { return { ready: false, reason: error.message }; }
  }
  return { options, configure, preflight, prepareSend, inspect };
}
