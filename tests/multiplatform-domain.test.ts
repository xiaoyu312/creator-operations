import assert from "node:assert/strict";
import test from "node:test";
import type { Actor, DomainState, ImportOrderRow, ImportRefundRow, Platform } from "../shared/types.ts";
import { PLATFORMS } from "../shared/types.ts";
import { createDemoState } from "../shared/seed.ts";
import { DomainError } from "../server/domain/errors.ts";
import { DomainService, type DomainStore } from "../server/domain/domain-service.ts";

const T0 = "2026-10-14T09:00:00+08:00";
const manager: Actor = { principalId: "demo:manager" };

function fixture(initial: DomainState = createDemoState()) {
  let state = structuredClone(initial);
  let sequence = 0;
  const store: DomainStore = {
    read: async () => structuredClone(state),
    transaction: async <T>(fn: (draft: DomainState) => T | Promise<T>): Promise<T> => {
      const draft = structuredClone(state);
      const result = await fn(draft);
      state = draft;
      return structuredClone(result);
    },
  };
  return {
    service: new DomainService(store, { runtime: { now: () => T0, id: (prefix) => `${prefix}-${++sequence}` } }),
    state: () => state,
  };
}

function result<T>(value: { result: unknown }): T {
  return value.result as T;
}

async function expectDomainError(action: Promise<unknown>, code: DomainError["code"]): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof DomainError);
    assert.equal(error.code, code);
    return true;
  });
}

test("creator identities are unique per platform, while legacy requests still default to Douyin", async () => {
  const app = fixture();
  const creatorIds = new Map<Platform, string>();

  for (const platform of PLATFORMS) {
    const created = result<{ id: string; accounts: Array<{ platform: Platform; externalAccountId: string }> }>(await app.service.execute(manager, {
      type: "creator.create",
      name: `Synthetic ${platform}`,
      platform,
      externalAccountId: "shared-platform-account",
      displayName: `Account ${platform}`,
      source: "synthetic-test",
    }));
    creatorIds.set(platform, created.id);
    assert.equal(created.accounts[0]?.platform, platform);
    assert.equal(created.accounts[0]?.externalAccountId, "shared-platform-account");
  }
  assert.equal(creatorIds.size, 4);
  assert.equal(new Set(creatorIds.values()).size, 4);

  await expectDomainError(app.service.execute(manager, {
    type: "creator.create", name: "Duplicate Douyin", platform: "douyin",
    externalAccountId: "shared-platform-account", displayName: "Duplicate", source: "synthetic-test",
  }), "IDENTITY_CONFLICT");

  const legacy = result<{ id: string; version: number; accounts: Array<{ platform: Platform; externalAccountId: string }> }>(await app.service.execute(manager, {
    type: "creator.create", name: "Legacy creator", externalAccountId: "legacy-account", displayName: "Legacy", source: "synthetic-test",
  }));
  assert.equal(legacy.accounts[0]?.platform, "douyin");

  const secondCreator = result<{ id: string; version: number }>(await app.service.execute(manager, {
    type: "creator.create", name: "Second creator", platform: "douyin",
    externalAccountId: "second-douyin-account", displayName: "Second", source: "synthetic-test",
  }));
  const withNewPlatformAccount = result<{ version: number; accounts: Array<{ platform: Platform; externalAccountId: string }> }>(await app.service.execute(manager, {
    type: "creator.addAccount", creatorId: secondCreator.id, expectedVersion: secondCreator.version,
    platform: "channels", externalAccountId: "new-platform-account", displayName: "Channels account",
  }));
  assert.ok(withNewPlatformAccount.accounts.some((account) => account.platform === "channels" && account.externalAccountId === "new-platform-account"));

  await expectDomainError(app.service.execute(manager, {
    type: "creator.addAccount", creatorId: legacy.id, expectedVersion: legacy.version,
    platform: "channels", externalAccountId: "new-platform-account", displayName: "Duplicate channels account",
  }), "IDENTITY_CONFLICT");

  const withLegacyAccount = result<{ accounts: Array<{ platform: Platform; externalAccountId: string }> }>(await app.service.execute(manager, {
    type: "creator.addAccount", creatorId: legacy.id, expectedVersion: legacy.version,
    externalAccountId: "legacy-added-account", displayName: "Legacy added account",
  }));
  assert.ok(withLegacyAccount.accounts.some((account) => account.platform === "douyin" && account.externalAccountId === "legacy-added-account"));
});

test("creator import and order/refund matching remain platform-scoped and replay idempotently", async () => {
  const app = fixture();
  const creatorIds = new Map<Platform, string>();
  for (const platform of PLATFORMS) {
    const created = result<{ id: string }>(await app.service.execute(manager, {
      type: "creator.create", name: `Import target ${platform}`, platform,
      externalAccountId: "shared-order-account", displayName: `Target ${platform}`, source: "synthetic-test",
    }));
    creatorIds.set(platform, created.id);
  }

  const orders: ImportOrderRow[] = PLATFORMS.map((platform, index) => ({
    rowNumber: index + 1,
    platform,
    shopId: "shared-shop",
    externalOrderId: "shared-order-id",
    externalLineId: "shared-line-id",
    productId: null,
    sku: null,
    creatorAccountId: "shared-order-account",
    paidAt: T0,
    sourceStatus: "paid",
    status: "paid",
    paidAmountCents: 10000,
    rawAmount: "100.00",
  }));
  const refunds: ImportRefundRow[] = PLATFORMS.map((platform, index) => ({
    rowNumber: index + 10,
    platform,
    shopId: "shared-shop",
    externalRefundId: "shared-refund-id",
    externalOrderId: "shared-order-id",
    externalLineId: "shared-line-id",
    refundedAt: "2026-10-14T10:00:00+08:00",
    sourceStatus: "succeeded",
    status: "succeeded",
    amountCents: 1000,
    direction: "refund",
    rawAmount: "10.00",
  }));
  const command = {
    type: "import.commit",
    batchId: "multi-platform-import-batch",
    sourceName: "synthetic-multiplatform.csv",
    orders,
    refunds,
  };

  const committed = result<{ creates: { creators: number; orders: number; refunds: number }; duplicates: { creators: number; orders: number; refunds: number }; errors: number }>(await app.service.execute(manager, command));
  assert.deepEqual(committed.creates, { creators: 0, orders: 4, refunds: 4 });
  assert.deepEqual(committed.duplicates, { creators: 0, orders: 0, refunds: 0 });
  assert.equal(committed.errors, 0);

  const storedOrders = app.state().orders.filter((order) => order.externalOrderId === "shared-order-id");
  assert.equal(storedOrders.length, 4);
  for (const order of storedOrders) assert.equal(order.creatorId, creatorIds.get(order.platform));
  assert.deepEqual(new Set(storedOrders.map((order) => order.platform)), new Set(PLATFORMS));

  const storedRefunds = app.state().refunds.filter((refund) => refund.externalRefundId === "shared-refund-id");
  assert.equal(storedRefunds.length, 4);
  for (const refund of storedRefunds) {
    const linkedOrder = storedOrders.find((order) => order.id === refund.orderLineId);
    assert.equal(linkedOrder?.platform, refund.platform);
  }

  const replay = result<{ creates: { creators: number; orders: number; refunds: number }; duplicates: { creators: number; orders: number; refunds: number } }>(await app.service.execute(manager, command));
  assert.deepEqual(replay.creates, { creators: 0, orders: 4, refunds: 4 }, "replay returns the committed batch summary");
  assert.deepEqual(replay.duplicates, { creators: 0, orders: 0, refunds: 0 });
  assert.equal(app.state().orders.filter((order) => order.externalOrderId === "shared-order-id").length, 4);
  assert.equal(app.state().refunds.filter((refund) => refund.externalRefundId === "shared-refund-id").length, 4);
});
