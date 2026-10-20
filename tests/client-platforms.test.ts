import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CreatorAccount, Platform } from '../shared/types.ts';
import { accountForPlatform, accountsForPlatform, creatorHasPlatform, creatorPlatformOptions, isPlatform, platformLabel } from '../client/src/lib/platform-presentation.ts';

function account(id: string, platform: Platform, active: boolean): CreatorAccount {
  return {
    id,
    platform,
    externalAccountId: `demo-${id}`,
    displayName: `合成账号 ${id}`,
    profileUrl: null,
    active,
    firstSeenAt: '2026-10-14T00:00:00.000Z',
    lastVerifiedAt: null,
  };
}

test('creator platform filters expose the four supported labels in the requested display order', () => {
  assert.deepEqual(creatorPlatformOptions, [
    { value: 'all', label: '全部平台' },
    { value: 'douyin', label: '抖音' },
    { value: 'kuaishou', label: '快手' },
    { value: 'channels', label: '视频号' },
    { value: 'xiaohongshu', label: '小红书' },
  ]);
  assert.equal(isPlatform('kuaishou'), true);
  assert.equal(isPlatform('unknown'), false);
  assert.equal(platformLabel('xiaohongshu'), '小红书');
});

test('platform filtering and displayed account stay on the same creator account', () => {
  const accounts = [account('dy', 'douyin', true), account('ks', 'kuaishou', false)];

  assert.equal(creatorHasPlatform(accounts, 'kuaishou'), true);
  assert.equal(creatorHasPlatform(accounts, 'channels'), false);
  assert.deepEqual(accountsForPlatform(accounts, 'kuaishou').map((item) => item.id), ['ks']);
  assert.equal(accountForPlatform(accounts, 'kuaishou')?.id, 'ks');
  assert.equal(accountForPlatform(accounts, 'all')?.id, 'dy');
});
