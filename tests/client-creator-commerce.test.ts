import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Platform } from '../shared/types.ts';
import { creatorMatchesCommerceType, type CreatorCommerceAccount } from '../client/src/lib/creator-commerce.ts';

function commerceAccount(platform: Platform, commerceTypes?: CreatorCommerceAccount['commerceTypes']): CreatorCommerceAccount {
  return { platform, commerceTypes };
}

test('both type matches when one selected-platform account supports video and live commerce', () => {
  const accounts = [commerceAccount('xiaohongshu', ['short_video', 'live'])];

  assert.equal(creatorMatchesCommerceType(accounts, 'xiaohongshu', 'both'), true);
});

test('both type never combines single-purpose accounts across platforms', () => {
  const accounts = [
    commerceAccount('douyin', ['short_video']),
    commerceAccount('channels', ['live']),
  ];

  assert.equal(creatorMatchesCommerceType(accounts, 'all', 'both'), false);
  assert.equal(creatorMatchesCommerceType(accounts, 'douyin', 'both'), false);
});

test('unknown legacy account types remain unset and do not imply both', () => {
  const accounts = [commerceAccount('kuaishou')];

  assert.equal(creatorMatchesCommerceType(accounts, 'kuaishou', 'unset'), true);
  assert.equal(creatorMatchesCommerceType(accounts, 'kuaishou', 'both'), false);
});
