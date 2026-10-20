import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeInviteConfig, summarizeInviteConfig } from '../lib/invite-config.mjs';

function options(platform = 'douyin', overrides = {}) {
  return {
    ready: true,
    platform,
    contextId: 'shop-context-1',
    accountLabel: '测试店铺',
    mode: 'words',
    products: Array.from({ length: 12 }, (_, index) => ({ id: `product-${index + 1}`, name: `商品 ${index + 1}`, priceText: `¥${index + 1}` })),
    hasMore: false,
    cursor: '',
    categories: [{ id: 'category-1', label: '美妆', path: ['美妆', '护肤'] }],
    rights: [{ id: 'right-1', label: '佣金 20%', group: '佣金' }],
    reason: '',
    // Unknown values, including session material, are not returned by config/summary APIs.
    session: { cookie: 'never-return-this' },
    ...overrides,
  };
}

function config(overrides = {}) {
  return {
    message: '你好，希望邀请你体验新品。',
    contactName: '商务小周',
    phone: '13800138000',
    wechat: 'wx_12345',
    productIds: ['product-1'],
    categoryIds: [],
    rightIds: [],
    ignored: 'drop',
    ...overrides,
  };
}

test('normalizeInviteConfig returns only the whitelisted words configuration', () => {
  const normalized = normalizeInviteConfig('douyin', config(), options());
  assert.deepEqual(normalized, {
    message: '你好，希望邀请你体验新品。',
    contactName: '商务小周',
    phone: '13800138000',
    wechat: 'wx_12345',
    productIds: ['product-1'],
    categoryIds: [],
    rightIds: [],
  });
  assert.equal(Object.hasOwn(normalized, 'ignored'), false);
  assert.equal(JSON.stringify(normalized).includes('never-return-this'), false);
});

test('Douyin words mode requires a message, a phone or WeChat, and at least one known product', () => {
  assert.throws(() => normalizeInviteConfig('douyin', config({ phone: '', wechat: '' }), options()), /手机号或微信号/u);
  assert.throws(() => normalizeInviteConfig('douyin', config({ message: '' }), options()), /请输入邀约话术/u);
  assert.throws(() => normalizeInviteConfig('douyin', config({ productIds: [] }), options()), /请选择至少 1 个商品/u);
  assert.throws(() => normalizeInviteConfig('douyin', config({ productIds: ['unlisted'] }), options()), /商品已失效/u);
  assert.throws(() => normalizeInviteConfig('douyin', config({ productIds: ['product-1', 'product-1'] }), options()), /重复选择/u);
  assert.throws(() => normalizeInviteConfig('douyin', config({ message: 'x'.repeat(501) }), options()), /最多 500 字/u);
});

test('Douyin words mode enforces product limit and accepted contact shapes', () => {
  const fiveProducts = ['product-1', 'product-2', 'product-3', 'product-4', 'product-5'];
  assert.equal(normalizeInviteConfig('douyin', config({ productIds: fiveProducts }), options()).productIds.length, 5);
  assert.throws(() => normalizeInviteConfig('douyin', config({ productIds: [...fiveProducts, 'product-6'] }), options()), /最多选择 5/u);
  assert.throws(() => normalizeInviteConfig('douyin', config({ phone: '123' }), options()), /11 位/u);
  assert.throws(() => normalizeInviteConfig('douyin', config({ wechat: 'short' }), options()), /6–20 位/u);
});

test('Douyin category mode requires known categories and rights and refuses ignored freeform text', () => {
  const categoryOptions = options('douyin', { mode: 'category' });
  const categoryConfig = config({ message: '', categoryIds: ['category-1'], rightIds: ['right-1'] });
  assert.deepEqual(normalizeInviteConfig('douyin', categoryConfig, categoryOptions), {
    message: '', contactName: '商务小周', phone: '13800138000', wechat: 'wx_12345',
    productIds: ['product-1'], categoryIds: ['category-1'], rightIds: ['right-1'],
  });
  assert.throws(() => normalizeInviteConfig('douyin', config({ message: '' }), categoryOptions), /请选择至少 1 个品类/u);
  assert.throws(() => normalizeInviteConfig('douyin', config({ message: '', categoryIds: ['category-1'] }), categoryOptions), /至少 1 项合作权限/u);
  assert.throws(() => normalizeInviteConfig('douyin', config({
    message: '', phone: '', wechat: '', categoryIds: ['category-1'], rightIds: ['right-1'],
  }), categoryOptions), /请至少填写手机号或微信号/u);
  assert.throws(() => normalizeInviteConfig('douyin', { ...categoryConfig, message: '这段话不能被忽略' }, categoryOptions), /清空自定义话术/u);
  assert.throws(() => normalizeInviteConfig('douyin', { ...categoryConfig, rightIds: ['unknown-right'] }, categoryOptions), /合作权限已失效/u);
});

test('Weixin words configuration enforces its message, contact, and product limits', () => {
  const weixinOptions = options('weixin');
  const valid = config({ productIds: Array.from({ length: 10 }, (_, index) => `product-${index + 1}`) });
  assert.equal(normalizeInviteConfig('weixin', valid, weixinOptions).productIds.length, 10);
  assert.throws(() => normalizeInviteConfig('weixin', config({ productIds: [...valid.productIds, 'product-11'] }), weixinOptions), /最多选择 10/u);
  assert.throws(() => normalizeInviteConfig('weixin', config({ message: 'x'.repeat(201) }), weixinOptions), /最多 200 字/u);
  assert.throws(() => normalizeInviteConfig('weixin', config({ contactName: '' }), weixinOptions), /联系人姓名/u);
  assert.throws(() => normalizeInviteConfig('weixin', config({ phone: '' }), weixinOptions), /11 位/u);
  assert.throws(() => normalizeInviteConfig('weixin', config({ phone: '13800138000', wechat: '' }), weixinOptions), /6–20 位/u);
  assert.throws(() => normalizeInviteConfig('weixin', config({ wechat: 'wx_12345', categoryIds: ['category-1'] }), weixinOptions), /不支持品类/u);
  assert.throws(() => normalizeInviteConfig('weixin', config(), options('weixin', { mode: 'category' })), /暂不支持/u);
});

test('options must be ready, match the platform, and contain unique bounded catalog identities', () => {
  assert.throws(() => normalizeInviteConfig('douyin', config(), options('douyin', { ready: false, reason: '商品列表未加载' })), /商品列表未加载/u);
  assert.throws(() => normalizeInviteConfig('douyin', config(), options('weixin')), /邀约设置无效/u);
  assert.throws(() => normalizeInviteConfig('kuaishou', config(), options()), /邀约设置无效/u);
  assert.throws(() => normalizeInviteConfig('douyin', config(), options('douyin', { products: [{ id: 'same', name: '商品 1' }, { id: 'same', name: '商品 2' }] })), /邀约设置无效/u);
  assert.throws(() => normalizeInviteConfig('douyin', config(), options('douyin', { contextId: '' })), /邀约设置无效/u);
  assert.throws(() => normalizeInviteConfig('douyin', config(), options('douyin', { mode: 'unsupported' })), /邀约设置无效/u);
});

test('summary maps selected IDs to official names and masks contact values', () => {
  const summary = summarizeInviteConfig('douyin', config(), options());
  assert.deepEqual(summary, {
    accountLabel: '测试店铺',
    message: '你好，希望邀请你体验新品。',
    productIds: ['product-1'],
    productNames: ['商品 1'],
    contactName: '商务小周',
    phoneMasked: '138****8000',
    wechatMasked: 'wx****45',
    cardVersion: 'words',
  });
  assert.equal(JSON.stringify(summary).includes('never-return-this'), false);
});

test('category summary says it uses the platform template instead of hiding custom text', () => {
  const summary = summarizeInviteConfig('douyin', config({ message: '', categoryIds: ['category-1'], rightIds: ['right-1'] }), options('douyin', { mode: 'category' }));
  assert.equal(summary.message, '使用平台品类模板（无自定义话术）');
  assert.equal(summary.cardVersion, 'category');
});
