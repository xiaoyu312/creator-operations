import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Creator, ImportBatch, OrderLine, RefundEvent, Team } from '../shared/types.ts';
import { buildBusinessHomeFacts, getBusinessHomeRankingAmount, getBusinessOrderSourceStatus } from '../client/src/lib/business-home.ts';

function order(input: Partial<OrderLine> & Pick<OrderLine, 'id' | 'platform' | 'teamId'>): OrderLine {
  return {
    status: 'paid',
    paidAt: '2026-10-02T02:00:00.000Z',
    paidAmountCents: 1000,
    creatorId: 'creator-a',
    creatorAccountId: 'douyin-a',
    ...input,
  } as OrderLine;
}

function refund(input: Partial<RefundEvent> & Pick<RefundEvent, 'id' | 'platform'>): RefundEvent {
  return {
    status: 'succeeded',
    refundedAt: '2026-10-03T02:00:00.000Z',
    amountCents: 100,
    direction: 'refund',
    ...input,
  } as RefundEvent;
}

function creator(id: string, name: string, accountId: string): Creator {
  return {
    id,
    name,
    mergedIntoCreatorId: null,
    ownerMemberId: 'member-a',
    accounts: [{ id: `${id}-account`, platform: 'douyin', externalAccountId: accountId, displayName: name, active: true }],
  } as unknown as Creator;
}

const teams = [{ id: 'team-a', name: '华东团队' }, { id: 'team-b', name: '华南团队' }] as unknown as Team[];

test('platform and Shanghai-date filters are applied once to paid facts, trend, and both rankings', () => {
  const facts = buildBusinessHomeFacts({
    orders: [
      order({ id: 'order-a', platform: 'douyin', teamId: 'team-a', paidAt: '2026-10-01T16:30:00.000Z', paidAmountCents: 12000 }),
      order({ id: 'order-b', platform: 'douyin', teamId: 'team-a', paidAt: '2026-10-04T02:00:00.000Z', paidAmountCents: null }),
      order({ id: 'order-c', platform: 'channels', teamId: 'team-b', paidAt: '2026-10-03T02:00:00.000Z', paidAmountCents: 9000 }),
      order({ id: 'order-d', platform: 'douyin', teamId: 'team-b', paidAt: '2026-10-05T16:30:00.000Z', paidAmountCents: 8000 }),
      order({ id: 'order-e', platform: 'douyin', teamId: 'team-b', status: 'pending', paidAmountCents: 7000 }),
    ],
    refunds: [
      refund({ id: 'refund-a', platform: 'douyin', amountCents: 3000 }),
      refund({ id: 'refund-b', platform: 'douyin', direction: 'reversal', refundedAt: '2026-10-04T03:00:00.000Z', amountCents: 1000 }),
      refund({ id: 'refund-c', platform: 'channels', amountCents: 9900 }),
      refund({ id: 'refund-d', platform: 'douyin', status: 'pending', amountCents: 5000 }),
      refund({ id: 'refund-e', platform: 'douyin', amountCents: null }),
    ],
    creators: [creator('creator-a', '达人甲', 'douyin-a')],
    teams,
    orderStatus: 'records_only',
    refundStatus: 'records_only',
    observedAt: '2026-10-14T12:00:00+08:00',
    filters: { platform: 'douyin', from: '2026-10-02', to: '2026-10-05' },
  });

  assert.deepEqual(facts.orders.map((item) => item.id), ['order-a', 'order-b']);
  assert.deepEqual(facts.refunds.map((item) => item.id), ['refund-a', 'refund-b', 'refund-e']);
  assert.deepEqual(facts.paid, { status: 'records_only', count: 2, knownCents: 12000, unknownCount: 1, complete: false });
  assert.deepEqual(facts.refund, { status: 'records_only', count: 3, signedCents: 2000, unknownCount: 1 });
  assert.equal(facts.teamRanking[0]?.id, 'team-a');
  assert.deepEqual(facts.teamRanking[0], { id: 'team-a', name: '华东团队', count: 2, knownCents: 12000, unknownAmountCount: 1 });
  assert.deepEqual(facts.creatorRanking[0], { id: 'creator-a', name: '达人甲', count: 2, knownCents: 12000, unknownAmountCount: 1 });
  assert.deepEqual(facts.trend.map((point) => point.date), ['2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05']);
  assert.equal(facts.trend[0]?.paidCents, 12000);
  assert.equal(facts.trend[2]?.unknownPaidAmountCount, 1);
  assert.equal(facts.trend[3]?.paidLines, 0);
});

test('unavailable refund coverage never turns populated refund payloads into a zero refund claim', () => {
  const base = {
    orders: [order({ id: 'order-a', platform: 'douyin', teamId: 'team-a' })],
    refunds: [refund({ id: 'refund-a', platform: 'douyin', amountCents: 500 })],
    creators: [creator('creator-a', '达人甲', 'douyin-a')],
    teams,
    orderStatus: 'records_only' as const,
    observedAt: '2026-10-14T12:00:00+08:00',
    filters: { platform: 'all' as const, from: '2026-10-01', to: '2026-10-05' },
  };

  const notImported = buildBusinessHomeFacts({ ...base, refundStatus: 'not_imported' });
  const notVisible = buildBusinessHomeFacts({ ...base, refundStatus: 'not_visible' });
  assert.deepEqual(notImported.refund, { status: 'not_imported', count: 0, signedCents: 0, unknownCount: 0 });
  assert.deepEqual(notVisible.refund, { status: 'not_visible', count: 0, signedCents: 0, unknownCount: 0 });
  assert.equal(notImported.trend.reduce((sum, point) => sum + point.refundEvents, 0), 0);
  assert.equal(notVisible.trend.reduce((sum, point) => sum + point.refundEvents, 0), 0);
});

test('ambiguous platform-account-only attribution is excluded from creator ranking instead of duplicated', () => {
  const facts = buildBusinessHomeFacts({
    orders: [order({ id: 'order-a', platform: 'douyin', teamId: 'team-a', creatorId: null, creatorAccountId: 'shared-account' })],
    refunds: [],
    creators: [creator('creator-a', '达人甲', 'shared-account'), creator('creator-b', '达人乙', 'shared-account')],
    teams,
    orderStatus: 'records_only',
    refundStatus: 'records_only',
    observedAt: '2026-10-14T12:00:00+08:00',
    filters: { platform: 'douyin', from: '', to: '' },
  });

  assert.deepEqual(facts.creatorRanking, []);
  assert.equal(facts.ambiguousCreatorOrderCount, 1);
});

test('creator-only imports and duplicate-only batches do not establish an order source; visible order rows do', () => {
  const creatorBatch = { kind: 'creators', acceptedOrders: 0, duplicateOrders: 0 } as ImportBatch;
  const duplicateOrderBatch = { kind: 'orders_and_refunds', acceptedOrders: 0, duplicateOrders: 1 } as ImportBatch;

  assert.equal(getBusinessOrderSourceStatus({ orders: [], importBatches: [creatorBatch], importHistoryVisible: true }), 'not_imported');
  assert.equal(getBusinessOrderSourceStatus({ orders: [], importBatches: [duplicateOrderBatch], importHistoryVisible: true }), 'not_imported');
  assert.equal(getBusinessOrderSourceStatus({ orders: [order({ id: 'visible-order', platform: 'douyin', teamId: 'team-a' })], importBatches: [], importHistoryVisible: false }), 'records_only');
  assert.equal(getBusinessOrderSourceStatus({ orders: [], importBatches: [], importHistoryVisible: false }), 'not_visible');
});

test('no imported order source does not manufacture zero trend points; historical source with an empty filter is a real zero', () => {
  const common = {
    orders: [order({ id: 'historical-order', platform: 'douyin', teamId: 'team-a', paidAt: '2025-09-02T02:00:00.000Z' })],
    refunds: [],
    creators: [creator('creator-a', '达人甲', 'douyin-a')],
    teams,
    refundStatus: 'not_imported' as const,
    observedAt: '2026-10-14T12:00:00+08:00',
    filters: { platform: 'all' as const, from: '2026-10-02', to: '2026-10-04' },
  };
  const historicalSource = buildBusinessHomeFacts({ ...common, orderStatus: 'records_only' });
  const noSource = buildBusinessHomeFacts({ ...common, orders: [], orderStatus: 'not_imported' });

  assert.deepEqual(historicalSource.paid, { status: 'records_only', count: 0, knownCents: 0, unknownCount: 0, complete: true });
  assert.deepEqual(historicalSource.trend.map((point) => point.paidCents), [0, 0, 0]);
  assert.equal(noSource.paid.status, 'not_imported');
  assert.deepEqual(noSource.trend, []);
});

test('orders and refunds after observedAt are excluded from home counts and rankings', () => {
  const facts = buildBusinessHomeFacts({
    orders: [order({ id: 'future-order', platform: 'douyin', teamId: 'team-a', paidAt: '2026-10-14T20:00:00+08:00', paidAmountCents: 1000 })],
    refunds: [refund({ id: 'future-refund', platform: 'douyin', refundedAt: '2026-10-14T20:30:00+08:00', amountCents: 100 })],
    creators: [creator('creator-a', '达人甲', 'douyin-a')],
    teams,
    orderStatus: 'records_only',
    refundStatus: 'records_only',
    observedAt: '2026-10-14T12:00:00+08:00',
    filters: { platform: 'all', from: '2026-10-14', to: '2026-10-14' },
  });

  assert.deepEqual(facts.orders, []);
  assert.deepEqual(facts.refunds, []);
  assert.equal(facts.paid.count, 0);
  assert.equal(facts.teamRanking.length, 0);
});

test('ranking amount distinguishes complete, partial, and entirely unknown amounts', () => {
  assert.deepEqual(getBusinessHomeRankingAmount({ id: 'unknown', name: '未知', count: 1, knownCents: 0, unknownAmountCount: 1 }), { status: 'missing' });
  assert.deepEqual(getBusinessHomeRankingAmount({ id: 'partial', name: '部分', count: 2, knownCents: 1250, unknownAmountCount: 1 }), { status: 'partial', knownCents: 1250, unknownCount: 1 });
  assert.deepEqual(getBusinessHomeRankingAmount({ id: 'partial-zero', name: '部分零', count: 2, knownCents: 0, unknownAmountCount: 1 }), { status: 'partial', knownCents: 0, unknownCount: 1 });
  assert.deepEqual(getBusinessHomeRankingAmount({ id: 'zero', name: '已知零', count: 1, knownCents: 0, unknownAmountCount: 0 }), { status: 'complete', knownCents: 0 });
});
