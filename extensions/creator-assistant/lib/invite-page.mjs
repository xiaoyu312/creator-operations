export function executeInvitePage(operation, args) {
  'use strict';

  const fail = (reason) => ({ ok: false, reason: String(reason || '操作不可用').slice(0, 160) });
  const isRecord = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    try {
      const prototype = Object.getPrototypeOf(value);
      return prototype === Object.prototype || prototype === null;
    } catch (_) {
      return false;
    }
  };
  const validSessionKey = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(value);
  const validCapability = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{40,128}$/.test(value);

  if (!['install', 'inspect', 'preflight', 'send'].includes(operation)) return fail('不支持的页面操作');
  if (!isRecord(args)) args = {};

  if (operation === 'install') {
    const sessionKey = args.sessionKey;
    const capability = args.capability;
    if (!validSessionKey(sessionKey) || !validCapability(capability)) return fail('页面连接参数无效');

    let currentLocation;
    try {
      currentLocation = new URL(globalThis.location.href);
    } catch (_) {
      return fail('当前页面地址不可用');
    }
    const platform = currentLocation.hostname === 'buyin.jinritemai.com'
      ? 'douyin'
      : ['channels.weixin.qq.com', 'store.weixin.qq.com'].includes(currentLocation.hostname)
        ? 'weixin'
        : '';
    if (!platform || currentLocation.protocol !== 'https:' || currentLocation.username || currentLocation.password) {
      return {
        ready: false,
        platform,
        templateId: '',
        expiresAt: '',
        referenceRecipientId: '',
        summary: { message: '', productIds: [], contactName: '', phoneMasked: '', wechatMasked: '', cardVersion: '' },
        reason: '请在抖音或视频号官方工作台页面读取邀约配置。',
      };
    }

    const existing = globalThis[sessionKey];
    if (existing && typeof existing.inspect === 'function') {
      try {
        const state = existing.inspect(capability);
        if (state && typeof state.ready === 'boolean') return state;
      } catch (_) {}
      return fail('页面运行时冲突，请重新连接当前标签页');
    }
    try {
      if (Object.prototype.hasOwnProperty.call(globalThis, sessionKey)) return fail('页面运行时冲突，请重新连接当前标签页');
    } catch (_) {
      return fail('页面运行时冲突，请重新连接当前标签页');
    }

    const MAX_REQUEST_BYTES = 128 * 1024;
    const MAX_RESPONSE_BYTES = 1024 * 1024;
    const TEMPLATE_TTL_MS = 15 * 60 * 1000;
    const OP_TIMEOUT_MS = 15 * 1000;
    const APPROVAL_TTL_MS = 30 * 1000;
    const INVALID = Symbol('invalid-json-value');
    const allowedHosts = platform === 'douyin'
      ? ['buyin.jinritemai.com']
      : ['channels.weixin.qq.com', 'store.weixin.qq.com'];
    const sendPath = platform === 'douyin'
      ? '/connection/pc/im/invite/card/send'
      : '/shop-faas/mmchannelstradeleague/finderSquare/cgi/createPromotionInvitation';
    let nativeFetch = globalThis.fetch;
    let installed = false;
    let template = null;
    let expiryTimer = 0;
    let approvedRecipient = null;
    let routeKey = currentRouteKey();
    const xhrStates = new WeakMap();
    const watchedXhrs = new WeakSet();

    function currentRouteKey() {
      try {
        return new URL(globalThis.location.href).href;
      } catch (_) {
        return '';
      }
    }

    function platformNow() {
      try {
        const url = new URL(globalThis.location.href);
        if (url.protocol !== 'https:' || !allowedHosts.includes(url.hostname)) return '';
        return platform;
      } catch (_) {
        return '';
      }
    }

    function clearTemplate() {
      template = null;
      approvedRecipient = null;
      if (expiryTimer) {
        try { globalThis.clearTimeout(expiryTimer); } catch (_) {}
      }
      expiryTimer = 0;
    }

    function invalidateIfNavigated() {
      const next = currentRouteKey();
      if (next !== routeKey) {
        clearTemplate();
        routeKey = next;
      }
    }

    function boundedText(value, max = 256) {
      if (typeof value !== 'string') return '';
      return value.slice(0, max * 4).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
    }

    function cleanId(value) {
      if (typeof value === 'number') {
        if (!Number.isSafeInteger(value) || value <= 0) return '';
        value = String(value);
      }
      if (typeof value !== 'string') return '';
      const result = value.trim();
      return result.length > 0 && result.length <= 256 && /^[A-Za-z0-9._-]+$/.test(result) ? result : '';
    }

    function cloneJson(value, state, depth = 0) {
      if (depth > 8) return INVALID;
      state.nodes += 1;
      if (state.nodes > 600) return INVALID;
      if (value === null || typeof value === 'boolean') return value;
      if (typeof value === 'number') return Number.isFinite(value) ? value : INVALID;
      if (typeof value === 'string') {
        if (value.length > 6000) return INVALID;
        state.chars += value.length;
        return state.chars > 128 * 1024 ? INVALID : value;
      }
      if (Array.isArray(value)) {
        if (value.length > 100) return INVALID;
        const result = [];
        for (const item of value) {
          const cloned = cloneJson(item, state, depth + 1);
          if (cloned === INVALID) return INVALID;
          result.push(cloned);
        }
        return result;
      }
      if (!isRecord(value)) return INVALID;
      const result = Object.create(null);
      const keys = Object.keys(value);
      if (keys.length > 100) return INVALID;
      for (const key of keys) {
        if (key.length > 120 || /^(?:__proto__|prototype|constructor)$/i.test(key)
          || /(?:cookie|token|authorization|password|secret|csrf|signature)/i.test(key)) return INVALID;
        const cloned = cloneJson(value[key], state, depth + 1);
        if (cloned === INVALID) return INVALID;
        result[key] = cloned;
      }
      return result;
    }

    function cloneValue(value) {
      return cloneJson(value, { nodes: 0, chars: 0 });
    }

    function exactKeys(value, allowed) {
      return isRecord(value) && Object.keys(value).every((key) => allowed.includes(key));
    }

    function isJsonContentType(value) {
      return typeof value === 'string' && /^application\/json(?:\s*;|$)/i.test(value.trim());
    }

    function validateRequestUrl(value, method) {
      if (method !== 'POST' || typeof value !== 'string' || value.length > 4096) return null;
      try {
        const url = new URL(value, globalThis.location.href);
        if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
        if (!allowedHosts.includes(url.hostname) || url.hostname !== globalThis.location.hostname) return null;
        if (url.pathname !== sendPath) return null;
        url.hash = '';
        return url;
      } catch (_) {
        return null;
      }
    }

    function sanitizeHeaders(headers) {
      const result = Object.create(null);
      const read = (source, name) => {
        if (!source) return '';
        try {
          if (typeof source.get === 'function') return source.get(name) || '';
          const lower = name.toLowerCase();
          const title = name.split('-').map((part) => part ? part[0].toUpperCase() + part.slice(1).toLowerCase() : part).join('-');
          return source[lower] || source[title] || '';
        } catch (_) {
          return '';
        }
      };
      const contentType = boundedText(read(headers, 'content-type'), 256);
      if (contentType && isJsonContentType(contentType)) result['Content-Type'] = contentType;
      if (platform === 'weixin') {
        const magic = boundedText(read(headers, 'biz_magic'), 4096);
        if (magic) result.biz_magic = magic;
      }
      return result;
    }

    function safeRequestBody(platformId, sourceBody, urlString, headers) {
      if (typeof sourceBody !== 'string' || sourceBody.length > MAX_REQUEST_BYTES) return null;
      let raw;
      try { raw = JSON.parse(sourceBody); } catch (_) { return null; }
      if (!isRecord(raw)) return null;
      const cloned = cloneValue(raw);
      if (cloned === INVALID || !isRecord(cloned)) return null;
      if (!headers || !isJsonContentType(headers['Content-Type'])) return null;

      if (platformId === 'douyin') {
        const allowed = ['account_id', 'account_type', 'contact_info', 'entry_point', 'invite_card', 'event_param'];
        if (!exactKeys(cloned, allowed) || cloned.account_type !== 1) return null;
        if (!cleanId(cloned.account_id) || !isRecord(cloned.contact_info) || !isRecord(cloned.invite_card)
          || !isRecord(cloned.event_param) || !['string', 'number'].includes(typeof cloned.entry_point)) return null;
        if (!Object.keys(cloned.invite_card).length) return null;
        return { body: cloned, referenceRecipientId: cleanId(cloned.account_id), nativeUrl: urlString, headers };
      }

      const allowed = ['finderUsername', 'talentAppid', 'itemList', 'contactInfo'];
      if (!exactKeys(cloned, allowed) || !cleanId(cloned.finderUsername) || !cleanId(cloned.talentAppid)) return null;
      if (!isRecord(cloned.itemList) || !Array.isArray(cloned.itemList.itemInfo) || cloned.itemList.itemInfo.length < 1
        || cloned.itemList.itemInfo.length > 10 || !isRecord(cloned.contactInfo)
        || !['string', 'number'].includes(typeof cloned.contactInfo.inviteScene)) return null;
      if (!cloned.itemList.itemInfo.every((item) => isRecord(item) && cleanId(item.spuId))) return null;
      return { body: cloned, referenceRecipientId: cleanId(cloned.finderUsername), nativeUrl: urlString, headers };
    }

    function findValue(value, keys, depth = 0, visited = { n: 0 }) {
      if (!value || typeof value !== 'object' || depth > 7 || visited.n++ > 500) return '';
      if (Array.isArray(value)) {
        for (const item of value) {
          const found = findValue(item, keys, depth + 1, visited);
          if (found) return found;
        }
        return '';
      }
      for (const key of Object.keys(value)) {
        if (keys.includes(key.toLowerCase()) && typeof value[key] === 'string' && value[key].trim()) return value[key];
      }
      for (const key of Object.keys(value)) {
        const found = findValue(value[key], keys, depth + 1, visited);
        if (found) return found;
      }
      return '';
    }

    function collectProductIds(body) {
      const values = [];
      const seen = new Set();
      let overflow = false;
      const keys = new Set(['spuid', 'productid', 'product_id', 'productids', 'product_ids', 'goodsid', 'goods_id', 'goodsids', 'goods_ids', 'itemid', 'item_id']);
      const walk = (value, depth = 0, visited = { n: 0 }) => {
        if (!value || typeof value !== 'object' || depth > 7 || visited.n++ > 500) return;
        if (Array.isArray(value)) {
          for (const child of value) walk(child, depth + 1, visited);
          return;
        }
        for (const key of Object.keys(value)) {
          if (keys.has(key.toLowerCase())) {
            const id = cleanId(value[key]);
            if (id && !seen.has(id)) {
              seen.add(id);
              if (values.length < 20) values.push(id);
              else overflow = true;
            }
          } else {
            walk(value[key], depth + 1, visited);
          }
        }
      };
      walk(body);
      return { values, overflow };
    }

    function maskPhone(value) {
      const digits = String(value || '').replace(/\D/g, '');
      return digits.length >= 4 ? `***${digits.slice(-4)}` : digits ? '已设置' : '';
    }

    function maskWechat(value) {
      const text = boundedText(String(value || ''), 120);
      if (!text) return '';
      if (text.length <= 2) return '***';
      return `${text.slice(0, 1)}***${text.slice(-1)}`;
    }

    function summarize(platformId, body) {
      const contact = platformId === 'douyin' ? body.contact_info : body.contactInfo;
      const rawMessage = platformId === 'weixin'
        ? contact.invitationIntroduction || findValue(body, [
          'message', 'text', 'content', 'invitationintroduction', 'invitation_text', 'words', 'description', 'desc', 'cardtext', 'invitetext',
        ])
        : findValue(body.invite_card, [
          'message', 'text', 'content', 'invitationintroduction', 'invitation_text', 'words', 'description', 'desc', 'cardtext', 'invitetext',
        ]);
      const messageTooLong = typeof rawMessage === 'string' && rawMessage.trim().length > 3000;
      const message = messageTooLong ? '' : boundedText(rawMessage, 3000);
      const version = platformId === 'douyin'
        ? findValue(body.invite_card, ['card_version', 'cardversion', 'version'])
        : findValue(body, ['card_version', 'cardversion', 'version']);
      const products = collectProductIds(body);
      return {
        message,
        productIds: products.values,
        productIdsTooMany: products.overflow,
        contactName: boundedText(contact.contactName || contact.contact_name || contact.name || '', 120),
        phoneMasked: maskPhone(contact.phone || contact.contactPhoneNumber || contact.contact_phone || ''),
        wechatMasked: maskWechat(contact.wechat || contact.contactWxId || contact.contact_wx_id || ''),
        cardVersion: boundedText(String(version || ''), 40),
        messageTooLong,
      };
    }

    function makeTemplate(platformId, request, requestUrl) {
      const parsed = safeRequestBody(platformId, request.body, requestUrl, request.headers);
      if (!parsed) return null;
      const summary = summarize(platformId, parsed.body);
      if (summary.messageTooLong || summary.productIdsTooMany) return null;
      const now = Date.now();
      let suffix = '';
      try {
        const bytes = new Uint8Array(16);
        globalThis.crypto.getRandomValues(bytes);
        suffix = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
      } catch (_) {
        suffix = `${now.toString(36)}${Math.random().toString(36).slice(2, 16)}`;
      }
      const next = {
        id: `invite-${suffix}`,
        platform: platformId,
        origin: globalThis.location.origin,
        routeKey,
        nativeUrl: parsed.nativeUrl,
        headers: parsed.headers,
        body: parsed.body,
        referenceRecipientId: parsed.referenceRecipientId,
        summary,
        expiresAtMs: now + TEMPLATE_TTL_MS,
      };
      clearTemplate();
      template = next;
      try {
        expiryTimer = globalThis.setTimeout(() => {
          if (template === next) clearTemplate();
        }, TEMPLATE_TTL_MS);
      } catch (_) {
        expiryTimer = 0;
      }
      return next;
    }

    function outcome(payload, httpOk = true) {
      if (!isRecord(payload)) return { kind: 'unknown', code: undefined, explicitDenied: false };
      const layers = [];
      const seen = new Set();
      const visit = (value, depth) => {
        if (!isRecord(value) || depth > 3 || seen.has(value)) return;
        seen.add(value);
        layers.push(value);
        for (const key of ['data', 'response', 'result']) if (isRecord(value[key])) visit(value[key], depth + 1);
      };
      visit(payload, 0);
      const codes = layers.filter((layer) => typeof layer.code === 'number').map((layer) => layer.code);
      const baseErrors = [];
      for (const layer of layers) {
        const bases = [layer.baseResp, layer.base_resp].filter(isRecord);
        for (const base of bases) {
          for (const key of ['errCode', 'errcode', 'code', 'ret', 'retCode', 'retcode']) {
            if (Object.prototype.hasOwnProperty.call(base, key) && Number(base[key]) !== 0) baseErrors.push(base[key]);
          }
          const message = boundedText(String(base.errMsg || base.errmsg || ''), 120).toLowerCase();
          if (message && !['ok', 'success'].includes(message)) baseErrors.push(message);
        }
      }
      const explicitNonZero = codes.find((code) => code !== 0);
      if (explicitNonZero !== undefined || baseErrors.length) {
        return { kind: 'failed', code: explicitNonZero === undefined ? codes.find((code) => code === 0) : explicitNonZero, explicitDenied: true };
      }
      if (!codes.includes(0) || !httpOk) return { kind: 'unknown', code: codes.includes(0) ? 0 : undefined, explicitDenied: false };
      return { kind: 'success', code: 0, explicitDenied: false };
    }

    function readStreamText(stream, limit) {
      return new Promise((resolve, reject) => {
        if (!stream || typeof stream.getReader !== 'function') return reject(new Error('stream unavailable'));
        let reader;
        try { reader = stream.getReader(); } catch (error) { reject(error); return; }
        let bytes = 0;
        let text = '';
        const decoder = new TextDecoder();
        const fail = (error) => {
          try { reader.cancel(); } catch (_) {}
          reject(error || new Error('stream read failed'));
        };
        const readNext = () => {
          let read;
          try { read = reader.read(); } catch (error) { fail(error); return; }
          Promise.resolve(read).then((part) => {
            if (!part || part.done) {
              try { text += decoder.decode(); resolve(text); } catch (error) { fail(error); }
              return;
            }
            const chunk = part.value;
            const size = chunk && typeof chunk.byteLength === 'number' ? chunk.byteLength : 0;
            if (bytes + size > limit) { fail(new Error('payload too large')); return; }
            bytes += size;
            try { text += decoder.decode(chunk, { stream: true }); } catch (error) { fail(error); return; }
            readNext();
          }).catch(fail);
        };
        readNext();
      });
    }

    function readJsonClone(response, limit) {
      let clone;
      try { clone = response && typeof response.clone === 'function' ? response.clone() : null; } catch (_) { return Promise.reject(new Error('response clone failed')); }
      return readStreamText(clone && clone.body, limit).then((text) => JSON.parse(text));
    }

    function readRequestClone(request) {
      let clone;
      try { clone = request && typeof request.clone === 'function' ? request.clone() : null; } catch (_) { return Promise.resolve(''); }
      return readStreamText(clone && clone.body, MAX_REQUEST_BYTES).catch(() => '');
    }

    function nativeSuccess(payload, response) {
      if (response && response.ok === false) return false;
      return outcome(payload, !response || response.ok !== false).kind === 'success';
    }

    function captureSuccessful(platformId, request, responsePayload, response, urlString, requestRoute) {
      if (!nativeSuccess(responsePayload, response) || requestRoute !== currentRouteKey()) return;
      makeTemplate(platformId, request, urlString);
    }

    function captureHeadersForFetch(init, input) {
      const primary = sanitizeHeaders(init && init.headers);
      const secondary = sanitizeHeaders(input && input.headers);
      return {
        'Content-Type': primary['Content-Type'] || secondary['Content-Type'] || '',
        ...(platform === 'weixin' && (primary.biz_magic || secondary.biz_magic)
          ? { biz_magic: primary.biz_magic || secondary.biz_magic }
          : {}),
      };
    }

    function installFetchObserver() {
      if (typeof nativeFetch !== 'function') return false;
      const original = nativeFetch;
      const wrapper = function daboInviteObservedFetch(input, init) {
        let requestUrl = '';
        let method = '';
        try {
          requestUrl = typeof input === 'string' ? input : input && typeof input.url === 'string' ? input.url : String(input || '');
          method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
        } catch (_) {}
        const targetUrl = validateRequestUrl(requestUrl, method);
        if (!targetUrl) return original.apply(this, arguments);
        const requestRoute = currentRouteKey();
        const headers = captureHeadersForFetch(init, typeof input === 'object' ? input : null);
        const bodyPromise = init && typeof init.body === 'string'
          ? Promise.resolve(init.body)
          : init && init.body != null
            ? Promise.resolve('')
            : input && typeof input.clone === 'function'
              ? readRequestClone(input)
              : Promise.resolve('');
        const result = original.apply(this, arguments);
        Promise.resolve(result).then((response) => {
          if (!response || typeof response.clone !== 'function') return;
          Promise.all([readJsonClone(response, MAX_RESPONSE_BYTES), bodyPromise]).then(([payload, body]) => {
            if (body && body.length <= MAX_REQUEST_BYTES) {
              captureSuccessful(platform, { body, headers }, payload, response, targetUrl.href, requestRoute);
            }
          }).catch(() => {});
        }).catch(() => {});
        return result;
      };
      try {
        globalThis.fetch = wrapper;
        return globalThis.fetch === wrapper;
      } catch (_) {
        return false;
      }
    }

    function installXhrObserver() {
      const XHR = globalThis.XMLHttpRequest;
      if (!XHR || !XHR.prototype || typeof XHR.prototype.open !== 'function' || typeof XHR.prototype.send !== 'function') return false;
      const proto = XHR.prototype;
      const originalOpen = proto.open;
      const originalSend = proto.send;
      const originalSetHeader = proto.setRequestHeader;
      proto.open = function daboInviteObservedOpen(method, url) {
        let requestUrl = '';
        let requestMethod = '';
        try { requestUrl = String(url); requestMethod = String(method).toUpperCase(); } catch (_) {}
        const parsed = validateRequestUrl(requestUrl, requestMethod);
        if (parsed) {
          xhrStates.set(this, {
            url: parsed.href,
            route: currentRouteKey(),
            body: '',
            headers: Object.create(null),
          });
          if (!watchedXhrs.has(this) && typeof this.addEventListener === 'function') {
            watchedXhrs.add(this);
            this.addEventListener('load', function daboInviteObservedLoad() {
              const state = xhrStates.get(this);
              if (!state) return;
              try {
                if (typeof this.status === 'number' && (this.status < 200 || this.status >= 300)) return;
                let payload = null;
                if (this.responseType === 'json' && isRecord(this.response)) payload = this.response;
                else if ((!this.responseType || this.responseType === 'text')
                  && typeof this.responseText === 'string' && this.responseText.length <= MAX_RESPONSE_BYTES) {
                  payload = JSON.parse(this.responseText);
                }
                if (payload && state.body) {
                  captureSuccessful(platform, { body: state.body, headers: state.headers }, payload,
                    { ok: this.status >= 200 && this.status < 300 }, state.url, state.route);
                }
              } catch (_) {
                // Unrecognized native response shapes are not calibration evidence.
              } finally {
                state.body = '';
                state.headers = Object.create(null);
                xhrStates.delete(this);
              }
            });
          }
        } else {
          xhrStates.delete(this);
        }
        return originalOpen.apply(this, arguments);
      };
      proto.send = function daboInviteObservedSend(body) {
        const state = xhrStates.get(this);
        if (state) state.body = typeof body === 'string' && body.length <= MAX_REQUEST_BYTES ? body : '';
        return originalSend.apply(this, arguments);
      };
      if (typeof originalSetHeader === 'function') {
        proto.setRequestHeader = function daboInviteObservedSetRequestHeader(name, value) {
          const state = xhrStates.get(this);
          if (state && typeof name === 'string' && typeof value === 'string') {
            const lower = name.trim().toLowerCase();
            if (lower === 'content-type' && isJsonContentType(value)) state.headers['Content-Type'] = boundedText(value, 256);
            if (platform === 'weixin' && lower === 'biz_magic') {
              const magic = boundedText(value, 4096);
              if (magic) state.headers.biz_magic = magic;
            }
          }
          return originalSetHeader.apply(this, arguments);
        };
      }
      return true;
    }

    function installNavigationInvalidation() {
      const handler = () => {
        clearTemplate();
        routeKey = currentRouteKey();
      };
      if (typeof globalThis.addEventListener === 'function') {
        for (const name of ['popstate', 'hashchange']) {
          try { globalThis.addEventListener(name, handler); } catch (_) {}
        }
        try { globalThis.addEventListener('pagehide', clearTemplate, { once: true }); } catch (_) {}
        try { globalThis.addEventListener('beforeunload', clearTemplate, { once: true }); } catch (_) {}
      }
      const history = globalThis.history;
      if (!history) return;
      for (const method of ['pushState', 'replaceState']) {
        const original = history[method];
        if (typeof original !== 'function') continue;
        try {
          history[method] = function daboInviteObservedHistory() {
            const result = original.apply(this, arguments);
            handler();
            return result;
          };
        } catch (_) {}
      }
    }

    function emptySummary() {
      return { message: '', productIds: [], contactName: '', phoneMasked: '', wechatMasked: '', cardVersion: '' };
    }

    function getActiveTemplate() {
      invalidateIfNavigated();
      if (!template) return null;
      if (Date.now() >= template.expiresAtMs || template.platform !== platformNow()
        || template.origin !== globalThis.location.origin || template.routeKey !== currentRouteKey()) {
        clearTemplate();
        return null;
      }
      return template;
    }

    function inspect(givenCapability) {
      if (givenCapability !== capability) {
        return { ready: false, missing: false, platform: platformNow(), templateId: '', expiresAt: '', referenceRecipientId: '', summary: emptySummary(), reason: '页面权限无效，请重新读取邀约配置。' };
      }
      if (!installed) {
        return { ready: false, missing: false, platform: platformNow(), templateId: '', expiresAt: '', referenceRecipientId: '', summary: emptySummary(), reason: '当前页面未能安装邀约观察器，请重新连接后重试。' };
      }
      const active = getActiveTemplate();
      if (!active) {
        return {
          ready: false,
          missing: false,
          platform: platformNow(),
          templateId: '',
          expiresAt: '',
          referenceRecipientId: '',
          summary: emptySummary(),
          reason: '先连接当前官方账号，再在平台手动成功发送一条邀约，然后重新读取配置。',
        };
      }
      return {
        ready: true,
        missing: false,
        platform: active.platform,
        templateId: active.id,
        expiresAt: new Date(active.expiresAtMs).toISOString(),
        referenceRecipientId: active.referenceRecipientId,
        summary: {
          message: boundedText(active.summary.message, 3000),
          productIds: active.summary.productIds.slice(0, 20),
          contactName: boundedText(active.summary.contactName, 120),
          phoneMasked: boundedText(active.summary.phoneMasked, 16),
          wechatMasked: boundedText(active.summary.wechatMasked, 32),
          cardVersion: boundedText(active.summary.cardVersion, 40),
        },
        reason: '',
      };
    }

    function normalizeRecipient(raw, expectedPlatform) {
      if (!isRecord(raw) || raw.platform !== expectedPlatform) return null;
      const externalId = cleanId(raw.externalId);
      if (!externalId) return null;
      const recipient = {
        id: boundedText(raw.id, 128),
        platform: expectedPlatform,
        name: boundedText(raw.name, 120),
        externalId,
        accountId: expectedPlatform === 'douyin' ? cleanId(raw.accountId) : '',
        talentAppid: expectedPlatform === 'weixin' ? cleanId(raw.talentAppid) : '',
      };
      if (expectedPlatform === 'douyin' && !recipient.accountId) return null;
      if (expectedPlatform === 'weixin' && !recipient.talentAppid) return null;
      return recipient;
    }

    function recipientKey(recipient) {
      return recipient.platform === 'douyin'
        ? `${recipient.platform}:${recipient.accountId}`
        : `${recipient.platform}:${recipient.externalId}:${recipient.talentAppid}`;
    }

    function makeHeaders(active) {
      const headers = Object.create(null);
      if (active.headers['Content-Type']) headers['Content-Type'] = active.headers['Content-Type'];
      if (active.platform === 'weixin' && active.headers.biz_magic) headers.biz_magic = active.headers.biz_magic;
      return headers;
    }

    function apiUrl(active, path) {
      try {
        const url = new URL(active.nativeUrl);
        if (url.origin !== active.origin || !allowedHosts.includes(url.hostname)) return null;
        url.pathname = path;
        url.hash = '';
        return url.href;
      } catch (_) {
        return null;
      }
    }

    async function callNativeApi(active, path, body) {
      const url = apiUrl(active, path);
      if (!url || typeof nativeFetch !== 'function') return { kind: 'unknown', reason: '官方接口地址不可用。' };
      const controller = typeof globalThis.AbortController === 'function' ? new globalThis.AbortController() : null;
      let timer = 0;
      let timeoutReject;
      const timeout = new Promise((_, reject) => { timeoutReject = reject; });
      const timeoutMarker = { kind: 'timeout' };
      try {
        timer = globalThis.setTimeout(() => {
          try { if (controller) controller.abort(); } catch (_) {}
          timeoutReject(timeoutMarker);
        }, OP_TIMEOUT_MS);
      } catch (_) {
        return { kind: 'unknown', reason: '无法建立请求超时保护。' };
      }
      try {
        const init = {
          method: 'POST',
          headers: makeHeaders(active),
          body: JSON.stringify(body),
          credentials: 'include',
        };
        if (controller) init.signal = controller.signal;
        const response = await Promise.race([nativeFetch.call(globalThis, url, init), timeout]);
        let payload;
        try {
          payload = await Promise.race([readJsonClone(response, MAX_RESPONSE_BYTES), timeout]);
        } catch (error) {
          if (error === timeoutMarker) return { kind: 'timeout', reason: '官方接口 15 秒内未返回明确结果。' };
          return { kind: 'unknown', reason: '官方接口未返回可识别的 JSON 结果。' };
        }
        const result = outcome(payload, !response || response.ok !== false);
        return { ...result, payload };
      } catch (error) {
        if (error === timeoutMarker) return { kind: 'timeout', reason: '官方接口 15 秒内未返回明确结果。' };
        return { kind: 'unknown', reason: '未收到明确的官方接口结果。' };
      } finally {
        try { globalThis.clearTimeout(timer); } catch (_) {}
      }
    }

    function preflightFailure(reason, code, platformRejected = false) {
      return {
        ok: false,
        reason: boundedText(reason, 160),
        ...(code !== undefined ? { code } : {}),
        ...(platformRejected ? { platformRejected: true } : {}),
      };
    }

    function matchesDouyinStatus(row, accountId) {
      if (!isRecord(row)) return false;
      const receiver = isRecord(row.receiver) ? row.receiver : {};
      const accountType = row.account_type === undefined ? receiver.account_type : row.account_type;
      return cleanId(row.account_id || receiver.account_id) === accountId
        && (accountType === undefined || Number(accountType) === 1);
    }

    function statusRows(payload) {
      const data = isRecord(payload) ? payload.data : null;
      if (Array.isArray(data)) return data;
      if (!isRecord(data)) return [];
      for (const key of ['receivers', 'list', 'statusList', 'status_list', 'results']) {
        if (Array.isArray(data[key])) return data[key];
      }
      return [];
    }

    function precheckIdentityMatches(payload, recipient) {
      const layers = [];
      const seen = new Set();
      const visit = (value, depth) => {
        if (!isRecord(value) || depth > 3 || seen.has(value)) return;
        seen.add(value);
        layers.push(value);
        if (isRecord(value.anchor)) visit(value.anchor, depth + 1);
        for (const key of ['data', 'response', 'result']) if (isRecord(value[key])) visit(value[key], depth + 1);
      };
      visit(payload, 0);
      for (const layer of layers) {
        for (const key of ['finderUsername', 'finder_username']) {
          if (Object.prototype.hasOwnProperty.call(layer, key)) {
            if (cleanId(layer[key]) !== recipient.externalId) return false;
          }
        }
        for (const key of ['talentAppid', 'talent_appid', 'anchorUid', 'anchor_uid']) {
          if (Object.prototype.hasOwnProperty.call(layer, key)) {
            if (cleanId(layer[key]) !== recipient.talentAppid) return false;
          }
        }
      }
      return true;
    }

    async function preflight(givenCapability, args) {
      if (givenCapability !== capability) return preflightFailure('页面权限无效。');
      if (!installed) return preflightFailure('当前页面未能安装邀约观察器。');
      const active = getActiveTemplate();
      if (!active) return preflightFailure('邀约配置已失效，请重新校准。');
      if (!isRecord(args) || args.templateId !== active.id) return preflightFailure('邀约配置与当前页面不匹配。');
      const recipient = normalizeRecipient(args.recipient, active.platform);
      if (!recipient) return preflightFailure(active.platform === 'weixin' ? '达人缺少视频号身份标识。' : '达人缺少抖音账户标识。');
      if (active.referenceRecipientId && (active.platform === 'douyin'
        ? recipient.accountId === active.referenceRecipientId
        : recipient.externalId === active.referenceRecipientId)) return preflightFailure('校准时已发送的达人会从批次中排除。');
      approvedRecipient = null;

      if (active.platform === 'douyin') {
        const response = await callNativeApi(active, '/connection/pc/im/chat/batch/status', {
          receivers: [{ account_id: recipient.accountId, account_type: 1 }],
        });
        if (response.kind !== 'success') {
          const reason = response.kind === 'failed' ? '抖音当前不允许向该达人发送邀约。' : response.reason || '未能确认抖音邀约状态。';
          return preflightFailure(reason, response.code, response.explicitDenied === true);
        }
        const rows = statusRows(response.payload);
        const matches = rows.filter((row) => matchesDouyinStatus(row, recipient.accountId));
        const status = matches.length === 1
          ? Number(matches[0].status === undefined && isRecord(matches[0].receiver) ? matches[0].receiver.status : matches[0].status)
          : 0;
        if (matches.length !== 1) return preflightFailure('抖音未返回该账户的邀约状态。');
        if (status !== 1) return preflightFailure('抖音当前不允许向该达人发送邀约。', undefined, true);
      } else {
        const url = apiUrl(active, '/shop-faas/mmchannelstradeleague/finderSquare/cgi/createPromotionInvitation');
        if (!url) return preflightFailure('视频号官方接口地址不可用。');
        const response = await callNativeApi(active, '/shop-faas/mmchannelstradeleague/finderSquare/cgi/createPromotionInvitation', {
          finderUsername: recipient.externalId,
          inviteScene: 0,
          preCheck: true,
          talentAppid: recipient.talentAppid,
        });
        if (response.kind !== 'success') {
          const reason = response.kind === 'failed' ? '视频号当前不允许向该达人发送邀约。' : response.reason || '未能确认视频号邀约状态。';
          return preflightFailure(reason, response.code, response.explicitDenied === true);
        }
        if (!precheckIdentityMatches(response.payload, recipient)) return preflightFailure('视频号预检响应的达人身份不匹配。');
      }

      approvedRecipient = {
        templateId: active.id,
        key: recipientKey(recipient),
        recipient,
        expiresAtMs: Math.min(active.expiresAtMs, Date.now() + APPROVAL_TTL_MS),
      };
      return { ok: true };
    }

    function sendFailure(status, message, code, flags = {}) {
      return {
        status,
        message: boundedText(message, 160),
        ...(code !== undefined ? { code } : {}),
        ...(flags.notSubmitted ? { notSubmitted: true } : {}),
        ...(flags.platformRejected ? { platformRejected: true } : {}),
      };
    }

    async function send(givenCapability, args) {
      const notSubmitted = (message) => sendFailure('failed', message, undefined, { notSubmitted: true });
      if (givenCapability !== capability) return notSubmitted('页面权限无效。');
      if (!installed) return notSubmitted('当前页面未能安装邀约观察器。');
      const active = getActiveTemplate();
      if (!active) return notSubmitted('邀约配置已失效，请重新校准。');
      if (!isRecord(args) || args.templateId !== active.id) return notSubmitted('邀约配置与当前页面不匹配。');
      const recipient = normalizeRecipient(args.recipient, active.platform);
      if (!recipient) return notSubmitted(active.platform === 'weixin' ? '达人缺少视频号身份标识。' : '达人缺少抖音账户标识。');
      const approval = approvedRecipient;
      approvedRecipient = null;
      if (!approval || approval.templateId !== active.id || approval.key !== recipientKey(recipient) || Date.now() >= approval.expiresAtMs) {
        return notSubmitted('请先对该达人完成一次官方状态预检。');
      }
      const body = cloneValue(active.body);
      if (body === INVALID) return notSubmitted('邀约模板数据无法安全复制。');
      if (active.platform === 'douyin') body.account_id = recipient.accountId;
      else {
        body.finderUsername = recipient.externalId;
        body.talentAppid = recipient.talentAppid;
      }
      if (!apiUrl(active, sendPath)) return notSubmitted('官方邀约接口地址不可用。');
      const response = await callNativeApi(active, sendPath, body);
      if (response.kind === 'success') return sendFailure('succeeded', '官方接口确认邀约成功。', 0);
      if (response.kind === 'failed') return sendFailure('failed', '平台明确拒绝了本次邀约。', response.code, { platformRejected: response.explicitDenied === true });
      return sendFailure('unknown', '未收到明确结果；请先核对平台状态，系统不会自动重试。', response.code);
    }

    const runtime = Object.freeze({
      inspect: (givenCapability) => inspect(givenCapability),
      preflight: (givenCapability, callArgs) => preflight(givenCapability, callArgs),
      send: (givenCapability, callArgs) => send(givenCapability, callArgs),
    });

    try {
      Object.defineProperty(globalThis, sessionKey, {
        value: runtime,
        writable: false,
        configurable: false,
        enumerable: false,
      });
    } catch (_) {
      return fail('无法建立安全的页面运行时');
    }

    nativeFetch = globalThis.fetch;
    try {
      const fetchInstalled = installFetchObserver();
      let xhrInstalled = false;
      try { xhrInstalled = installXhrObserver(); } catch (_) {}
      try { installNavigationInvalidation(); } catch (_) {}
      installed = fetchInstalled || xhrInstalled;
    } catch (_) {
      installed = false;
    }
    if (!installed) return fail('邀约观察器安装失败');
    return inspect(capability);
  }

  const sessionKey = args.sessionKey;
  const capability = args.capability;
  if (!validSessionKey(sessionKey) || !validCapability(capability)) return fail('页面连接参数无效');
  const runtime = globalThis[sessionKey];
  if (!runtime || typeof runtime[operation] !== 'function') {
    return operation === 'inspect'
      ? { ready: false, missing: true, platform: '', templateId: '', expiresAt: '', referenceRecipientId: '', summary: { message: '', productIds: [], contactName: '', phoneMasked: '', wechatMasked: '', cardVersion: '' }, reason: '页面运行时未连接，请重新读取配置。' }
      : fail('页面运行时未连接，请重新读取配置');
  }
  try {
    return runtime[operation](capability, args);
  } catch (_) {
    return operation === 'inspect'
      ? { ready: false, missing: false, platform: '', templateId: '', expiresAt: '', referenceRecipientId: '', summary: { message: '', productIds: [], contactName: '', phoneMasked: '', wechatMasked: '', cardVersion: '' }, reason: '页面操作未完成。' }
      : operation === 'preflight'
        ? { ok: false, reason: '页面预检未完成。' }
        : { status: 'unknown', message: '页面未返回明确结果；系统不会自动重试。' };
  }
}
