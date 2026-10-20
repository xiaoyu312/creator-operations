import assert from "node:assert/strict";
import test from "node:test";
import type { Actor, CreatorSessionRecord, DomainState, IsoDateTime, ManualStore, SampleRequest, StoreAssortment } from "../shared/types.ts";
import { createDemoState } from "../shared/seed.ts";
import { DomainService, type DomainStore } from "../server/domain/domain-service.ts";
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
      const output = await fn(draft);
      state = draft;
      return structuredClone(output);
    },
  };
  const service = new DomainService(store, { runtime: { now: () => now, id: (prefix) => `${prefix}-${++sequence}` } });
  return {
    service,
    state: () => state,
    setNow: (value: IsoDateTime) => { now = value; },
    actor: (profile: "admin" | "manager" | "bd-a" | "bd-b" | "ops" | "other-team-bd" | "other-manager"): Actor => ({ principalId: `demo:${profile}` }),
  };
}

function result<T>(value: { result: unknown }): T { return value.result as T; }

async function expectDomainError(action: Promise<unknown>, code: DomainError["code"]): Promise<DomainError> {
  let found: unknown;
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof DomainError);
    found = error;
    return true;
  });
  if (!(found instanceof DomainError)) throw new Error("Expected a DomainError instance");
  assert.equal(found.code, code);
  return found;
}

async function createStoreAndAssortment(app: ReturnType<typeof fixture>, overrides: Record<string, unknown> = {}) {
  const store = result<ManualStore>(await app.service.execute(app.actor("manager"), {
    type: "store.create", teamId: "demo-team-main", platform: "douyin", externalShopId: "MANUAL-SHOP-01", name: "演示人工店铺", note: "手工登记",
  }));
  const assortment = result<StoreAssortment>(await app.service.execute(app.actor("manager"), {
    type: "assortment.create", storeId: store.id, productId: "demo-product-a", priceCents: 5900, livePriceCents: 4900,
    creatorCommissionBps: 0, mainSellingPoints: ["轻巧", "易收纳"], sellingPointEvidenceUrl: "https://example.invalid/evidence",
    salesCardUrl: "https://example.invalid/card", productGroups: ["居家", "收纳"], ...overrides,
  }));
  return { store, assortment };
}

test("店铺与货盘按团队隔离，BD可读但不能维护，运营无权进入商务目录", async () => {
  const app = fixture();
  const { store, assortment } = await createStoreAndAssortment(app);
  assert.equal(store.connectionMode, "manual");
  assert.equal(store.connectionStatus, "not_connected");
  assert.equal(assortment.creatorCommissionBps, 0, "0% 与未填写需分开");
  assert.equal(assortment.priceCents, 5900);
  assert.equal(assortment.livePriceCents, 4900);

  const bd = await app.service.getWorkspace(app.actor("bd-a"));
  assert.equal(bd.manualStores.some((item) => item.id === store.id), true);
  assert.equal(bd.storeAssortments.some((item) => item.id === assortment.id), true);
  const otherTeam = await app.service.getWorkspace(app.actor("other-team-bd"));
  assert.equal(otherTeam.manualStores.length, 0);
  assert.equal(otherTeam.storeAssortments.length, 0);

  await expectDomainError(app.service.execute(app.actor("other-team-bd"), {
    type: "assortment.update", assortmentId: assortment.id, expectedVersion: 1, priceCents: 1,
  }), "FORBIDDEN");
  await expectDomainError(app.service.execute(app.actor("manager"), {
    type: "store.create", teamId: "demo-team-other", platform: "douyin", externalShopId: "CROSS-TEAM-SHOP", name: "越权店铺",
  }), "FORBIDDEN");
  await expectDomainError(app.service.execute(app.actor("bd-b"), {
    type: "proposal.create", creatorId: "demo-creator-a", title: "非本人提案", deliveryRequirement: "推品",
    sampleRequirement: "none", assortmentIds: [assortment.id],
  }), "NOT_FOUND");
  await expectDomainError(app.service.execute(app.actor("ops"), {
    type: "store.create", platform: "douyin", externalShopId: "OPS-SHOP", name: "运营不应建店",
  }), "FORBIDDEN");
  await app.service.execute(app.actor("manager"), { type: "product.update", productId: "demo-product-a", expectedVersion: 1, active: false });
  await expectDomainError(app.service.execute(app.actor("manager"), {
    type: "assortment.create", storeId: store.id, productId: "demo-product-a", priceCents: 0,
  }), "BUSINESS_RULE_VIOLATION");
});

test("团长机构私密字段对BD脱敏，BD不能维护资源，链接仅挂在有权访问的合作草稿", async () => {
  const app = fixture();
  const resource = result<{ id: string; contactPhone: string | null }>(await app.service.execute(app.actor("manager"), {
    type: "partnerResource.create", kind: "agency", name: "演示机构", summary: "擅长家居品类选品",
    tags: ["家居"], contactName: "内部联系人", contactPhone: "13800000000", contactHandle: "agency-demo", privateNote: "仅主管查看",
  }));
  assert.equal(resource.contactPhone, "13800000000");
  const bd = await app.service.getWorkspace(app.actor("bd-a"));
  const visibleResource = bd.partnerResources.find((item) => item.id === resource.id)!;
  assert.equal(visibleResource.summary, "擅长家居品类选品");
  assert.equal(visibleResource.contactName, null);
  assert.equal(visibleResource.contactPhone, null);
  assert.equal(visibleResource.contactHandle, null);
  assert.equal(visibleResource.privateNote, null);
  await expectDomainError(app.service.execute(app.actor("bd-a"), {
    type: "partnerResource.update", resourceId: resource.id, expectedVersion: 1, summary: "BD不能改目录",
  }), "FORBIDDEN");

  const draft = result<{ id: string; version: number }>(await app.service.execute(app.actor("bd-a"), {
    type: "cooperation.create", creatorId: "demo-creator-a", expectedCreatorVersion: 1,
    title: "机构合作记录", lines: [{ productName: "人工记录商品", deliveryRequirement: "直播合作" }],
    sampleRequirement: "none", deliveryRequirement: "记录合作关系",
  }));
  const link = result<{ id: string; cooperationId: string }>(await app.service.execute(app.actor("bd-a"), {
    type: "cooperationPartnerLink.create", cooperationId: draft.id, partnerResourceId: resource.id, role: "service_provider", note: "资源关联，不代表归因或分佣",
  }));
  assert.equal(link.cooperationId, draft.id);
  await expectDomainError(app.service.execute(app.actor("other-team-bd"), {
    type: "cooperationPartnerLink.update", linkId: link.id, expectedVersion: 1, active: false,
  }), "NOT_FOUND");
});

test("推品状态转换冻结货盘快照，转换为草稿幂等且不跳过既有审批", async () => {
  const app = fixture();
  const { assortment } = await createStoreAndAssortment(app);
  const created = result<{ id: string; version: number; items: Array<{ creatorCommissionBps: number | null; livePriceCents: number | null }> }>(await app.service.execute(app.actor("bd-a"), {
    type: "proposal.create", creatorId: "demo-creator-a", title: "收纳提案", deliveryRequirement: "至少一条直播讲解",
    sampleRequirement: "none", assortmentIds: [assortment.id],
  }));
  assert.equal(created.items[0].creatorCommissionBps, 0);
  assert.equal(created.items[0].livePriceCents, 4900);

  await expectDomainError(app.service.execute(app.actor("admin"), {
    type: "creator.transfer", creatorId: "demo-creator-a", targetMemberId: "demo-member-other", expectedVersion: 1,
    effectiveAt: T0, reason: "有未结提案时不应静默转团队",
  }), "BUSINESS_RULE_VIOLATION");
  assert.equal(app.state().creators.find((item) => item.id === "demo-creator-a")!.teamId, "demo-team-main");
  const cancelled = result<{ status: string }>(await app.service.execute(app.actor("bd-a"), {
    type: "proposal.cancel", proposalId: created.id, expectedVersion: created.version, reason: "先关闭未结提案再交接",
  }));
  assert.equal(cancelled.status, "cancelled");
  const activeProposal = result<typeof created>(await app.service.execute(app.actor("bd-a"), {
    type: "proposal.create", creatorId: "demo-creator-a", title: "收纳提案二", deliveryRequirement: "至少一条直播讲解",
    sampleRequirement: "none", assortmentIds: [assortment.id],
  }));

  const submitted = result<{ id: string; version: number; status: string }>(await app.service.execute(app.actor("bd-a"), {
    type: "proposal.submit", proposalId: activeProposal.id, expectedVersion: activeProposal.version,
  }));
  assert.equal(submitted.status, "proposed", "仅表示已记录推品，不发送外部消息");
  const accepted = result<{ id: string; version: number }>(await app.service.execute(app.actor("bd-a"), {
    type: "proposal.recordOutcome", proposalId: activeProposal.id, expectedVersion: submitted.version, outcome: "accepted", note: "达人确认合作意向",
  }));
  await app.service.execute(app.actor("manager"), {
    type: "assortment.update", assortmentId: assortment.id, expectedVersion: 1,
    priceCents: 6900, livePriceCents: 6200, creatorCommissionBps: 1200,
  });
  assert.equal(app.state().creatorProductProposals.find((item) => item.id === activeProposal.id)!.items[0].livePriceCents, 4900, "货盘改价不覆盖提案快照");

  const converted = result<{ proposal: { id: string; status: string; version: number }; cooperation: { id: string; status: string; ownerMemberId: string; lines: Array<{ livePriceCents?: number | null; creatorCommissionBps?: number | null; assortmentVersion?: number | null }> }; idempotent: boolean }>(await app.service.execute(app.actor("bd-a"), {
    type: "proposal.convert", proposalId: activeProposal.id, expectedVersion: accepted.version,
  }));
  assert.equal(converted.proposal.status, "converted");
  assert.equal(converted.idempotent, false);
  assert.equal(converted.cooperation.status, "draft");
  assert.equal(converted.cooperation.ownerMemberId, "demo-member-bd-a");
  assert.equal(converted.cooperation.lines[0].livePriceCents, 4900);
  assert.equal(converted.cooperation.lines[0].creatorCommissionBps, 0);
  assert.equal(converted.cooperation.lines[0].assortmentVersion, assortment.version);
  assert.equal(app.state().cooperations.length, 1);

  const replay = result<typeof converted>(await app.service.execute(app.actor("bd-a"), {
    type: "proposal.convert", proposalId: activeProposal.id, expectedVersion: accepted.version,
  }));
  assert.equal(replay.idempotent, true);
  assert.equal(replay.cooperation.id, converted.cooperation.id);
  assert.equal(app.state().cooperations.length, 1);
  assert.equal(app.state().cooperations[0].status, "draft", "转换不会绕过原合作审批流程");
});

test("主管可按版本和原因关闭本团队开放提案，外团队主管不能关闭", async () => {
  const app = fixture();
  const manager = app.state().members.find((item) => item.id === "demo-member-manager")!;
  app.state().members.push({
    ...structuredClone(manager), id: "demo-member-other-manager", principalId: "demo:other-manager",
    displayName: "异团队主管", teamId: "demo-team-other", role: "manager", capabilities: [],
  });
  const { assortment } = await createStoreAndAssortment(app);
  const proposal = result<{ id: string; version: number }>(await app.service.execute(app.actor("bd-a"), {
    type: "proposal.create", creatorId: "demo-creator-a", title: "离职交接待关闭提案", deliveryRequirement: "待人工确认",
    sampleRequirement: "none", assortmentIds: [assortment.id],
  }));
  const closed = result<{ status: string; version: number; outcomeNote: string | null }>(await app.service.execute(app.actor("manager"), {
    type: "proposal.cancel", proposalId: proposal.id, expectedVersion: proposal.version, reason: "原负责人离职，由本团队主管关闭待处理事项",
  }));
  assert.equal(closed.status, "cancelled");
  assert.equal(closed.version, 2);
  assert.equal(closed.outcomeNote, "原负责人离职，由本团队主管关闭待处理事项");

  const stillOpen = result<{ id: string; version: number; status: string }>(await app.service.execute(app.actor("bd-a"), {
    type: "proposal.create", creatorId: "demo-creator-a", title: "外团队越权测试", deliveryRequirement: "只允许本团队关闭",
    sampleRequirement: "none", assortmentIds: [assortment.id],
  }));
  await expectDomainError(app.service.execute(app.actor("other-manager"), {
    type: "proposal.cancel", proposalId: stillOpen.id, expectedVersion: stillOpen.version, reason: "越权关闭",
  }), "NOT_FOUND");
  await expectDomainError(app.service.execute(app.actor("manager"), {
    type: "proposal.submit", proposalId: stillOpen.id, expectedVersion: stillOpen.version,
  }), "NOT_FOUND");
  assert.equal(app.state().creatorProductProposals.find((item) => item.id === stillOpen.id)!.status, "draft");
});

test("内容授权按有效期派生，不确定状态不能产生可投放权限，人工指标区分0与null", async () => {
  const app = fixture();
  const asset = result<{ id: string; version: number; rightsStatus: string }>(await app.service.execute(app.actor("bd-a"), {
    type: "contentAsset.create", creatorId: "demo-creator-a", sourceUrl: "https://example.invalid/content-a",
    assetType: "short_video", title: "已验收视频备份", tags: ["收纳"], productIds: ["demo-product-a"],
  }));
  assert.equal(asset.rightsStatus, "unknown");
  await expectDomainError(app.service.execute(app.actor("bd-a"), {
    type: "contentAsset.updateRights", assetId: asset.id, expectedVersion: 1,
    rightsStatus: "unknown", rightsScope: ["paid_media"], rightsValidFrom: null, rightsValidUntil: null,
    rightsEvidenceUrl: null, reason: "不能伪装授权",
  }), "BUSINESS_RULE_VIOLATION");
  await app.service.execute(app.actor("bd-a"), {
    type: "contentAsset.updateRights", assetId: asset.id, expectedVersion: 1,
    rightsStatus: "authorized", rightsScope: ["publish", "paid_media"],
    rightsValidFrom: "2026-10-14T00:00:00+08:00", rightsValidUntil: "2026-10-20T00:00:00+08:00",
    rightsEvidenceUrl: "https://example.invalid/rights-proof", reason: "授权将于明日生效",
  });
  const future = await app.service.getWorkspace(app.actor("bd-a"));
  assert.equal(future.contentAssets.find((item) => item.id === asset.id)!.authorizationEffectiveNow, false);
  assert.deepEqual(future.contentAssets.find((item) => item.id === asset.id)!.effectiveRightsScope, []);

  await app.service.execute(app.actor("bd-a"), {
    type: "contentAsset.updateRights", assetId: asset.id, expectedVersion: 2,
    rightsStatus: "authorized", rightsScope: ["publish"],
    rightsValidFrom: "2026-10-01T00:00:00+08:00", rightsValidUntil: "2026-10-12T23:59:59+08:00",
    rightsEvidenceUrl: "https://example.invalid/rights-proof-old", reason: "已过期授权不能继续使用",
  });
  const expired = await app.service.getWorkspace(app.actor("bd-a"));
  assert.equal(expired.contentAssets.find((item) => item.id === asset.id)!.authorizationEffectiveNow, false);
  await expectDomainError(app.service.execute(app.actor("bd-a"), {
    type: "contentAsset.update", assetId: asset.id, expectedVersion: 3, sourceUrl: "https://example.invalid/replacement-content",
  }), "VALIDATION_ERROR");

  const observation = result<{ views: number | null; likes: number | null; orders: number | null; observedPaidCents: number | null; recordedAt: string }>(await app.service.execute(app.actor("bd-a"), {
    type: "contentObservation.append", assetId: asset.id, expectedAssetVersion: 3,
    source: "手工抄录平台页面", observedAt: T0, views: 0, likes: null, comments: 2, shares: 0, orders: 0,
    observedPaidCents: 0, note: "这不是导入订单或GMV",
  }));
  assert.equal(observation.views, 0);
  assert.equal(observation.likes, null);
  assert.equal(observation.orders, 0);
  assert.equal(observation.observedPaidCents, 0);
  assert.ok(observation.recordedAt);
  await app.service.execute(app.actor("bd-a"), {
    type: "contentObservation.append", assetId: asset.id, expectedAssetVersion: 4,
    source: "第二次手工观察", observedAt: T0, views: null, likes: 0, comments: null, shares: null, orders: null,
    observedPaidCents: null,
  });
  assert.equal(app.state().contentObservations.length, 2, "人工观察只追加，不覆盖历史观察值");
  assert.equal(app.state().contentObservations[0].views, 0);
  assert.equal(app.state().contentObservations[1].views, null);
  assert.equal(app.state().orders.length, 0, "内容观察值不写入订单或退款");
  await expectDomainError(app.service.execute(app.actor("bd-a"), {
    type: "contentAsset.create", creatorId: "demo-creator-a", sourceUrl: "https://user:secret@example.invalid/content",
    assetType: "short_video", title: "带凭据的地址", tags: [], productIds: [],
  }), "VALIDATION_ERROR");
});

test("费用仅管理员和主管可维护，作废留痕且不改GMV；月目标实际值按同team月份和当前时点派生", async () => {
  const app = fixture();
  const orderRows = [
    {
      rowNumber: 1, shopId: "DEMO-SHOP", externalOrderId: "MONTHLY-PAID-1", externalLineId: "MONTHLY-LINE-1",
      productId: null, sku: "DEMO-SKU-001", creatorAccountId: "DEMO-DY-ALPHA-001",
      paidAt: "2026-10-12T08:00:00+08:00", sourceStatus: "已支付", status: "paid" as const,
      paidAmountCents: 12345, rawAmount: "123.45",
    },
    {
      rowNumber: 2, shopId: "DEMO-SHOP", externalOrderId: "MONTHLY-FUTURE-1", externalLineId: "MONTHLY-FUTURE-LINE",
      productId: null, sku: "DEMO-SKU-001", creatorAccountId: "DEMO-DY-ALPHA-001",
      paidAt: "2026-10-30T08:00:00+08:00", sourceStatus: "已支付", status: "paid" as const,
      paidAmountCents: 999999, rawAmount: "9999.99",
    },
  ];
  await app.service.execute(app.actor("manager"), {
    type: "import.commit", batchId: "monthly-target-orders", sourceName: "synthetic-month.csv", orders: orderRows, refunds: [],
  });
  app.state().deliveries.push(
    {
      id: "monthly-approved-delivery", orgId: "demo-org", teamId: "demo-team-main", creatorId: "demo-creator-a",
      cooperationId: "completed-coop", cooperationLineId: null, scheduleId: null, ownerMemberId: "demo-member-bd-a",
      type: "live", title: "已完成交付", dueAt: "2026-10-12T08:00:00+08:00", required: true,
      status: "approved", submissions: [], reviews: [{ decision: "approved", reviewedAt: "2026-10-12T08:30:00+08:00", reviewedBy: "demo-member-manager", reason: null, submissionIndex: 0 }],
      cancellationReason: null, version: 1, createdAt: T0, createdBy: "demo-member-bd-a", updatedAt: T0, updatedBy: "demo-member-manager",
    },
    {
      id: "monthly-future-delivery", orgId: "demo-org", teamId: "demo-team-main", creatorId: "demo-creator-a",
      cooperationId: "future-coop", cooperationLineId: null, scheduleId: null, ownerMemberId: "demo-member-bd-a",
      type: "live", title: "未来验收交付", dueAt: "2026-10-30T08:00:00+08:00", required: true,
      status: "approved", submissions: [], reviews: [{ decision: "approved", reviewedAt: "2026-10-30T08:30:00+08:00", reviewedBy: "demo-member-manager", reason: null, submissionIndex: 0 }],
      cancellationReason: null, version: 1, createdAt: T0, createdBy: "demo-member-bd-a", updatedAt: T0, updatedBy: "demo-member-manager",
    },
  );
  app.state().creatorStageEvents.push({
    id: "future-contact-event", orgId: "demo-org", teamId: "demo-team-main", creatorId: "demo-creator-b",
    stage: "contacted", occurredAt: "2026-10-30T08:00:00+08:00", recordedAt: T0, actorId: "demo-member-bd-b", reason: "测试未来触达",
  });

  await app.service.execute(app.actor("manager"), { type: "teamTarget.upsert", teamId: "demo-team-main", month: "2026-10", metric: "paid_gmv", targetValue: 500000, expectedVersion: 0 });
  await app.service.execute(app.actor("manager"), { type: "teamTarget.upsert", teamId: "demo-team-main", month: "2026-10", metric: "approved_deliveries", targetValue: 10, expectedVersion: 0 });
  await app.service.execute(app.actor("manager"), { type: "teamTarget.upsert", teamId: "demo-team-main", month: "2026-10", metric: "new_contacts", targetValue: 20, expectedVersion: 0 });
  await app.service.execute(app.actor("manager"), { type: "teamTarget.upsert", teamId: "demo-team-main", month: "2026-09", metric: "paid_gmv", targetValue: 100000, expectedVersion: 0 });
  await app.service.execute(app.actor("admin"), { type: "teamTarget.upsert", teamId: "demo-team-other", month: "2026-10", metric: "paid_gmv", targetValue: 1, expectedVersion: 0 });

  const targetsBefore = await app.service.getWorkspace(app.actor("manager"));
  const findTarget = (teamId: string, month: string, metric: string) => targetsBefore.teamMonthlyTargets.find((item) => item.teamId === teamId && item.month === month && item.metric === metric)!;
  assert.equal(findTarget("demo-team-main", "2026-10", "paid_gmv").actualValue, 12345, "未到期的未来支付不得进入当前实际值");
  assert.equal(findTarget("demo-team-main", "2026-10", "approved_deliveries").actualValue, 1);
  assert.equal(findTarget("demo-team-main", "2026-10", "new_contacts").actualValue, 1, "已触达达人去重，未来事件排除");
  assert.equal(findTarget("demo-team-main", "2026-09", "paid_gmv").actualValue, 0);

  const ledger = result<{ id: string; version: number; status: string }>(await app.service.execute(app.actor("manager"), {
    type: "ledgerEntry.create", teamId: "demo-team-main", title: "已登记投放消耗", kind: "ad_spend", amountCents: 5000,
    occurredAt: "2026-10-12T12:00:00+08:00", source: "手工录入平台报表", evidenceUrl: "https://example.invalid/ad-evidence",
  }));
  assert.equal(ledger.status, "recorded", "登记费用不表示付款成功或平台结算");
  const cooperation = result<{ id: string }>(await app.service.execute(app.actor("manager"), {
    type: "cooperation.create", creatorId: "demo-creator-a", expectedCreatorVersion: 1, title: "费用跨团队引用测试",
    lines: [{ productName: "测试商品", deliveryRequirement: "测试" }], sampleRequirement: "none", deliveryRequirement: "测试",
  }));
  await expectDomainError(app.service.execute(app.actor("admin"), {
    type: "ledgerEntry.create", teamId: "demo-team-other", title: "跨团队费用关联", kind: "cooperation_fee", amountCents: 100,
    occurredAt: T0, source: "测试", cooperationId: cooperation.id,
  }), "NOT_FOUND");
  await app.service.execute(app.actor("manager"), { type: "ledgerEntry.void", entryId: ledger.id, expectedVersion: 1, voidReason: "重复录入，保留作废痕迹" });
  assert.equal(app.state().commercialLedgerEntries.length, 1);
  assert.equal(app.state().commercialLedgerEntries[0].status, "voided");
  assert.equal(app.state().commercialLedgerEntries[0].voidReason, "重复录入，保留作废痕迹");
  assert.equal(app.state().orders.length, 2, "费用作废不改订单事实");
  const afterVoid = await app.service.getWorkspace(app.actor("manager"));
  assert.equal(afterVoid.metrics.paidOrders.amount.knownCents, 12345);
  assert.equal(afterVoid.teamMonthlyTargets.find((item) => item.metric === "paid_gmv" && item.month === "2026-10")!.actualValue, 12345);

  const bd = await app.service.getWorkspace(app.actor("bd-a"));
  const ops = await app.service.getWorkspace(app.actor("ops"));
  assert.equal(bd.commercialLedgerEntries.length, 0);
  assert.equal(bd.teamMonthlyTargets.length, 0);
  assert.equal(ops.commercialLedgerEntries.length, 0);
  assert.equal(ops.teamMonthlyTargets.length, 0);
  await expectDomainError(app.service.execute(app.actor("ops"), {
    type: "ledgerEntry.create", teamId: "demo-team-main", title: "运营不得登记", kind: "other", amountCents: 1,
    occurredAt: T0, source: "测试",
  }), "FORBIDDEN");
  await expectDomainError(app.service.execute(app.actor("manager"), {
    type: "ledgerEntry.create", teamId: "demo-team-main", title: "未来预算不能记作已发生费用", kind: "ad_spend", amountCents: 1,
    occurredAt: "2026-10-30T08:00:00+08:00", source: "预算",
  }), "BUSINESS_RULE_VIOLATION");
});

test("交付登记内容资产只能沿用最终验收提交链接", async () => {
  const app = fixture();
  const cooperation = result<{ id: string; version: number; lines: Array<{ id: string }> }>(await app.service.execute(app.actor("bd-a"), {
    type: "cooperation.create", creatorId: "demo-creator-a", expectedCreatorVersion: 1, title: "内容资产来源合作",
    lines: [{ productId: "demo-product-a", productName: "演示收纳盒", deliveryRequirement: "提交一条可复用短视频" }],
    sampleRequirement: "none", deliveryRequirement: "演示交付来源",
  }));
  const submittedCoop = result<{ id: string; version: number }>(await app.service.execute(app.actor("bd-a"), {
    type: "cooperation.submit", cooperationId: cooperation.id, expectedVersion: cooperation.version, submittedAt: T0,
  }));
  const approvedCoop = result<{ id: string; version: number }>(await app.service.execute(app.actor("manager"), {
    type: "cooperation.decide", cooperationId: cooperation.id, expectedVersion: submittedCoop.version, decision: "approved", decidedAt: T0,
  }));
  const delivery = result<{ id: string; version: number }>(await app.service.execute(app.actor("bd-a"), {
    type: "delivery.create", cooperationId: approvedCoop.id, expectedCooperationVersion: approvedCoop.version,
    cooperationLineId: cooperation.lines[0].id, deliveryType: "short_video", title: "验收视频", dueAt: "2026-10-20T18:00:00+08:00",
  }));
  const submittedDelivery = result<{ id: string; version: number }>(await app.service.execute(app.actor("bd-a"), {
    type: "delivery.submit", deliveryId: delivery.id, expectedVersion: delivery.version, submittedAt: T0,
    contentUrl: "https://example.invalid/accepted-video", evidenceUrl: "https://example.invalid/accepted-proof",
  }));
  const approvedDelivery = result<{ id: string; version: number }>(await app.service.execute(app.actor("manager"), {
    type: "delivery.review", deliveryId: delivery.id, expectedVersion: submittedDelivery.version, decision: "approved", reviewedAt: T0,
  }));
  await expectDomainError(app.service.execute(app.actor("bd-a"), {
    type: "contentAsset.registerFromDelivery", deliveryId: approvedDelivery.id, expectedDeliveryVersion: approvedDelivery.version,
    sourceUrl: "https://example.invalid/not-the-approved-submission", assetType: "short_video", title: "冒用验收链接",
  }), "BUSINESS_RULE_VIOLATION");
  const asset = result<{ deliveryId: string | null; sourceUrl: string }>(await app.service.execute(app.actor("bd-a"), {
    type: "contentAsset.registerFromDelivery", deliveryId: approvedDelivery.id, expectedDeliveryVersion: approvedDelivery.version,
    sourceUrl: "https://example.invalid/accepted-video", assetType: "short_video", title: "验收视频资产",
  }));
  assert.equal(asset.deliveryId, approvedDelivery.id);
  assert.equal(asset.sourceUrl, "https://example.invalid/accepted-video");
});

test("跨团队交接保留内容历史team但禁用旧scope授权，同team合并重挂提案和内容", async () => {
  const app = fixture();
  const asset = result<{ id: string; version: number }>(await app.service.execute(app.actor("bd-a"), {
    type: "contentAsset.create", creatorId: "demo-creator-a", sourceUrl: "https://example.invalid/transfer-video",
    assetType: "short_video", title: "原团队内容资产",
  }));
  await app.service.execute(app.actor("bd-a"), {
    type: "contentAsset.updateRights", assetId: asset.id, expectedVersion: asset.version,
    rightsStatus: "authorized", rightsScope: ["paid_media"], rightsValidFrom: T0, rightsValidUntil: null,
    rightsEvidenceUrl: "https://example.invalid/transfer-rights", reason: "原团队授权记录",
  });
  const cooperation = result<{ id: string; version: number }>(await app.service.execute(app.actor("bd-a"), {
    type: "cooperation.create", creatorId: "demo-creator-a", expectedCreatorVersion: 1, title: "关联团长的开放合作",
    lines: [{ productName: "测试商品", deliveryRequirement: "合作交付" }], sampleRequirement: "none", deliveryRequirement: "关联资源",
  }));
  const resource = result<{ id: string }>(await app.service.execute(app.actor("manager"), {
    type: "partnerResource.create", kind: "leader", name: "演示团长", summary: "测试资源",
  }));
  const link = result<{ id: string }>(await app.service.execute(app.actor("bd-a"), {
    type: "cooperationPartnerLink.create", cooperationId: cooperation.id, partnerResourceId: resource.id, role: "lead_source",
  }));
  await expectDomainError(app.service.execute(app.actor("admin"), {
    type: "creator.transfer", creatorId: "demo-creator-a", targetMemberId: "demo-member-other", expectedVersion: 1,
    effectiveAt: T0, reason: "未停用合作资源关联不可转团队",
  }), "BUSINESS_RULE_VIOLATION");
  await app.service.execute(app.actor("manager"), {
    type: "cooperationPartnerLink.update", linkId: link.id, expectedVersion: 1, active: false,
  });
  await app.service.execute(app.actor("admin"), {
    type: "creator.transfer", creatorId: "demo-creator-a", targetMemberId: "demo-member-other", expectedVersion: 1,
    effectiveAt: T0, reason: "已停用旧团队合作资源关联后转交",
  });
  assert.equal(app.state().contentAssets.find((item) => item.id === asset.id)!.teamId, "demo-team-main");
  const oldTeam = await app.service.getWorkspace(app.actor("manager"));
  assert.equal(oldTeam.contentAssets.find((item) => item.id === asset.id)!.authorizationEffectiveNow, false);
  assert.deepEqual(oldTeam.contentAssets.find((item) => item.id === asset.id)!.effectiveRightsScope, []);
  const newOwner = await app.service.getWorkspace(app.actor("other-team-bd"));
  assert.equal(newOwner.contentAssets.length, 0);

  const mergeApp = fixture();
  const source = structuredClone(mergeApp.state().creators.find((item) => item.id === "demo-creator-a")!);
  source.id = "demo-merge-source";
  source.name = "同团队合并来源";
  source.accounts = [{ ...source.accounts[0], id: "merge-account", externalAccountId: "DEMO-DY-MERGE-SOURCE", displayName: "合并来源账号" }];
  mergeApp.state().creators.push(source);
  mergeApp.state().ownerAssignments.push({
    id: "merge-owner", orgId: source.orgId, teamId: source.teamId, creatorId: source.id,
    memberId: "demo-member-bd-a", validFrom: T0, validTo: null, changedBy: "demo-member-admin", reason: "合成合并测试",
  });
  const { assortment } = await createStoreAndAssortment(mergeApp);
  const proposal = result<{ id: string }>(await mergeApp.service.execute(mergeApp.actor("bd-a"), {
    type: "proposal.create", creatorId: source.id, title: "合并前提案", deliveryRequirement: "样例交付",
    sampleRequirement: "none", assortmentIds: [assortment.id],
  }));
  const mergeAsset = result<{ id: string }>(await mergeApp.service.execute(mergeApp.actor("bd-a"), {
    type: "contentAsset.create", creatorId: source.id, sourceUrl: "https://example.invalid/merge-content",
    assetType: "short_video", title: "合并前内容",
  }));
  await mergeApp.service.execute(mergeApp.actor("manager"), {
    type: "creator.merge", sourceCreatorId: source.id, targetCreatorId: "demo-creator-a",
    expectedSourceVersion: 1, expectedTargetVersion: 1, reason: "同团队身份核实一致",
  });
  assert.equal(mergeApp.state().creatorProductProposals.find((item) => item.id === proposal.id)!.creatorId, "demo-creator-a");
  assert.equal(mergeApp.state().contentAssets.find((item) => item.id === mergeAsset.id)!.creatorId, "demo-creator-a");
  const mergedBd = await mergeApp.service.getWorkspace(mergeApp.actor("bd-a"));
  assert.ok(mergedBd.creatorProductProposals.some((item) => item.id === proposal.id));
  assert.ok(mergedBd.contentAssets.some((item) => item.id === mergeAsset.id));
});

test("样品运营可见明确分配给本人的样品工作流任务但不泄露达人ID", async () => {
  const app = fixture();
  const manager = await app.service.getWorkspace(app.actor("manager"));
  assert.equal(manager.tasks.find((item) => item.id === "demo-task-a")?.ownerMemberId, "demo-member-ops");
  const ops = await app.service.getWorkspace(app.actor("ops"));
  const assignedTask = ops.tasks.find((item) => item.id === "demo-task-a");
  assert.ok(assignedTask);
  assert.equal(assignedTask.creatorId, null);
  assert.equal(assignedTask.relatedType, "sample");
  assert.equal(assignedTask.relatedId, "demo-sample-a");
});

test("批量成员交接在所有达人预检后才写入，未结合作关联阻断时整批回滚", async () => {
  const app = fixture();
  const firstLegalCreator = structuredClone(app.state().creators.find((item) => item.id === "demo-creator-a")!);
  firstLegalCreator.id = "demo-handoff-legal-first";
  firstLegalCreator.name = "先检查的可交接达人";
  firstLegalCreator.accounts = [{ ...firstLegalCreator.accounts[0], id: "handoff-legal-account", externalAccountId: "DEMO-DY-HANDOFF-LEGAL", displayName: "合法交接账号" }];
  app.state().creators.unshift(firstLegalCreator);
  app.state().ownerAssignments.unshift({
    id: "handoff-legal-owner", orgId: firstLegalCreator.orgId, teamId: firstLegalCreator.teamId,
    creatorId: firstLegalCreator.id, memberId: "demo-member-bd-a", validFrom: T0, validTo: null,
    changedBy: "demo-member-admin", reason: "合成批量交接测试",
  });
  const cooperation = result<{ id: string }>(await app.service.execute(app.actor("bd-a"), {
    type: "cooperation.create", creatorId: "demo-creator-a", expectedCreatorVersion: 1,
    title: "阻断批量交接的开放合作", lines: [{ productName: "测试商品", deliveryRequirement: "合作交付" }],
    sampleRequirement: "none", deliveryRequirement: "保留现有合作资源关系",
  }));
  const resource = result<{ id: string }>(await app.service.execute(app.actor("manager"), {
    type: "partnerResource.create", kind: "leader", name: "批量交接测试团长", summary: "仅用于合成测试",
  }));
  const link = result<{ id: string }>(await app.service.execute(app.actor("bd-a"), {
    type: "cooperationPartnerLink.create", cooperationId: cooperation.id, partnerResourceId: resource.id, role: "lead_source",
  }));
  const assignmentCount = app.state().ownerAssignments.length;
  await expectDomainError(app.service.execute(app.actor("admin"), {
    type: "member.handoff", sourceMemberId: "demo-member-bd-a", targetMemberId: "demo-member-other",
    effectiveAt: T0, reason: "整批转团队前需停用未结合作资源关联", deactivateSource: true,
  }), "BUSINESS_RULE_VIOLATION");
  assert.equal(app.state().creators.find((item) => item.id === firstLegalCreator.id)!.teamId, "demo-team-main", "先遍历到的合法达人也不得部分交接");
  assert.equal(app.state().creators.find((item) => item.id === "demo-creator-a")!.teamId, "demo-team-main");
  assert.equal(app.state().creators.find((item) => item.id === firstLegalCreator.id)!.ownerMemberId, "demo-member-bd-a");
  assert.equal(app.state().ownerAssignments.length, assignmentCount);
  assert.equal(app.state().members.find((item) => item.id === "demo-member-bd-a")!.active, true, "失败事务不能停用来源成员");
  assert.equal(app.state().cooperationPartnerLinks.find((item) => item.id === link.id)!.active, true);
  assert.equal(app.state().cooperations.find((item) => item.id === cooperation.id)!.teamId, "demo-team-main");
});

test("达人历史表现按品牌和账号隔离保存，CAS 生效且不改变订单统计", async () => {
  const app = fixture();
  const creator = app.state().creators.find((item) => item.id === "demo-creator-a")!;
  const account = creator.accounts[0]!;
  const before = await app.service.getWorkspace(app.actor("manager"));
  const paidOrdersBefore = structuredClone(before.metrics.paidOrders);
  const zeroValue = result<CreatorSessionRecord>(await app.service.execute(app.actor("bd-a"), {
    type: "creator.session.create", creatorId: creator.id, creatorAccountId: account.id,
    commerceType: "live", occurredOn: "2026-10-10", title: "手工登记直播复盘",
    productIds: ["demo-product-a"], gmvCents: 0, orderCount: 0,
  }));
  const unknownValue = result<CreatorSessionRecord>(await app.service.execute(app.actor("bd-a"), {
    type: "creator.session.create", creatorId: creator.id, creatorAccountId: account.id,
    commerceType: "short_video", occurredOn: "2026-10-11", title: "手工登记短视频复盘",
  }));
  assert.equal(zeroValue.platform, account.platform);
  assert.equal(zeroValue.source, "manual");
  assert.equal(zeroValue.gmvCents, 0);
  assert.equal(zeroValue.orderCount, 0);
  assert.equal(unknownValue.gmvCents, null);
  assert.equal(unknownValue.orderCount, null);
  assert.deepEqual(account.commerceTypes, [], "recording history must not infer the account's commerce types");

  const updated = result<CreatorSessionRecord>(await app.service.execute(app.actor("bd-a"), {
    type: "creator.session.update", sessionId: zeroValue.id, expectedVersion: 1,
    gmvCents: null, orderCount: null, note: "修正为未知值",
  }));
  assert.equal(updated.version, 2);
  assert.equal(updated.gmvCents, null);
  assert.equal(updated.orderCount, null);
  await expectDomainError(app.service.execute(app.actor("bd-a"), {
    type: "creator.session.update", sessionId: zeroValue.id, expectedVersion: 1, title: "陈旧版本更新",
  }), "VERSION_CONFLICT");
  await expectDomainError(app.service.execute(app.actor("bd-b"), {
    type: "creator.session.create", creatorId: creator.id, creatorAccountId: account.id,
    commerceType: "live", occurredOn: "2026-10-10", title: "非本人达人",
  }), "NOT_FOUND");
  await expectDomainError(app.service.execute(app.actor("bd-a"), {
    type: "creator.session.create", creatorId: creator.id, creatorAccountId: "missing-account",
    commerceType: "live", occurredOn: "2026-10-10", title: "账号不匹配",
  }), "NOT_FOUND");
  await expectDomainError(app.service.execute(app.actor("bd-a"), {
    type: "creator.session.create", creatorId: creator.id, creatorAccountId: account.id,
    commerceType: "live", occurredOn: "2026-02-30", title: "无效日期",
  }), "VALIDATION_ERROR");
  await expectDomainError(app.service.execute(app.actor("bd-a"), {
    type: "creator.session.create", creatorId: creator.id, creatorAccountId: account.id,
    commerceType: "live", occurredOn: "2026-10-10", title: "无效金额", gmvCents: -1,
  }), "VALIDATION_ERROR");
  await expectDomainError(app.service.execute(app.actor("ops"), {
    type: "creator.session.create", creatorId: creator.id, creatorAccountId: account.id,
    commerceType: "live", occurredOn: "2026-10-10", title: "运营不可写",
  }), "FORBIDDEN");

  const managerWorkspace = await app.service.getWorkspace(app.actor("manager"));
  const bdWorkspace = await app.service.getWorkspace(app.actor("bd-a"));
  const otherBdWorkspace = await app.service.getWorkspace(app.actor("bd-b"));
  const opsWorkspace = await app.service.getWorkspace(app.actor("ops"));
  assert.equal(managerWorkspace.creatorSessions.length, 2);
  assert.equal(bdWorkspace.creatorSessions.length, 2);
  assert.equal(otherBdWorkspace.creatorSessions.length, 0);
  assert.equal(opsWorkspace.creatorSessions.length, 0);
  assert.deepEqual(managerWorkspace.metrics.paidOrders, paidOrdersBefore);
  assert.equal(app.state().orders.length, 0, "manual performance must not create order records");
  const exported = result<{ dataset: string; rows: CreatorSessionRecord[] }>(await app.service.execute(app.actor("manager"), {
    type: "export.record", dataset: "creatorSessions", filters: { creatorId: creator.id },
  }));
  assert.equal(exported.dataset, "creatorSessions");
  assert.equal(exported.rows.length, 2);
});

test("共享平台账号带货类型使用档案和账号 CAS，旧账号类型保持未知", async () => {
  const app = fixture();
  const creator = app.state().creators.find((item) => item.id === "demo-creator-a")!;
  const account = creator.accounts[0]!;
  assert.deepEqual(account.commerceTypes, []);
  const updated = result<typeof creator>(await app.service.execute(app.actor("manager"), {
    type: "creator.updateAccount", creatorId: creator.id, accountId: account.id,
    expectedVersion: creator.version, expectedProfileVersion: 1, expectedAccountVersion: 1,
    commerceTypes: ["live"],
  }));
  assert.deepEqual(updated.accounts[0]!.commerceTypes, ["live"]);
  assert.equal(updated.accounts[0]!.accountVersion, 2);
  await expectDomainError(app.service.execute(app.actor("manager"), {
    type: "creator.updateAccount", creatorId: creator.id, accountId: account.id,
    expectedVersion: updated.version, expectedProfileVersion: 1, expectedAccountVersion: 1,
    commerceTypes: [],
  }), "VERSION_CONFLICT");
  await expectDomainError(app.service.execute(app.actor("bd-a"), {
    type: "creator.updateAccount", creatorId: creator.id, accountId: account.id,
    expectedVersion: updated.version, expectedProfileVersion: 1, expectedAccountVersion: 2,
    commerceTypes: [],
  }), "FORBIDDEN");
  const created = result<{ accounts: Array<{ commerceTypes?: string[]; accountVersion?: number }> }>(await app.service.execute(app.actor("manager"), {
    type: "creator.create", name: "账号类型显式建档", platform: "channels",
    externalAccountId: "commerce-type-explicit-account", displayName: "显式选择直播",
    commerceTypes: ["live"],
  }));
  assert.deepEqual(created.accounts[0]!.commerceTypes, ["live"]);
  assert.equal(created.accounts[0]!.accountVersion, 1);
});

test("直接寄样按选定达人账号记录平台、直达待发货并只创建履约任务", async () => {
  const app = fixture();
  const creator = app.state().creators.find((item) => item.id === "demo-creator-a")!;
  const account = creator.accounts[0]!;
  const direct = result<SampleRequest>(await app.service.execute(app.actor("bd-a"), {
    type: "sample.request", creatorId: creator.id, creatorAccountId: account.id,
    expectedCreatorVersion: creator.version, lines: [{ productId: "demo-product-a", quantity: 1 }],
    recipient: { recipientName: "合成收件人", phone: null, address: "合成地址" }, reason: "商务直接申请寄样",
  }));
  assert.equal(direct.status, "pending_shipment");
  assert.equal(direct.creatorAccountId, account.id);
  assert.equal(direct.platform, account.platform);
  assert.equal(direct.decidedBy, null);
  assert.equal(direct.decidedAt, null);
  assert.ok(app.state().tasks.some((task) => task.relatedId === direct.id && task.kind === "sample_shipment" && task.requiredCapability === "sample.fulfill"));
  assert.equal(app.state().tasks.some((task) => task.relatedId === direct.id && task.kind === "sample_approval"), false);
  const audit = app.state().auditEvents.find((event) => event.entityId === direct.id && event.action === "sample.directly_requested");
  assert.equal(audit?.actorId, "demo-member-bd-a");
  assert.equal(audit?.after?.source, "direct_submission");

  const oldFlow = result<SampleRequest>(await app.service.execute(app.actor("bd-a"), {
    type: "sample.create", creatorId: creator.id, expectedCreatorVersion: creator.version,
    lines: [{ productId: "demo-product-a", quantity: 1 }],
    recipient: { recipientName: "合成收件人", phone: null, address: "合成地址" }, reason: "旧审批流程仍保留",
  }));
  assert.equal(oldFlow.status, "draft");
  assert.equal(oldFlow.creatorAccountId, undefined);
  assert.equal(oldFlow.platform, undefined);

  const sampleCount = app.state().samples.length;
  const taskCount = app.state().tasks.length;
  await expectDomainError(app.service.execute(app.actor("bd-a"), {
    type: "sample.request", creatorId: creator.id, creatorAccountId: "missing-account",
    expectedCreatorVersion: creator.version, lines: [{ productId: "demo-product-a", quantity: 1 }],
    recipient: { recipientName: "合成收件人", phone: null, address: "合成地址" }, reason: "错误账号不可提交",
  }), "NOT_FOUND");
  await expectDomainError(app.service.execute(app.actor("bd-a"), {
    type: "sample.request", creatorId: creator.id, creatorAccountId: account.id,
    expectedCreatorVersion: creator.version, lines: [{ productId: "missing-product", quantity: 1 }],
    recipient: { recipientName: "合成收件人", phone: null, address: "合成地址" }, reason: "错误商品不可提交",
  }), "NOT_FOUND");
  await expectDomainError(app.service.execute(app.actor("bd-a"), {
    type: "sample.request", creatorId: creator.id, creatorAccountId: account.id,
    expectedCreatorVersion: creator.version, lines: [{ productId: "demo-product-a", quantity: 1 }], reason: "缺收件信息不可提交",
  }), "BUSINESS_RULE_VIOLATION");
  await expectDomainError(app.service.execute(app.actor("ops"), {
    type: "sample.request", creatorId: creator.id, creatorAccountId: account.id,
    expectedCreatorVersion: creator.version, lines: [{ productId: "demo-product-a", quantity: 1 }],
    recipient: { recipientName: "合成收件人", phone: null, address: "合成地址" }, reason: "运营不可提交申请",
  }), "FORBIDDEN");
  await expectDomainError(app.service.execute(app.actor("bd-b"), {
    type: "sample.request", creatorId: "demo-creator-a", creatorAccountId: account.id,
    expectedCreatorVersion: creator.version, lines: [{ productId: "demo-product-a", quantity: 1 }],
    recipient: { recipientName: "合成收件人", phone: null, address: "合成地址" }, reason: "非本人达人不可申请",
  }), "NOT_FOUND");
  const deactivated = result<typeof creator>(await app.service.execute(app.actor("manager"), {
    type: "creator.updateAccount", creatorId: creator.id, accountId: account.id,
    expectedVersion: creator.version, expectedProfileVersion: 1, expectedAccountVersion: 1, active: false,
  }));
  await expectDomainError(app.service.execute(app.actor("bd-a"), {
    type: "sample.request", creatorId: creator.id, creatorAccountId: account.id,
    expectedCreatorVersion: deactivated.version, lines: [{ productId: "demo-product-a", quantity: 1 }],
    recipient: { recipientName: "合成收件人", phone: null, address: "合成地址" }, reason: "已停用账号不可申请",
  }), "NOT_FOUND");
  assert.equal(app.state().samples.length, sampleCount);
  assert.equal(app.state().tasks.length, taskCount);
});

test("catalog.saveProduct 同事务创建店铺、商品和货盘，失败不留孤立商品", async () => {
  const app = fixture();
  const saved = result<{ store: ManualStore; product: { id: string; sampleCostCents: number | null }; assortment: StoreAssortment }>(await app.service.execute(app.actor("manager"), {
    type: "catalog.saveProduct",
    newStore: { platform: "douyin", externalShopId: "CATALOG-STORE-01", name: "合成商品店" },
    newProduct: { brand: "合成品牌", name: "合成商品", sku: "CATALOG-SKU-01", sampleCostCents: 0 },
    priceCents: 0, livePriceCents: 0, creatorCommissionBps: 0, salesCardUrl: "https://example.invalid/card",
  }));
  assert.equal(saved.store.connectionMode, "manual");
  assert.equal(saved.product.sampleCostCents, 0);
  assert.equal(saved.assortment.priceCents, 0);
  assert.equal(saved.assortment.livePriceCents, 0);
  assert.equal(saved.assortment.creatorCommissionBps, 0);
  assert.equal(saved.assortment.salesCardUrl, "https://example.invalid/card");

  const inactive = result<ManualStore>(await app.service.execute(app.actor("manager"), {
    type: "store.create", platform: "douyin", externalShopId: "CATALOG-INACTIVE-01", name: "已停用店铺",
  }));
  await app.service.execute(app.actor("manager"), { type: "store.update", storeId: inactive.id, expectedVersion: 1, active: false });
  const productCount = app.state().products.length;
  const assortmentCount = app.state().storeAssortments.length;
  await expectDomainError(app.service.execute(app.actor("manager"), {
    type: "catalog.saveProduct", storeId: inactive.id,
    newProduct: { brand: "合成品牌", name: "不能遗留的商品" },
  }), "BUSINESS_RULE_VIOLATION");
  assert.equal(app.state().products.length, productCount);
  assert.equal(app.state().storeAssortments.length, assortmentCount);
  await expectDomainError(app.service.execute(app.actor("bd-a"), {
    type: "catalog.saveProduct", storeId: saved.store.id, productId: saved.product.id,
  }), "FORBIDDEN");
});
