import assert from 'node:assert/strict';
import test from 'node:test';
import type { Creator, OrderLine, OwnerCorrection, Product, RefundEvent } from '../shared/types.ts';
import { filterOrdersForView, filterRefundsForView } from '../shared/order-view.ts';
import {
  filterOrdersByDateAndPlatform,
  filterRefundsByDateAndPlatform,
  summarizeOrderViewMetrics,
} from '../client/src/lib/order-view.ts';

function order(overrides: Partial<OrderLine> = {}): OrderLine {
  return {
    id: 'order-1', orgId: 'org-1', teamId: 'team-1', platform: 'douyin', shopId: null,
    externalOrderId: 'ext-order-1', externalLineId: 'line-1', productId: null, sku: null,
    creatorAccountId: null, creatorId: null, paidAt: '2026-10-14T10:00:00+08:00',
    sourceStatus: '已支付', status: 'paid', paidAmountCents: 10000, rawAmount: '100.00',
    ownerSnapshot: { memberId: 'member-1', assignedAt: '2026-10-14T10:00:00+08:00', ruleVersion: 'paid_at_owner_v1', reason: 'matched' },
    sourceEvidenceUrl: null, importBatchId: 'batch-1', sourceRowNumber: 2, contentFingerprint: 'fp-1',
    createdAt: '2026-10-14T10:00:00+08:00', createdBy: 'member-1', updatedAt: '2026-10-14T10:00:00+08:00', updatedBy: 'member-1', version: 1,
    ...overrides,
  };
}

function refund(overrides: Partial<RefundEvent> = {}): RefundEvent {
  return {
    id: 'refund-1', orgId: 'org-1', teamId: 'team-1', platform: 'douyin', shopId: null,
    externalRefundId: 'ext-refund-1', orderLineId: 'order-1', refundedAt: '2026-10-14T11:00:00+08:00',
    sourceStatus: '退款成功', status: 'succeeded', amountCents: 2500, direction: 'refund', rawAmount: '25.00',
    sourceEvidenceUrl: null, importBatchId: 'batch-2', sourceRowNumber: 2, contentFingerprint: 'fp-r1',
    createdAt: '2026-10-14T11:00:00+08:00', createdBy: 'member-1', version: 1,
    ...overrides,
  };
}

test('订单和退款按平台及各自日期筛选，日期未知的记录不进入日期范围', () => {
  const orders = [
    order({ id: 'douyin-in-range' }),
    order({ id: 'other-platform', platform: 'xiaohongshu' }),
    order({ id: 'unknown-date', paidAt: null }),
  ];
  const refunds = [
    refund({ id: 'douyin-in-range' }),
    refund({ id: 'other-platform', platform: 'xiaohongshu' }),
    refund({ id: 'unknown-date', refundedAt: null }),
  ];
  const filters = { dateFrom: '2026-10-14', dateTo: '2026-10-14', platform: 'douyin' as const };

  assert.deepEqual(filterOrdersByDateAndPlatform(orders, filters).map((item) => item.id), ['douyin-in-range']);
  assert.deepEqual(filterRefundsByDateAndPlatform(refunds, filters).map((item) => item.id), ['douyin-in-range']);
  assert.deepEqual(filterOrdersByDateAndPlatform(orders, { ...filters, dateFrom: '', dateTo: '' }).map((item) => item.id), ['douyin-in-range', 'unknown-date']);
});

test('金额未知会保留为待补充状态，不并入已知金额小计', () => {
  const orders = [order({ id: 'known', paidAmountCents: 1250 }), order({ id: 'unknown', paidAmountCents: null })];
  const summary = summarizeOrderViewMetrics({
    orders,
    visibleRefunds: [],
    allRefunds: [],
    orderSourceAvailable: true,
    refundSourceAvailable: true,
    observedAt: '2026-10-15T00:00:00+08:00',
    getOrderOwner: (item) => item.ownerSnapshot.memberId,
  });

  assert.equal(summary.paidOrders.count, 2);
  assert.deepEqual(summary.paidOrders.amount, { knownCents: 1250, unknownCount: 1, complete: false });
  assert.deepEqual(summary.netPaidCohort.amount, { knownCents: 1250, unknownCount: 1, complete: false });
  assert.equal(summary.refunds.count, 0);
});

test('订单和退款指标共用 observedAt 截止，排除同日尚未发生的记录', () => {
  const summary = summarizeOrderViewMetrics({
    orders: [order({ id: 'before-cutoff', paidAt: '2026-10-14T11:00:00+08:00' }), order({ id: 'after-cutoff', paidAt: '2026-10-14T20:00:00+08:00' })],
    visibleRefunds: [refund({ id: 'after-cutoff-refund', refundedAt: '2026-10-14T20:30:00+08:00' })],
    allRefunds: [],
    orderSourceAvailable: true,
    refundSourceAvailable: true,
    observedAt: '2026-10-14T12:00:00+08:00',
    getOrderOwner: (item) => item.ownerSnapshot.memberId,
  });

  assert.equal(summary.paidOrders.count, 1);
  assert.equal(summary.refunds.count, 0);
});

test('退款卡按退款日期统计，退款后金额按订单支付 cohort 累计所有成功退款和冲正', () => {
  const orders = [order({ id: 'first', paidAmountCents: 10000 }), order({ id: 'second', paidAmountCents: 3000 })];
  const allRefunds = [
    refund({ id: 'in-range-refund', orderLineId: 'first', amountCents: 2500, refundedAt: '2026-10-14T12:00:00+08:00' }),
    refund({ id: 'later-reversal', orderLineId: 'first', amountCents: 500, direction: 'reversal', refundedAt: '2026-10-20T12:00:00+08:00' }),
    refund({ id: 'later-refund', orderLineId: 'second', amountCents: 1000, refundedAt: '2026-10-20T13:00:00+08:00' }),
  ];
  const visibleRefunds = filterRefundsByDateAndPlatform(allRefunds, {
    dateFrom: '2026-10-14', dateTo: '2026-10-14', platform: 'all',
  });
  const summary = summarizeOrderViewMetrics({
    orders,
    visibleRefunds,
    allRefunds,
    orderSourceAvailable: true,
    refundSourceAvailable: true,
    observedAt: '2026-10-21T00:00:00+08:00',
    getOrderOwner: (item) => item.ownerSnapshot.memberId,
  });

  assert.equal(summary.refunds.count, 1);
  assert.equal(summary.refunds.amount?.knownCents, 2500);
  assert.equal(summary.netPaidCohort.amount?.knownCents, 10000);
  assert.equal(summary.netPaidCohort.amount?.complete, true);
});

test('列表筛选同时匹配商品名、平台、达人和更正后的负责人', () => {
  const creator = {
    id: 'creator-a', name: '达人甲', mergedIntoCreatorId: null,
    accounts: [{ platform: 'channels', externalAccountId: 'account-a', displayName: '频道甲' }],
  } as unknown as Creator;
  const products = [{ id: 'product-a', name: 'SyntheticProductName' }] as unknown as Product[];
  const corrections = [{ id: 'correction-a', orderLineId: 'target', correctedMemberId: 'owner-new', recordedAt: '2026-10-14T12:00:00+08:00' }] as unknown as OwnerCorrection[];
  const orders = [
    order({ id: 'target', teamId: 'team-a', platform: 'channels', creatorId: 'creator-a', creatorAccountId: 'account-a', productId: 'product-a', ownerSnapshot: { memberId: 'owner-old', assignedAt: null, ruleVersion: 'paid_at_owner_v1', reason: 'matched' } }),
    order({ id: 'wrong-platform', teamId: 'team-a', platform: 'douyin', productId: 'product-a' }),
    order({ id: 'wrong-owner', teamId: 'team-a', platform: 'channels', productId: 'product-a' }),
  ];
  const context = { creators: [creator], products, ownerCorrections: corrections };
  const filters = {
    dateFrom: '2026-10-14', dateTo: '2026-10-14', platform: 'channels' as const,
    teamId: 'team-a', ownerMemberId: 'owner-new', creatorId: 'creator-a', search: 'SyntheticProductName',
  };

  assert.deepEqual(filterOrdersForView(orders, filters, context).map((item) => item.id), ['target']);
  assert.deepEqual(filterOrdersForView(orders, { ...filters, search: 'unmatched-name' }, context), []);
});

test('退款列表筛选复用平台、日期、达人、负责人和退款号搜索', () => {
  const creator = {
    id: 'creator-a', name: '达人甲', mergedIntoCreatorId: null,
    accounts: [{ platform: 'douyin', externalAccountId: 'account-a', displayName: '抖音甲' }],
  } as unknown as Creator;
  const orders = [order({ id: 'order-1', creatorId: 'creator-a', creatorAccountId: 'account-a', ownerSnapshot: { memberId: 'owner-a', assignedAt: null, ruleVersion: 'paid_at_owner_v1', reason: 'matched' } })];
  const refunds = [refund({ id: 'refund-target', externalRefundId: 'refund-target', orderLineId: 'order-1' }), refund({ id: 'refund-outside', externalRefundId: 'refund-outside', orderLineId: 'order-1', refundedAt: '2026-10-13T11:00:00+08:00' })];
  const filters = { dateFrom: '2026-10-14', dateTo: '2026-10-14', platform: 'douyin' as const, creatorId: 'creator-a', ownerMemberId: 'owner-a', search: 'refund-target' };

  assert.deepEqual(filterRefundsForView(refunds, orders, filters, { creators: [creator], products: [], ownerCorrections: [] }).map((item) => item.id), ['refund-target']);
});
