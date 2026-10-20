(() => {
  'use strict';

  const ADAPTERS = globalThis.DaboAdapters;
  const CHANNEL = 'dabo-creator-assistant';
  const VERSION = 1;
  const MAX_CANDIDATES = 500;
  const MAX_MESSAGE_CANDIDATES = 100;
  const HOST_ID = 'dabo-creator-assistant-panel';

  if (!ADAPTERS || globalThis.__DABO_CONTENT_INSTALLED__) return;
  const currentPlatform = ADAPTERS.detectPlatform(globalThis.location && globalThis.location.href);
  if (!currentPlatform) return;
  globalThis.__DABO_CONTENT_INSTALLED__ = true;

  const candidates = new Map();
  const savedIds = new Set();
  const savedCreators = new Map();
  const orphanDetails = new Map();
  const diagnostics = {
    received: 0,
    rejected: 0,
    domFound: 0,
    truncated: 0,
    orphanDetails: 0,
  };
  let panel = null;
  let panelOpen = true;
  let scanTimer = 0;
  let handshakeTimer = 0;
  let handshakeAttempts = 0;
  let hookReady = false;
  let statusText = '正在读取当前页面';
  const lastErrorReports = new Map();

  function reportContentError(operation, error) {
    // Never send page contents, exception text or arbitrary stack strings to the logger.
    try {
      const now = Date.now();
      if (now - (lastErrorReports.get(operation) || 0) < 10000) return;
      lastErrorReports.set(operation, now);
      const runtime = globalThis.chrome?.runtime;
      if (!runtime?.getURL) return;
      const ownFiles = ['content.js', 'adapters.js'];
      const frames = [];
      for (const line of String(error?.stack || '').slice(0, 10000).split('\n')) {
        for (const file of ownFiles) {
          const prefix = runtime.getURL(file);
          const offset = line.indexOf(prefix + ':');
          if (offset < 0) continue;
          const location = line.slice(offset + prefix.length).match(/^:(\d{1,7}):(\d{1,7})(?:\)|\s|$)/);
          if (location) frames.push(`    at ${prefix}:${location[1]}:${location[2]}`);
        }
        if (frames.length >= 6) break;
      }
      const name = ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError'].includes(error?.name) ? error.name : 'Error';
      void runtimeSend({ type: 'CONTENT_DIAGNOSTIC', event: { operation, error: { name, stack: frames.join('\n') } } }).catch(() => {});
    } catch { /* Reporting must not affect page capture. */ }
  }

  function sourceUrl() {
    return ADAPTERS.safeSourceUrl(globalThis.location.href, currentPlatform);
  }

  function runtimeSend(message) {
    try {
      const runtime = globalThis.chrome && globalThis.chrome.runtime;
      if (!runtime || typeof runtime.sendMessage !== 'function') return Promise.reject(new Error('扩展后台不可用'));
      return Promise.resolve(runtime.sendMessage(message));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  function addCandidates(items, source) {
    if (!Array.isArray(items)) return 0;
    let added = 0;
    for (const raw of items.slice(0, MAX_MESSAGE_CANDIDATES)) {
      let item = ADAPTERS.sanitizeCandidate(raw, currentPlatform, sourceUrl());
      if (!item) {
        diagnostics.rejected += 1;
        continue;
      }
      const key = `${item.platform}:${item.externalId}`;
      const previous = candidates.get(key);
      if (!item.name) {
        const known = previous || savedCreators.get(key);
        const hasContact = Object.values(item.contact || {}).some(Boolean);
        if (known && known.name) {
          item = ADAPTERS.mergeCandidates([known], [item])[0];
        } else if (hasContact) {
          const patch = ADAPTERS.mergeCandidates(orphanDetails.has(key) ? [orphanDetails.get(key)] : [], [item])[0];
          if (patch) {
            if (!orphanDetails.has(key) && orphanDetails.size >= 100) {
              const oldestPatch = orphanDetails.keys().next().value;
              if (oldestPatch) orphanDetails.delete(oldestPatch);
            }
            orphanDetails.set(key, patch);
            diagnostics.orphanDetails = orphanDetails.size;
          }
          continue;
        } else {
          diagnostics.rejected += 1;
          continue;
        }
      }
      const orphan = orphanDetails.get(key);
      if (orphan) {
        item = ADAPTERS.mergeCandidates([item], [orphan])[0] || item;
        orphanDetails.delete(key);
        diagnostics.orphanDetails = orphanDetails.size;
      }
      if (!previous && candidates.size >= MAX_CANDIDATES) {
        const oldest = candidates.keys().next().value;
        if (oldest) candidates.delete(oldest);
        diagnostics.truncated += 1;
      }
      const merged = ADAPTERS.mergeCandidates(previous ? [previous] : [], [item])[0];
      if (!merged) continue;
      if (!previous) added += 1;
      candidates.delete(key);
      candidates.set(key, merged);
    }
    if (source === 'network') diagnostics.received += items.length;
    if (source === 'dom') diagnostics.domFound += added;
    render();
    return added;
  }

  function snapshot() {
    return {
      candidates: Array.from(candidates.values()).filter((item) => item.name).slice(0, MAX_CANDIDATES),
      platform: currentPlatform,
      captureStats: { ...diagnostics, hookReady },
      diagnostics: [
        `收到接口候选 ${diagnostics.received} 条`,
        `页面链接识别 ${diagnostics.domFound} 位`,
        `拒绝无效消息 ${diagnostics.rejected} 条`,
        `待关联联系详情 ${diagnostics.orphanDetails} 条`,
        `容量截断 ${diagnostics.truncated} 条`,
      ],
    };
  }

  function installRuntimeListener() {
    const runtime = globalThis.chrome && globalThis.chrome.runtime;
    if (!runtime || !runtime.onMessage || typeof runtime.onMessage.addListener !== 'function') return;
    runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || message.type !== 'CAPTURE_PAGE') return false;
      if (typeof sendResponse === 'function') sendResponse(snapshot());
      return false;
    });
  }

  function onWindowMessage(event) {
    if (event.source !== globalThis || event.origin !== globalThis.location.origin) return;
    const data = event.data;
    if (!data || data.channel !== CHANNEL || data.version !== VERSION) return;
    if (data.type === 'CONTENT_ACK') {
      hookReady = true;
      if (handshakeTimer) globalThis.clearTimeout(handshakeTimer);
      handshakeTimer = 0;
      return;
    }
    if (data.type !== 'CAPTURE_RESPONSE') return;
    if (data.platform !== currentPlatform || !Array.isArray(data.candidates) || data.candidates.length > MAX_MESSAGE_CANDIDATES) {
      diagnostics.rejected += 1;
      render();
      return;
    }
    addCandidates(data.candidates, 'network');
  }

  function sendContentReady() {
    if (hookReady || handshakeAttempts >= 10) return;
    handshakeAttempts += 1;
    try {
      globalThis.postMessage({ channel: CHANNEL, version: VERSION, type: 'CONTENT_READY' }, globalThis.location.origin);
    } catch (_) {}
    handshakeTimer = globalThis.setTimeout(() => {
      handshakeTimer = 0;
      sendContentReady();
    }, 200);
  }

  function getCreatorRows(response) {
    if (!response) return [];
    if (response.state && Array.isArray(response.state.creators)) return response.state.creators;
    if (response.payload && response.payload.state && Array.isArray(response.payload.state.creators)) return response.payload.state.creators;
    return [];
  }

  async function refreshSavedIds() {
    try {
      const response = await runtimeSend({ type: 'GET_STATE' });
      const rows = getCreatorRows(response);
      savedIds.clear();
      savedCreators.clear();
      for (const row of rows) {
        if (!row || row.platform !== currentPlatform || typeof row.externalId !== 'string') continue;
        const id = row.externalId.trim();
        if (id && id.length <= 256) {
          const key = `${row.platform}:${id}`;
          savedIds.add(key);
          const creator = ADAPTERS.sanitizeCandidate(row, currentPlatform, sourceUrl());
          if (creator && creator.name) savedCreators.set(key, creator);
        }
      }
      statusText = '只显示本地收录状态';
      const matchedPatches = [];
      for (const [key, patch] of orphanDetails) {
        const known = savedCreators.get(key);
        if (known && known.name) matchedPatches.push(ADAPTERS.mergeCandidates([known], [patch])[0]);
      }
      if (matchedPatches.length) addCandidates(matchedPatches, 'state');
    } catch (error) {
      reportContentError('content.state', error);
      statusText = '暂时无法读取工作台收录状态';
    }
    render();
  }

  function formattedFollowers(value) {
    if (!Number.isSafeInteger(value) || value < 0) return '';
    try {
      return `${new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value)} 粉丝`;
    } catch (_) {
      return `${value} 粉丝`;
    }
  }

  function element(tag, className, text) {
    const node = globalThis.document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function attachPanel() {
    const doc = globalThis.document;
    if (!doc || !doc.documentElement || typeof doc.createElement !== 'function') return false;
    const host = doc.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('data-extension-ui', 'true');
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = element('style');
    style.textContent = `
      :host { all: initial; color: #17212f; font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .wrap { position: fixed; right: 18px; bottom: 18px; z-index: 2147483647; width: 328px; max-width: calc(100vw - 28px); color: #17212f; }
      .panel { overflow: hidden; border: 1px solid #e4e8ef; border-radius: 8px; background: #fff; box-shadow: 0 10px 28px rgba(23, 33, 47, .16); }
      .head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 13px 14px 10px; border-bottom: 1px solid #e4e8ef; }
      .title { margin: 0; font-size: 15px; font-weight: 650; }
      .caption { margin-top: 3px; color: #5e6b7a; font-size: 12px; }
      .close, .toggle { border: 0; background: transparent; color: #5e6b7a; cursor: pointer; font: inherit; }
      .close { padding: 0 2px; font-size: 18px; line-height: 1; }
      .list { max-height: 250px; overflow: auto; }
      .empty { padding: 19px 14px; color: #5e6b7a; }
      .row { display: flex; justify-content: space-between; gap: 12px; padding: 10px 14px; border-bottom: 1px solid #f0f2f5; }
      .row:last-child { border-bottom: 0; }
      .name { overflow: hidden; color: #17212f; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
      .meta { margin-top: 3px; color: #5e6b7a; font-size: 12px; }
      .badge { align-self: center; flex: none; border-radius: 999px; background: #eef4ff; color: #2563eb; padding: 3px 8px; font-size: 11px; }
      .badge.saved { background: #edf7f0; color: #237342; }
      .foot { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-top: 1px solid #e4e8ef; }
      .status { flex: 1; min-width: 0; overflow: hidden; color: #5e6b7a; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
      .actions { display: flex; gap: 7px; padding: 0 14px 13px; }
      button.action { min-height: 34px; border: 1px solid #e4e8ef; border-radius: 6px; background: #fff; color: #17212f; cursor: pointer; font: inherit; padding: 6px 10px; }
      button.action.primary { border-color: #2563eb; background: #2563eb; color: #fff; }
      button.action:disabled { cursor: wait; opacity: .65; }
      a.profile { color: inherit; text-decoration: none; }
      a.profile:hover { text-decoration: underline; }
      .toggle { position: absolute; right: 0; bottom: 0; display: none; border: 1px solid #e4e8ef; border-radius: 8px; background: #fff; box-shadow: 0 6px 18px rgba(23, 33, 47, .15); padding: 9px 12px; }
      .wrap.closed .panel { display: none; }
      .wrap.closed .toggle { display: block; }
      @media (max-width: 460px) { .wrap { right: 10px; bottom: 10px; width: min(328px, calc(100vw - 20px)); } }
    `;
    const wrap = element('div', 'wrap');
    wrap.className = panelOpen ? 'wrap' : 'wrap closed';
    const box = element('section', 'panel');
    box.setAttribute('aria-label', '达人助手收录面板');
    const head = element('header', 'head');
    const titleGroup = element('div');
    titleGroup.append(element('h2', 'title', '达人助手'));
    titleGroup.append(element('div', 'caption', '从当前平台页面整理达人资料'));
    const close = element('button', 'close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', '收起面板');
    close.addEventListener('click', () => { panelOpen = false; render(); });
    head.append(titleGroup, close);
    const list = element('div', 'list');
    list.setAttribute('role', 'list');
    const foot = element('div', 'foot');
    const status = element('div', 'status');
    const refresh = element('button', 'action', '刷新');
    refresh.type = 'button';
    refresh.addEventListener('click', () => refreshSavedIds());
    foot.append(status, refresh);
    const actions = element('div', 'actions');
    const save = element('button', 'action primary', '本地收录全部候选');
    save.type = 'button';
    save.addEventListener('click', (event) => collectAll(save, event));
    const workbench = element('button', 'action', '打开工作台');
    workbench.type = 'button';
    workbench.addEventListener('click', (event) => openWorkbench(event));
    actions.append(save, workbench);
    box.append(head, list, foot, actions);
    const toggle = element('button', 'toggle', '达人助手');
    toggle.type = 'button';
    toggle.addEventListener('click', () => { panelOpen = true; render(); });
    wrap.append(box, toggle);
    shadow.append(style, wrap);
    doc.documentElement.append(host);
    panel = shadow;
    return true;
  }

  function render() {
    if (!panel && !attachPanel()) return;
    const wrap = panel.querySelector('.wrap');
    const list = panel.querySelector('.list');
    const status = panel.querySelector('.status');
    const save = panel.querySelector('.action.primary');
    if (!wrap || !list || !status || !save) return;
    wrap.className = panelOpen ? 'wrap' : 'wrap closed';
    status.textContent = `${statusText} · ${candidates.size} 位候选`;
    list.replaceChildren();
    const rows = Array.from(candidates.values()).slice(-80).reverse();
    if (!rows.length) {
      list.append(element('div', 'empty', '浏览达人列表或详情页后，这里会显示可收录资料。'));
    } else {
      for (const item of rows) {
        const row = element('div', 'row');
        row.setAttribute('role', 'listitem');
        const details = element('div');
        const nameLine = element('div', 'name');
        const name = item.name || `达人 ${item.externalId.slice(-8)}`;
        const profileUrl = ADAPTERS.safeProfileUrl(item.profileUrl, item.platform)
          || ADAPTERS.safeSourceUrl(item.sourceUrl, item.platform);
        if (profileUrl) {
          const link = element('a', 'profile', name);
          link.href = profileUrl;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          nameLine.append(link);
        } else {
          nameLine.textContent = name;
        }
        const followers = formattedFollowers(item.followers);
        const meta = element('div', 'meta', followers || '粉丝数未提供');
        details.append(nameLine, meta);
        const alreadySaved = savedIds.has(`${item.platform}:${item.externalId}`);
        const badge = element('span', alreadySaved ? 'badge saved' : 'badge', alreadySaved ? '已本地收录' : '待收录');
        row.append(details, badge);
        list.append(row);
      }
    }
    save.disabled = candidates.size === 0;
  }

  async function collectAll(button, event) {
    if (!event || event.isTrusted !== true) return;
    if (candidates.size === 0) return;
    button.disabled = true;
    statusText = '正在写入工作台';
    render();
    try {
      const response = await runtimeSend({ type: 'UPSERT_CREATORS', creators: Array.from(candidates.values()).slice(0, MAX_CANDIDATES) });
      if (!response || response.ok === false) throw new Error(response && response.error || '收录失败');
      statusText = '已写入本地工作台';
      await refreshSavedIds();
    } catch (error) {
      reportContentError('content.save', error);
      statusText = error && error.message ? error.message : '收录失败，请重试';
      render();
    } finally {
      if (button.isConnected) button.disabled = candidates.size === 0;
    }
  }

  async function openWorkbench(event) {
    if (!event || event.isTrusted !== true) return;
    try {
      const response = await runtimeSend({ type: 'OPEN_WORKBENCH' });
      if (response && response.ok === false) throw new Error(response.error || '无法打开工作台');
    } catch (error) {
      reportContentError('content.open', error);
      statusText = error && error.message ? error.message : '无法打开工作台';
      render();
    }
  }

  function scanPage() {
    if (ADAPTERS.detectPlatform(globalThis.location.href) !== currentPlatform) return;
    const found = ADAPTERS.scanDocument(globalThis.document, globalThis.location.href);
    addCandidates(found, 'dom');
  }

  function scheduleScan(delay) {
    if (scanTimer) globalThis.clearTimeout(scanTimer);
    scanTimer = globalThis.setTimeout(() => {
      scanTimer = 0;
      try { scanPage(); } catch (error) { reportContentError('content.capture', error); }
    }, delay === undefined ? 450 : delay);
  }

  function observeDocument() {
    const MutationObserverImpl = globalThis.MutationObserver;
    if (!MutationObserverImpl || !globalThis.document.documentElement) return;
    const observer = new MutationObserverImpl(() => scheduleScan());
    observer.observe(globalThis.document.documentElement, { childList: true, subtree: true, attributes: false, characterData: false });
  }

  globalThis.addEventListener('message', event => {
    try { onWindowMessage(event); } catch (error) { reportContentError('content.capture', error); }
  });
  installRuntimeListener();
  sendContentReady();

  if (globalThis.document.documentElement) {
    attachPanel();
    observeDocument();
    scheduleScan(50);
  } else {
    globalThis.document.addEventListener('DOMContentLoaded', () => {
      attachPanel();
      observeDocument();
      scheduleScan(50);
    }, { once: true });
  }
  refreshSavedIds();
  globalThis.addEventListener('pagehide', () => {
    if (scanTimer) globalThis.clearTimeout(scanTimer);
    if (handshakeTimer) globalThis.clearTimeout(handshakeTimer);
  }, { once: true });
})();
