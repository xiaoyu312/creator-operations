import assert from "node:assert/strict";
import test from "node:test";
import type { DomainState, ImportOrderRow, Product } from "../shared/types.ts";
import { createDemoState } from "../shared/seed.ts";
import { DomainService, type DomainStore } from "../server/domain/domain-service.ts";

const T0 = "2026-10-14T09:00:00+08:00";

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

function product(state: DomainState, id: string, sku: string, teamId = "demo-team-main"): Product {
  const base = state.products[0]!;
  return { ...base, id, sku, teamId, name: `Synthetic ${id}`, brand: `Brand ${teamId}` };
}

function order(overrides: Partial<ImportOrderRow> = {}): ImportOrderRow {
  return {
    rowNumber: 1,
    platform: "channels",
    shopId: "synthetic-shop",
    externalOrderId: "synthetic-order-001",
    externalLineId: "synthetic-line-001",
    productId: null,
    sku: "SYNTH-SKU-001",
    creatorAccountId: null,
    paidAt: T0,
    sourceStatus: "paid",
    status: "paid",
    paidAmountCents: 1000,
    rawAmount: "10.00",
    ...overrides,
  };
}

function commit(batchId: string, orders: ImportOrderRow[]) {
  return {
    type: "import.commit",
    batchId,
    sourceName: "synthetic-native-orders.csv",
    creators: [],
    orders,
    refunds: [],
  } as const;
}

test("native order SKU maps to the unique exact product in its team and remains fingerprint-idempotent", async () => {
  const initial = createDemoState();
  const teamProduct = product(initial, "synthetic-team-product", "SYNTH-SKU-001");
  const otherTeamProduct = product(initial, "synthetic-other-team-product", "SYNTH-SKU-001", "demo-team-other");
  initial.products.push(teamProduct, otherTeamProduct);
  const app = fixture(initial);
  const row = order();

  const first = await app.service.execute({ principalId: "demo:manager" }, commit("sku-match-first", [row]));
  const saved = app.state().orders.find((item) => item.externalOrderId === row.externalOrderId)!;
  assert.equal(saved.productId, teamProduct.id);
  assert.equal(saved.platform, "channels");
  assert.equal((first.result as { errors: number }).errors, 0);
  const savedFingerprint = saved.contentFingerprint;
  const savedOwnerSnapshot = structuredClone(saved.ownerSnapshot);

  const replay = await app.service.execute({ principalId: "demo:manager" }, commit("sku-match-second-batch", [row]));
  assert.equal((replay.result as { duplicates: { orders: number } }).duplicates.orders, 1);
  const afterReplay = app.state().orders.filter((item) => item.externalOrderId === row.externalOrderId);
  assert.equal(afterReplay.length, 1);
  assert.equal(afterReplay[0].contentFingerprint, savedFingerprint);
  assert.deepEqual(afterReplay[0].ownerSnapshot, savedOwnerSnapshot);
});

test("missing, ambiguous, and cross-team SKU matches remain pending without guessing", async () => {
  const initial = createDemoState();
  initial.products.push(
    product(initial, "synthetic-ambiguous-product-a", "SYNTH-DUPLICATE-SKU"),
    product(initial, "synthetic-ambiguous-product-b", "SYNTH-DUPLICATE-SKU"),
    product(initial, "synthetic-foreign-product", "SYNTH-FOREIGN-SKU", "demo-team-other"),
  );
  const app = fixture(initial);
  const rows = [
    order({ rowNumber: 1, externalOrderId: "synthetic-ambiguous-order", externalLineId: "synthetic-ambiguous-line", sku: "SYNTH-DUPLICATE-SKU" }),
    order({ rowNumber: 2, externalOrderId: "synthetic-foreign-order", externalLineId: "synthetic-foreign-line", sku: "SYNTH-FOREIGN-SKU" }),
    order({ rowNumber: 3, externalOrderId: "synthetic-missing-order", externalLineId: "synthetic-missing-line", sku: null }),
  ];

  const imported = await app.service.execute({ principalId: "demo:manager" }, commit("sku-match-unresolved", rows));
  const savedOrders = app.state().orders.filter((item) => rows.some((row) => row.externalOrderId === item.externalOrderId));
  assert.equal(savedOrders.length, 3);
  assert.ok(savedOrders.every((item) => item.productId === null));
  assert.equal((imported.result as { errors: number }).errors, 0);
});

test("explicit productId keeps its current precedence and validation behavior", async () => {
  const initial = createDemoState();
  const matchingSkuProduct = product(initial, "synthetic-sku-product", "SYNTH-SKU-001");
  const explicitlySelectedProduct = product(initial, "synthetic-explicit-product", "OTHER-SKU", "demo-team-other");
  initial.products.push(matchingSkuProduct, explicitlySelectedProduct);
  const app = fixture(initial);
  const rows = [
    order({ rowNumber: 1, externalOrderId: "synthetic-explicit-order", externalLineId: "synthetic-explicit-line", productId: explicitlySelectedProduct.id }),
    order({ rowNumber: 2, externalOrderId: "synthetic-invalid-id-order", externalLineId: "synthetic-invalid-id-line", productId: "missing-product-id" }),
  ];

  await app.service.execute({ principalId: "demo:manager" }, commit("sku-match-explicit-ids", rows));
  const savedOrders = app.state().orders.filter((item) => rows.some((row) => row.externalOrderId === item.externalOrderId));
  assert.equal(savedOrders.find((item) => item.externalOrderId === rows[0].externalOrderId)?.productId, explicitlySelectedProduct.id);
  assert.equal(savedOrders.find((item) => item.externalOrderId === rows[1].externalOrderId)?.productId, null);
});

test("an order linked to another team creator resolves SKU in that order's team", async () => {
  const initial = createDemoState();
  const currentTeamProduct = product(initial, "synthetic-current-team-product", "SYNTH-CROSS-TEAM-SKU");
  const creatorTeamProduct = product(initial, "synthetic-creator-team-product", "SYNTH-CROSS-TEAM-SKU", "demo-team-other");
  initial.products.push(currentTeamProduct, creatorTeamProduct);
  const app = fixture(initial);

  await app.service.execute({ principalId: "demo:admin" }, commit("sku-match-creator-team", [order({
    platform: "douyin",
    creatorAccountId: "DEMO-DY-DELTA-004",
    externalOrderId: "synthetic-creator-team-order",
    externalLineId: "synthetic-creator-team-line",
    sku: "SYNTH-CROSS-TEAM-SKU",
  })]));
  const saved = app.state().orders.find((item) => item.externalOrderId === "synthetic-creator-team-order")!;
  assert.equal(saved.teamId, "demo-team-other");
  assert.equal(saved.productId, creatorTeamProduct.id);
});
