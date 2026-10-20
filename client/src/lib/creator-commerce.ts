import type { CreatorCommerceType, Platform } from '../../../shared/types.ts';

export type CommerceTypeFilter = CreatorCommerceType | 'both' | 'unset' | 'all';

export interface CreatorCommerceAccount {
  platform: Platform;
  commerceTypes?: CreatorCommerceType[];
}

export function accountMatchesCommerceType(
  commerceTypes: readonly CreatorCommerceType[] | null | undefined,
  filter: CommerceTypeFilter,
): boolean {
  if (filter === 'all') return true;
  const types = commerceTypes ?? [];
  if (filter === 'unset') return types.length === 0;
  if (filter === 'both') {
    return types.includes('short_video') && types.includes('live');
  }
  return types.includes(filter);
}

export function creatorMatchesCommerceType(
  accounts: readonly CreatorCommerceAccount[],
  platform: Platform | 'all',
  filter: CommerceTypeFilter,
): boolean {
  if (filter === 'all') return true;
  return accounts.some((account) => {
    if (platform !== 'all' && account.platform !== platform) return false;
    return accountMatchesCommerceType(account.commerceTypes, filter);
  });
}
