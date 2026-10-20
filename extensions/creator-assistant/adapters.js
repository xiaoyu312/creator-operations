(() => {
  'use strict';

  if (globalThis.DaboAdapters) return;

  const VERSION = 1;
  const MAX_TEXT = 256;
  const MAX_EXTERNAL_ID = 256;
  const DATA_HOSTS = Object.freeze({
    douyin: ['buyin.jinritemai.com'],
    kuaishou: ['cps.kwaixiaodian.com'],
    xiaohongshu: ['pgy.xiaohongshu.com'],
    weixin: ['channels.weixin.qq.com', 'store.weixin.qq.com'],
  });
  const PROFILE_HOSTS = Object.freeze({
    douyin: ['www.douyin.com'],
    kuaishou: ['www.kuaishou.com'],
    xiaohongshu: ['www.xiaohongshu.com'],
    weixin: ['channels.weixin.qq.com'],
  });
  const CAPTURE_PATHS = Object.freeze({
    douyin: [
      /\/api\/authorStatData\/authorListRec(?:\/|$)/i,
      /\/square_pc_api\/square\/search_feed_author(?:\/|$)/i,
    ],
    kuaishou: [/\/distribute\/pc\/seller\/promoter\/list(?:\/|$)/i],
    xiaohongshu: [
      /\/api\/draco\/distributor-square\/live\/buyers(?:\/|$)/i,
      /\/api\/solar\/cooperator\/blogger\/v2(?:\/|$)/i,
      /\/api\/draco\/selection-center\/contact\/info\/query(?:\/|$)/i,
    ],
    weixin: [
      /(?:^|\/)getSquareFinderList(?:\/|$)/i,
      /(?:^|\/)getSquareTalentList(?:\/|$)/i,
      /(?:^|\/)getFinderInfo(?:\/|$)/i,
      /(?:^|\/)getFinderContact(?:\/|$)/i,
    ],
  });

  function toUrl(value, base) {
    if (typeof value !== 'string' || value.length > 4096) return null;
    try {
      const locationHref = globalThis.location && typeof globalThis.location.href === 'string'
        ? globalThis.location.href
        : 'https://invalid.local/';
      return new URL(value, base || locationHref);
    } catch (_) {
      return null;
    }
  }

  function hostMatches(hostname, allowlist) {
    return allowlist.includes(String(hostname || '').toLowerCase());
  }

  function detectPlatform(value) {
    const url = toUrl(value);
    if (!url || url.protocol !== 'https:') return '';
    for (const [platform, hosts] of Object.entries(DATA_HOSTS)) {
      if (hostMatches(url.hostname, hosts)) return platform;
    }
    return '';
  }

  function safeSourceUrl(value, platform) {
    const url = toUrl(value);
    if (!url || url.protocol !== 'https:' || !hostMatches(url.hostname, DATA_HOSTS[platform] || [])) return '';
    url.username = '';
    url.password = '';
    const allowedIds = new Set(['finderusername', 'finder_username', 'finderid', 'finder_id', 'buyer_id', 'distributor_id', 'red_id', 'userid', 'uid', 'author_id', 'sec_author_id', 'aweme_id', 'promoterid', 'promoter_id']);
    for (const key of Array.from(url.searchParams.keys())) {
      if (!allowedIds.has(key.toLowerCase()) || !cleanId(url.searchParams.get(key))) url.searchParams.delete(key);
    }
    url.hash = '';
    return url.href;
  }

  function safeProfileUrl(value, platform) {
    const url = toUrl(value);
    let allowedHost = url && hostMatches(url.hostname, PROFILE_HOSTS[platform] || []);
    if (url && platform === 'douyin') allowedHost = allowedHost && /^\/user\/[^/]+\/?$/i.test(url.pathname);
    if (url && platform === 'kuaishou') allowedHost = allowedHost && /^\/profile\/[^/]+\/?$/i.test(url.pathname);
    if (url && platform === 'xiaohongshu' && url.hostname === 'www.xiaohongshu.com') {
      allowedHost = /^\/user\/profile\/[^/]+\/?$/i.test(url.pathname);
    }
    if (url && platform === 'xiaohongshu' && url.hostname === 'pgy.xiaohongshu.com') {
      allowedHost = /^\/(?:microapp\/distribution\/live-blogger-info|solar\/pre-trade\/blogger-detail)\//i.test(url.pathname);
    }
    if (url && platform === 'weixin' && url.hostname === 'channels.weixin.qq.com') {
      allowedHost = /^\/shop\/findersquare\/finder-detail\/?$/i.test(url.pathname);
    }
    if (!url || url.protocol !== 'https:' || !allowedHost) return '';
    url.username = '';
    url.password = '';
    const allowedIds = new Set(['finderusername', 'finder_username', 'finderid', 'finder_id', 'buyer_id', 'distributor_id', 'red_id', 'userid', 'uid', 'author_id', 'sec_author_id', 'aweme_id', 'promoterid', 'promoter_id']);
    for (const key of Array.from(url.searchParams.keys())) {
      if (!allowedIds.has(key.toLowerCase()) || !cleanId(url.searchParams.get(key))) url.searchParams.delete(key);
    }
    url.hash = '';
    return url.href;
  }

  function profileUrlQuality(value, platform) {
    const url = toUrl(value);
    if (!url || url.protocol !== 'https:') return 0;
    if (hostMatches(url.hostname, PROFILE_HOSTS[platform] || [])) return 2;
    if (hostMatches(url.hostname, DATA_HOSTS[platform] || [])) return 1;
    return 0;
  }

  function cleanText(value, maxLength) {
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value) || value < 0) return '';
      value = String(value);
    }
    if (typeof value !== 'string') return '';
    const limit = maxLength || MAX_TEXT;
    return value.slice(0, limit * 4).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
  }

  function cleanId(value) {
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value) || value <= 0) return '';
      value = String(value);
    }
    if (typeof value !== 'string') return '';
    const id = value.trim();
    if (!id || id.length > MAX_EXTERNAL_ID || !/^[A-Za-z0-9._-]+$/.test(id)) return '';
    return id;
  }

  function parseFollowers(value) {
    if (typeof value === 'number') {
      return Number.isSafeInteger(value) && value >= 0 ? value : null;
    }
    if (typeof value !== 'string') return null;
    const text = value.replace(/,/g, '').trim();
    const match = text.match(/^(\d+(?:\.\d+)?)\s*(万|亿|w|k)?(?:粉丝|粉|followers?)?$/i);
    if (!match) return null;
    const amount = Number(match[1]);
    const unit = (match[2] || '').toLowerCase();
    const multiplier = unit === '万' || unit === 'w' ? 10000 : unit === '亿' ? 100000000 : unit === 'k' ? 1000 : 1;
    const count = Math.round(amount * multiplier);
    return Number.isSafeInteger(count) && count >= 0 ? count : null;
  }

  function object(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  }

  function first(...values) {
    for (const value of values) {
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return undefined;
  }

  function dataRoot(payload) {
    const root = object(payload);
    if (!root) return null;
    const nested = object(root.data);
    return nested || root;
  }

  function endpointKind(platform, apiUrl) {
    const url = toUrl(apiUrl);
    if (!url || detectPlatform(url.href) !== platform) return '';
    const path = url.pathname;
    if (!(CAPTURE_PATHS[platform] || []).some((pattern) => pattern.test(path))) return '';
    if (platform === 'douyin') return /authorListRec/i.test(path) ? 'douyin-list-a' : 'douyin-list-b';
    if (platform === 'kuaishou') return 'kuaishou-list';
    if (platform === 'xiaohongshu') {
      if (/contact\/info\/query/i.test(path)) return 'xhs-contact';
      if (/cooperator\/blogger\/v2/i.test(path)) return 'xhs-bloggers';
      return 'xhs-buyers';
    }
    if (/getSquareFinderList/i.test(path)) return 'weixin-finder-list';
    if (/getSquareTalentList/i.test(path)) return 'weixin-talent-list';
    if (/getFinderContact/i.test(path)) return 'weixin-contact';
    if (/getFinderInfo/i.test(path)) return 'weixin-info';
    return '';
  }

  function isCaptureUrl(value, platform) {
    const url = toUrl(value);
    if (!url) return false;
    const detected = detectPlatform(url.href);
    if (!detected || (platform && detected !== platform)) return false;
    const path = url.pathname;
    return (CAPTURE_PATHS[detected] || []).some((pattern) => pattern.test(path));
  }

  function contactFrom(row) {
    const root = object(row);
    if (!root) return null;
    const data = object(root.data);
    const response = object(root.response);
    const containers = [
      response, object(response && response.contact), object(response && response.contact_info),
      object(root.contact), object(root.contact_info), object(root.contactInfo),
      object(root.contact_data), object(root.contactData), object(root.finderContact),
      object(root.finder_contact), object(data && data.contact), object(data && data.contact_info),
      data, root,
    ].filter(Boolean);
    const pick = (keys) => {
      for (const container of containers) {
        for (const key of keys) {
          const value = cleanText(container[key], MAX_TEXT);
          if (value) return value;
        }
      }
      return '';
    };
    const contact = {
      phone: pick(['phone', 'mobile', 'contact_phone', 'phone_number']),
      wechat: pick(['wechat', 'wechat_id', 'weixin', 'wx_id']),
      email: pick(['email', 'mail']),
    };
    return Object.values(contact).some(Boolean) ? contact : null;
  }

  function candidate(platform, raw, sourceUrl, overrides) {
    const row = object(raw);
    if (!row) return null;
    const patch = object(overrides) || {};
    const id = cleanId(first(patch.externalId, row.externalId));
    if (!id) return null;
    const name = cleanText(first(patch.name, row.name));
    const followers = parseFollowers(first(patch.followers, row.followers));
    const contact = object(patch.contact) || object(row.contact);
    const metadata = safePlatformData(platform, first(patch.platformData, row.platformData));
    const out = {
      platform,
      externalId: id,
      name,
      profileUrl: safeProfileUrl(first(patch.profileUrl, row.profileUrl), platform),
      followers,
      category: cleanText(first(patch.category, row.category), 120),
      contact: {
        phone: cleanText(contact && contact.phone),
        wechat: cleanText(contact && contact.wechat),
        email: cleanText(contact && contact.email),
      },
      sourceUrl: safeSourceUrl(first(patch.sourceUrl, row.sourceUrl, sourceUrl), platform),
    };
    if (metadata) out.platformData = metadata;
    return out;
  }

  function safePlatformData(platform, value) {
    const data = object(value);
    if (!data) return null;
    const accountId = platform === 'douyin' ? cleanId(data.accountId) : '';
    const talentAppid = platform === 'weixin' ? cleanId(data.talentAppid) : '';
    const searchAccount = platform === 'douyin' ? cleanId(data.searchAccount) : '';
    if (!accountId && !talentAppid && !searchAccount) return null;
    return { accountId, talentAppid, searchAccount };
  }

  function pickCandidate(platform, row, sourceUrl, idValues, nameValues, followerValues, contact, profileValues, platformDataValues) {
    const externalId = cleanId(first(...idValues));
    if (!externalId) return null;
    const name = cleanText(first(...nameValues));
    const followers = parseFollowers(first(...followerValues));
    const raw = {
      externalId,
      name,
      followers,
      contact: contact || undefined,
      profileUrl: first(...(profileValues || [])),
      platformData: first(...(platformDataValues || [])),
    };
    return candidate(platform, raw, sourceUrl);
  }

  function listAt(root, key) {
    const value = object(root) && root[key];
    return Array.isArray(value) ? value : [];
  }

  function unwrapResponse(payload) {
    const root = object(payload);
    if (!root) return null;
    if (object(root.response)) return root.response;
    if (object(root.data) && object(root.data.response)) return root.data.response;
    return object(root.data) || root;
  }

  function extractCandidates(platform, payload, sourceUrl, context) {
    if (!Object.prototype.hasOwnProperty.call(DATA_HOSTS, platform) || !object(payload)) return [];
    const ctx = object(context) || {};
    const kind = endpointKind(platform, ctx.apiUrl);
    if (!kind) return [];
    const root = dataRoot(payload);
    const response = unwrapResponse(payload);
    const results = [];

    if (platform === 'douyin') {
      const rows = listAt(root, 'list');
      for (const row of rows.slice(0, 200)) {
        const top = object(row) || {};
        const author = object(top.author_base) || object(object(top.author_data) && top.author_data.author_base) || {};
        const item = pickCandidate(platform, top, sourceUrl,
          [author.uid, author.author_id, author.sec_author_id, author.aweme_id, top.uid, top.author_id, top.sec_author_id, top.aweme_id],
          [author.nickname, author.author_name, top.nickname, top.author_name],
          [author.follower_count, author.fans_num, top.follower_count, top.fans_num, top.fans], null,
          [author.profile_url, author.user_url, author.sec_user_url, top.profile_url, top.user_url],
          [{
            accountId: first(author.account_id, author.uid, top.account_id, top.uid),
            searchAccount: first(author.aweme_id, author.account_douyin, author.unique_id,
              top.aweme_id, top.account_douyin, top.unique_id),
          }]);
        if (item) results.push(item);
      }
      return results;
    }

    if (platform === 'kuaishou') {
      const rows = listAt(root, 'promoterList');
      for (const row of rows.slice(0, 200)) {
        const top = object(row) || {};
        const item = pickCandidate(platform, top, sourceUrl,
          [top.promoterId], [top.promoterNickName], [top.fanNum], null,
          [top.profileUrl, top.profile_url, top.user_url]);
        if (item) results.push(item);
      }
      return results;
    }

    if (platform === 'xiaohongshu') {
      if (kind === 'xhs-contact') {
        const contact = contactFrom(payload);
        const requestId = cleanId(ctx.requestId);
        const internalIds = [response.buyer_id, response.distributor_id, response.userId, response.user_id,
          root.buyer_id, root.distributor_id, root.userId, root.user_id].map(cleanId).filter(Boolean);
        const redIds = [response.redId, response.red_id, root.redId, root.red_id].map(cleanId).filter(Boolean);
        if (new Set(internalIds).size > 1 || new Set(redIds).size > 1) return [];
        const internalId = internalIds[0] || '';
        const redId = redIds[0] || '';
        const requestField = typeof ctx.requestIdField === 'string' ? ctx.requestIdField.toLowerCase() : '';
        const requestIsRedId = requestField === 'red_id' || requestField === 'redid';
        const responseComparableId = requestIsRedId ? redId : internalId;
        if (requestId && requestIsRedId && !redId) return [];
        if (requestId && responseComparableId && requestId !== responseComparableId) return [];
        const extId = internalId || requestId || redId;
        if (!extId) return [];
        const item = pickCandidate(platform, response, sourceUrl, [extId],
          [response.name, response.nickname], [response.fans, response.fans_num, response.follower_count], contact);
        return item ? [item] : [];
      }
      const rows = kind === 'xhs-bloggers' ? listAt(root, 'kols') : listAt(root, 'distributor_info_list');
      for (const row of rows.slice(0, 200)) {
        const top = object(row) || {};
        const data = object(top.distributor_data_info) || {};
        const item = kind === 'xhs-bloggers'
          ? pickCandidate(platform, top, sourceUrl,
            [top.userId, top.user_id, top.redId, top.red_id], [top.name, top.nickname], [top.fans, top.fans_num, top.follower_count, top.followerCount], null,
            [top.profileUrl, top.profile_url, top.user_url])
          : pickCandidate(platform, top, sourceUrl,
            [data.distributor_id, data.red_id, top.distributor_id, top.red_id],
            [data.name, data.nickname, data.distributor_name, top.name, top.nickname],
            [data.fans, data.fans_num, data.follower_count, top.fans, top.fans_num], null,
            [data.profile_url, data.user_url, top.profile_url]);
        if (item) results.push(item);
      }
      return results;
    }

    const contact = kind === 'weixin-contact' ? contactFrom(payload) : null;
    let rows = [];
    if (kind === 'weixin-finder-list') rows = listAt(response, 'finderList');
    else if (kind === 'weixin-talent-list') rows = listAt(response, 'list');
    else if (kind === 'weixin-info' || kind === 'weixin-contact') rows = [response];
    for (const row of rows.slice(0, 200)) {
      const top = object(row) || {};
      const info = object(top.finderInfo) || object(top.finderBaseInfo) || {};
      const base = object(top.finderBaseInfo) || object(info.finderBaseInfo) || {};
      const responseId = cleanId(first(top.finderUsername, info.finderUsername, base.finderUsername));
      const isDetail = kind === 'weixin-info' || kind === 'weixin-contact';
      const requestId = isDetail ? cleanId(ctx.requestId) : '';
      if (requestId && responseId && requestId !== responseId) continue;
      const extId = cleanId(first(responseId, requestId));
      if (!extId) continue;
      const nestedContact = contact || contactFrom(top);
      const item = pickCandidate(platform, top, sourceUrl,
        [extId],
        [top.finderNickname, info.finderNickname, info.anchor_name, base.finderNickname, base.anchor_name],
        [top.fans_num_text, info.fans_num_text, base.fans_num_text, top.fans_num, info.fans_num], nestedContact,
        [top.profileUrl, top.profile_url, info.profileUrl, info.profile_url, base.profileUrl, base.profile_url],
        [{ talentAppid: first(top.talentAppid, top.talent_appid, info.talentAppid, info.talent_appid, base.talentAppid, base.talent_appid) }]);
      if (item) results.push(item);
    }
    return results;
  }

  function sanitizeCandidate(input, expectedPlatform, sourceUrl) {
    const raw = object(input);
    if (!raw) return null;
    const platform = expectedPlatform || raw.platform;
    if (!Object.prototype.hasOwnProperty.call(DATA_HOSTS, platform) || raw.platform !== platform) return null;
    const id = cleanId(raw.externalId);
    if (!id) return null;
    const contact = object(raw.contact) || {};
    const sanitized = candidate(platform, {
      externalId: id,
      name: cleanText(raw.name),
      followers: parseFollowers(raw.followers),
      profileUrl: safeProfileUrl(raw.profileUrl, platform),
      category: cleanText(raw.category, 120),
      platformData: safePlatformData(platform, raw.platformData),
      contact: {
        phone: cleanText(contact.phone),
        wechat: cleanText(contact.wechat),
        email: cleanText(contact.email),
      },
      sourceUrl: safeSourceUrl(sourceUrl || raw.sourceUrl, platform),
    }, sourceUrl || raw.sourceUrl);
    return sanitized;
  }

  function mergeCandidates(existing, incoming) {
    const merged = new Map();
    const add = (item) => {
      const clean = sanitizeCandidate(item);
      if (!clean) return;
      const key = `${clean.platform}:${clean.externalId}`;
      const prior = merged.get(key);
      if (!prior) {
        merged.set(key, clean);
        return;
      }
      const contact = { ...prior.contact };
      for (const field of ['phone', 'wechat', 'email']) {
        if (clean.contact[field]) contact[field] = clean.contact[field];
      }
      const platformData = {
        accountId: clean.platformData && clean.platformData.accountId || prior.platformData && prior.platformData.accountId || '',
        talentAppid: clean.platformData && clean.platformData.talentAppid || prior.platformData && prior.platformData.talentAppid || '',
        searchAccount: clean.platformData && clean.platformData.searchAccount || prior.platformData && prior.platformData.searchAccount || '',
      };
      merged.set(key, {
        ...prior,
        name: clean.name || prior.name,
        profileUrl: profileUrlQuality(clean.profileUrl, clean.platform) > profileUrlQuality(prior.profileUrl, prior.platform)
          ? clean.profileUrl
          : profileUrlQuality(clean.profileUrl, clean.platform) === profileUrlQuality(prior.profileUrl, prior.platform) && clean.profileUrl
            ? clean.profileUrl
            : prior.profileUrl,
        followers: clean.followers === null ? prior.followers : clean.followers,
        category: clean.category || prior.category,
        contact,
        sourceUrl: clean.sourceUrl || prior.sourceUrl,
        ...(platformData.accountId || platformData.talentAppid || platformData.searchAccount ? { platformData } : {}),
      });
    };
    for (const item of Array.isArray(existing) ? existing : []) add(item);
    for (const item of Array.isArray(incoming) ? incoming : []) add(item);
    return Array.from(merged.values());
  }

  function scanDocument(document, url) {
    const platform = detectPlatform(url);
    if (!platform || !document || typeof document.querySelectorAll !== 'function') return [];
    let anchors = [];
    try {
      anchors = Array.from(document.querySelectorAll('a[href]')).slice(0, 1000);
    } catch (_) {
      return [];
    }
    const found = [];
    for (const anchor of anchors) {
      const href = typeof anchor.href === 'string' ? anchor.href : anchor.getAttribute && anchor.getAttribute('href');
      const parsed = toUrl(href, url);
      if (!parsed || parsed.protocol !== 'https:') continue;
      let externalId = '';
      if (platform === 'douyin' && hostMatches(parsed.hostname, PROFILE_HOSTS.douyin)) {
        const match = parsed.pathname.match(/^\/user\/([^/]+)\/?$/);
        try { externalId = match ? cleanId(decodeURIComponent(match[1])) : ''; } catch (_) { externalId = ''; }
      } else if (platform === 'kuaishou' && hostMatches(parsed.hostname, PROFILE_HOSTS.kuaishou)) {
        const match = parsed.pathname.match(/^\/profile\/([^/]+)\/?$/);
        try { externalId = match ? cleanId(decodeURIComponent(match[1])) : ''; } catch (_) { externalId = ''; }
      } else if (platform === 'xiaohongshu' && hostMatches(parsed.hostname, PROFILE_HOSTS.xiaohongshu)) {
        const match = parsed.pathname.match(/^\/user\/profile\/([^/]+)\/?$/);
        try { externalId = match ? cleanId(decodeURIComponent(match[1])) : ''; } catch (_) { externalId = ''; }
      }
      if (!externalId) continue;
      const name = cleanText(anchor.getAttribute && first(anchor.getAttribute('aria-label'), anchor.getAttribute('title'), anchor.textContent));
      const parentText = cleanText(anchor.parentElement && anchor.parentElement.textContent, 1200);
      const followerMatch = parentText.match(/(\d+(?:\.\d+)?\s*(?:万|亿|w|k)?(?:粉丝|粉|followers?))/i);
      const item = candidate(platform, {
        externalId,
        name,
        followers: followerMatch ? parseFollowers(followerMatch[1]) : null,
        profileUrl: `${parsed.origin}${parsed.pathname}`,
      }, url);
      if (item) found.push(item);
    }
    return mergeCandidates([], found).slice(0, 200);
  }

  globalThis.DaboAdapters = Object.freeze({
    VERSION,
    detectPlatform,
    isCaptureUrl,
    extractCandidates,
    sanitizeCandidate,
    safeSourceUrl,
    safeProfileUrl,
    scanDocument,
    mergeCandidates,
  });
})();
