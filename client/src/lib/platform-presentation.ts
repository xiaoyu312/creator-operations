import { PLATFORMS, type CreatorAccount, type Platform } from '../../../shared/types.ts';

export type CreatorPlatformFilter = Platform | 'all';

const platformLabels: Record<Platform, string> = {
  douyin: '抖音',
  channels: '视频号',
  xiaohongshu: '小红书',
  kuaishou: '快手',
};

export const creatorPlatformOptions: Array<{ value: CreatorPlatformFilter; label: string }> = [
  { value: 'all', label: '全部平台' },
  ...(['douyin', 'kuaishou', 'channels', 'xiaohongshu'] as const).map((platform) => ({ value: platform, label: platformLabels[platform] })),
];

export function isPlatform(value: string): value is Platform {
  return (PLATFORMS as readonly string[]).includes(value);
}

export function platformLabel(platform: Platform): string {
  return platformLabels[platform];
}

export function accountsForPlatform(accounts: readonly CreatorAccount[], platform: CreatorPlatformFilter): readonly CreatorAccount[] {
  return platform === 'all' ? accounts : accounts.filter((account) => account.platform === platform);
}

export function creatorHasPlatform(accounts: readonly CreatorAccount[], platform: CreatorPlatformFilter): boolean {
  return platform === 'all' || accounts.some((account) => account.platform === platform);
}

export function accountForPlatform(accounts: readonly CreatorAccount[], platform: CreatorPlatformFilter = 'all'): CreatorAccount | undefined {
  const candidates = accountsForPlatform(accounts, platform);
  return candidates.find((account) => account.active) ?? candidates[0];
}
