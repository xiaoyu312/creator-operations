(() => {
  'use strict';

  const ADAPTERS = globalThis.DaboAdapters;
  const CHANNEL = 'dabo-creator-assistant';
  const VERSION = 1;
  const MAX_CANDIDATES = 100;
  const MAX_QUEUE = 20;
  const MAX_RESPONSE_CHARS = 1024 * 1024;

  if (!ADAPTERS || globalThis.__DABO_PAGE_HOOK_INSTALLED__) return;
  const platform = ADAPTERS.detectPlatform(globalThis.location && globalThis.location.href);
  if (!platform) return;
  globalThis.__DABO_PAGE_HOOK_INSTALLED__ = true;

  const origin = globalThis.location.origin;
  const pageUrl = ADAPTERS.safeSourceUrl(globalThis.location.href, platform);
  const earlyQueue = [];
  let contentReady = false;

  function safeId(value) {
    return ADAPTERS.sanitizeCandidate({ platform, externalId: value }, platform, pageUrl)?.externalId || '';
  }

  function requestIdFrom(url, body) {
    const parsed = (() => {
      try { return new URL(url, globalThis.location.href); } catch (_) { return null; }
    })();
    if (!parsed) return '';
    const allowedKeys = platform === 'xiaohongshu'
      ? ['buyer_id', 'distributor_id', 'red_id', 'userId']
      : platform === 'weixin'
        ? ['finderUsername', 'finder_username', 'finderId', 'finder_id']
        : platform === 'douyin'
          ? ['uid', 'author_id', 'sec_author_id', 'aweme_id']
          : ['promoterId', 'promoter_id'];
    for (const key of allowedKeys) {
      const id = safeId(parsed.searchParams.get(key));
      if (id) return { id, field: key };
    }

    if (typeof body !== 'string' || body.length > 64 * 1024) return '';
    let parsedBody = null;
    try {
      parsedBody = JSON.parse(body);
    } catch (_) {
      try {
        const form = new URLSearchParams(body);
        for (const key of allowedKeys) {
          const id = safeId(form.get(key));
          if (id) return { id, field: key };
        }
      } catch (_) {
        return '';
      }
      return '';
    }
    if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) return '';
    for (const key of allowedKeys) {
      const id = safeId(parsedBody[key]);
      if (id) return { id, field: key };
    }
    return '';
  }

  function publish(candidates) {
    if (!Array.isArray(candidates) || candidates.length === 0) return;
    const clean = [];
    for (const item of candidates.slice(0, MAX_CANDIDATES)) {
      const normalized = ADAPTERS.sanitizeCandidate(item, platform, pageUrl);
      if (normalized) clean.push(normalized);
    }
    if (!clean.length) return;
    const message = {
      channel: CHANNEL,
      version: VERSION,
      type: 'CAPTURE_RESPONSE',
      platform,
      candidates: ADAPTERS.mergeCandidates([], clean).slice(0, MAX_CANDIDATES),
    };
    if (contentReady) {
      try { globalThis.postMessage(message, origin); } catch (_) {}
      return;
    }
    earlyQueue.push(message);
    if (earlyQueue.length > MAX_QUEUE) earlyQueue.shift();
  }

  function processPayload(apiUrl, payload, requestIdentity) {
    if (!ADAPTERS.isCaptureUrl(apiUrl, platform)) return;
    try {
      const identity = requestIdentity && typeof requestIdentity === 'object' ? requestIdentity : {};
      const candidates = ADAPTERS.extractCandidates(platform, payload, pageUrl, {
        apiUrl,
        requestId: identity.id || '',
        requestIdField: identity.field || '',
      });
      publish(candidates);
    } catch (_) {
      // An unexpected response shape is ignored; the platform response is never forwarded.
    }
  }

  function readJsonClone(response, callback) {
    let clone;
    try { clone = response.clone(); } catch (_) { return; }
    if (!clone || !clone.body || typeof clone.body.getReader !== 'function') return;
    let reader;
    try { reader = clone.body.getReader(); } catch (_) { return; }
    const decoder = new TextDecoder();
    let text = '';
    let byteCount = 0;
    let finished = false;
    const fail = () => {
      if (finished) return;
      finished = true;
      try { reader.cancel(); } catch (_) {}
    };
    const readNext = () => {
      let read;
      try { read = reader.read(); } catch (_) { fail(); return; }
      Promise.resolve(read).then((result) => {
        if (finished) return;
        if (!result || result.done) {
          finished = true;
          try {
            text += decoder.decode();
            callback(JSON.parse(text));
          } catch (_) {}
          return;
        }
        const chunk = result.value;
        const size = chunk && typeof chunk.byteLength === 'number' ? chunk.byteLength : 0;
        if (byteCount + size > MAX_RESPONSE_CHARS) { fail(); return; }
        byteCount += size;
        text += decoder.decode(chunk, { stream: true });
        readNext();
      }).catch(fail);
    };
    readNext();
  }

  globalThis.addEventListener('message', (event) => {
    if (event.source !== globalThis || event.origin !== origin) return;
    const data = event.data;
    if (!data || data.channel !== CHANNEL || data.version !== VERSION || data.type !== 'CONTENT_READY') return;
    contentReady = true;
    try { globalThis.postMessage({ channel: CHANNEL, version: VERSION, type: 'CONTENT_ACK' }, origin); } catch (_) {}
    while (earlyQueue.length) {
      try { globalThis.postMessage(earlyQueue.shift(), origin); } catch (_) { earlyQueue.length = 0; }
    }
  });

  const originalFetch = globalThis.fetch;
  if (typeof originalFetch === 'function') {
    globalThis.fetch = function daboCaptureFetch(input, init) {
      let requestUrl = '';
      try {
        requestUrl = typeof input === 'string' ? input : input && typeof input.url === 'string' ? input.url : '';
      } catch (_) {}
      if (!ADAPTERS.isCaptureUrl(requestUrl, platform)) return originalFetch.apply(this, arguments);
      const requestIdentity = requestIdFrom(requestUrl, init && init.body);
      const result = originalFetch.apply(this, arguments);
      try {
        Promise.resolve(result).then((response) => {
          if (response && response.ok && typeof response.clone === 'function') {
            readJsonClone(response, (payload) => processPayload(requestUrl, payload, requestIdentity));
          }
        }).catch(() => {});
      } catch (_) {}
      return result;
    };
  }

  const XHR = globalThis.XMLHttpRequest;
  if (XHR && XHR.prototype && typeof XHR.prototype.open === 'function' && typeof XHR.prototype.send === 'function') {
    const xhrState = new WeakMap();
    const watched = new WeakSet();
    const originalOpen = XHR.prototype.open;
    const originalSend = XHR.prototype.send;
    XHR.prototype.open = function daboCaptureOpen(method, url) {
      let requestUrl = '';
      try { requestUrl = String(url); } catch (_) {}
      if (ADAPTERS.isCaptureUrl(requestUrl, platform)) {
        xhrState.set(this, { url: requestUrl, requestIdentity: null });
        if (!watched.has(this) && typeof this.addEventListener === 'function') {
          watched.add(this);
          this.addEventListener('load', function daboCaptureLoad() {
            const state = xhrState.get(this);
            if (!state) return;
            try {
              if (typeof this.status === 'number' && (this.status < 200 || this.status >= 300)) return;
              let payload = null;
              if (this.responseType === 'json') payload = this.response;
              else if ((!this.responseType || this.responseType === 'text') && typeof this.responseText === 'string' && this.responseText.length <= MAX_RESPONSE_CHARS) {
                payload = JSON.parse(this.responseText);
              }
              if (payload && typeof payload === 'object') processPayload(state.url, payload, state.requestIdentity);
            } catch (_) {}
          });
        }
      } else {
        xhrState.delete(this);
      }
      return originalOpen.apply(this, arguments);
    };
    XHR.prototype.send = function daboCaptureSend(body) {
      const state = xhrState.get(this);
      if (state) state.requestIdentity = requestIdFrom(state.url, body);
      return originalSend.apply(this, arguments);
    };
  }
})();
