const INVITE_PLATFORMS = new Set(['douyin', 'weixin']);
const MODES = new Set(['words', 'category']);
const MAX_CATALOG_ROWS = 5000;

class UserConfigError extends Error {}

function userError(message) {
  throw new UserConfigError(message);
}

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
  if (value.length > MAX_CATALOG_ROWS) throw new RangeError(`${label} contains too many rows`);
  return value;
}

function readString(value, label, { required = false, max = 500 } = {}) {
  if (value == null) {
    if (required) throw new TypeError(`${label} is required`);
    return '';
  }
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  const text = value.trim();
  if (required && !text) throw new TypeError(`${label} is required`);
  if (text.length > max) throw new RangeError(`${label} is too long`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) throw new TypeError(`${label} contains control characters`);
  return text;
}

function readId(value, label) {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  const id = value.trim();
  if (!id) throw new TypeError(`${label} is required`);
  if (id.length > 256) throw new RangeError(`${label} is too long`);
  if (/[\u0000-\u001f\u007f]/u.test(id)) throw new TypeError(`${label} contains control characters`);
  return id;
}

function normalizeCatalogRows(value, label, kind) {
  const rows = requireArray(value, label);
  const ids = new Set();
  return rows.map((raw) => {
    const row = requireRecord(raw, `${label} item`);
    const id = readId(row.id, `${label}.id`);
    if (ids.has(id)) throw new TypeError(`${label} contains duplicate id ${id}`);
    ids.add(id);
    const normalized = {
      id,
      label: readString(kind === 'product' ? row.name : row.label, `${label}.label`, { required: true, max: 200 }),
    };
    if (kind === 'product') {
      if (row.priceText != null) normalized.priceText = readString(row.priceText, `${label}.priceText`, { max: 80 });
    } else if (kind === 'category') {
      if (row.path != null) {
        normalized.path = requireArray(row.path, `${label}.path`).map((part) => readString(part, `${label}.path item`, { required: true, max: 120 }));
      }
    } else if (row.group != null) {
      normalized.group = readString(row.group, `${label}.group`, { max: 120 });
    }
    return normalized;
  });
}

function normalizeOptions(platform, input) {
  const options = requireRecord(input, 'options');
  if (!INVITE_PLATFORMS.has(platform)) throw new TypeError('automatic invites support only douyin and weixin');
  const optionsPlatform = readString(options.platform, 'options.platform', { required: true, max: 32 });
  if (optionsPlatform !== platform) throw new TypeError('options platform does not match invite platform');
  if (options.ready !== true) {
    const reason = readString(options.reason, 'options.reason', { max: 300 });
    userError(reason || '邀约选项尚未就绪，请刷新平台页面后重试。');
  }
  const contextId = readId(options.contextId, 'options.contextId');
  const accountLabel = readString(options.accountLabel, 'options.accountLabel', { required: true, max: 120 });
  const mode = readString(options.mode, 'options.mode', { required: true, max: 20 });
  if (!MODES.has(mode)) throw new TypeError('options.mode must be words or category');
  if (platform === 'weixin' && mode !== 'words') userError('当前页面暂不支持这种邀约设置，请刷新后重试。');
  if (typeof options.hasMore !== 'boolean') throw new TypeError('options.hasMore must be a boolean');
  return {
    platform,
    contextId,
    accountLabel,
    mode,
    products: normalizeCatalogRows(options.products, 'options.products', 'product'),
    hasMore: options.hasMore,
    cursor: readString(options.cursor, 'options.cursor', { max: 256 }),
    categories: normalizeCatalogRows(options.categories, 'options.categories', 'category'),
    rights: normalizeCatalogRows(options.rights, 'options.rights', 'right'),
    reason: readString(options.reason, 'options.reason', { max: 300 }),
  };
}

function normalizeSelection(value, label, knownIds, { max, required = false } = {}) {
  const ids = value == null ? [] : requireArray(value, label);
  const display = label === 'productIds' ? '商品' : label === 'categoryIds' ? '品类' : '合作权限';
  if (ids.length > max) {
    const limit = label === 'productIds' ? `最多选择 ${max} 个${display}。` : `${display}选择过多，请减少选择后重试。`;
    userError(limit);
  }
  const seen = new Set();
  const result = ids.map((rawId) => {
    const id = readId(rawId, `${label} item`);
    if (seen.has(id)) userError(`请勿重复选择同一${display}。`);
    if (!knownIds.has(id)) {
      const message = label === 'productIds'
        ? '所选商品已失效，请刷新商品列表后重新选择。'
        : label === 'categoryIds'
          ? '所选品类已失效，请刷新后重新选择。'
          : '所选合作权限已失效，请刷新后重新选择。';
      userError(message);
    }
    seen.add(id);
    return id;
  });
  if (required && result.length === 0) userError('请选择至少 1 个商品。');
  return result;
}

function validatePhone(phone, required) {
  if (!phone && !required) return '';
  if (!/^1[3-9]\d{9}$/u.test(phone)) userError('手机号需为 11 位中国大陆手机号。');
  return phone;
}

function validateWechat(wechat, required) {
  if (!wechat && !required) return '';
  if (!/^[A-Za-z0-9_-]{6,20}$/u.test(wechat)) userError('微信号需为 6–20 位字母、数字、下划线或连字符。');
  return wechat;
}

function readInviteMessage(value, max, required) {
  if (value == null) value = '';
  if (typeof value !== 'string') throw new TypeError('configuration.message must be a string');
  const message = value.trim();
  if (Array.from(message).length > max) userError(`邀约话术最多 ${max} 字。`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(message)) throw new TypeError('configuration.message contains control characters');
  if (required && !message) userError('请输入邀约话术。');
  return message;
}

function readContactName(value, required) {
  const name = readString(value, 'configuration.contactName', { max: 120 });
  if (required && !name) userError('请填写联系人姓名。');
  return name;
}

function readContactValue(value, label, max) {
  return readString(value, `configuration.${label}`, { max });
}

function normalizeForSummary(platform, input, options) {
  const data = normalizeOptions(platform, options);
  const config = normalizeInviteConfig(platform, input, options);
  const productMap = new Map(data.products.map((product) => [product.id, product]));
  const phoneMasked = config.phone ? `${config.phone.slice(0, 3)}****${config.phone.slice(-4)}` : '';
  const wechatMasked = config.wechat ? `${config.wechat.slice(0, 2)}****${config.wechat.slice(-2)}` : '';
  const summary = {
    accountLabel: data.accountLabel,
    message: data.mode === 'category' ? '使用平台品类模板（无自定义话术）' : config.message,
    productIds: [...config.productIds],
    productNames: config.productIds.map((id) => productMap.get(id).label),
    contactName: config.contactName,
    phoneMasked,
    wechatMasked,
    cardVersion: data.mode,
  };
  return summary;
}

function normalizeInviteConfigUnchecked(platform, input, options) {
  if (!INVITE_PLATFORMS.has(platform)) throw new TypeError('automatic invites support only douyin and weixin');
  const data = normalizeOptions(platform, options);
  const config = requireRecord(input, 'configuration');
  const messageRequired = platform === 'weixin' || data.mode === 'words';
  const message = readInviteMessage(config.message, platform === 'weixin' ? 200 : 500, messageRequired);
  const contactName = readContactName(config.contactName, platform === 'weixin');
  const phone = validatePhone(readContactValue(config.phone, 'phone', 40), platform === 'weixin');
  const wechat = validateWechat(readContactValue(config.wechat, 'wechat', 80), platform === 'weixin');
  const maxProducts = platform === 'douyin' ? 5 : 10;
  const productIds = normalizeSelection(config.productIds, 'productIds', new Set(data.products.map((item) => item.id)), { max: maxProducts, required: true });
  const categoryIds = normalizeSelection(config.categoryIds, 'categoryIds', new Set(data.categories.map((item) => item.id)), { max: 50 });
  const rightIds = normalizeSelection(config.rightIds, 'rightIds', new Set(data.rights.map((item) => item.id)), { max: 50 });

  if (platform === 'weixin') {
    if (categoryIds.length || rightIds.length) userError('当前页面暂不支持品类或合作权限设置。');
  } else {
    if (!phone && !wechat) userError('请至少填写手机号或微信号。');
    if (data.mode === 'words') {
      if (categoryIds.length || rightIds.length) userError('话术模式不能同时选择品类或合作权限。');
    } else {
      if (message) userError('品类邀约将使用平台话术，请清空自定义话术。');
      if (!categoryIds.length) userError('请选择至少 1 个品类。');
      if (!rightIds.length) userError('请选择至少 1 项合作权限。');
    }
  }

  return { message, contactName, phone, wechat, productIds, categoryIds, rightIds };
}

export function normalizeInviteConfig(platform, input, options) {
  try {
    return normalizeInviteConfigUnchecked(platform, input, options);
  } catch (error) {
    if (error instanceof UserConfigError) throw error;
    throw new TypeError('邀约设置无效，请重新选择。');
  }
}

export function summarizeInviteConfig(platform, config, options) {
  try {
    return normalizeForSummary(platform, config, options);
  } catch (error) {
    if (error instanceof UserConfigError) throw error;
    throw new TypeError('邀约设置无效，请重新选择。');
  }
}
