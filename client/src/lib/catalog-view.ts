import type { ManualStore, Platform, Product, StoreAssortment } from '../../../shared/types.ts';
import { isPlatform } from './platform-presentation.ts';

export type CatalogPlatformFilter = Platform | 'all';

export interface CatalogFilters {
  platform: CatalogPlatformFilter;
  storeId: string;
  query: string;
}

export interface CatalogOffer {
  assortment: StoreAssortment;
  store: ManualStore | null;
}

export interface CatalogProductGroup {
  product: Product;
  offers: CatalogOffer[];
}

export function readCatalogFilters(params: URLSearchParams): CatalogFilters {
  const requestedPlatform = params.get('platform') ?? '';
  return {
    platform: isPlatform(requestedPlatform) ? requestedPlatform : 'all',
    storeId: params.get('storeId') ?? '',
    query: params.get('q') ?? '',
  };
}

export function withCatalogFilters(params: URLSearchParams, changes: Partial<CatalogFilters>): URLSearchParams {
  const next = new URLSearchParams(params);
  if (changes.platform) {
    if (changes.platform === 'all') next.delete('platform');
    else next.set('platform', changes.platform);
  }
  if (changes.storeId !== undefined) {
    if (changes.storeId) next.set('storeId', changes.storeId);
    else next.delete('storeId');
  }
  if (changes.query !== undefined) {
    const query = changes.query.trim();
    if (query) next.set('q', query);
    else next.delete('q');
  }
  return next;
}

export function buildCatalogGroups(
  products: Product[],
  assortments: StoreAssortment[],
  stores: ManualStore[],
): CatalogProductGroup[] {
  const storesById = new Map(stores.map((store) => [store.id, store]));
  const productsById = new Map(products.map((product) => [product.id, product]));
  const offersByProductId = new Map<string, CatalogOffer[]>();

  for (const assortment of assortments) {
    if (!productsById.has(assortment.productId)) continue;
    const offers = offersByProductId.get(assortment.productId) ?? [];
    offers.push({ assortment, store: storesById.get(assortment.storeId) ?? null });
    offersByProductId.set(assortment.productId, offers);
  }

  return products
    .map((product) => ({
      product,
      offers: (offersByProductId.get(product.id) ?? []).sort((left, right) => (left.store?.name ?? '').localeCompare(right.store?.name ?? '', 'zh-CN')),
    }))
    .sort((left, right) => left.product.name.localeCompare(right.product.name, 'zh-CN'));
}

export function filterCatalogGroups(
  groups: CatalogProductGroup[],
  filters: CatalogFilters,
): CatalogProductGroup[] {
  const query = filters.query.trim().toLocaleLowerCase();
  return groups.flatMap((group) => {
    const matchingOffers = group.offers.filter(({ assortment, store }) => {
      if (filters.platform !== 'all' && store?.platform !== filters.platform) return false;
      if (filters.storeId && assortment.storeId !== filters.storeId) return false;
      return true;
    });
    const productMatches = !query || [
      group.product.brand,
      group.product.name,
      group.product.sku ?? '',
      group.product.specification ?? '',
    ].join(' ').toLocaleLowerCase().includes(query);

    if (matchingOffers.length === 0 && (filters.platform !== 'all' || filters.storeId)) return [];
    if (matchingOffers.length === 0 && group.offers.length > 0) return [];
    if (matchingOffers.length === 0 && filters.platform !== 'all') return [];

    if (!query) return [{ ...group, offers: matchingOffers }];
    if (productMatches) return [{ ...group, offers: matchingOffers }];

    const matchingStoreOffers = matchingOffers.filter(({ store }) => [
      store?.name ?? '',
      store?.externalShopId ?? '',
      store?.note ?? '',
    ].join(' ').toLocaleLowerCase().includes(query));
    return matchingStoreOffers.length ? [{ ...group, offers: matchingStoreOffers }] : [];
  });
}
