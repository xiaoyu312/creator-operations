import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Creator, ManualStore, OrderLine, OwnerCorrection, RefundEvent, SamplePackage, SampleRequest, Team, WorkspaceSnapshot } from '../shared/types.ts';
import { buildOrdersDrilldownHref, buildShopFilterOptions, buildTeamPerformanceRows, encodeShopFilterValue, matchesShopFilter } from '../client/src/lib/team-performance.ts';

const observedAt = '2026-10-15T12:00:00+08:00';

function member(id: string, teamId = 'team-a'): WorkspaceSnapshot['members'][number] {
  return { id, teamId, displayName: id, role: 'bd', active: true, version: 1 };
}

function team(id: string): Team {
  return { id, orgId: 'org-a', name: id, active: true, version: 1 };
}

function store(id: string, platform: 'douyin' | 'channels', externalShopId: string, name: string): ManualStore {
  return { id, orgId: 'org-a', teamId: 'team-a', platform, externalShopId, name, note: null, active: true, connectionMode: 'manual', connectionStatus: 'not_connected', version: 1 } as ManualStore;
}

function account(id: string, platform: 'douyin' | 'channels') {
  return { id, platform, externalAccountId: `${id}-external`, displayName: id, profileUrl: null, active: true, firstSeenAt: '2026-09-01T00:00:00.000Z', lastVerifiedAt: null } as Creator['accounts'][number];
}

function creator(id: string, input: Partial<Creator> = {}): Creator {
  return {
    id,
    orgId: 'org-a',
    teamId: 'team-a',
    ownerMemberId: 'member-a',
    name: id,
    accounts: [account(`${id}-account`, 'douyin')],
    createdAt: '2026-10-05T02:00:00.000Z',
    crmStage: 'uncontacted',
    mergedIntoCreatorId: null,
    ...input,
  } as Creator;
}

function order(id: string, input: Partial<OrderLine> = {}): OrderLine {
  return {
    id,
    orgId: 'org-a',
    teamId: 'team-a',
    platform: 'douyin',
    shopId: 'shop-a',
    status: 'paid',
    paidAt: '2026-10-08T02:00:00.000Z',
    paidAmountCents: 1000,
    ownerSnapshot: { memberId: 'member-a', assignedAt: '2026-10-08T02:00:00.000Z', ruleVersion: 'paid_at_owner_v1', reason: 'matched' },
    ...input,
  } as OrderLine;
}

function refund(id: string, orderLineId: string, input: Partial<RefundEvent> = {}): RefundEvent {
  return {
    id,
    orgId: 'org-a',
    teamId: 'team-a',
    platform: 'douyin',
    shopId: 'shop-a',
    orderLineId,
    refundedAt: '2026-10-10T02:00:00.000Z',
    status: 'succeeded',
    amountCents: 200,
    direction: 'refund',
    ...input,
  } as RefundEvent;
}

function sample(id: string, input: Partial<SampleRequest> = {}): SampleRequest {
  return {
    id,
    orgId: 'org-a',
    teamId: 'team-a',
    creatorId: 'creator-a',
    platform: 'douyin',
    applicantId: 'member-a',
    status: 'draft',
    createdAt: '2026-10-08T02:00:00.000Z',
    lines: [{ id: `${id}-line`, productId: 'product-a', quantity: 1 }],
    ...input,
  } as SampleRequest;
}

function samplePackage(sampleId: string, id: string): SamplePackage {
  return { id, orgId: 'org-a', teamId: 'team-a', sampleId, receivedAt: null } as SamplePackage;
}

function ownerCorrection(orderLineId: string, correctedMemberId: string): OwnerCorrection {
  return {
    id: `correction-${orderLineId}`,
    orgId: 'org-a',
    teamId: 'team-a',
    orderLineId,
    previousMemberId: 'member-a',
    correctedMemberId,
    correctedAt: '2026-10-14T02:00:00.000Z',
    recordedAt: '2026-10-14T02:00:00.000Z',
    correctedBy: 'admin',
    reason: '更正归属',
  };
}

function makeWorkspace(input: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return {
    dataMode: 'demo',
    actor: { memberId: 'member-a', displayName: 'member-a', role: 'manager', capabilities: [], teamId: 'team-a' },
    scope: { teamIds: ['team-a'], canSeeTeamMetrics: true, canManageMembers: false },
    metrics: { observedAt },
    members: [member('member-a'), member('member-b'), member('other-team', 'team-b')],
    teams: [team('team-a'), team('team-b')],
    creators: [],
    products: [],
    samples: [],
    samplePackages: [],
    orders: [],
    refunds: [],
    ownerCorrections: [],
    ...input,
  } as unknown as WorkspaceSnapshot;
}

function filters(input: Partial<{ dateFrom: string; dateTo: string; platform: 'all' | 'douyin' | 'channels' | 'xiaohongshu' | 'kuaishou'; shopId: string; shopPlatform: 'all' | 'douyin' | 'channels' | 'xiaohongshu' | 'kuaishou'; teamId: string; ownerMemberId: string }> = {}) {
  return { dateFrom: '2026-10-01', dateTo: '2026-10-15', platform: 'all' as const, shopId: 'all', shopPlatform: 'all' as const, teamId: 'all', ownerMemberId: 'all', ...input };
}

test('order rows use owner corrections while excluding data outside the workspace team scope', () => {
  const workspace = makeWorkspace({
    orders: [
      order('corrected', { ownerSnapshot: { memberId: 'member-a', assignedAt: null, ruleVersion: 'paid_at_owner_v1', reason: 'matched' } }),
      order('assigned', { ownerSnapshot: { memberId: 'member-b', assignedAt: null, ruleVersion: 'paid_at_owner_v1', reason: 'matched' }, paidAmountCents: 500 }),
      order('other-shop', { shopId: 'shop-b', paidAmountCents: 9000 }),
      order('outside-scope', { teamId: 'team-b', paidAmountCents: 99999 }),
    ],
    refunds: [
      refund('refund-corrected', 'corrected', { shopId: 'shop-b' }),
      refund('refund-other-shop', 'other-shop', { shopId: 'shop-a' }),
    ],
    ownerCorrections: [ownerCorrection('corrected', 'member-b')],
  });

  const result = buildTeamPerformanceRows({ workspace, actor: workspace.actor, filters: filters({ shopId: 'shop-a' }) });
  assert.deepEqual(result.visibleOrders.map((item) => item.id), ['corrected', 'assigned']);
  assert.equal(result.orders.find((row) => row.memberId === 'member-a')?.paidOrderCount, 0);
  assert.equal(result.orders.find((row) => row.memberId === 'member-b')?.paidOrderCount, 2);
  assert.equal(result.orders.find((row) => row.memberId === 'member-b')?.paidKnownCents, 1500);
  assert.equal(result.orders.find((row) => row.memberId === 'member-b')?.refundEventCount, 1);
  assert.equal(result.orders.find((row) => row.memberId === 'member-b')?.refundSignedCents, 200);
});

test('BD scope is fixed to their own payment-time owner despite a different requested member filter', () => {
  const workspace = makeWorkspace({
    actor: { memberId: 'member-a', displayName: 'member-a', role: 'bd', capabilities: [], teamId: 'team-a' },
    orders: [order('mine'), order('other', { ownerSnapshot: { memberId: 'member-b', assignedAt: null, ruleVersion: 'paid_at_owner_v1', reason: 'matched' } })],
  });

  const result = buildTeamPerformanceRows({ workspace, actor: workspace.actor, filters: filters({ ownerMemberId: 'member-b' }) });
  assert.deepEqual(result.visibleMembers.map((item) => item.id), ['member-a']);
  assert.deepEqual(result.visibleOrders.map((item) => item.id), ['mine']);
});

test('creator and sample tabs share date/platform/team/owner filters and count receipt requests once', () => {
  const workspace = makeWorkspace({
    creators: [
      creator('creator-a', { crmStage: 'cooperating' }),
      creator('creator-channel', { accounts: [account('channel', 'channels')] }),
      creator('creator-other-team', { teamId: 'team-b' }),
    ],
    samples: [
      sample('waiting-receipt', { status: 'shipped', lines: [{ id: 'line-a', productId: 'product-a', quantity: 2 }] }),
      sample('pending-shipment', { status: 'pending_shipment', lines: [{ id: 'line-b', productId: 'product-a', quantity: 1 }] }),
      sample('other-platform', { status: 'draft', creatorId: 'creator-channel', platform: 'channels' }),
      sample('legacy-platform', { status: 'draft', platform: undefined }),
      sample('other-team', { status: 'draft', teamId: 'team-b', creatorId: 'creator-other-team' }),
    ],
    samplePackages: [samplePackage('waiting-receipt', 'package-1'), samplePackage('waiting-receipt', 'package-2')],
  });

  const result = buildTeamPerformanceRows({ workspace, actor: workspace.actor, filters: filters({ platform: 'douyin' }) });
  const creatorRow = result.creators.find((row) => row.memberId === 'member-a');
  const sampleRow = result.samples.find((row) => row.memberId === 'member-a');
  assert.equal(creatorRow?.creatorCount, 1);
  assert.equal(creatorRow?.cooperatingCount, 1);
  assert.equal(sampleRow?.requestCount, 2);
  assert.equal(sampleRow?.requestedUnitCount, 3);
  assert.equal(sampleRow?.waitingReceiptRequestCount, 1);
  assert.equal(sampleRow?.pendingShipmentCount, 1);

  const allPlatforms = buildTeamPerformanceRows({ workspace, actor: workspace.actor, filters: filters({ platform: 'all' }) });
  assert.equal(allPlatforms.samples.find((row) => row.memberId === 'member-a')?.requestCount, 4);
  const channels = buildTeamPerformanceRows({ workspace, actor: workspace.actor, filters: filters({ platform: 'channels' }) });
  assert.equal(channels.samples.find((row) => row.memberId === 'member-a')?.requestCount, 1);
});

test('shop filters pair platform with external ID, and refunds follow the linked order shop', () => {
  const workspace = makeWorkspace({
    orders: [
      order('douyin-shared', { platform: 'douyin', shopId: 'shared-shop' }),
      order('channels-shared', { platform: 'channels', shopId: 'shared-shop' }),
    ],
    refunds: [
      refund('refund-linked-douyin', 'douyin-shared', { platform: 'channels', shopId: 'different-event-shop' }),
      refund('refund-linked-channels', 'channels-shared', { platform: 'channels', shopId: 'shared-shop' }),
    ],
  });
  const result = buildTeamPerformanceRows({ workspace, actor: workspace.actor, filters: filters({ shopId: 'shared-shop', shopPlatform: 'douyin' }) });
  assert.deepEqual(result.visibleOrders.map((item) => item.id), ['douyin-shared']);
  assert.deepEqual(result.visibleRefunds.map((item) => item.id), ['refund-linked-douyin']);
  const legacyResult = buildTeamPerformanceRows({ workspace, actor: workspace.actor, filters: filters({ shopId: 'shared-shop' }) });
  assert.deepEqual(legacyResult.visibleOrders.map((item) => item.id), ['douyin-shared', 'channels-shared']);

  const stores = [store('douyin-store', 'douyin', 'shared-shop', '抖音旗舰店'), store('channels-store', 'channels', 'shared-shop', '视频号小店')];
  const options = buildShopFilterOptions({
    stores,
    orders: workspace.orders,
    allowedTeamIds: ['team-a'],
    platformFilter: 'all',
    selectedShopId: 'all',
    selectedShopPlatform: 'all',
  });
  assert.deepEqual(options.filter((option) => option.shopId === 'shared-shop').map((option) => [option.shopPlatform, option.name]), [
    ['channels', '视频号小店'],
    ['douyin', '抖音旗舰店'],
  ]);
  const douyinOptions = buildShopFilterOptions({ stores, orders: workspace.orders, allowedTeamIds: ['team-a'], platformFilter: 'douyin', selectedShopId: 'all', selectedShopPlatform: 'all' });
  assert.deepEqual(douyinOptions.map((option) => [option.shopPlatform, option.name]), [['douyin', '抖音旗舰店']]);
  assert.equal(matchesShopFilter('shared-shop', 'douyin', 'shared-shop', 'douyin'), true);
  assert.equal(matchesShopFilter('shared-shop', 'channels', 'shared-shop', 'douyin'), false);
  assert.equal(matchesShopFilter('shared-shop', 'channels', 'shared-shop', 'all'), true);
  assert.equal(matchesShopFilter(null, 'channels', '__unknown__', 'channels'), true);
  assert.equal(encodeShopFilterValue('shared-shop', 'douyin'), '["douyin","shared-shop"]');
});

test('orders drilldown keeps brand, selected shop, platform, dates, team, and owner filters', () => {
  const searchParams = new URLSearchParams('brandId=brand-a&tab=management&metric=samples&shopId=old-shop');
  const href = buildOrdersDrilldownHref({
    searchParams,
    dateFrom: '2026-10-01',
    dateTo: '2026-10-15',
    platform: 'douyin',
    shopId: 'shop-a',
    shopPlatform: 'channels',
    teamId: 'team-a',
    ownerMemberId: 'member-b',
    actor: { memberId: 'manager', role: 'manager' },
  });
  const query = new URL(href, 'http://local').searchParams;
  assert.equal(new URL(href, 'http://local').pathname, '/orders');
  assert.equal(query.get('brandId'), 'brand-a');
  assert.equal(query.get('shopId'), 'shop-a');
  assert.equal(query.get('shopPlatform'), 'channels');
  assert.equal(query.get('platform'), 'douyin');
  assert.equal(query.get('dateFrom'), '2026-10-01');
  assert.equal(query.get('dateTo'), '2026-10-15');
  assert.equal(query.get('teamId'), 'team-a');
  assert.equal(query.get('ownerMemberId'), 'member-b');
  assert.equal(query.has('tab'), false);
  assert.equal(query.has('metric'), false);

  assert.equal(matchesShopFilter('shop-a', 'douyin', 'shop-a'), true);
  assert.equal(matchesShopFilter('shop-b', 'douyin', 'shop-a'), false);
  assert.equal(matchesShopFilter(null, 'douyin', '__unknown__'), true);
  assert.equal(matchesShopFilter('shop-a', 'douyin', 'all'), true);
  assert.equal(matchesShopFilter('shop-a', 'douyin', 'shop-a', 'douyin'), true);
  assert.equal(matchesShopFilter('shop-a', 'channels', 'shop-a', 'douyin'), false);
});

test('BD order drilldown forces the actor owner while keeping the selected shop', () => {
  const href = buildOrdersDrilldownHref({
    searchParams: new URLSearchParams('brandId=brand-a&shopId=shop-a'),
    dateFrom: '',
    dateTo: '',
    platform: 'all',
    shopId: 'shop-b',
    shopPlatform: 'channels',
    teamId: 'all',
    ownerMemberId: 'member-b',
    actor: { memberId: 'member-a', role: 'bd' },
  });
  const query = new URL(href, 'http://local').searchParams;
  assert.equal(query.get('brandId'), 'brand-a');
  assert.equal(query.get('shopId'), 'shop-b');
  assert.equal(query.get('shopPlatform'), 'channels');
  assert.equal(query.get('ownerMemberId'), 'member-a');
  assert.equal(query.has('platform'), false);
  assert.equal(query.has('dateFrom'), false);
});
