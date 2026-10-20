// Local geometric placeholders are authored for this public package.
export const EMPTY_ILLUSTRATION_URLS = {
  creators: '/brand/placeholder.svg',
  products: '/brand/placeholder.svg',
  orders: '/brand/placeholder.svg',
} as const;
export type EmptyIllustrationKind = keyof typeof EMPTY_ILLUSTRATION_URLS;
export const PRODUCT_NAME = '达播';
