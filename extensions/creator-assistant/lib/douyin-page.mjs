export function executeDouyinPage(operation, args) {
  'use strict';

  const isRecord = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    try {
      const prototype = Object.getPrototypeOf(value);
      return prototype === Object.prototype || prototype === null;
    } catch (_) { return false; }
  };
  const safeText = (value, max = 500) => typeof value === 'string'
    ? value.slice(0, max * 4).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
    : '';
  const safeId = (value) => {
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value) || value <= 0) return '';
      value = String(value);
    }
    if (typeof value !== 'string') return '';
    const result = value.trim();
    return result.length > 0 && result.length <= 256 && /^[A-Za-z0-9._-]+$/.test(result) ? result : '';
  };
  const fail = (reason, extra = {}) => ({ ok: false, reason: safeText(reason || '操作未完成。', 200), ...extra });
  const validSessionKey = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(value);
  const validCapability = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{40,128}$/.test(value);
  if (!['install', 'inspect', 'options', 'configure', 'preflight', 'send', 'release'].includes(operation)) return fail('不支持的抖音页面操作。');
  if (!isRecord(args)) args = {};

  if (operation === 'install') {
    const sessionKey = args.sessionKey;
    const capability = args.capability;
    if (!validSessionKey(sessionKey) || !validCapability(capability)) return fail('页面连接参数无效。');
    let location;
    try { location = new URL(globalThis.location.href); } catch (_) { return fail('当前页面地址不可用。'); }
    if (location.protocol !== 'https:' || location.hostname !== 'buyin.jinritemai.com' || location.username || location.password) {
      return { ready: false, platform: 'douyin', contextId: '', accountLabel: '', reason: '请在抖音官方达人工作台标签页读取。' };
    }
    const existing = globalThis[sessionKey];
    if (existing && typeof existing.inspect === 'function') {
      try {
        const current = existing.inspect(capability);
        if (current && current.platform === 'douyin') return current;
      } catch (_) {}
      return fail('页面运行时冲突，请重新连接当前标签页。');
    }
    try {
      if (Object.prototype.hasOwnProperty.call(globalThis, sessionKey)) return fail('页面运行时冲突，请重新连接当前标签页。');
    } catch (_) { return fail('页面运行时冲突，请重新连接当前标签页。'); }

    const MAX_BODY_BYTES = 1024 * 1024;
    const MAX_RESPONSE_BYTES = 1024 * 1024;
    const MAX_ROWS = 500;
    const OP_TIMEOUT_MS = 15 * 1000;
    const CONFIG_TTL_MS = 24 * 60 * 60 * 1000;
    const INVALID = Symbol('invalid-json');
    const READ_ENDPOINTS = new Set([
      '/square_pc_api/square/search_feed_author',
      '/square_pc_api/common/square/squareConf',
      '/connection/pc/im/account_check',
      '/connection/pc/im/promotion/list',
      '/connection/pc/im/card/sender/msg',
    ]);
    const SEND_ENDPOINTS = new Set([
      '/connection/pc/im/invite/card/send',
      '/connection/pc/im/shangda/msgs/send',
    ]);
    const state = {
      capability,
      context: null,
      routeKey: currentRouteKey(),
      products: [],
      productCatalog: new Map(),
      productCatalogContextId: '',
      productHasMore: false,
      productCursor: '',
      productPageCount: 0,
      officialCategories: new Map(),
      officialCategoriesContextId: '',
      verificationParams: Object.create(null),
      cardInfo: null,
      searchRows: new Map(),
      accountChecks: new Map(),
      activeAccountCheck: null,
      activeRecipient: null,
      optionsSnapshot: null,
      configuration: null,
      approved: null,
      guardMode: 'idle',
      quarantine: false,
      readonlySendAttempt: false,
      operationInFlight: false,
      armed: null,
      lastGuardResult: null,
      promotionSequence: 0,
      operationSequence: 0,
    };
    const xhrState = new WeakMap();
    const watchedXhrs = new WeakSet();
    const originalFetch = globalThis.fetch;
    const originalHistory = {};
    const NativeResponse = globalThis.Response;

    function currentRouteKey() {
      try { return new URL(globalThis.location.href).href; } catch (_) { return ''; }
    }

    function parseStoredJson(storage, key) {
      try {
        const text = storage && storage.getItem(key);
        if (!text || typeof text !== 'string' || text.length > 128 * 1024) return null;
        const value = JSON.parse(text);
        return isRecord(value) ? value : null;
      } catch (_) { return null; }
    }

    function inspectKnownFields(root) {
      const found = { shopId: '', userId: '', shopLabel: '' };
      const queue = [{ value: root, depth: 0 }];
      const seen = new Set();
      const childKeys = ['data', 'userInfo', 'user_info', 'user', 'account', 'accountInfo', 'account_info', 'shop', 'shopInfo', 'shop_info', 'store', 'storeInfo'];
      while (queue.length && seen.size < 200) {
        const current = queue.shift();
        const value = current && current.value;
        const depth = current && current.depth;
        if (!isRecord(value) || depth > 4 || seen.has(value)) continue;
        seen.add(value);
        if (!found.shopId) found.shopId = safeId(value.shop_id || value.shopId || value.appid || value.appId);
        if (!found.userId) found.userId = safeId(value.user_id || value.userId || value.uid);
        if (!found.shopLabel) found.shopLabel = safeText(value.shop_name || value.shopName || value.nickname, 120);
        if (depth < 4) for (const key of childKeys) if (isRecord(value[key])) queue.push({ value: value[key], depth: depth + 1 });
      }
      return found;
    }

    function readShopContext() {
      let local = null;
      let session = null;
      try { local = parseStoredJson(globalThis.localStorage, 'BUYIN_USER_LOGIN_STORAGE'); } catch (_) {}
      try { session = parseStoredJson(globalThis.sessionStorage, 'userInfo'); } catch (_) {}
      const localFields = inspectKnownFields(local);
      const sessionFields = inspectKnownFields(session);
      const shopId = localFields.shopId || sessionFields.shopId;
      const userId = localFields.userId || sessionFields.userId;
      const shopLabel = localFields.shopLabel || sessionFields.shopLabel || '当前店铺';
      const stableId = shopId || userId;
      if (!stableId) return null;
      return {
        id: `${shopId ? `shop:${shopId}` : `user:${userId}`}${userId && shopId ? `|user:${userId}` : ''}`,
        accountLabel: shopLabel,
      };
    }

    function clearFlowData() {
      state.products = [];
      state.productCatalog.clear();
      state.productCatalogContextId = '';
      state.productHasMore = false;
      state.productCursor = '';
      state.productPageCount = 0;
      state.officialCategories.clear();
      state.officialCategoriesContextId = '';
      state.verificationParams = Object.create(null);
      state.cardInfo = null;
      state.searchRows.clear();
      state.accountChecks.clear();
      state.activeAccountCheck = null;
      state.activeRecipient = null;
      state.optionsSnapshot = null;
      state.configuration = null;
      state.approved = null;
      state.armed = null;
      state.lastGuardResult = null;
    }

    function refreshContext() {
      const next = readShopContext();
      const route = currentRouteKey();
      if (route !== state.routeKey) {
        state.routeKey = route;
        clearFlowData();
        state.guardMode = 'readonly';
        state.quarantine = true;
      }
      if (!next) return { ok: false, context: null, changed: false };
      if (state.context && state.context.id !== next.id) {
        clearFlowData();
        state.guardMode = 'readonly';
        state.quarantine = true;
        state.context = next;
        return { ok: true, context: next, changed: true };
      }
      if (!state.context) state.context = next;
      else state.context = next;
      return { ok: true, context: next, changed: false };
    }

    function emptyOptions(context, reason) {
      return {
        ready: false,
        platform: 'douyin',
        contextId: context && context.id || '',
        accountLabel: context && context.accountLabel || '',
        mode: 'words',
        products: [],
        hasMore: false,
        cursor: '',
        categories: [],
        rights: [],
        reason: safeText(reason, 200),
      };
    }

    function responseOutcome(payload, httpOk = true) {
      if (!isRecord(payload)) return { kind: 'unknown', code: undefined };
      const layers = [];
      const seen = new Set();
      const visit = (value, depth) => {
        if (!isRecord(value) || depth > 3 || seen.has(value)) return;
        seen.add(value);
        layers.push(value);
        for (const key of ['data', 'response', 'result']) if (isRecord(value[key])) visit(value[key], depth + 1);
      };
      visit(payload, 0);
      const codes = layers.filter((value) => typeof value.code === 'number').map((value) => value.code);
      const explicit = codes.find((code) => code !== 0);
      for (const layer of layers) {
        const base = layer.baseResp || layer.base_resp;
        if (!isRecord(base)) continue;
        for (const key of ['errCode', 'errcode', 'ret', 'retCode']) if (Object.hasOwn(base, key) && Number(base[key]) !== 0) return { kind: 'failed', code: Number(base[key]) };
        const message = safeText(String(base.errmsg || base.errMsg || ''), 120).toLowerCase();
        if (message && !['ok', 'success'].includes(message)) return { kind: 'failed', code: codes.find((code) => code === 0) };
      }
      if (explicit !== undefined) return { kind: 'failed', code: explicit };
      if (!codes.includes(0) || !httpOk) return { kind: 'unknown', code: codes.includes(0) ? 0 : undefined };
      return { kind: 'succeeded', code: 0 };
    }

    function readStreamText(stream, maxBytes = MAX_RESPONSE_BYTES) {
      return new Promise((resolve, reject) => {
        if (!stream || typeof stream.getReader !== 'function') return reject(new Error('stream unavailable'));
        let reader;
        try { reader = stream.getReader(); } catch (error) { reject(error); return; }
        let bytes = 0;
        let text = '';
        const decoder = new TextDecoder();
        const failRead = (error) => { try { reader.cancel(); } catch (_) {} reject(error); };
        const next = () => {
          Promise.resolve().then(() => reader.read()).then((part) => {
            if (!part || part.done) { text += decoder.decode(); resolve(text); return; }
            const size = part.value && part.value.byteLength || 0;
            if (bytes + size > maxBytes) { failRead(new Error('payload too large')); return; }
            bytes += size;
            text += decoder.decode(part.value, { stream: true });
            next();
          }).catch(failRead);
        };
        next();
      });
    }

    function readResponse(response) {
      let clone;
      try { clone = response && typeof response.clone === 'function' ? response.clone() : null; } catch (_) { return Promise.reject(new Error('response clone failed')); }
      return readStreamText(clone && clone.body).then((text) => JSON.parse(text));
    }

    function parseJsonBody(body) {
      if (typeof body !== 'string' || body.length > MAX_BODY_BYTES) return null;
      try {
        const value = JSON.parse(body);
        return isRecord(value) ? value : null;
      } catch (_) { return null; }
    }

    function requestUrl(input) {
      try { return typeof input === 'string' ? new URL(input, globalThis.location.href) : input && typeof input.url === 'string' ? new URL(input.url, globalThis.location.href) : null; } catch (_) { return null; }
    }

    function allowedReadPath(url) {
      return url && url.protocol === 'https:' && url.hostname === 'buyin.jinritemai.com'
        && ['/square_pc_api/square/search_feed_author', '/square_pc_api/common/square/squareConf', '/connection/pc/im/account_check', '/connection/pc/im/promotion/list', '/connection/pc/im/card/sender/msg'].includes(url.pathname);
    }

    function captureVerificationParams(url) {
      if (!allowedReadPath(url)) return;
      for (const key of ['fp', 'verifyFp']) {
        const value = url.searchParams.get(key);
        if (typeof value === 'string' && value.length > 0 && value.length <= 256 && /^[A-Za-z0-9._-]+$/.test(value)) {
          state.verificationParams[key] = value;
        }
      }
    }

    function isKnownSendPath(url) {
      return url && url.protocol === 'https:' && url.hostname === 'buyin.jinritemai.com'
        && ['/connection/pc/im/invite/card/send', '/connection/pc/im/shangda/msgs/send'].includes(url.pathname);
    }

    function getRequestBody(init, input) {
      if (init && typeof init.body === 'string' && init.body.length <= MAX_BODY_BYTES) return init.body;
      if (input && typeof input.bodyText === 'string' && input.bodyText.length <= MAX_BODY_BYTES) return input.bodyText;
      return '';
    }

    function shallowRequestIdentity(path, body, url) {
      const parsed = parseJsonBody(body);
      let id = '';
      if (path === '/connection/pc/im/account_check') id = safeId(parsed && (parsed.account_id || parsed.uid || parsed.user_id)) || '';
      if (path === '/square_pc_api/square/search_feed_author') id = safeId(parsed && (parsed.uid || parsed.account_id || parsed.author_id)) || '';
      if (!id && url) id = safeId(url.searchParams.get('account_id') || url.searchParams.get('uid'));
      return id;
    }

    function mapSearchRows(payload) {
      const data = isRecord(payload) && isRecord(payload.data) ? payload.data : null;
      const rows = data && Array.isArray(data.list) ? data.list : [];
      const result = [];
      for (const row of rows.slice(0, MAX_ROWS)) {
        const base = row && (row.author_base || row.author_data && row.author_data.author_base || row.author_data);
        if (!isRecord(base)) continue;
        const accountId = safeId(base.account_id || base.uid || base.author_id || base.sec_author_id);
        const externalId = safeId(base.uid || base.author_id || base.sec_author_id || base.aweme_id);
        const searchAccount = safeId(base.aweme_id || base.account_douyin || base.unique_id);
        if (!accountId || !externalId) continue;
        result.push({ accountId, externalId, searchAccount, name: safeText(base.nickname || base.author_name, 120) });
      }
      return result;
    }

    function productRows(payload) {
      const data = isRecord(payload) && isRecord(payload.data) ? payload.data : null;
      if (!data || !Array.isArray(data.promotion_list)) return null;
      const result = [];
      for (const row of data.promotion_list.slice(0, 500)) {
        if (!isRecord(row)) return null;
        const productInfo = isRecord(row.productInfo) ? row.productInfo : {};
        const id = safeId(row.product_id || row.productId || row.spuId || row.spu_id);
        const name = safeText(row.product_name || row.productName || row.name || row.title || productInfo.title, 180);
        if (!id || !name) return null;
        const rawPrice = row.priceText || row.price_text || row.price || row.product_price || productInfo.price;
        const priceText = typeof rawPrice === 'string' && /[￥¥元]/.test(rawPrice) ? safeText(rawPrice, 80) : '';
        result.push({ id, name, ...(priceText ? { priceText } : {}) });
      }
      const hasMoreRaw = data.has_more === undefined ? data.hasMore : data.has_more;
      const hasMore = hasMoreRaw === true || hasMoreRaw === 1 || hasMoreRaw === '1';
      return { products: result, hasMore };
    }

    function cardMode(payload) {
      const data = isRecord(payload) && isRecord(payload.data) ? payload.data : null;
      const info = data && data.invite_card_info;
      if (!isRecord(info) || ![0, 1, '0', '1'].includes(info.card_version)) return null;
      return {
        mode: Number(info.card_version) === 1 ? 'category' : 'words',
        cardVersion: Number(info.card_version),
      };
    }

    function accountCheck(payload) {
      const data = isRecord(payload) && isRecord(payload.data) ? payload.data : null;
      if (!data || typeof data.is_passed !== 'boolean') return null;
      const code = isRecord(payload) && typeof payload.code === 'number' ? payload.code : undefined;
      return { isPassed: data.is_passed, reason: safeText(data.popwindow_text || data.reason || '', 180), ...(code !== undefined ? { code } : {}) };
    }

    function captureReadResponse(path, requestId, payload, requestContext = null) {
      if (path === '/connection/pc/im/account_check') {
        const check = accountCheck(payload);
        const active = state.activeAccountCheck;
        const recipient = requestContext && requestContext.recipient;
        const requestMatches = !requestId || recipient && [recipient.accountId, recipient.externalId, recipient.rowKey].includes(requestId);
        if (!check || !active || !requestContext || requestContext.token !== active.token
          || !recipient || !sameRecipient(recipient, active.recipient) || !requestMatches) return;
        const outcome = responseOutcome(payload);
        const usable = outcome.kind !== 'failed' || check.isPassed === false;
        state.accountChecks.set(active.recipient.accountId, usable ? check : {
          isPassed: null,
          code: check.code,
          reason: '官方准入检查返回了错误结果。',
        });
        return;
      }
      const outcome = responseOutcome(payload);
      if (outcome.kind !== 'succeeded') return;
      if (path === '/square_pc_api/square/search_feed_author') {
        const rows = mapSearchRows(payload);
        for (const row of rows) state.searchRows.set(row.accountId, row);
      } else if (path === '/connection/pc/im/promotion/list') {
        const catalog = productRows(payload);
        if (catalog) {
          state.products = catalog.products;
          if (state.context && state.productCatalogContextId && state.productCatalogContextId !== state.context.id) state.productCatalog.clear();
          state.productCatalogContextId = state.context && state.context.id || '';
          for (const product of catalog.products) {
            state.productCatalog.delete(product.id);
            state.productCatalog.set(product.id, product);
          }
          while (state.productCatalog.size > 500) state.productCatalog.delete(state.productCatalog.keys().next().value);
          state.productHasMore = catalog.hasMore;
          state.productPageCount += 1;
          state.productCursor = catalog.hasMore ? `page:${state.productPageCount + 1}` : '';
          state.promotionSequence += 1;
        }
      } else if (path === '/connection/pc/im/card/sender/msg') {
        state.cardInfo = cardMode(payload);
      }
    }

    function contactFromNativeBody(body) {
      const message = body && body.message_content;
      const info = message && message.contact_info;
      return isRecord(info) ? info : null;
    }

    function inviteCardFromNativeBody(body) {
      const message = body && body.message_content;
      const card = message && message.invite_card;
      return isRecord(card) ? card : null;
    }

    function listIds(value) {
      return Array.isArray(value) ? value.map(safeId).filter(Boolean) : [];
    }

    function sameIdList(actual, expected) {
      return Array.isArray(actual) && Array.isArray(expected) && actual.length === expected.length
        && actual.every((value, index) => safeId(value) === expected[index]);
    }

    function sameNativeRights(actual, ids, rightMap) {
      if (!Array.isArray(actual) || !Array.isArray(ids) || actual.length !== ids.length) return false;
      const expected = ids.map((id) => rightMap.get(id));
      if (expected.some((item) => !item || !item.nativeId)) return false;
      const remaining = actual.slice();
      for (const item of expected) {
        const index = remaining.findIndex((raw) => {
          const right = isRecord(raw) ? raw.right : raw;
          return safeText(right, 180) === item.label || safeId(right) === item.nativeId;
        });
        if (index < 0) return false;
        const raw = remaining[index];
        remaining.splice(index, 1);
        if (!isRecord(raw)) continue;
        const explicit = raw.right_id ?? raw.rightId ?? raw.id;
        if (explicit != null && safeId(explicit) !== item.nativeId) return false;
      }
      return remaining.length === 0;
    }

    function guardSendBody(body) {
      const armed = state.armed;
      if (!armed || !isRecord(body)) return { ok: false, reason: '没有有效的开始邀约许可。' };
      const current = readShopContext();
      if (!current || current.id !== armed.contextId || state.configuration !== armed.configRef
        || currentRouteKey() !== armed.routeKey || state.routeKey !== armed.routeKey) {
        return { ok: false, reason: '店铺或页面已变化，已停止提交。' };
      }
      const allowedKeys = ['account_id', 'account_type', 'contact_info', 'entry_point', 'invite_card', 'event_param'];
      if (Object.keys(body).length !== allowedKeys.length || Object.keys(body).some((key) => !allowedKeys.includes(key))) {
        return { ok: false, reason: '平台准备发送的内容与设置不一致，已停止。' };
      }
      if (safeId(body.account_id) !== armed.recipient.accountId || body.account_type !== 1 || body.entry_point !== 1) {
        return { ok: false, reason: '平台准备发送的内容与设置不一致，已停止。' };
      }
      const contact = isRecord(body.contact_info) ? body.contact_info : null;
      const card = isRecord(body.invite_card) ? body.invite_card : null;
      if (!contact || !card) return { ok: false, reason: '平台准备发送的内容与设置不一致，已停止。' };
      if (contact.phone !== armed.configuration.phone || contact.wechat !== armed.configuration.wechat) return { ok: false, reason: '平台准备发送的内容与设置不一致，已停止。' };
      const productIds = Array.isArray(card.product_ids) ? card.product_ids.map(safeId) : [];
      if (productIds.some((id) => !id) || !sameIdList(productIds, armed.configuration.productIds)) return { ok: false, reason: '平台准备发送的内容与设置不一致，已停止。' };
      if (!Array.isArray(card.product_setting)) return { ok: false, reason: '平台准备发送的内容与设置不一致，已停止。' };
      const settings = card.product_setting.map((item) => isRecord(item) ? safeId(item.product_id) : '');
      if (settings.some((id) => !id) || !sameIdList(settings, armed.configuration.productIds)) return { ok: false, reason: '平台准备发送的内容与设置不一致，已停止。' };
      if (!isRecord(body.event_param)) return { ok: false, reason: '平台准备发送的内容与设置不一致，已停止。' };
      if (armed.options.mode === 'words') {
        if (![undefined, 0, '0'].includes(card.card_version) || card.content !== armed.configuration.message) {
          return { ok: false, reason: '平台准备发送的内容与设置不一致，已停止。' };
        }
        if (Array.isArray(card.categories) && card.categories.length > 0) return { ok: false, reason: '平台准备发送的内容与设置不一致，已停止。' };
        if (!sameNativeRights(card.rights, armed.configuration.rightIds, armed.options.rightMap)) {
          return { ok: false, reason: '平台准备发送的内容与设置不一致，已停止。' };
        }
      } else {
        if (Number(card.card_version) !== 1 || card.content !== 'from buyin') {
          return { ok: false, reason: '平台邀约模板已变化，请重新设置。' };
        }
        const expectedCategories = armed.configuration.categoryIds.map((id) => armed.options.categoryMap.get(id)?.nativeId || '');
        const actualCategories = Array.isArray(card.categories) ? card.categories.map((item) => safeId(isRecord(item) ? item.id : item)) : [];
        if (expectedCategories.some((id) => !id) || actualCategories.some((id) => !id)
          || !sameIdList(actualCategories, expectedCategories)) {
          return { ok: false, reason: '平台准备发送的内容与设置不一致，已停止。' };
        }
        if (!sameNativeRights(card.rights, armed.configuration.rightIds, armed.options.rightMap)) {
          return { ok: false, reason: '平台准备发送的内容与设置不一致，已停止。' };
        }
      }
      return { ok: true };
    }

    function blockedResponse(reason) {
      const body = JSON.stringify({ code: 403, message: safeText(reason, 120) });
      try { if (typeof NativeResponse === 'function') return new NativeResponse(body, { status: 403, headers: { 'Content-Type': 'application/json' } }); } catch (_) {}
      return { ok: false, status: 403, clone: () => ({ body: { getReader: () => ({ read: async () => ({ done: true }) }) } }), json: async () => ({ code: 403 }) };
    }

    function resolveGuard(result) {
      const armed = state.armed;
      if (!armed || armed.finished) return;
      armed.finished = true;
      armed.outcome = result;
      state.lastGuardResult = result;
      if (typeof armed.complete === 'function') armed.complete(result);
    }

    function interceptSend(path, method, bodyText, originalCall) {
      const mode = state.guardMode;
      if (mode === 'idle') return { passthrough: true };
      if (mode === 'readonly') {
        const reason = '只读设置期间已拦截原生邀约发送。';
        state.readonlySendAttempt = true;
        if (state.armed && !state.armed.used) resolveGuard({ status: 'failed', notSubmitted: true, message: reason });
        return { blocked: true, reason };
      }
      if (path !== '/connection/pc/im/invite/card/send') {
        const reason = '开始邀约期间只允许已配置的原生邀约请求。';
        if (state.armed && !state.armed.used) resolveGuard({ status: 'failed', notSubmitted: true, message: reason });
        state.guardMode = 'readonly';
        state.quarantine = true;
        state.readonlySendAttempt = true;
        return { blocked: true, reason };
      }
      if (method !== 'POST') {
        const reason = '原生邀约只允许平台表单的 POST 请求。';
        if (state.armed && !state.armed.used) resolveGuard({ status: 'failed', notSubmitted: true, message: reason });
        state.guardMode = 'readonly';
        state.quarantine = true;
        state.readonlySendAttempt = true;
        return { blocked: true, reason };
      }
      const body = parseJsonBody(bodyText);
      const validated = guardSendBody(body);
      if (mode !== 'authorized' || !state.armed || state.armed.used || !validated.ok) {
        const reason = validated.reason || '原生邀约许可已使用。';
        if (state.armed && !state.armed.used) resolveGuard({ status: 'failed', notSubmitted: true, message: reason });
        state.guardMode = 'readonly';
        state.quarantine = true;
        state.readonlySendAttempt = true;
        return { blocked: true, reason };
      }
      state.armed.used = true;
      state.guardMode = 'consumed';
      return { allowed: true, call: originalCall };
    }

    function observeResponse(path, requestId, response, requestContext = null) {
      if (!response || typeof response.clone !== 'function') return;
      readResponse(response).then((payload) => {
        captureReadResponse(path, requestId, payload, requestContext);
      }).catch(() => {});
    }

    function installFetchObserver() {
      if (typeof originalFetch !== 'function') return false;
      const wrapper = function daboDouyinObservedFetch(input, init) {
        const url = requestUrl(input);
        const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
        if (!url || url.protocol !== 'https:' || url.hostname !== 'buyin.jinritemai.com') return originalFetch.apply(this, arguments);
        const path = url.pathname;
        if (allowedReadPath(url)) captureVerificationParams(url);
        const body = getRequestBody(init, null);
        if (SEND_ENDPOINTS.has(path)) {
          const guard = interceptSend(path, method, body, () => originalFetch.apply(this, arguments));
          if (guard.blocked) return Promise.resolve(blockedResponse(guard.reason));
          let result;
          try { result = guard.passthrough ? originalFetch.apply(this, arguments) : guard.call(); }
          catch (error) {
            if (guard.allowed) {
              state.guardMode = 'readonly';
              state.quarantine = true;
              resolveGuard({ status: 'unknown', message: '原生请求未返回明确结果；请核对官方状态，不能自动重试。' });
            }
            throw error;
          }
          if (guard.allowed) {
            Promise.resolve(result).then((response) => {
              if (!state.armed || !state.armed.used) return;
              readResponse(response).then((payload) => {
                const outcome = responseOutcome(payload, response && response.ok !== false);
                resolveGuard(outcome.kind === 'succeeded'
                  ? { status: 'succeeded', code: 0, message: '官方页面确认邀请成功。' }
                  : outcome.kind === 'failed'
                    ? { status: 'failed', code: outcome.code, platformRejected: true, message: '平台明确拒绝了本次邀约。' }
                    : { status: 'unknown', message: '没有收到明确结果；请核对官方状态，不能自动重试。' });
              }).catch(() => resolveGuard({ status: 'unknown', message: '没有收到明确结果；请核对官方状态，不能自动重试。' }));
            }).catch(() => resolveGuard({ status: 'unknown', message: '没有收到明确结果；请核对官方状态，不能自动重试。' }));
          }
          return result;
        }
        if (!READ_ENDPOINTS.has(path) || !['GET', 'POST'].includes(method)) return originalFetch.apply(this, arguments);
        const requestId = shallowRequestIdentity(path, body, url);
        const requestContext = path === '/connection/pc/im/account_check' && state.activeAccountCheck
          ? { token: state.activeAccountCheck.token, recipient: { ...state.activeRecipient } }
          : null;
        const result = originalFetch.apply(this, arguments);
        Promise.resolve(result).then((response) => observeResponse(path, requestId, response, requestContext)).catch(() => {});
        return result;
      };
      try { globalThis.fetch = wrapper; state.fetchObserver = wrapper; return globalThis.fetch === wrapper; } catch (_) { return false; }
    }

    function installXhrObserver() {
      const XHR = globalThis.XMLHttpRequest;
      if (!XHR || !XHR.prototype || typeof XHR.prototype.open !== 'function' || typeof XHR.prototype.send !== 'function') return false;
      const proto = XHR.prototype;
      const originalOpen = proto.open;
      const originalSend = proto.send;
      const originalSetHeader = proto.setRequestHeader;
      proto.open = function daboDouyinObservedOpen(method, url) {
        let parsed = null;
        try { parsed = new URL(String(url), globalThis.location.href); } catch (_) {}
        const upper = String(method || '').toUpperCase();
        if (parsed && parsed.protocol === 'https:' && parsed.hostname === 'buyin.jinritemai.com'
          && (READ_ENDPOINTS.has(parsed.pathname) || SEND_ENDPOINTS.has(parsed.pathname))) {
          if (allowedReadPath(parsed)) captureVerificationParams(parsed);
          xhrState.set(this, { url: parsed.href, path: parsed.pathname, method: upper, body: '', requestId: '', requestContext: null });
          if (!watchedXhrs.has(this) && typeof this.addEventListener === 'function') {
            watchedXhrs.add(this);
            this.addEventListener('load', function daboDouyinObservedLoad() {
              const request = xhrState.get(this);
              if (!request) return;
              try {
                let payload = null;
                if (this.responseType === 'json' && isRecord(this.response)) payload = this.response;
                else if ((!this.responseType || this.responseType === 'text') && typeof this.responseText === 'string' && this.responseText.length <= MAX_RESPONSE_BYTES) payload = JSON.parse(this.responseText);
                if (!payload) return;
                if (SEND_ENDPOINTS.has(request.path) && request.mode === 'authorized') {
                  const outcome = responseOutcome(payload, this.status >= 200 && this.status < 300);
                  resolveGuard(outcome.kind === 'succeeded'
                    ? { status: 'succeeded', code: 0, message: '官方页面确认邀请成功。' }
                    : outcome.kind === 'failed'
                      ? { status: 'failed', code: outcome.code, platformRejected: true, message: '平台明确拒绝了本次邀约。' }
                      : { status: 'unknown', message: '没有收到明确结果；请核对官方状态，不能自动重试。' });
                } else if (READ_ENDPOINTS.has(request.path)) {
                  captureReadResponse(request.path, request.requestId, payload, request.requestContext);
                }
              } catch (_) {
                if (request.mode === 'authorized') resolveGuard({ status: 'unknown', message: '没有收到明确结果；请核对官方状态，不能自动重试。' });
              } finally {
                request.body = '';
                xhrState.delete(this);
              }
            });
          }
        } else xhrState.delete(this);
        return originalOpen.apply(this, arguments);
      };
      if (typeof originalSetHeader === 'function') proto.setRequestHeader = function daboDouyinObservedHeader(name, value) {
        return originalSetHeader.apply(this, arguments);
      };
      const observedSend = function daboDouyinObservedSend(body) {
        const request = xhrState.get(this);
        if (!request) return originalSend.apply(this, arguments);
        request.body = typeof body === 'string' && body.length <= MAX_BODY_BYTES ? body : '';
        if (SEND_ENDPOINTS.has(request.path)) {
          const guard = interceptSend(request.path, request.method, request.body, () => originalSend.apply(this, arguments));
          if (guard.passthrough) return originalSend.apply(this, arguments);
          if (guard.blocked) {
            request.mode = 'blocked';
            try { this.abort(); } catch (_) {}
            return undefined;
          }
          if (guard.allowed) {
            request.mode = 'authorized';
            try { return guard.call(); }
            catch (error) {
              state.guardMode = 'readonly';
              state.quarantine = true;
              resolveGuard({ status: 'unknown', message: '原生请求未返回明确结果；请核对官方状态，不能自动重试。' });
              throw error;
            }
          }
          return undefined;
        }
        request.requestId = shallowRequestIdentity(request.path, request.body, new URL(request.url));
        if (request.path === '/connection/pc/im/account_check' && state.activeAccountCheck) {
          request.requestContext = { token: state.activeAccountCheck.token, recipient: state.activeRecipient && { ...state.activeRecipient } };
        }
        return originalSend.apply(this, arguments);
      };
      proto.send = observedSend;
      state.xhrSendObserver = observedSend;
      return true;
    }

    function installNavigationGuard() {
      const onNavigate = () => {
        state.routeKey = currentRouteKey();
        clearSessionFlow();
        state.guardMode = 'readonly';
        state.quarantine = true;
      };
      if (typeof globalThis.addEventListener === 'function') {
        for (const name of ['popstate', 'hashchange']) try { globalThis.addEventListener(name, onNavigate); } catch (_) {}
        try { globalThis.addEventListener('pagehide', () => { clearSessionFlow(); state.guardMode = 'readonly'; state.quarantine = true; }); } catch (_) {}
      }
      const history = globalThis.history;
      if (history) for (const key of ['pushState', 'replaceState']) {
        const original = history[key];
        if (typeof original !== 'function') continue;
        try {
          history[key] = function daboDouyinHistory() {
            const result = original.apply(this, arguments);
            onNavigate();
            return result;
          };
        } catch (_) {}
      }
    }

    function clearSessionFlow() {
      state.products = [];
      state.productCatalog.clear();
      state.productCatalogContextId = '';
      state.productHasMore = false;
      state.productCursor = '';
      state.productPageCount = 0;
      state.officialCategories.clear();
      state.officialCategoriesContextId = '';
      state.verificationParams = Object.create(null);
      state.cardInfo = null;
      state.searchRows.clear();
      state.accountChecks.clear();
      state.activeAccountCheck = null;
      state.activeRecipient = null;
      state.optionsSnapshot = null;
      state.configuration = null;
      state.approved = null;
      state.armed = null;
      state.lastGuardResult = null;
    }

    function inspect(given, payload = {}) {
      if (given !== capability) return { ready: false, platform: 'douyin', contextId: '', accountLabel: '', reason: '页面权限无效。' };
      const checked = currentContextResult(payload && payload.contextId || '');
      if (!checked.ok) return { ready: false, platform: 'douyin', contextId: '', accountLabel: '', reason: checked.reason };
      const cfg = state.configuration;
      if (payload && payload.templateId) {
        if (!cfg || payload.templateId !== cfg.templateId || Date.now() >= cfg.expiresAtMs) {
          state.configuration = null;
          state.approved = null;
          return { ready: false, platform: 'douyin', contextId: checked.context.id, accountLabel: checked.context.accountLabel, reason: '邀约设置已过期，请重新设置。' };
        }
        return {
          ready: true,
          platform: 'douyin',
          templateId: cfg.templateId,
          contextId: cfg.contextId,
          expiresAt: new Date(cfg.expiresAtMs).toISOString(),
          referenceRecipientId: '',
          summary: { ...cfg.summary, productIds: cfg.summary.productIds.slice(), productNames: cfg.summary.productNames.slice() },
          accountLabel: checked.context.accountLabel,
          reason: '',
        };
      }
      return { ready: true, platform: 'douyin', contextId: checked.context.id, accountLabel: checked.context.accountLabel, reason: '' };
    }

    function visible(node) {
      if (!node || node.hidden || node.getAttribute && node.getAttribute('aria-hidden') === 'true') return false;
      try {
        const style = globalThis.getComputedStyle && globalThis.getComputedStyle(node);
        if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return false;
        return typeof node.getClientRects !== 'function' || node.getClientRects().length > 0;
      } catch (_) { return true; }
    }

    function all(selector, root = globalThis.document) {
      try { return Array.from(root.querySelectorAll(selector)).filter(visible); } catch (_) { return []; }
    }

    function exactText(node) { return safeText(node && (node.textContent || node.innerText || ''), 180); }

    function click(node) {
      if (!node || !visible(node) || typeof node.click !== 'function') return false;
      try { node.click(); return true; } catch (_) { return false; }
    }

    function nativeSetValue(node, value) {
      if (!node || !visible(node) || typeof value !== 'string') return false;
      try {
        const prototype = Object.getPrototypeOf(node);
        const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
        if (descriptor && typeof descriptor.set === 'function') descriptor.set.call(node, value);
        else node.value = value;
        node.dispatchEvent(new Event('input', { bubbles: true }));
        node.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      } catch (_) { return false; }
    }

    function sleep(ms) { return new Promise((resolve) => globalThis.setTimeout(resolve, ms)); }

    async function waitFor(check, timeout = 8000, interval = 100) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        try {
          const value = check();
          if (value) return value;
        } catch (_) {}
        await sleep(interval);
      }
      return null;
    }

    function safeOptionsFailure(context, reason) {
      return emptyOptions(context, reason);
    }

    function findNativeRow(recipient) {
      const rows = all('.virtual-list .auxo-table-tbody tr[data-row-key]');
      const matches = rows.filter((row) => {
        const key = safeId(row.getAttribute && row.getAttribute('data-row-key'));
        return key && [recipient.externalId, recipient.accountId].includes(key);
      });
      return matches.length === 1 ? matches[0] : null;
    }

    async function searchNativeRow(recipient, keyword) {
      let row = findNativeRow(recipient);
      if (row) return row;
      const searchText = safeText(keyword || recipient.searchAccount || '', 120);
      if (!searchText) return null;
      const inputs = all('.auxo-select-selector input');
      const buttons = all('.auxo-select-selector .auxo-input-group-addon .auxo-btn');
      if (inputs.length !== 1 || buttons.length !== 1) return null;
      if (!nativeSetValue(inputs[0], searchText) || !click(buttons[0])) return null;
      return waitFor(() => findNativeRow(recipient), 8000, 120);
    }

    function onlineButton(row) {
      if (!row) return null;
      const matches = [];
      for (const span of all('.auxo-btn span', row)) if (exactText(span) === '在线沟通') {
        const button = span.closest && span.closest('.auxo-btn');
        if (button && visible(button)) matches.push(button);
      }
      return matches.length === 1 ? matches[0] : null;
    }

    async function openRecipientForm(recipient, forceRefresh = false) {
      if (forceRefresh && all('.auxo-drawer-body').length) {
        if (!closeNativeDrawer() || !await waitFor(() => all('.auxo-drawer-body').length === 0, 3000, 100)) {
          return { ok: false, reason: '无法关闭旧的官方邀约表单以刷新准入检查。' };
        }
      }
      const row = await searchNativeRow(recipient);
      if (!row) return { ok: false, reason: recipient.searchAccount ? '未在官方达人列表找到该搜索身份。' : '当前页面没有该达人可见行，且该资料缺少抖音搜索身份。' };
      const rowKey = safeId(row.getAttribute && row.getAttribute('data-row-key'));
      if (!rowKey || ![recipient.externalId, recipient.accountId].includes(rowKey)) return { ok: false, reason: '官方列表行身份与已选达人不匹配。' };
      state.activeRecipient = { ...recipient, rowKey };
      state.accountChecks.delete(recipient.accountId);
      const button = onlineButton(row);
      if (!button || !click(button)) return { ok: false, reason: '当前达人行没有唯一可用的在线沟通入口。' };
      const drawer = await waitFor(() => all('.auxo-drawer-body')[0], 8000, 100);
      if (!drawer) return { ok: false, reason: '官方邀约表单未打开。' };
      return { ok: true, drawer, rowKey };
    }

    function parsePrice(value) {
      if (typeof value === 'string' && /[￥¥元]/.test(value)) return safeText(value, 80);
      return '';
    }

    function productDto(row) {
      if (!isRecord(row)) return null;
      const productInfo = isRecord(row.productInfo) ? row.productInfo : {};
      const id = safeId(row.id || row.product_id || row.productId || row.spuId || row.spu_id);
      const name = safeText(row.name || row.product_name || row.productName || row.product_title || row.title || productInfo.title, 180);
      if (!id || !name) return null;
      const priceText = parsePrice(row.priceText || row.price_text || row.price || row.product_price || productInfo.price);
      return { id, name, ...(priceText ? { priceText } : {}) };
    }

    function stableOpaqueId(prefix, value) { return `${prefix}:${encodeURIComponent(value).slice(0, 300)}`; }

    function categoryPathKey(path) { return JSON.stringify(path); }

    function parseOfficialCategoryTree(payload) {
      const data = isRecord(payload) && isRecord(payload.data) ? payload.data : null;
      if (!data || !Array.isArray(data.main_cates) || data.main_cates.length > 500) return null;
      const byPath = new Map();
      const idToPath = new Map();
      const add = (rawId, rawName, path) => {
        const nativeId = safeId(rawId);
        const label = safeText(rawName, 120);
        if (!nativeId || !label || path.length < 1 || path.length > 5) return false;
        const key = categoryPathKey(path);
        const prior = byPath.get(key);
        if (prior && prior.nativeId !== nativeId) return false;
        const previousPath = idToPath.get(nativeId);
        if (previousPath && previousPath !== key) return false;
        byPath.set(key, { id: `native:${nativeId}`, nativeId, label, path: path.slice() });
        idToPath.set(nativeId, key);
        return true;
      };
      for (const main of data.main_cates) {
        if (!isRecord(main) || !add(main.id, main.name, [safeText(main.name, 120)])) return null;
        const mainName = safeText(main.name, 120);
        if (Array.isArray(main.sub_cates)) {
          if (main.sub_cates.length > 500) return null;
          for (const sub of main.sub_cates) {
            if (!isRecord(sub) || !add(sub.id, sub.name, [mainName, safeText(sub.name, 120)])) return null;
          }
        }
      }
      return byPath.size ? byPath : null;
    }

    async function readOfficialCategoryTree() {
      if (state.officialCategoriesContextId === state.context?.id && state.officialCategories.size) {
        return { ok: true, categories: state.officialCategories };
      }
      const url = new URL('/square_pc_api/common/square/squareConf', globalThis.location.href);
      url.searchParams.set('type', '2');
      for (const key of ['fp', 'verifyFp']) if (state.verificationParams[key]) url.searchParams.set(key, state.verificationParams[key]);
      let controller = null;
      try { if (typeof globalThis.AbortController === 'function') controller = new globalThis.AbortController(); } catch (_) {}
      let timeoutId = 0;
      const read = (async () => {
        const response = await globalThis.fetch(url.href, {
          method: 'GET',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', applicationId: '2', 'data-view-id': '' },
          ...(controller ? { signal: controller.signal } : {}),
        });
        if (!response || response.ok === false) return { ok: false, reason: '官方类目接口没有返回有效结果。' };
        const payload = await readResponse(response);
        if (responseOutcome(payload, response.ok !== false).kind !== 'succeeded') return { ok: false, reason: '官方类目接口返回错误，暂不能配置类目邀约。' };
        const categories = parseOfficialCategoryTree(payload);
        if (!categories) return { ok: false, reason: '官方类目数据格式无法确认，暂不能配置类目邀约。' };
        return { ok: true, categories };
      })().catch(() => ({ ok: false, reason: '读取官方类目列表失败，请刷新工作台后重试。' }));
      const timeout = new Promise((resolve) => {
        timeoutId = globalThis.setTimeout(() => {
          try { controller?.abort(); } catch (_) {}
          resolve({ ok: false, reason: '读取官方类目列表超时，请稍后重试。' });
        }, OP_TIMEOUT_MS);
      });
      const result = await Promise.race([read, timeout]);
      if (timeoutId) globalThis.clearTimeout(timeoutId);
      if (!result.ok) return result;
      const latestContext = readShopContext();
      if (!latestContext || latestContext.id !== state.context?.id || currentRouteKey() !== state.routeKey) {
        return { ok: false, reason: '店铺或页面已变化，请重新读取官方类目。' };
      }
      const categories = result.categories;
      state.officialCategories = categories;
      state.officialCategoriesContextId = state.context && state.context.id || '';
      return { ok: true, categories };
    }

    function categoryNativeId(item) {
      const input = item.querySelector && item.querySelector('input[type="checkbox"]');
      const inputValue = input && input.value !== 'on' ? input.value : '';
      const value = input && (input.getAttribute('value') || inputValue)
        || item.getAttribute && (item.getAttribute('data-value') || item.getAttribute('data-id') || item.getAttribute('data-key'));
      return safeId(value);
    }

    function categoryMenus() {
      return all('.auxo-cascader-menu').filter((menu) => menu.querySelectorAll && menu.querySelectorAll('li[title]').length > 0);
    }

    function pathId(path) { return stableOpaqueId('path', path.join('/')); }

    async function readCategoryOptions(officialCategories) {
      if (!(officialCategories instanceof Map) || !officialCategories.size) return { categories: [], categoryMap: new Map(), reason: '未读取到可核验的官方类目树。' };
      const wrappers = all('.auxo-cascader-multiple-wrapper');
      if (wrappers.length !== 1) return { categories: [], categoryMap: new Map(), reason: '类目选择控件不存在或不唯一。' };
      const wrapper = wrappers[0];
      if (!click(wrapper)) return { categories: [], categoryMap: new Map(), reason: '无法打开官方类目选择控件。' };
      await sleep(100);
      const results = [];
      const visited = new Set();
      let invalidReason = '';
      const walk = async (depth, path) => {
        if (depth > 5 || results.length >= 200 || invalidReason) return;
        const menus = categoryMenus();
        const menu = menus[depth] || menus[menus.length - 1];
        if (!menu) return;
        const items = all('li[title]', menu);
        for (const item of items) {
          const label = safeText(item.getAttribute('title') || exactText(item), 120);
          if (!label) continue;
          const nextPath = [...path, label];
          const expand = item.querySelector && item.querySelector('.auxo-cascader-menu-item-expand, [aria-haspopup="true"]');
          if (expand && visible(expand)) {
            if (click(expand)) {
              await sleep(50);
              await walk(depth + 1, nextPath);
            }
            continue;
          }
          const official = officialCategories.get(categoryPathKey(nextPath));
          if (!official) continue;
          const observedId = categoryNativeId(item);
          if (observedId && observedId !== official.nativeId) {
            invalidReason = '官方类目树与页面原生编号不一致。';
            return;
          }
          const nativeId = official.nativeId;
          const id = `native:${nativeId}`;
          if (!visited.has(id)) {
            visited.add(id);
            results.push({ id, label: official.label, path: nextPath });
          }
        }
      };
      await walk(0, []);
      try { wrapper.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); } catch (_) {}
      const categoryMap = new Map(results.map((item) => [item.id, { ...item, nativeId: item.id.slice(7) }]));
      return { categories: results, categoryMap, reason: invalidReason || (results.length ? '' : '官方类目列表没有可读取的选项。') };
    }

    const RIGHT_NATIVE_IDS = new Map([
      ['行业知名度高', '1001'], ['其他平台知名度高', '1002'],
      ['源头工厂', '2001'], ['货源充足', '2002'], ['品类丰富', '2003'],
      ['用户口碑高', '3001'], ['参数爆款', '3002'], ['商品高颜值', '3003'], ['多项专利', '3004'],
      ['48h发货', '4001'], ['现场现发', '4002'], ['七天无理由退货', '4003'], ['售后无忧', '4004'],
      ['专属高佣', '5001'], ['免费样品', '5002'], ['佣金可谈', '5003'], ['机制可谈', '5004'],
      ['优质视频投流', '6001'], ['视频素材/脚本支持', '6002'], ['带货指导/陪跑', '6003'],
    ]);

    function readRights(root = globalThis.document) {
      const labels = all('.auxo-checkbox-group label', root);
      const rights = [];
      const rightMap = new Map();
      const seen = new Set();
      let invalid = false;
      for (const labelNode of labels) {
        const label = safeText(labelNode.textContent || labelNode.innerText || '', 180);
        if (!label) continue;
        const input = labelNode.querySelector && labelNode.querySelector('input');
        const groupNode = labelNode.closest && labelNode.closest('.auxo-form-item-row, .auxo-form-item');
        const groupLabel = groupNode && groupNode.querySelector && groupNode.querySelector('.auxo-form-item-label');
        const group = safeText(groupLabel && groupLabel.textContent || '', 100);
        const inputValue = input && input.value !== 'on' ? input.value : '';
        const rawId = input && (input.getAttribute('value') || inputValue)
          || labelNode.getAttribute && (labelNode.getAttribute('data-value') || labelNode.getAttribute('data-id'));
        const explicitId = safeId(rawId);
        const mappedId = RIGHT_NATIVE_IDS.get(label);
        if (!mappedId) continue;
        if (explicitId && explicitId !== mappedId) { invalid = true; continue; }
        const nativeId = explicitId || mappedId;
        const id = `native:${nativeId}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const item = { id, label, ...(group ? { group } : {}) };
        rights.push(item);
        rightMap.set(id, { ...item, nativeId, node: labelNode });
      }
      return { rights, rightMap, invalid };
    }

    function formSummaryRecipient(recipient) {
      return {
        platform: 'douyin',
        externalId: recipient.externalId,
        accountId: recipient.accountId,
        searchAccount: recipient.searchAccount,
        name: recipient.name,
      };
    }

    function currentOptionsDto() {
      const snapshot = state.optionsSnapshot;
      if (!snapshot) return null;
      return {
        ready: true,
        platform: 'douyin',
        contextId: snapshot.contextId,
        accountLabel: snapshot.accountLabel,
        mode: snapshot.mode,
        products: snapshot.products.map((product) => ({ ...product })),
        hasMore: snapshot.hasMore,
        cursor: snapshot.cursor,
        categories: snapshot.categories.map((category) => ({ ...category, path: category.path.slice() })),
        rights: snapshot.rights.map((right) => ({ ...right })),
        reason: '',
      };
    }

    function strictText(value, max) {
      if (typeof value !== 'string') return null;
      const result = value.trim();
      if (Array.from(result).length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(result)) return null;
      return result;
    }

    function safeOptionId(value) {
      if (typeof value !== 'string') return '';
      const id = value.trim();
      return id.length > 0 && id.length <= 512 && /^[A-Za-z0-9._:%-]+$/.test(id) ? id : '';
    }

    function normalizeRecipient(value) {
      if (!isRecord(value) || value.platform !== 'douyin') return null;
      const externalId = safeId(value.externalId);
      const accountId = safeId(value.accountId);
      const recipientId = typeof value.id === 'string' ? value.id.trim() : '';
      if (!externalId || !accountId || !recipientId || recipientId.length > 256 || /[\u0000-\u001f\u007f]/.test(recipientId)) return null;
      return {
        id: recipientId,
        platform: 'douyin',
        externalId,
        accountId,
        searchAccount: safeId(value.searchAccount),
        name: safeText(value.name || '', 120),
      };
    }

    function sameRecipient(left, right) {
      return Boolean(left && right && left.platform === 'douyin' && right.platform === 'douyin'
        && left.id === right.id && left.externalId === right.externalId && left.accountId === right.accountId);
    }

    function currentContextResult(expectedContextId = '') {
      const checked = refreshContext();
      if (!checked.ok) {
        if (state.context) clearFlowData();
        state.guardMode = 'readonly';
        state.quarantine = true;
        return { ok: false, reason: '无法确认当前店铺身份，请重新登录抖音官方工作台。' };
      }
      if (expectedContextId && checked.context.id !== expectedContextId) {
        state.guardMode = 'readonly';
        state.quarantine = true;
        return { ok: false, reason: '当前店铺已变化，请重新读取邀约设置。' };
      }
      return { ok: true, context: checked.context };
    }

    function guardAvailable() {
      if (!state.fetchObserver || globalThis.fetch !== state.fetchObserver) return false;
      const XHR = globalThis.XMLHttpRequest;
      if (XHR && XHR.prototype && state.xhrSendObserver && XHR.prototype.send !== state.xhrSendObserver) return false;
      return true;
    }

    function buttonsByText(root, selector, expected) {
      return all(selector, root).filter((node) => exactText(node) === expected);
    }

    async function readProductOptions(drawer, keyword, cursor) {
      const addButtons = buttonsByText(drawer, '.auxo-btn', '添加商品');
      if (addButtons.length !== 1 || !click(addButtons[0])) return { ok: false, reason: '无法打开官方商品选择器。' };
      const modal = await waitFor(() => all('.auxo-modal-content')[0], OP_TIMEOUT_MS, 100);
      if (!modal) return { ok: false, reason: '官方商品选择器未打开。' };
      const inputs = all('.auxo-input-search .auxo-input-wrapper input', modal);
      const searches = all('.auxo-input-search .auxo-input-group-addon .auxo-btn.auxo-btn-icon-only', modal);
      if (inputs.length !== 1 || searches.length !== 1) return { ok: false, reason: '官方商品搜索控件无法唯一确认。' };
      const query = strictText(keyword == null ? '' : keyword, 120);
      if (query === null || !nativeSetValue(inputs[0], query)) return { ok: false, reason: '商品搜索词无效或控件不可用。' };
      const before = state.promotionSequence;
      state.productPageCount = 0;
      if (!click(searches[0])) return { ok: false, reason: '无法提交官方商品搜索。' };
      const firstPage = await waitFor(() => state.promotionSequence > before ? state.promotionSequence : null, OP_TIMEOUT_MS, 100);
      if (!firstPage) return { ok: false, reason: '未收到官方商品列表，请刷新后重试。' };
      if (cursor) {
        if (typeof cursor !== 'string') return { ok: false, reason: '商品列表页码无效，请重新搜索。' };
        let traversedCursor = '';
        let pages = 0;
        while (traversedCursor !== cursor && pages < 50) {
          const nextCursor = state.productCursor;
          if (!nextCursor || !state.productHasMore) return { ok: false, reason: '商品列表已变化，请重新搜索后选择。' };
          const nextButtons = all('.auxo-pagination-next', modal).filter((node) => !node.disabled && node.getAttribute('aria-disabled') !== 'true');
          if (nextButtons.length !== 1) return { ok: false, reason: '官方商品列表不支持当前分页操作。' };
          const nextBefore = state.promotionSequence;
          if (!click(nextButtons[0]) || !await waitFor(() => state.promotionSequence > nextBefore, OP_TIMEOUT_MS, 100)) {
            return { ok: false, reason: '未能读取下一页官方商品。' };
          }
          traversedCursor = nextCursor;
          pages += 1;
        }
        if (traversedCursor !== cursor) return { ok: false, reason: '商品列表页数过多，请使用关键词缩小范围。' };
      }
      const closeButtons = all('.auxo-modal-close', modal);
      if (closeButtons.length !== 1 || !click(closeButtons[0])) return { ok: false, reason: '无法安全关闭官方商品选择器。' };
      await waitFor(() => all('.auxo-modal-content').length === 0, 2000, 100);
      return {
        ok: true,
        products: state.products.map((row) => ({ ...row })),
        hasMore: state.productHasMore,
        cursor: state.productCursor,
      };
    }

    function closeNativeDrawer() {
      const drawers = all('.auxo-drawer-body');
      if (drawers.length === 0) return true;
      const closeButtons = all('.auxo-drawer-close');
      if (closeButtons.length === 1) return click(closeButtons[0]);
      try {
        drawers[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      } catch (_) { return false; }
      return true;
    }

    function normalizeOptionIds(value, max) {
      if (!Array.isArray(value) || value.length > max) return null;
      const result = [];
      const seen = new Set();
      for (const raw of value) {
        const id = safeOptionId(raw);
        if (!id || seen.has(id)) return null;
        seen.add(id);
        result.push(id);
      }
      return result;
    }

    function maskedPhone(value) { return value ? `***${value.slice(-4)}` : ''; }
    function maskedWechat(value) { return value ? `${value.slice(0, 1)}***${value.slice(-1)}` : ''; }

    function validateConfiguration(input, snapshot) {
      if (!isRecord(input)) return { ok: false, reason: '邀约设置格式无效，请重新填写。' };
      const allowed = ['message', 'contactName', 'phone', 'wechat', 'productIds', 'categoryIds', 'rightIds'];
      if (Object.keys(input).some((key) => !allowed.includes(key))) return { ok: false, reason: '邀约设置包含未确认字段。' };
      const message = strictText(input.message == null ? '' : input.message, 500);
      const contactName = strictText(input.contactName == null ? '' : input.contactName, 120);
      const phone = strictText(input.phone == null ? '' : input.phone, 40);
      const wechat = strictText(input.wechat == null ? '' : input.wechat, 80);
      if (message === null || contactName === null || phone === null || wechat === null) return { ok: false, reason: '话术或联系人信息格式无效。' };
      if (phone && !/^1[3-9]\d{9}$/.test(phone)) return { ok: false, reason: '手机号需为 11 位中国大陆手机号。' };
      if (wechat && !/^[A-Za-z0-9_-]{6,20}$/.test(wechat)) return { ok: false, reason: '微信号需为 6–20 位字母、数字、下划线或连字符。' };
      if (!phone && !wechat) return { ok: false, reason: '请至少填写手机号或微信号。' };
      const productIds = normalizeOptionIds(input.productIds, 5);
      const categoryIds = normalizeOptionIds(input.categoryIds, 50);
      const rightIds = normalizeOptionIds(input.rightIds, 50);
      if (!productIds || productIds.length < 1 || productIds.some((id) => !snapshot.productMap.has(id))) return { ok: false, reason: '请选择商品列表中有效的 1–5 个商品。' };
      if (!categoryIds || !rightIds) return { ok: false, reason: '品类或合作权限选择格式无效。' };
      if (snapshot.mode === 'words') {
        if (!message) return { ok: false, reason: '请输入邀约话术。' };
        if (categoryIds.length || rightIds.length) return { ok: false, reason: '话术模式不能同时选择品类或合作权限。' };
      } else {
        if (message) return { ok: false, reason: '品类邀约将使用平台模板，请清空自定义话术。' };
        if (!categoryIds.length || !rightIds.length) return { ok: false, reason: '请选择至少 1 个品类和 1 项合作权限。' };
        if (categoryIds.some((id) => !snapshot.categoryMap.has(id) || !snapshot.categoryMap.get(id).nativeId)) {
          return { ok: false, reason: '官方类目没有可核验的原生编号，暂不能安全提交。' };
        }
      }
      if (categoryIds.some((id) => !snapshot.categoryMap.has(id))
        || rightIds.some((id) => !snapshot.rightMap.has(id) || !snapshot.rightMap.get(id)?.nativeId)) {
        return { ok: false, reason: '所选品类或合作权限已变化，请重新读取设置。' };
      }
      return { ok: true, value: Object.freeze({
        message, contactName, phone, wechat,
        productIds: Object.freeze(productIds.slice()),
        categoryIds: Object.freeze(categoryIds.slice()),
        rightIds: Object.freeze(rightIds.slice()),
      }) };
    }

    async function executeOptions(given, payload) {
      if (given !== capability) return emptyOptions(null, '页面权限无效。');
      if (!guardAvailable()) return emptyOptions(null, '邀约防护未能安装，请刷新官方工作台。');
      const current = currentContextResult();
      if (!current.ok) return emptyOptions(null, current.reason);
      if (state.armed && !state.armed.finished) return emptyOptions(current.context, '当前邀约结果尚未确认，请先核对官方状态。');
      state.guardMode = 'readonly';
      state.quarantine = true;
      state.optionsSnapshot = null;
      state.configuration = null;
      state.approved = null;
      state.products = [];
      state.productHasMore = false;
      state.productCursor = '';
      state.productPageCount = 0;
      state.accountChecks.clear();
      const recipient = normalizeRecipient(payload && payload.recipient);
      if (!recipient) return safeOptionsFailure(current.context, '请先选择一位身份信息完整的抖音达人。');
      const existingDrawer = all('.auxo-drawer-body');
      const reuseDrawer = existingDrawer.length === 1 && sameRecipient(state.activeRecipient, recipient);
      let opened;
      if (reuseDrawer) opened = { ok: true, drawer: existingDrawer[0], rowKey: state.activeRecipient.rowKey };
      else {
        state.cardInfo = null;
        const nextForm = await openRecipientForm(recipient, existingDrawer.length > 0);
        if (!nextForm.ok) return safeOptionsFailure(current.context, nextForm.reason);
        opened = nextForm;
      }
      const mode = await waitFor(() => state.cardInfo, OP_TIMEOUT_MS, 100);
      if (!mode) return safeOptionsFailure(current.context, '未读取到官方邀约模板，请刷新页面后重试。');
      const catalog = await readProductOptions(opened.drawer, payload && payload.keyword, payload && payload.cursor || '');
      if (!catalog.ok) return safeOptionsFailure(current.context, catalog.reason);
      const products = catalog.products.map(productDto);
      if (products.some((product) => !product)) return safeOptionsFailure(current.context, '官方商品列表字段无法确认，请刷新后重试。');
      let categories = [];
      let categoryMap = new Map();
      if (mode.mode === 'category') {
        const official = await readOfficialCategoryTree();
        if (!official.ok) return safeOptionsFailure(current.context, official.reason);
        const result = await readCategoryOptions(official.categories);
        if (!result.categories.length) return safeOptionsFailure(current.context, result.reason || '未读取到官方类目。');
        if (result.reason) return safeOptionsFailure(current.context, result.reason);
        if (result.categories.some((category) => !result.categoryMap.get(category.id)?.nativeId)) {
          return safeOptionsFailure(current.context, '官方类目没有可核验的原生编号，当前不能安全配置类目邀约。');
        }
        categories = result.categories;
        categoryMap = result.categoryMap;
      }
      const rights = readRights(opened.drawer);
      if (rights.invalid) return safeOptionsFailure(current.context, '页面合作权益编号与已核验映射不一致，请刷新后重试。');
      const snapshot = {
        contextId: current.context.id,
        accountLabel: current.context.accountLabel,
        mode: mode.mode,
        cardVersion: mode.cardVersion,
        recipient,
        products,
        productMap: new Map(state.productCatalogContextId === current.context.id
          ? state.productCatalog
          : products.map((product) => [product.id, product])),
        hasMore: catalog.hasMore,
        cursor: catalog.cursor,
        categories,
        categoryMap,
        rights: rights.rights,
        rightMap: rights.rightMap,
      };
      state.optionsSnapshot = snapshot;
      return currentOptionsDto();
    }

    async function executeConfigure(given, payload) {
      if (given !== capability) return fail('页面权限无效。');
      const snapshot = state.optionsSnapshot;
      const current = currentContextResult(payload && payload.contextId || '');
      if (!current.ok) return fail(current.reason);
      if (!snapshot || snapshot.contextId !== current.context.id) return fail('请先读取当前抖音店铺的官方邀约设置。');
      const validated = validateConfiguration(payload && payload.configuration, snapshot);
      if (!validated.ok) return fail(validated.reason);
      const config = validated.value;
      state.operationSequence += 1;
      const templateId = `dycfg-${Date.now().toString(36)}-${state.operationSequence.toString(36)}`;
      const expiresAtMs = Date.now() + CONFIG_TTL_MS;
      const productNames = config.productIds.map((id) => snapshot.productMap.get(id).name);
      const summary = Object.freeze({
        message: snapshot.mode === 'category' ? '使用平台品类模板（无自定义话术）' : config.message,
        productIds: config.productIds.slice(),
        productNames,
        accountLabel: snapshot.accountLabel,
        contactName: config.contactName,
        phoneMasked: maskedPhone(config.phone),
        wechatMasked: maskedWechat(config.wechat),
        cardVersion: snapshot.mode,
      });
      state.configuration = { templateId, contextId: snapshot.contextId, expiresAtMs, configuration: config, options: snapshot, summary };
      state.approved = null;
      return {
        ready: true,
        platform: 'douyin',
        templateId,
        contextId: snapshot.contextId,
        expiresAt: new Date(expiresAtMs).toISOString(),
        referenceRecipientId: '',
        summary: { ...summary, productIds: summary.productIds.slice(), productNames: productNames.slice() },
      };
    }

    function sameStoredRecipient(left, right) {
      return left && right && left.id === right.id && left.externalId === right.externalId && left.accountId === right.accountId;
    }

    async function executePreflight(given, payload) {
      if (given !== capability) return { ok: false, platformRejected: false, reason: '页面权限无效。' };
      if (!guardAvailable()) return { ok: false, platformRejected: false, reason: '邀约防护未能安装，请刷新官方工作台。' };
      const cfg = state.configuration;
      const current = currentContextResult(cfg && cfg.contextId || '');
      if (!current.ok) return { ok: false, platformRejected: false, reason: current.reason };
      if (!cfg || payload?.templateId !== cfg.templateId || Date.now() >= cfg.expiresAtMs) {
        state.configuration = null;
        state.approved = null;
        return { ok: false, platformRejected: false, reason: '邀约设置已过期，请重新设置。' };
      }
      const recipient = normalizeRecipient(payload && payload.recipient);
      if (!recipient) return { ok: false, platformRejected: false, reason: '达人身份信息无效。' };
      state.guardMode = 'readonly';
      state.quarantine = true;
      state.approved = null;
      state.accountChecks.delete(recipient.accountId);
      const checkToken = ++state.operationSequence;
      state.activeAccountCheck = { token: checkToken, recipient: { ...recipient } };
      const opened = await openRecipientForm(recipient, true);
      if (!opened.ok) {
        state.activeAccountCheck = null;
        return { ok: false, platformRejected: false, reason: opened.reason };
      }
      const check = await waitFor(() => state.accountChecks.get(recipient.accountId), OP_TIMEOUT_MS, 100);
      state.activeAccountCheck = null;
      if (!check || typeof check.isPassed !== 'boolean') return { ok: false, platformRejected: false, reason: check?.reason || '未收到该达人的有效官方准入检查结果，请稍后重试。' };
      if (!check.isPassed) return { ok: false, platformRejected: true, ...(check.code !== undefined ? { code: check.code } : {}), reason: check.reason || '平台暂不允许向该达人发送邀约。' };
      if (check.code !== undefined && check.code !== 0) return { ok: false, platformRejected: false, code: check.code, reason: '官方准入检查返回错误，未能确认该达人可邀约。' };
      state.approved = {
        templateId: cfg.templateId,
        recipient,
        expiresAtMs: Date.now() + 60 * 1000,
      };
      return { ok: true };
    }

    function inputChecked(input, labelNode) {
      if (input && typeof input.checked === 'boolean') return input.checked;
      return Boolean(labelNode && /checked/.test(String(labelNode.className || '')));
    }

    function findOptionControl(labelNode) {
      return labelNode && labelNode.querySelector && (labelNode.querySelector('input[type="checkbox"]') || labelNode.querySelector('.auxo-checkbox-input') || labelNode);
    }

    function setRights(drawer, config, snapshot) {
      const native = readRights(drawer);
      if (native.invalid) return { ok: false, reason: '页面合作权益编号与已核验映射不一致，请重新读取设置。' };
      const chosen = new Set(config.rightIds);
      for (const [id, previous] of snapshot.rightMap.entries()) {
        const current = native.rightMap.get(id);
        if (!current) return { ok: false, reason: '官方合作权限列表已变化，请重新读取设置。' };
        const input = current.node.querySelector && current.node.querySelector('input');
        const selected = chosen.has(id);
        if (inputChecked(input, current.node) !== selected) {
          if (!click(findOptionControl(current.node)) || inputChecked(input, current.node) !== selected) {
            return { ok: false, reason: '无法按配置设置官方合作权限。' };
          }
        }
      }
      for (const id of chosen) if (!snapshot.rightMap.has(id)) return { ok: false, reason: '所选合作权限已失效。' };
      return { ok: true };
    }

    async function selectCategories(config, snapshot) {
      const selection = new Set(config.categoryIds);
      const wrappers = all('.auxo-cascader-multiple-wrapper');
      if (wrappers.length !== 1) return { ok: false, reason: '官方类目控件不存在或不唯一。' };
      const wrapper = wrappers[0];
      const existing = all('.auxo-cascader-selection__choice__close', wrapper);
      for (const close of existing) if (!click(close)) return { ok: false, reason: '无法清除原有类目选择。' };
      const remaining = all('.auxo-cascader-selection__choice', wrapper);
      if (remaining.length) return { ok: false, reason: '官方类目存在未能清除的默认选项。' };
      for (const id of selection) {
        const option = snapshot.categoryMap.get(id);
        if (!option || !option.nativeId || !Array.isArray(option.path) || !option.path.length) return { ok: false, reason: '所选品类缺少可核验的官方路径。' };
        if (!categoryMenus().length && !click(wrapper)) return { ok: false, reason: '无法打开官方类目控件。' };
        for (let depth = 0; depth < option.path.length; depth += 1) {
          const menu = await waitFor(() => categoryMenus()[depth], 3000, 50);
          if (!menu) return { ok: false, reason: '官方类目路径未完整显示。' };
          const item = all('li[title]', menu).find((node) => safeText(node.getAttribute('title') || exactText(node), 120) === option.path[depth]);
          if (!item) return { ok: false, reason: '所选官方类目路径已变化。' };
          if (depth < option.path.length - 1) {
            const expand = item.querySelector && item.querySelector('.auxo-cascader-menu-item-expand, [aria-haspopup="true"]');
            if (!click(expand || item)) return { ok: false, reason: '无法展开官方类目路径。' };
          } else {
            const input = item.querySelector && item.querySelector('input[type="checkbox"]');
            const control = input || item.querySelector && item.querySelector('.auxo-checkbox-wrapper') || item;
            const observedId = categoryNativeId(item);
            if ((observedId && observedId !== option.nativeId) || !click(control)) return { ok: false, reason: '官方类目编号与设置不一致。' };
          }
        }
      }
      try { wrapper.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); } catch (_) {}
      return { ok: true };
    }

    function exactProductRow(modal, id, name) {
      const rows = all('.auxo-table-tbody tr', modal);
      const exact = rows.filter((row) => [row.getAttribute('data-row-key'), row.getAttribute('data-product-id'), row.getAttribute('data-id')].map(safeId).includes(id));
      if (exact.length === 1) return exact[0];
      if (exact.length > 1) return null;
      const byName = rows.filter((row) => exactText(row).includes(name));
      return byName.length === 1 && rows.length === 1 ? byName[0] : null;
    }

    async function selectProducts(drawer, config, snapshot) {
      for (const id of config.productIds) {
        const addButtons = buttonsByText(drawer, '.auxo-btn', '添加商品');
        if (addButtons.length !== 1 || !click(addButtons[0])) return { ok: false, reason: '无法打开官方商品选择器。' };
        const modal = await waitFor(() => all('.auxo-modal-content')[0], OP_TIMEOUT_MS, 100);
        if (!modal) return { ok: false, reason: '官方商品选择器未打开。' };
        const inputs = all('.auxo-input-search .auxo-input-wrapper input', modal);
        const searches = all('.auxo-input-search .auxo-input-group-addon .auxo-btn.auxo-btn-icon-only', modal);
        if (inputs.length !== 1 || searches.length !== 1) return { ok: false, reason: '官方商品搜索控件无法唯一确认。' };
        const product = snapshot.productMap.get(id);
        if (!product) return { ok: false, reason: '所选商品已不在官方商品列表中。' };
        if (!nativeSetValue(inputs[0], id)) return { ok: false, reason: '无法填写官方商品编号。' };
        const before = state.promotionSequence;
        state.productPageCount = 0;
        if (!click(searches[0]) || !await waitFor(() => state.promotionSequence > before, OP_TIMEOUT_MS, 100)) {
          return { ok: false, reason: '未读取到所选商品的官方记录。' };
        }
        const responseMatches = state.products.filter((item) => item.id === id);
        const row = responseMatches.length === 1 ? exactProductRow(modal, id, product.name) : null;
        if (!row) return { ok: false, reason: '官方商品搜索结果无法唯一匹配所选商品。' };
        const checkboxes = all('.auxo-checkbox-input', row);
        if (checkboxes.length !== 1) return { ok: false, reason: '商品选择框无法唯一确认。' };
        if (!inputChecked(checkboxes[0], row) && !click(checkboxes[0])) return { ok: false, reason: '无法选择官方商品。' };
        if (!inputChecked(checkboxes[0], row)) return { ok: false, reason: '官方商品没有进入选择状态。' };
        const add = all('.auxo-modal-footer .auxo-btn-primary', modal);
        if (add.length !== 1 || !click(add[0])) return { ok: false, reason: '无法确认所选官方商品。' };
        const closes = all('.auxo-modal-close', modal);
        if (all('.auxo-modal-content').length && closes.length === 1) click(closes[0]);
        if (await waitFor(() => all('.auxo-modal-content').length === 0, 2500, 100) === null) {
          return { ok: false, reason: '官方商品选择器未能关闭。' };
        }
      }
      return { ok: true };
    }

    function sendContextStillCurrent(cfg, routeKey) {
      const current = readShopContext();
      return Boolean(state.configuration === cfg && state.routeKey === routeKey
        && currentRouteKey() === routeKey && current && current.id === cfg.contextId);
    }

    async function executeSend(given, payload) {
      if (given !== capability) return { status: 'failed', notSubmitted: true, message: '页面权限无效。' };
      if (!guardAvailable()) return { status: 'failed', notSubmitted: true, message: '邀约防护未能安装，请刷新官方工作台。' };
      const cfg = state.configuration;
      const current = currentContextResult(cfg && cfg.contextId || '');
      if (!current.ok) return { status: 'failed', notSubmitted: true, message: current.reason };
      const sendRouteKey = state.routeKey;
      if (!cfg || payload?.templateId !== cfg.templateId || Date.now() >= cfg.expiresAtMs) {
        state.configuration = null;
        state.approved = null;
        return { status: 'failed', notSubmitted: true, message: '邀约设置已过期，请重新设置。' };
      }
      const recipient = normalizeRecipient(payload && payload.recipient);
      const ticket = state.approved;
      if (!recipient || !ticket || ticket.templateId !== cfg.templateId || Date.now() >= ticket.expiresAtMs || !sameStoredRecipient(ticket.recipient, recipient)) {
        return { status: 'failed', notSubmitted: true, message: '请先完成该达人的官方准入检查。' };
      }
      if (state.armed && (!state.armed.finished || state.armed.outcome?.status === 'unknown' || state.armed.timedOut)) {
        return { status: 'failed', notSubmitted: true, message: '上一条邀约结果仍不确定，请核对官方状态。' };
      }
      state.approved = null;
      state.guardMode = 'readonly';
      state.quarantine = true;
      let drawer = all('.auxo-drawer-body')[0] || null;
      if (!sameRecipient(state.activeRecipient, recipient) || !drawer) {
        const opened = await openRecipientForm(recipient, all('.auxo-drawer-body').length > 0);
        if (!opened.ok) return { status: 'failed', notSubmitted: true, message: opened.reason };
        drawer = opened.drawer;
      }
      if (!sendContextStillCurrent(cfg, sendRouteKey)) return { status: 'failed', notSubmitted: true, message: '店铺或页面已变化，已停止提交。' };
      const phones = all('#phone', drawer);
      const wechats = all('#wechat', drawer);
      if (phones.length !== 1 || wechats.length !== 1 || !nativeSetValue(phones[0], cfg.configuration.phone) || !nativeSetValue(wechats[0], cfg.configuration.wechat)) {
        return { status: 'failed', notSubmitted: true, message: '无法填写官方邀约联系方式。' };
      }
      if (cfg.options.mode === 'words') {
        const textareas = all('.auxo-form-item .auxo-sp-textarea textarea', drawer);
        if (textareas.length !== 1 || !nativeSetValue(textareas[0], cfg.configuration.message)) return { status: 'failed', notSubmitted: true, message: '无法填写官方邀约话术。' };
      } else {
        const categoryResult = await selectCategories(cfg.configuration, cfg.options);
        if (!categoryResult.ok) return { status: 'failed', notSubmitted: true, message: categoryResult.reason };
        if (!sendContextStillCurrent(cfg, sendRouteKey)) return { status: 'failed', notSubmitted: true, message: '店铺或页面已变化，已停止提交。' };
      }
      const rightsResult = setRights(drawer, cfg.configuration, cfg.options);
      if (!rightsResult.ok) return { status: 'failed', notSubmitted: true, message: rightsResult.reason };
      const productsResult = await selectProducts(drawer, cfg.configuration, cfg.options);
      if (!productsResult.ok) return { status: 'failed', notSubmitted: true, message: productsResult.reason };
      if (!sendContextStillCurrent(cfg, sendRouteKey)) return { status: 'failed', notSubmitted: true, message: '店铺或页面已变化，已停止提交。' };
      const drawerContainer = drawer.closest && (drawer.closest('.auxo-drawer') || drawer.closest('.auxo-drawer-content-wrapper'));
      const footerRoot = drawerContainer || globalThis.document;
      const submitButtons = all('.auxo-drawer-footer .auxo-btn-primary', footerRoot);
      if (all('.auxo-drawer-body').length !== 1) return { status: 'failed', notSubmitted: true, message: '官方邀约表单不唯一，已停止提交。' };
      if (submitButtons.length !== 1) return { status: 'failed', notSubmitted: true, message: '官方提交按钮无法唯一确认。' };
      if (!sendContextStillCurrent(cfg, sendRouteKey)) return { status: 'failed', notSubmitted: true, message: '店铺或页面已变化，已停止提交。' };
      let resolve;
      const completion = new Promise((done) => { resolve = done; });
      const armed = {
        templateId: cfg.templateId,
        configRef: cfg,
        contextId: cfg.contextId,
        routeKey: sendRouteKey,
        recipient,
        configuration: cfg.configuration,
        options: cfg.options,
        used: false,
        finished: false,
        complete: (outcome) => resolve(outcome),
      };
      state.armed = armed;
      state.guardMode = 'authorized';
      if (!click(submitButtons[0])) {
        state.guardMode = 'readonly';
        state.quarantine = true;
        if (armed.finished && armed.outcome) return armed.outcome;
        if (armed.used) {
          armed.timedOut = true;
          return { status: 'unknown', message: '原生请求未返回明确结果；请核对官方状态，不能自动重试。' };
        }
        armed.timedOut = true;
        return { status: 'failed', notSubmitted: true, message: '无法提交官方邀约表单。' };
      }
      const outcome = await Promise.race([
        completion,
        sleep(OP_TIMEOUT_MS).then(() => null),
      ]);
      state.guardMode = 'readonly';
      state.quarantine = true;
      if (!outcome) {
        armed.timedOut = true;
        return armed.used
          ? { status: 'unknown', message: '提交后未收到明确结果；请核对官方状态，不能自动重试。' }
          : { status: 'failed', notSubmitted: true, message: '未观察到官方提交请求，已保持只读保护。' };
      }
      return outcome;
    }

    function release(given) {
      if (given !== capability) return fail('页面权限无效。');
      if (state.operationInFlight) return fail('邀约页面仍有操作进行中，暂不能解除只读保护。');
      if (state.readonlySendAttempt) return fail('检测到未授权的原生发送尝试，页面继续保持只读保护。');
      if (state.armed && (!state.armed.finished || state.armed.timedOut || state.armed.outcome?.status === 'unknown'
        || state.armed.outcome?.notSubmitted)) return fail('邀约请求结果仍需核对，页面继续保持只读保护。');
      state.armed = null;
      state.approved = null;
      state.guardMode = 'idle';
      state.quarantine = false;
      return { ok: true };
    }

    function runtimeOperation(method) {
      return async (given, payload) => {
        if (given !== capability) return fail('页面权限无效。');
        if (state.operationInFlight) return fail('抖音页面正在处理上一步，请稍候。');
        state.operationInFlight = true;
        try { return await method(given, payload || {}); }
        finally { state.operationInFlight = false; }
      };
    }

    const runtime = Object.freeze({
      inspect: (given, payload) => inspect(given, payload || {}),
      options: runtimeOperation(executeOptions),
      configure: runtimeOperation(executeConfigure),
      preflight: runtimeOperation(executePreflight),
      send: runtimeOperation(executeSend),
      release: (given) => release(given),
    });
    const fetchInstalled = installFetchObserver();
    const xhrInstalled = installXhrObserver();
    if (!fetchInstalled || !xhrInstalled) return fail('无法完整安装抖音邀约请求防护，请刷新页面后重试。');
    installNavigationGuard();
    try {
      Object.defineProperty(globalThis, sessionKey, {
        value: runtime,
        enumerable: false,
        writable: false,
        configurable: false,
      });
    } catch (_) { return fail('无法创建受保护的页面运行时，请刷新后重试。'); }
    state.context = readShopContext();
    return inspect(capability);
  }

  if (!validSessionKey(args.sessionKey) || !validCapability(args.capability)) return fail('页面连接参数无效。');
  let runtime;
  try { runtime = globalThis[args.sessionKey]; } catch (_) { runtime = null; }
  if (!runtime || typeof runtime[operation] !== 'function') {
    if (operation === 'inspect') return {
      ready: false,
      missing: true,
      platform: 'douyin',
      contextId: '',
      accountLabel: '',
      reason: '页面运行时未连接，请重新读取当前抖音官方工作台。',
    };
    return fail('请先连接当前抖音官方工作台页面。');
  }
  try { return runtime[operation](args.capability, args); }
  catch (_) { return fail('抖音页面操作未完成，请刷新后重试。'); }
}
