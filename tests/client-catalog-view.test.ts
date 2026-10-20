import assert from 'node:assert/strict';
import test from 'node:test';
import type { ManualStore, Product, StoreAssortment } from '../shared/types.ts';
import {
  buildCatalogGroups,
  filterCatalogGroups,
  readCatalogFilters,
  withCatalogFilters,
} from '../client/src/lib/catalog-view.ts';

function product(id: string, name: string, overrides: Partial<Product> = {}): Product {
  return {
    id, orgId: 'org-1', teamId: 'team-1', brand: '云眠', name, sku: `${id}-SKU`, specification: '标准款',
    sampleCostCents: 1200, active: true, note: null, version: 1,
    createdAt: '2026-10-01T00:00:00+08:00', createdBy: 'member-1',
    updatedAt: '2026-10-01T00:00:00+08:00', updatedBy: 'member-1',
    ...overrides,
  };
}

function store(id: string, platform: ManualStore['platform'], name: string): ManualStore {
  return {
    id, orgId: 'org-1', teamId: 'team-1', platform, externalShopId: `${id}-external`, name, note: null,
    active: true, connectionMode: 'manual', connectionStatus: 'not_connected', version: 1,
    createdAt: '2026-10-01T00:00:00+08:00', createdBy: 'member-1',
    updatedAt: '2026-10-01T00:00:00+08:00', updatedBy: 'member-1',
  };
}

function assortment(id: string, productId: string, storeId: string, priceCents: number): StoreAssortment {
  return {
    id, orgId: 'org-1', teamId: 'team-1', productId, storeId, priceCents,
    livePriceCents: priceCents - 100, creatorCommissionBps: 1800, mainSellingPoints: [],
    sellingPointEvidenceUrl: null, salesCardUrl: null, productGroups: [], validFrom: null, validUntil: null,
    active: true, version: 1, createdAt: '2026-10-01T00:00:00+08:00', createdBy: 'member-1',
    updatedAt: '2026-10-01T00:00:00+08:00', updatedBy: 'member-1',
  };
}

test('每个商品只形成一个目录分组，多店货盘作为关联供货项，未归店铺商品仍保留', () => {
  const groups = buildCatalogGroups(
    [product('product-a', '轻暖枕'), product('product-b', '旅行眼罩')],
    [assortment('offer-a1', 'product-a', 'store-douyin', 12000), assortment('offer-a2', 'product-a', 'store-xhs', 12500)],
    [store('store-douyin', 'douyin', '抖音旗舰店'), store('store-xhs', 'xiaohongshu', '小红书店铺')],
  );

  assert.equal(groups.length, 2);
  const offersByProduct = new Map(groups.map((group) => [group.product.id, group.offers.length]));
  assert.equal(offersByProduct.get('product-a'), 2);
  assert.equal(offersByProduct.get('product-b'), 0);
});

test('平台和店铺筛选只保留匹配货盘；全部平台仍可发现未归店铺商品', () => {
  const groups = buildCatalogGroups(
    [product('product-a', '轻暖枕'), product('product-b', '旅行眼罩')],
    [assortment('offer-a1', 'product-a', 'store-douyin', 12000), assortment('offer-a2', 'product-a', 'store-xhs', 12500)],
    [store('store-douyin', 'douyin', '抖音旗舰店'), store('store-xhs', 'xiaohongshu', '小红书店铺')],
  );

  const xhs = filterCatalogGroups(groups, { platform: 'xiaohongshu', storeId: '', query: '' });
  assert.deepEqual(xhs.map((group) => [group.product.id, group.offers.map((offer) => offer.store?.id)]), [['product-a', ['store-xhs']]]);

  const oneStore = filterCatalogGroups(groups, { platform: 'all', storeId: 'store-douyin', query: '' });
  assert.deepEqual(oneStore.map((group) => [group.product.id, group.offers.map((offer) => offer.store?.id)]), [['product-a', ['store-douyin']]]);

  const unassigned = filterCatalogGroups(groups, { platform: 'all', storeId: '', query: '旅行眼罩' });
  assert.deepEqual(unassigned.map((group) => [group.product.id, group.offers.length]), [['product-b', 0]]);

  const storeSearch = filterCatalogGroups(groups, { platform: 'all', storeId: '', query: '小红书店铺' });
  assert.deepEqual(storeSearch.map((group) => [group.product.id, group.offers.map((offer) => offer.store?.id)]), [['product-a', ['store-xhs']]]);
});

test('平台、店铺和搜索更新保留品牌及其他路由上下文', () => {
  const original = new URLSearchParams('brandId=brand-a&scheduleId=schedule-1&creatorId=creator-2&platform=douyin&storeId=store-1&q=枕头');
  const next = withCatalogFilters(original, { platform: 'channels', storeId: '', query: '眼罩' });

  assert.deepEqual(readCatalogFilters(next), { platform: 'channels', storeId: '', query: '眼罩' });
  assert.equal(next.get('brandId'), 'brand-a');
  assert.equal(next.get('scheduleId'), 'schedule-1');
  assert.equal(next.get('creatorId'), 'creator-2');
});
