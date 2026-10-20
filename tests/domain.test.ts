import assert from "node:assert/strict";
import test from "node:test";
import type { Actor, DomainState, IsoDateTime } from "../shared/types.ts";
import { createDemoState } from "../shared/seed.ts";
import { DomainService, type DomainStore } from "../server/domain/domain-service.ts";
import { calculateMetrics } from "../server/domain/metrics.ts";
import { DomainError } from "../server/domain/errors.ts";

const T0 = "2026-10-13T09:00:00+08:00";

function fixture(initial: DomainState = createDemoState()) {
  let state = structuredClone(initial);
  let sequence = 0;
  let now = T0;
  const store: DomainStore = {
    read: async () => structuredClone(state),
    transaction: async <T>(fn: (draft: DomainState) => T | Promise<T>): Promise<T> => {
      const draft = structuredClone(state);
      const result = await fn(draft);
      state = draft;
      return structuredClone(result);
    },
  };
  const service = new DomainService(store, { runtime: { now: () => now, id: (prefix) => `${prefix}-${++sequence}` } });
  return {
    service,
    state: () => state,
    setNow: (value: IsoDateTime) => { now = value; },
    actor: (profile: "admin" | "manager" | "bd-a" | "bd-b" | "ops" | "other-team-bd"): Actor => ({ principalId: `demo:${profile}` }),
  };
}

function result<T>(value: { result: unknown }): T {
  return value.result as T;
}

async function expectDomainError(action: Promise<unknown>, code: DomainError["code"]): Promise<DomainError> {
  const caught: { error: DomainError | null } = { error: null };
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof DomainError);
    caught.error = error;
    return true;
  });
  assert.ok(caught.error);
  assert.equal(caught.error.code, code);
  return caught.error;
}

test("生产授权只消费可信平台角色，数据库角色值不能升级调用者", async () => {
  const state = createDemoState();
  state.dataMode = "production";
  const bdA = state.members.find((member) => member.id === "demo-member-bd-a")!;
  bdA.role = "admin";
  bdA.capabilities = ["sample.approve", "sample.fulfill", "cooperation.approve", "import.manage", "audit.read", "export.run"];
  state.members.filter((member) => member.id !== bdA.id).forEach((member) => { member.role = null; member.capabilities = null; });
  const { service } = fixture(state);

  await expectDomainError(service.getWorkspace({ principalId: bdA.principalId }), "UNAUTHENTICATED");
  await expectDomainError(service.getWorkspace({ principalId: bdA.principalId, platformAccess: { role: null, capabilities: [], sourceRoleState: "present" } }), "FORBIDDEN");

  const workspace = await service.getWorkspace({ principalId: bdA.principalId, platformAccess: { role: "bd", capabilities: [], sourceRoleState: "present" } });
  assert.equal(workspace.actor.role, "bd");
  assert.equal(workspace.scope.canManageMembers, false);
  assert.ok(workspace.creators.some((creator) => creator.id === "demo-creator-a"));
  assert.ok(!workspace.creators.some((creator) => creator.id === "demo-creator-other"));
});

test("公海档案的备注、负责人历史和审计摘要不泄露给普通商务", async () => {
  const app = fixture();
  await app.service.execute(app.actor("manager"), {
    type: "creator.update", creatorId: "demo-creator-public", expectedVersion: 1,
    internalNote: "公海内部备注-不应泄露", contact: { phone: "不提供真实号码" },
  });

  const bdWorkspace = await app.service.getWorkspace(app.actor("bd-a"));
  const publicCreator = bdWorkspace.creators.find((creator) => creator.id === "demo-creator-public");
  assert.ok(publicCreator);
  assert.equal(publicCreator.internalNote, null);
  assert.equal(publicCreator.contact, null);
  assert.ok(!bdWorkspace.ownerAssignments.some((item) => item.creatorId === publicCreator.id));
  assert.ok(!bdWorkspace.auditEvents.some((item) => item.entityId === publicCreator.id));
  assert.ok(!Object.hasOwn(bdWorkspace, "creatorStageEvents"));
  assert.ok(!bdWorkspace.followups.some((item) => item.creatorId === publicCreator.id));
  assert.ok(!bdWorkspace.creators.some((creator) => creator.id === "demo-creator-b"));

  const managerWorkspace = await app.service.getWorkspace(app.actor("manager"));
  const publicAudit = managerWorkspace.auditEvents.find((item) => item.entityId === publicCreator.id && item.action === "creator.updated");
  assert.ok(publicAudit);
  assert.ok(!JSON.stringify(publicAudit).includes("公海内部备注-不应泄露"));
  assert.ok(!JSON.stringify(publicAudit).includes("不提供真实号码"));
});

test("公海认领写入负责人有效期，陈旧版本和重复稳定账号会被拒绝", async () => {
  const app = fixture();
  const claimed = result<{ ownerMemberId: string; version: number }>(await app.service.execute(app.actor("bd-a"), {
    type: "creator.claim", creatorId: "demo-creator-public", expectedVersion: 1,
  }));
  assert.equal(claimed.ownerMemberId, "demo-member-bd-a");
  assert.equal(claimed.version, 2);
  const intervals = app.state().ownerAssignments.filter((item) => item.creatorId === "demo-creator-public").sort((a, b) => a.validFrom.localeCompare(b.validFrom));
  assert.equal(intervals.length, 2);
  assert.equal(intervals[0].memberId, null);
  assert.equal(intervals[0].validTo, T0);
  assert.equal(intervals[1].memberId, "demo-member-bd-a");
  assert.equal(intervals[1].validTo, null);

  await expectDomainError(app.service.execute(app.actor("bd-b"), { type: "creator.claim", creatorId: "demo-creator-public", expectedVersion: 1 }), "NOT_FOUND");
  await expectDomainError(app.service.execute(app.actor("bd-a"), {
    type: "creator.create", name: "虚构达人·重复 ID", externalAccountId: "DEMO-DY-ALPHA-001",
    displayName: "重复账号", makePublic: false,
  }), "IDENTITY_CONFLICT");
});

test("样品申请分批发货和签收时，不会在数量未齐前提前完成", async () => {
  const app = fixture();
  app.state().members.find((member) => member.id === "demo-member-bd-a")!.capabilities = ["sample.approve"];
  const sample = result<{ id: string; version: number; status: string }>(await app.service.execute(app.actor("bd-a"), {
    type: "sample.create", creatorId: "demo-creator-a", expectedCreatorVersion: 1,
    lines: [{ productId: "demo-product-a", quantity: 2 }],
    recipient: { recipientName: "演示收件人", phone: null, address: "演示地址-仅用于测试" },
    reason: "合成测试样品申请",
  }));
  const submitted = result<{ id: string; version: number }>(await app.service.execute(app.actor("bd-a"), {
    type: "sample.submit", sampleId: sample.id, expectedVersion: sample.version, submittedAt: T0,
  }));
  await expectDomainError(app.service.execute(app.actor("bd-a"), {
    type: "sample.decide", sampleId: sample.id, expectedVersion: submitted.version, decision: "approved", decidedAt: T0,
  }), "FORBIDDEN");

  const approved = result<{ id: string; version: number }>(await app.service.execute(app.actor("manager"), {
    type: "sample.decide", sampleId: sample.id, expectedVersion: submitted.version, decision: "approved", decidedAt: T0,
  }));
  const firstPackage = result<{ id: string; version: number }>(await app.service.execute(app.actor("ops"), {
    type: "sample.addPackage", sampleId: sample.id, expectedVersion: approved.version,
    carrier: "演示物流", trackingNumber: "DEMO-TRACK-001", lines: [{ sampleLineId: app.state().samples.find((item) => item.id === sample.id)!.lines[0].id, productId: "demo-product-a", quantity: 1 }], shippedAt: T0,
  }));
  let current = app.state().samples.find((item) => item.id === sample.id)!;
  assert.equal(current.status, "shipped");
  current = result<typeof current>(await app.service.execute(app.actor("ops"), {
    type: "sample.confirmReceipt", sampleId: sample.id, expectedSampleVersion: current.version,
    packageId: firstPackage.id, expectedPackageVersion: firstPackage.version,
    receivedAt: "2026-10-13T10:00:00+08:00",
  }));
  assert.equal(current.status, "shipped", "只签收了一件，整张申请仍待后续包裹");

  const lineId = current.lines[0].id;
  const secondPackage = result<{ id: string; version: number }>(await app.service.execute(app.actor("ops"), {
    type: "sample.addPackage", sampleId: sample.id, expectedVersion: current.version,
    carrier: "演示物流", trackingNumber: "DEMO-TRACK-002", lines: [{ sampleLineId: lineId, productId: "demo-product-a", quantity: 1 }], shippedAt: "2026-10-13T11:00:00+08:00",
  }));
  current = app.state().samples.find((item) => item.id === sample.id)!;
  current = result<typeof current>(await app.service.execute(app.actor("ops"), {
    type: "sample.confirmReceipt", sampleId: sample.id, expectedSampleVersion: current.version,
    packageId: secondPackage.id, expectedPackageVersion: secondPackage.version,
    receivedAt: "2026-10-13T12:00:00+08:00",
  }));
  assert.equal(current.status, "received");
});

test("多商品合作的首个交付通过验收不会结束合作，全部必需交付通过后才结束", async () => {
  const app = fixture();
  const cooperation = result<{ id: string; version: number }>(await app.service.execute(app.actor("bd-a"), {
    type: "cooperation.create", creatorId: "demo-creator-a", expectedCreatorVersion: 1,
    title: "合成双商品合作", sampleRequirement: "none", deliveryRequirement: "两个商品各交付一条直播复盘凭证",
    lines: [
      { productId: "demo-product-a", productName: "演示收纳盒 A", deliveryRequirement: "直播交付" },
      { productId: "demo-product-a", productName: "演示收纳盒 B", deliveryRequirement: "直播交付" },
    ],
  }));
  const submitted = result<{ id: string; version: number }>(await app.service.execute(app.actor("bd-a"), {
    type: "cooperation.submit", cooperationId: cooperation.id, expectedVersion: cooperation.version, submittedAt: T0,
  }));
  const approved = result<{ id: string; version: number; status: string }>(await app.service.execute(app.actor("manager"), {
    type: "cooperation.decide", cooperationId: cooperation.id, expectedVersion: submitted.version, decision: "approved", decidedAt: T0,
  }));
  assert.equal(approved.status, "pending_delivery");
  const schedule = result<{ id: string; version: number; history: unknown[] }>(await app.service.execute(app.actor("bd-a"), {
    type: "schedule.create", cooperationId: cooperation.id, expectedCooperationVersion: approved.version,
    title: "演示直播排期", platform: "douyin", plannedStartAt: "2026-10-14T20:00:00+08:00", plannedEndAt: "2026-10-14T22:00:00+08:00",
  }));
  const rescheduled = result<typeof schedule>(await app.service.execute(app.actor("bd-a"), {
    type: "schedule.reschedule", scheduleId: schedule.id, expectedVersion: schedule.version,
    plannedStartAt: "2026-10-15T20:00:00+08:00", plannedEndAt: "2026-10-15T22:00:00+08:00", changedAt: "2026-10-13T10:00:00+08:00", reason: "演示改期",
  }));
  assert.equal(rescheduled.history.length, 1);

  let coopVersion = app.state().cooperations.find((item) => item.id === cooperation.id)!.version;
  const first = result<{ id: string; version: number }>(await app.service.execute(app.actor("bd-a"), {
    type: "delivery.create", cooperationId: cooperation.id, expectedCooperationVersion: coopVersion,
    cooperationLineId: app.state().cooperations.find((item) => item.id === cooperation.id)!.lines[0].id,
    deliveryType: "live", title: "交付 A", dueAt: "2026-10-16T23:59:00+08:00", required: true,
  }));
  coopVersion = app.state().cooperations.find((item) => item.id === cooperation.id)!.version;
  const second = result<{ id: string; version: number }>(await app.service.execute(app.actor("bd-a"), {
    type: "delivery.create", cooperationId: cooperation.id, expectedCooperationVersion: coopVersion,
    cooperationLineId: app.state().cooperations.find((item) => item.id === cooperation.id)!.lines[1].id,
    deliveryType: "live", title: "交付 B", dueAt: "2026-10-16T23:59:00+08:00", required: true,
  }));
  const firstSubmitted = result<{ id: string; version: number }>(await app.service.execute(app.actor("bd-a"), {
    type: "delivery.submit", deliveryId: first.id, expectedVersion: first.version, submittedAt: "2026-10-15T12:00:00+08:00", contentUrl: "https://example.invalid/demo-a",
  }));
  const firstApproved = result<{ id: string; version: number; status: string }>(await app.service.execute(app.actor("manager"), {
    type: "delivery.review", deliveryId: first.id, expectedVersion: firstSubmitted.version, decision: "approved", reviewedAt: "2026-10-15T13:00:00+08:00",
  }));
  assert.equal(firstApproved.status, "approved");
  assert.equal(app.state().cooperations.find((item) => item.id === cooperation.id)!.status, "pending_delivery");

  const secondSubmitted = result<{ id: string; version: number }>(await app.service.execute(app.actor("bd-a"), {
    type: "delivery.submit", deliveryId: second.id, expectedVersion: second.version, submittedAt: "2026-10-15T14:00:00+08:00", contentUrl: "https://example.invalid/demo-b",
  }));
  await app.service.execute(app.actor("manager"), {
    type: "delivery.review", deliveryId: second.id, expectedVersion: secondSubmitted.version, decision: "approved", reviewedAt: "2026-10-15T15:00:00+08:00",
  });
  assert.equal(app.state().cooperations.find((item) => item.id === cooperation.id)!.status, "delivered");
});

test("订单导入重放不重复计数，退款按分计算，负责人交接不改写历史快照", async () => {
  const app = fixture();
  const order = {
    rowNumber: 1, shopId: "DEMO-SHOP", externalOrderId: "DEMO-ORDER-1", externalLineId: "DEMO-LINE-1",
    productId: null, sku: "DEMO-SKU-001", creatorAccountId: "DEMO-DY-ALPHA-001",
    paidAt: "2026-10-13T10:00:00+08:00", sourceStatus: "已支付", status: "paid" as const,
    paidAmountCents: 10000, rawAmount: "100.00",
  };
  const refund = {
    rowNumber: 2, shopId: "DEMO-SHOP", externalRefundId: "DEMO-REFUND-1", externalOrderId: "DEMO-ORDER-1", externalLineId: "DEMO-LINE-1",
    refundedAt: "2026-10-13T11:00:00+08:00", sourceStatus: "退款成功", status: "succeeded" as const,
    amountCents: 3000, direction: "refund" as const, rawAmount: "30.00",
  };
  const firstImport = { type: "import.commit", batchId: "demo-batch-1", sourceName: "orders-demo.csv", orders: [order], refunds: [refund] };
  const committed = result<{ creates: { orders: number; refunds: number }; duplicates: { orders: number; refunds: number } }>(await app.service.execute(app.actor("manager"), firstImport));
  assert.deepEqual(committed.creates, { creators: 0, orders: 1, refunds: 1 });
  const replay = result<{ creates: { orders: number; refunds: number }; duplicates: { orders: number; refunds: number } }>(await app.service.execute(app.actor("manager"), {
    ...firstImport, batchId: "demo-batch-2",
  }));
  assert.deepEqual(replay.creates, { creators: 0, orders: 0, refunds: 0 });
  assert.deepEqual(replay.duplicates, { creators: 0, orders: 1, refunds: 1 });

  const importedOrder = app.state().orders.find((item) => item.externalOrderId === "DEMO-ORDER-1")!;
  assert.equal(importedOrder.ownerSnapshot.memberId, "demo-member-bd-a");
  app.setNow("2026-10-13T13:00:00+08:00");
  const transferred = result<{ ownerMemberId: string; version: number }>(await app.service.execute(app.actor("manager"), {
    type: "creator.transfer", creatorId: "demo-creator-a", targetMemberId: "demo-member-bd-b", expectedVersion: 1,
    effectiveAt: "2026-10-13T12:00:00+08:00", reason: "合成团队交接",
  }));
  assert.equal(transferred.ownerMemberId, "demo-member-bd-b");
  assert.equal(app.state().orders.find((item) => item.id === importedOrder.id)!.ownerSnapshot.memberId, "demo-member-bd-a");

  const secondOrder = { ...order, rowNumber: 3, externalOrderId: "DEMO-ORDER-2", externalLineId: "DEMO-LINE-2", paidAt: "2026-10-13T13:00:00+08:00" };
  await app.service.execute(app.actor("manager"), {
    type: "import.commit", batchId: "demo-batch-3", sourceName: "order-after-handoff.csv", orders: [secondOrder], refunds: [],
  });
  const afterTransferOrder = app.state().orders.find((item) => item.externalOrderId === "DEMO-ORDER-2")!;
  assert.equal(afterTransferOrder.ownerSnapshot.memberId, "demo-member-bd-b");

  const bdA = await app.service.getWorkspace(app.actor("bd-a"), { dateFrom: "2026-10-13", dateTo: "2026-10-13" });
  assert.equal(bdA.metrics.netPaidCohort.amount.knownCents, 7000);
  const manager = await app.service.getWorkspace(app.actor("manager"), { dateFrom: "2026-10-13", dateTo: "2026-10-13" });
  assert.equal(manager.metrics.paidOrders.count, 2);
  assert.equal(manager.metrics.paidOrders.amount.knownCents, 20000);
  assert.equal(manager.metrics.refunds.amount, 3000);
  assert.equal(manager.metrics.netPaidCohort.amount.knownCents, 17000);
});

test("主管导入对外团队达人、订单或退款一律返回同一范围错误，且不产生业务行", async () => {
  const app = fixture();
  const bOrder = {
    rowNumber: 1, shopId: "DEMO-SHOP-B", externalOrderId: "DEMO-B-ORDER-1", externalLineId: "DEMO-B-LINE-1",
    productId: null, sku: "DEMO-B-SKU", creatorAccountId: "DEMO-DY-DELTA-004",
    paidAt: "2026-10-13T10:00:00+08:00", sourceStatus: "已支付", status: "paid" as const,
    paidAmountCents: 8000, rawAmount: "80.00",
  };
  await app.service.execute(app.actor("admin"), {
    type: "import.commit", batchId: "admin-team-b-order", sourceName: "synthetic-b-order.csv", orders: [bOrder], refunds: [],
  });
  const countsBefore = { creators: app.state().creators.length, orders: app.state().orders.length, refunds: app.state().refunds.length };
  const input = {
    type: "import.preview", batchId: "manager-a-cross-team", sourceName: "synthetic-cross-team.csv",
    creators: [{
      rowNumber: 1, platform: "douyin" as const, externalAccountId: "DEMO-DY-DELTA-004", name: "虚构达人·远山露营社",
      displayName: "远山露营社（演示）", profileUrl: null, category: "户外", tags: ["露营"], source: "合成演示数据", contact: null,
    }],
    orders: [bOrder],
    refunds: [{
      rowNumber: 2, shopId: "DEMO-SHOP-B", externalRefundId: "DEMO-B-REFUND-1", externalOrderId: "DEMO-B-ORDER-1", externalLineId: "DEMO-B-LINE-1",
      refundedAt: "2026-10-13T11:00:00+08:00", sourceStatus: "退款成功", status: "succeeded" as const,
      amountCents: 1000, direction: "refund" as const, rawAmount: "10.00",
    }],
  };
  const preview = result<{ issues: Array<{ entity: string; code: string; message: string; existingId: string | null }>; creates: { creators: number; orders: number; refunds: number } }>(await app.service.execute(app.actor("manager"), input));
  assert.deepEqual(preview.creates, { creators: 0, orders: 0, refunds: 0 });
  assert.equal(preview.issues.length, 3);
  assert.ok(preview.issues.every((issue) => issue.code === "invalid_row" && issue.existingId === null));
  assert.equal(new Set(preview.issues.map((issue) => issue.message)).size, 1);

  const commit = result<{ creates: { creators: number; orders: number; refunds: number }; errors: number }>(await app.service.execute(app.actor("manager"), { ...input, type: "import.commit" }));
  assert.deepEqual(commit.creates, { creators: 0, orders: 0, refunds: 0 });
  assert.equal(commit.errors, 3);
  assert.deepEqual({ creators: app.state().creators.length, orders: app.state().orders.length, refunds: app.state().refunds.length }, countsBefore);
});

test("退款冲正按退款时间顺序校验，不能超额或借用未来退款，合法冲正净额回到实付", async () => {
  const app = fixture();
  const order = {
    rowNumber: 1, shopId: "DEMO-SHOP", externalOrderId: "DEMO-REVERSAL-ORDER", externalLineId: "DEMO-REVERSAL-LINE",
    productId: null, sku: "DEMO-SKU-001", creatorAccountId: "DEMO-DY-ALPHA-001",
    paidAt: "2026-10-13T09:00:00+08:00", sourceStatus: "已支付", status: "paid" as const,
    paidAmountCents: 10000, rawAmount: "100.00",
  };
  await app.service.execute(app.actor("manager"), {
    type: "import.commit", batchId: "reversal-order", sourceName: "reversal-order.csv", orders: [order], refunds: [],
  });
  const earlyReversal = {
    rowNumber: 1, shopId: "DEMO-SHOP", externalRefundId: "REVERSAL-EARLY", externalOrderId: order.externalOrderId, externalLineId: order.externalLineId,
    refundedAt: "2026-10-13T10:00:00+08:00", sourceStatus: "退款冲正", status: "succeeded" as const,
    amountCents: 3000, direction: "reversal" as const, rawAmount: "30.00",
  };
  const earlyPreview = result<{ issues: Array<{ code: string }> }>(await app.service.execute(app.actor("manager"), {
    type: "import.preview", batchId: "reversal-before-refund", sourceName: "reversal.csv", orders: [], refunds: [earlyReversal],
  }));
  assert.equal(earlyPreview.issues[0]?.code, "refund_reversal_exceeds_refund");

  const refund = {
    ...earlyReversal, externalRefundId: "REFUND-30", refundedAt: "2026-10-13T11:00:00+08:00", sourceStatus: "退款成功", direction: "refund" as const,
  };
  await app.service.execute(app.actor("manager"), {
    type: "import.commit", batchId: "reversal-prior-refund", sourceName: "refund.csv", orders: [], refunds: [refund],
  });
  const validReversal = { ...earlyReversal, externalRefundId: "REVERSAL-30", refundedAt: "2026-10-13T12:00:00+08:00" };
  const validCommit = result<{ creates: { refunds: number }; errors: number }>(await app.service.execute(app.actor("manager"), {
    type: "import.commit", batchId: "reversal-valid", sourceName: "reversal.csv", orders: [], refunds: [validReversal],
  }));
  assert.equal(validCommit.creates.refunds, 1);
  assert.equal(validCommit.errors, 0);

  const duplicate = result<{ creates: { refunds: number }; duplicates: { refunds: number } }>(await app.service.execute(app.actor("manager"), {
    type: "import.commit", batchId: "reversal-replay", sourceName: "reversal.csv", orders: [], refunds: [validReversal],
  }));
  assert.equal(duplicate.creates.refunds, 0);
  assert.equal(duplicate.duplicates.refunds, 1);
  const overReversal = { ...validReversal, externalRefundId: "REVERSAL-OVER", refundedAt: "2026-10-13T13:00:00+08:00", amountCents: 3001 };
  const over = result<{ issues: Array<{ code: string }> }>(await app.service.execute(app.actor("manager"), {
    type: "import.preview", batchId: "reversal-over", sourceName: "reversal.csv", orders: [], refunds: [overReversal],
  }));
  assert.equal(over.issues[0]?.code, "refund_reversal_exceeds_refund");

  const workspace = await app.service.getWorkspace(app.actor("manager"), { dateFrom: "2026-10-13", dateTo: "2026-10-13" });
  assert.equal(workspace.metrics.netPaidCohort.amount.knownCents, 10000);
  assert.equal(workspace.metrics.refunds.amount, 0);
  assert.equal(app.state().refunds.length, 2, "重复冲正没有新增事件");
});

test("订单归属更正拒绝未来时间并按记录时间确定当前更正，不改原归属快照", async () => {
  const app = fixture();
  const orderRow = {
    rowNumber: 1, shopId: "DEMO-SHOP", externalOrderId: "DEMO-CORRECTION-ORDER", externalLineId: "DEMO-CORRECTION-LINE",
    productId: null, sku: "DEMO-SKU-001", creatorAccountId: "DEMO-DY-ALPHA-001",
    paidAt: "2026-10-13T10:00:00+08:00", sourceStatus: "已支付", status: "paid" as const,
    paidAmountCents: 5000, rawAmount: "50.00",
  };
  await app.service.execute(app.actor("manager"), { type: "import.commit", batchId: "correction-order", sourceName: "order.csv", orders: [orderRow], refunds: [] });
  const orderId = app.state().orders[0].id;
  await expectDomainError(app.service.execute(app.actor("manager"), {
    type: "order.correctOwner", orderLineId: orderId, expectedVersion: 1, correctedMemberId: "demo-member-bd-b",
    correctedAt: "2026-10-13T12:00:00+08:00", reason: "未来日期不应生效",
  }), "BUSINESS_RULE_VIOLATION");

  app.setNow("2026-10-13T11:00:00+08:00");
  await app.service.execute(app.actor("manager"), {
    type: "order.correctOwner", orderLineId: orderId, expectedVersion: 1, correctedMemberId: "demo-member-bd-b",
    correctedAt: "2026-10-13T10:30:00+08:00", reason: "核对后更正到商务乙",
  });
  await expectDomainError(app.service.execute(app.actor("manager"), {
    type: "order.correctOwner", orderLineId: orderId, expectedVersion: 1, correctedMemberId: "demo-member-bd-a",
    correctedAt: "2026-10-13T10:15:00+08:00", reason: "陈旧版本不能覆盖",
  }), "VERSION_CONFLICT");

  app.setNow("2026-10-13T11:30:00+08:00");
  await app.service.execute(app.actor("manager"), {
    type: "order.correctOwner", orderLineId: orderId, expectedVersion: 2, correctedMemberId: "demo-member-bd-a",
    correctedAt: "2026-10-13T10:15:00+08:00", reason: "后录入的核对结果优先",
  });
  assert.equal(app.state().orders[0].ownerSnapshot.memberId, "demo-member-bd-a");
  assert.equal(app.state().ownerCorrections.length, 2);
  const manager = await app.service.getWorkspace(app.actor("manager"), { dateFrom: "2026-10-13", dateTo: "2026-10-13" });
  assert.equal(manager.orders[0].version, 3);
  const bdA = await app.service.getWorkspace(app.actor("bd-a"), { dateFrom: "2026-10-13", dateTo: "2026-10-13" });
  assert.equal(bdA.orders.length, 1);
  const bdB = await app.service.getWorkspace(app.actor("bd-b"), { dateFrom: "2026-10-13", dateTo: "2026-10-13" });
  assert.equal(bdB.orders.length, 0);
});

test("订单来源核对允许待确认状态定稿，且成功退款只能关联已支付订单", async () => {
  const app = fixture();
  const pendingOrder = {
    rowNumber: 1, shopId: "DEMO-SHOP", externalOrderId: "RECONCILE-PENDING", externalLineId: "RECONCILE-LINE",
    productId: null, sku: "DEMO-SKU-001", creatorAccountId: "DEMO-DY-ALPHA-001",
    paidAt: null, sourceStatus: "待确认", status: "pending" as const, paidAmountCents: null, rawAmount: null,
  };
  const closedOrder = { ...pendingOrder, rowNumber: 2, externalOrderId: "RECONCILE-CLOSED", externalLineId: "RECONCILE-CLOSED-LINE", creatorAccountId: null, status: "unknown" as const };
  const pendingRefund = {
    rowNumber: 3, shopId: "DEMO-SHOP", externalRefundId: "RECONCILE-REFUND", externalOrderId: pendingOrder.externalOrderId, externalLineId: pendingOrder.externalLineId,
    refundedAt: "2026-10-13T11:00:00+08:00", sourceStatus: "退款处理中", status: "pending" as const,
    amountCents: null, direction: "refund" as const, rawAmount: null,
  };
  const rejectedSuccessImport = result<{ issues: Array<{ entity: string; code: string }>; creates: { refunds: number } }>(await app.service.execute(app.actor("manager"), {
    type: "import.commit", batchId: "reconcile-pending-import", sourceName: "pending-order.csv", orders: [pendingOrder],
    refunds: [{ ...pendingRefund, externalRefundId: "PREMATURE-SUCCESS", status: "succeeded" as const, amountCents: 1000, sourceStatus: "退款成功" }],
  }));
  assert.equal(rejectedSuccessImport.issues.some((issue) => issue.entity === "refund" && issue.code === "invalid_row"), true);
  assert.equal(rejectedSuccessImport.creates.refunds, 0);
  assert.equal(app.state().refunds.length, 0);

  await app.service.execute(app.actor("manager"), {
    type: "import.commit", batchId: "reconcile-pending-refund", sourceName: "pending-refund.csv", orders: [pendingOrder, closedOrder], refunds: [pendingRefund],
  });
  const pendingOrderId = app.state().orders.find((item) => item.externalOrderId === pendingOrder.externalOrderId)!.id;
  const closedOrderId = app.state().orders.find((item) => item.externalOrderId === closedOrder.externalOrderId)!.id;
  const refundId = app.state().refunds.find((item) => item.externalRefundId === pendingRefund.externalRefundId)!.id;
  app.setNow("2026-10-13T12:00:00+08:00");
  await expectDomainError(app.service.execute(app.actor("manager"), {
    type: "refund.reconcileSource", refundId, expectedVersion: 1, resolution: "succeeded", sourceStatus: "退款成功",
    refundedAt: "2026-10-13T11:00:00+08:00", amountCents: 1000, rawAmount: "10.00", reason: "订单尚未确认支付",
  }), "BUSINESS_RULE_VIOLATION");

  const paid = result<{ status: string; ownerSnapshot: { memberId: string | null }; version: number }>(await app.service.execute(app.actor("manager"), {
    type: "order.reconcileSource", orderLineId: pendingOrderId, expectedVersion: 1, resolution: "paid", sourceStatus: "已支付",
    paidAt: "2026-10-13T10:00:00+08:00", paidAmountCents: 5000, rawAmount: "50.00", reason: "来源流水已核实",
  }));
  assert.equal(paid.status, "paid");
  assert.equal(paid.ownerSnapshot.memberId, "demo-member-bd-a");
  const succeeded = result<{ status: string; version: number }>(await app.service.execute(app.actor("manager"), {
    type: "refund.reconcileSource", refundId, expectedVersion: 1, resolution: "succeeded", sourceStatus: "退款成功",
    refundedAt: "2026-10-13T11:00:00+08:00", amountCents: 1000, rawAmount: "10.00", reason: "退款流水已核实",
  }));
  assert.equal(succeeded.status, "succeeded");
  const closed = result<{ status: string }>(await app.service.execute(app.actor("manager"), {
    type: "order.reconcileSource", orderLineId: closedOrderId, expectedVersion: 1, resolution: "closed", sourceStatus: "已关闭",
    reason: "平台记录已关闭",
  }));
  assert.equal(closed.status, "closed");
});

test("待确认订单转为已支付前校验已有退款时间和累计金额", async () => {
  const buildPendingOrder = async (app: ReturnType<typeof fixture>, batchId: string, externalOrderId: string) => {
    const row = {
      rowNumber: 1, shopId: "DEMO-SHOP", externalOrderId, externalLineId: `${externalOrderId}-LINE`,
      productId: null, sku: "DEMO-SKU-001", creatorAccountId: "DEMO-DY-ALPHA-001",
      paidAt: null, sourceStatus: "待确认", status: "pending" as const, paidAmountCents: null, rawAmount: null,
    };
    await app.service.execute(app.actor("manager"), { type: "import.commit", batchId, sourceName: "pending.csv", orders: [row], refunds: [] });
    const order = app.state().orders.find((item) => item.externalOrderId === externalOrderId)!;
    return { order, row };
  };
  const makeLegacyRefund = (order: DomainState["orders"][number], id: string, refundedAt: string, amountCents: number): DomainState["refunds"][number] => ({
    id, orgId: order.orgId, teamId: order.teamId, platform: "douyin", shopId: order.shopId, externalRefundId: id,
    orderLineId: order.id, refundedAt, sourceStatus: "历史退款成功", status: "succeeded", amountCents,
    direction: "refund", rawAmount: null, sourceEvidenceUrl: null, importBatchId: "legacy-import", sourceRowNumber: 1,
    contentFingerprint: "legacy", createdAt: T0, createdBy: "demo-member-manager", version: 1,
  });

  for (const scenario of [
    { id: "legacy-before-payment", refundedAt: "2026-10-13T09:30:00+08:00", amountCents: 500 },
    { id: "legacy-over-payment", refundedAt: "2026-10-13T11:00:00+08:00", amountCents: 6000 },
  ]) {
    const app = fixture();
    const { order } = await buildPendingOrder(app, `pending-${scenario.id}`, scenario.id);
    app.state().refunds.push(makeLegacyRefund(order, scenario.id, scenario.refundedAt, scenario.amountCents));
    app.setNow("2026-10-13T12:00:00+08:00");
    await expectDomainError(app.service.execute(app.actor("manager"), {
      type: "order.reconcileSource", orderLineId: order.id, expectedVersion: 1, resolution: "paid", sourceStatus: "已支付",
      paidAt: "2026-10-13T10:00:00+08:00", paidAmountCents: 5000, rawAmount: "50.00", reason: "校验历史退款边界",
    }), "BUSINESS_RULE_VIOLATION");
    assert.equal(app.state().orders.find((item) => item.id === order.id)!.status, "pending", "失败核对不能部分写入订单状态");
  }
});

test("跨团队交接只移交原负责人的个人待办，履约待办回到目标团队能力队列", async () => {
  const app = fixture();
  const template = app.state().tasks[0];
  app.state().tasks.push(
    { ...template, id: "personal-followup-bd", kind: "followup", title: "商务个人跟进", ownerMemberId: "demo-member-bd-a", requiredCapability: null, relatedType: "creator", relatedId: "demo-creator-a" },
    { ...template, id: "personal-followup-ops", kind: "followup", title: "运营个人跟进", ownerMemberId: "demo-member-ops", requiredCapability: null, relatedType: "creator", relatedId: "demo-creator-a" },
    { ...template, id: "workflow-sample-receipt", kind: "sample_receipt", title: "履约签收队列", ownerMemberId: "demo-member-ops", requiredCapability: "sample.fulfill", relatedType: "sample", relatedId: "demo-sample-a" },
  );
  await app.service.execute(app.actor("admin"), {
    type: "creator.transfer", creatorId: "demo-creator-a", targetMemberId: "demo-member-other", expectedVersion: 1,
    effectiveAt: T0, reason: "跨团队责任交接",
  });
  const task = (id: string) => app.state().tasks.find((item) => item.id === id)!;
  assert.equal(task("personal-followup-bd").ownerMemberId, "demo-member-other");
  assert.equal(task("personal-followup-bd").teamId, "demo-team-other");
  assert.equal(task("personal-followup-ops").ownerMemberId, "demo-member-ops");
  assert.equal(task("personal-followup-ops").teamId, "demo-team-main");
  for (const taskId of ["demo-task-a", "workflow-sample-receipt"]) {
    assert.equal(task(taskId).ownerMemberId, null, `${taskId} 不应分配给新 BD`);
    assert.equal(task(taskId).requiredCapability, "sample.fulfill");
    assert.equal(task(taskId).teamId, "demo-team-other");
  }
});

test("达人合并将新样品与历史场次账号映射到合并后的稳定账号", async () => {
  const app = fixture();
  const target = structuredClone(app.state().creators.find((creator) => creator.id === "demo-creator-a")!);
  const source = structuredClone(target);
  source.id = "merge-account-source";
  source.name = "合并来源达人";
  source.accounts = [{ ...target.accounts[0]!, id: "merge-source-account" }];
  app.state().creators.push(source);
  app.state().ownerAssignments.push({
    id: "merge-source-owner", orgId: source.orgId, teamId: source.teamId,
    creatorId: source.id, memberId: source.ownerMemberId, validFrom: T0, validTo: null,
    changedBy: "demo-member-admin", reason: "同账号来源档案",
  });

  const directSample = result<{ id: string; creatorAccountId?: string; platform?: string }>(await app.service.execute(app.actor("bd-a"), {
    type: "sample.request", creatorId: source.id, creatorAccountId: source.accounts[0]!.id,
    expectedCreatorVersion: source.version, lines: [{ productId: "demo-product-a", quantity: 1 }],
    recipient: { recipientName: "合成收件人", phone: null, address: "合成地址" }, reason: "来源达人直接寄样",
  }));
  const legacySample = result<{ id: string; creatorAccountId?: string; platform?: string }>(await app.service.execute(app.actor("bd-a"), {
    type: "sample.create", creatorId: source.id, expectedCreatorVersion: source.version,
    lines: [{ productId: "demo-product-a", quantity: 1 }],
    recipient: { recipientName: "合成收件人", phone: null, address: "合成地址" }, reason: "旧样品流程不带账号归属",
  }));
  const session = result<{ id: string; creatorAccountId: string; platform: string }>(await app.service.execute(app.actor("bd-a"), {
    type: "creator.session.create", creatorId: source.id, creatorAccountId: source.accounts[0]!.id,
    commerceType: "live", occurredOn: "2026-10-12", title: "合并来源历史场次",
  }));

  await app.service.execute(app.actor("manager"), {
    type: "creator.merge", sourceCreatorId: source.id, targetCreatorId: target.id,
    expectedSourceVersion: source.version, expectedTargetVersion: target.version, reason: "相同稳定平台账号",
  });

  const mergedTarget = app.state().creators.find((creator) => creator.id === target.id)!;
  const mergedDirectSample = app.state().samples.find((sample) => sample.id === directSample.id)!;
  const preservedLegacySample = app.state().samples.find((sample) => sample.id === legacySample.id)!;
  const mergedSession = app.state().creatorSessions.find((item) => item.id === session.id)!;
  assert.equal(mergedDirectSample.creatorId, target.id);
  assert.equal(mergedDirectSample.creatorAccountId, mergedTarget.accounts[0]!.id);
  assert.equal(mergedDirectSample.platform, mergedTarget.accounts[0]!.platform);
  assert.equal(preservedLegacySample.creatorId, target.id);
  assert.equal(preservedLegacySample.creatorAccountId, undefined);
  assert.equal(preservedLegacySample.platform, undefined);
  assert.equal(mergedSession.creatorId, target.id);
  assert.equal(mergedSession.creatorAccountId, mergedTarget.accounts[0]!.id);
  assert.equal(mergedSession.platform, mergedTarget.accounts[0]!.platform);
});

test("导入历史权限不可见时不把空批次列表报告为尚未导入", async () => {
  const app = fixture();
  const order = {
    rowNumber: 1, shopId: "DEMO-SHOP", externalOrderId: "COVERAGE-ORDER", externalLineId: "COVERAGE-LINE",
    productId: null, sku: "DEMO-SKU-001", creatorAccountId: "DEMO-DY-ALPHA-001",
    paidAt: "2026-10-13T08:00:00+08:00", sourceStatus: "已支付", status: "paid" as const,
    paidAmountCents: 2500, rawAmount: "25.00",
  };
  await app.service.execute(app.actor("manager"), { type: "import.commit", batchId: "coverage-batch", sourceName: "coverage.csv", orders: [order], refunds: [] });
  const manager = app.state().members.find((member) => member.id === "demo-member-manager")!;
  const visible = await app.service.getWorkspace(app.actor("manager"));
  assert.equal(visible.metrics.dataCoverage.importHistoryVisible, true);
  manager.capabilities = manager.capabilities!.filter((capability) => capability !== "import.manage");
  const hidden = await app.service.getWorkspace(app.actor("manager"));
  assert.equal(hidden.metrics.dataCoverage.importHistoryVisible, false);
  assert.equal(hidden.metrics.dataCoverage.importedBatches, 0);
  assert.equal(hidden.metrics.dataCoverage.latestImportAt, null);
  assert.equal(hidden.metrics.dataCoverage.refundDataStatus, "not_visible");
  assert.equal(hidden.metrics.netPaidCohort.amount.complete, false);
});

test("取消的必需交付不计入按期交付率分母", () => {
  const state = createDemoState();
  const deliveryBase: Omit<DomainState["deliveries"][number], "id" | "status" | "reviews" | "cancellationReason"> = {
    orgId: state.orgId, teamId: state.teams[0].id, creatorId: state.creators[0].id,
    cooperationId: "test-cooperation", cooperationLineId: null, scheduleId: null, ownerMemberId: state.members[1].id,
    type: "live", title: "同日必需交付", dueAt: "2026-10-13T08:45:00+08:00", required: true,
    submissions: [], version: 1, createdAt: T0, createdBy: state.members[1].id, updatedAt: T0, updatedBy: state.members[1].id,
  };
  const deliveries: DomainState["deliveries"] = [
    { ...deliveryBase, id: "approved-on-time", status: "approved", cancellationReason: null, reviews: [{ decision: "approved", reviewedAt: "2026-10-13T08:30:00+08:00", reviewedBy: state.members[2].id, reason: null, submissionIndex: 0 }] },
    { ...deliveryBase, id: "cancelled-required", status: "cancelled", cancellationReason: "合作取消", reviews: [] },
  ];
  const metrics = calculateMetrics({
    creators: state.creators, stageEvents: state.creatorStageEvents, samples: state.samples, samplePackages: state.samplePackages,
    cooperations: state.cooperations, schedules: state.schedules, deliveries, orders: state.orders, refunds: state.refunds,
    ownerCorrections: state.ownerCorrections, tasks: state.tasks, importBatches: state.importBatches,
    importHistoryVisible: true, includeSales: false,
  }, { dateFrom: "2026-10-13", dateTo: "2026-10-13" }, T0);
  assert.deepEqual(metrics.deliveryOnTime, { onTime: 1, due: 1, rate: 1 });
});
