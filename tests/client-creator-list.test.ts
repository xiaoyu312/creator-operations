import assert from 'node:assert/strict';
import test from 'node:test';
import type { CreatorAccount } from '../shared/types.ts';
import { creatorHasPlatform } from '../client/src/lib/platform-presentation.ts';
import { creatorCreatedDestination, creatorsInVisibleScope, isImplicitDefaultCreatorPlatform, type CreatorListScope, type CreatorListScopeRecord } from '../client/src/lib/creator-list.ts';

function creator(overrides: Partial<CreatorListScopeRecord> = {}): CreatorListScopeRecord {
  return { archived: false, mergedIntoCreatorId: null, teamId: 'team-a', ownerMemberId: 'member-a', ...overrides };
}

const teamScope: CreatorListScope = {
  view: 'team',
  allowedTeamIds: ['team-a'],
  teamId: 'all',
  ownerMemberId: 'all',
  memberId: 'member-a',
};

test('a visible Channels-only creator makes implicit Douyin an active filter', () => {
  const channelsOnlyAccount: CreatorAccount = {
    id: 'account-channels',
    platform: 'channels',
    externalAccountId: 'wx-channel-id',
    displayName: '视频号账号',
    profileUrl: null,
    active: true,
    commerceTypes: [],
    firstSeenAt: '2026-10-16T00:00:00Z',
    lastVerifiedAt: null,
  };
  const channelsOnlyCreator = { ...creator(), accounts: [channelsOnlyAccount] };
  const candidates = creatorsInVisibleScope([channelsOnlyCreator], teamScope);

  assert.equal(candidates.length, 1);
  assert.equal(creatorHasPlatform(channelsOnlyCreator.accounts, 'douyin'), false);
  assert.equal(isImplicitDefaultCreatorPlatform('douyin', false, candidates.length > 0), false);
});

test('archived and merged creators do not prevent the first-creator empty state', () => {
  const candidates = creatorsInVisibleScope([
    creator({ archived: true }),
    creator({ mergedIntoCreatorId: 'creator-target' }),
  ], teamScope);

  assert.equal(candidates.length, 0);
  assert.equal(isImplicitDefaultCreatorPlatform('douyin', false, candidates.length > 0), true);
});

test('scope constraints determine whether the default platform is filtering visible creators', () => {
  const candidates = creatorsInVisibleScope([creator({ ownerMemberId: 'member-b' })], {
    ...teamScope,
    ownerMemberId: 'member-a',
  });

  assert.equal(candidates.length, 0);
  assert.equal(isImplicitDefaultCreatorPlatform('douyin', false, candidates.length > 0), true);
});

test('an explicit Douyin selection remains a filter when no visible creator matches it', () => {
  assert.equal(isImplicitDefaultCreatorPlatform('douyin', true, false), false);
});

test('creator creation routes managers to the public pool and BD to their own list with only the new platform', () => {
  assert.deepEqual(creatorCreatedDestination(true, 'channels'), {
    path: '/public-pool',
    values: { platform: 'channels' },
  });
  assert.deepEqual(creatorCreatedDestination(false, 'channels'), {
    path: '/creators',
    values: { scope: 'mine', platform: 'channels' },
  });
});
