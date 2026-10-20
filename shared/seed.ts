import type {
  AuditEvent,
  Creator,
  CreatorStageEvent,
  DataMode,
  DomainState,
  Member,
  OwnerAssignment,
  Product,
  SampleRequest,
  WorkTask,
} from "./types.ts";

export function createEmptyState(orgId: string, dataMode: DataMode = "production"): DomainState {
  return {
    schemaVersion: 1,
    dataMode,
    orgId,
    teams: [], members: [], creators: [], ownerAssignments: [], creatorStageEvents: [],
    followups: [], creatorSessions: [], salesReports: [], tasks: [], products: [], samples: [], samplePackages: [],
    manualStores: [], storeAssortments: [], creatorProductProposals: [], partnerResources: [],
    cooperationPartnerLinks: [], contentAssets: [], contentObservations: [], commercialLedgerEntries: [], teamMonthlyTargets: [],
    cooperations: [], schedules: [], deliveries: [], orders: [], refunds: [],
    ownerCorrections: [], importBatches: [], auditEvents: [],
  };
}

/** Fixed synthetic records for local demo/test workspaces only. Never used as a production default. */
export function createDemoState(): DomainState {
  const at = "2026-10-13T09:00:00+08:00";
  const orgId = "demo-org";
  const teamId = "demo-team-main";
  const otherTeamId = "demo-team-other";
  const admin: Member = { id: "demo-member-admin", principalId: "demo:admin", displayName: "演示管理员", orgId, teamId, role: "admin", capabilities: ["sample.approve", "sample.fulfill", "cooperation.approve", "import.manage", "audit.read", "export.run"], active: true, version: 1, createdAt: at, createdBy: "system", updatedAt: at, updatedBy: "system" };
  const manager: Member = { id: "demo-member-manager", principalId: "demo:manager", displayName: "演示主管", orgId, teamId, role: "manager", capabilities: ["sample.approve", "cooperation.approve", "import.manage", "audit.read", "export.run"], active: true, version: 1, createdAt: at, createdBy: "system", updatedAt: at, updatedBy: "system" };
  const bdA: Member = { id: "demo-member-bd-a", principalId: "demo:bd-a", displayName: "演示商务甲", orgId, teamId, role: "bd", capabilities: [], active: true, version: 1, createdAt: at, createdBy: "system", updatedAt: at, updatedBy: "system" };
  const bdB: Member = { id: "demo-member-bd-b", principalId: "demo:bd-b", displayName: "演示商务乙", orgId, teamId, role: "bd", capabilities: [], active: true, version: 1, createdAt: at, createdBy: "system", updatedAt: at, updatedBy: "system" };
  const ops: Member = { id: "demo-member-ops", principalId: "demo:ops", displayName: "演示样品运营", orgId, teamId, role: "ops", capabilities: ["sample.fulfill"], active: true, version: 1, createdAt: at, createdBy: "system", updatedAt: at, updatedBy: "system" };
  const other: Member = { id: "demo-member-other", principalId: "demo:other-team-bd", displayName: "演示异团队商务", orgId, teamId: otherTeamId, role: "bd", capabilities: [], active: true, version: 1, createdAt: at, createdBy: "system", updatedAt: at, updatedBy: "system" };

  const creatorA: Creator = {
    id: "demo-creator-a", orgId, teamId, name: "虚构达人·林间日记", category: "家居生活", tags: ["收纳", "家居"], source: "合成演示数据",
    accounts: [{ id: "demo-account-a", platform: "douyin", externalAccountId: "DEMO-DY-ALPHA-001", displayName: "林间日记（演示）", profileUrl: null, active: true, commerceTypes: [], accountVersion: 1, firstSeenAt: at, lastVerifiedAt: at }],
    ownerMemberId: bdA.id, crmStage: "contacted", pausedFromStage: null, pauseReason: null, reviewAt: null, declineReason: null,
    contact: null, internalNote: "仅用于演示，不是真实达人资料。", archived: false, mergedIntoCreatorId: null, version: 1, createdAt: at, createdBy: admin.id, updatedAt: at, updatedBy: admin.id,
  };
  const creatorB: Creator = {
    id: "demo-creator-b", orgId, teamId, name: "虚构达人·慢慢食记", category: "食品饮料", tags: ["测评"], source: "合成演示数据",
    accounts: [{ id: "demo-account-b", platform: "douyin", externalAccountId: "DEMO-DY-BETA-002", displayName: "慢慢食记（演示）", profileUrl: null, active: true, commerceTypes: [], accountVersion: 1, firstSeenAt: at, lastVerifiedAt: at }],
    ownerMemberId: bdB.id, crmStage: "uncontacted", pausedFromStage: null, pauseReason: null, reviewAt: null, declineReason: null,
    contact: null, internalNote: "仅用于演示，不是真实达人资料。", archived: false, mergedIntoCreatorId: null, version: 1, createdAt: at, createdBy: admin.id, updatedAt: at, updatedBy: admin.id,
  };
  const publicCreator: Creator = {
    id: "demo-creator-public", orgId, teamId, name: "虚构达人·小城种草簿", category: "美妆个护", tags: ["公海"], source: "合成演示数据",
    accounts: [{ id: "demo-account-public", platform: "douyin", externalAccountId: "DEMO-DY-GAMMA-003", displayName: "小城种草簿（演示）", profileUrl: null, active: true, commerceTypes: [], accountVersion: 1, firstSeenAt: at, lastVerifiedAt: null }],
    ownerMemberId: null, crmStage: "uncontacted", pausedFromStage: null, pauseReason: null, reviewAt: null, declineReason: null,
    contact: null, internalNote: "仅用于演示，不是真实达人资料。", archived: false, mergedIntoCreatorId: null, version: 1, createdAt: at, createdBy: admin.id, updatedAt: at, updatedBy: admin.id,
  };
  const otherCreator: Creator = {
    id: "demo-creator-other", orgId, teamId: otherTeamId, name: "虚构达人·远山露营社", category: "户外", tags: ["露营"], source: "合成演示数据",
    accounts: [{ id: "demo-account-other", platform: "douyin", externalAccountId: "DEMO-DY-DELTA-004", displayName: "远山露营社（演示）", profileUrl: null, active: true, commerceTypes: [], accountVersion: 1, firstSeenAt: at, lastVerifiedAt: at }],
    ownerMemberId: other.id, crmStage: "responded", pausedFromStage: null, pauseReason: null, reviewAt: null, declineReason: null,
    contact: null, internalNote: "仅用于演示，不是真实达人资料。", archived: false, mergedIntoCreatorId: null, version: 1, createdAt: at, createdBy: admin.id, updatedAt: at, updatedBy: admin.id,
  };

  const assignments: OwnerAssignment[] = [
    { id: "demo-owner-a", orgId, teamId, creatorId: creatorA.id, memberId: bdA.id, validFrom: at, validTo: null, changedBy: admin.id, reason: "演示初始分配" },
    { id: "demo-owner-b", orgId, teamId, creatorId: creatorB.id, memberId: bdB.id, validFrom: at, validTo: null, changedBy: admin.id, reason: "演示初始分配" },
    { id: "demo-owner-public", orgId, teamId, creatorId: publicCreator.id, memberId: null, validFrom: at, validTo: null, changedBy: admin.id, reason: "演示新达人进入公海" },
    { id: "demo-owner-other", orgId, teamId: otherTeamId, creatorId: otherCreator.id, memberId: other.id, validFrom: at, validTo: null, changedBy: admin.id, reason: "演示初始分配" },
  ];
  const stageEvents: CreatorStageEvent[] = [
    { id: "demo-stage-a", orgId, teamId, creatorId: creatorA.id, stage: "uncontacted", occurredAt: at, recordedAt: at, actorId: admin.id, reason: null },
    { id: "demo-stage-a-contacted", orgId, teamId, creatorId: creatorA.id, stage: "contacted", occurredAt: at, recordedAt: at, actorId: admin.id, reason: "合成演示数据" },
    { id: "demo-stage-b", orgId, teamId, creatorId: creatorB.id, stage: "uncontacted", occurredAt: at, recordedAt: at, actorId: admin.id, reason: null },
    { id: "demo-stage-public", orgId, teamId, creatorId: publicCreator.id, stage: "uncontacted", occurredAt: at, recordedAt: at, actorId: admin.id, reason: null },
    { id: "demo-stage-other", orgId, teamId: otherTeamId, creatorId: otherCreator.id, stage: "uncontacted", occurredAt: at, recordedAt: at, actorId: admin.id, reason: null },
    { id: "demo-stage-other-responded", orgId, teamId: otherTeamId, creatorId: otherCreator.id, stage: "responded", occurredAt: at, recordedAt: at, actorId: admin.id, reason: "合成演示数据" },
  ];

  const product: Product = { id: "demo-product-a", orgId, teamId, brand: "虚构品牌·云朵日常", name: "演示收纳盒", sku: "DEMO-SKU-001", specification: "演示规格", sampleCostCents: null, active: true, note: "合成演示商品", version: 1, createdAt: at, createdBy: admin.id, updatedAt: at, updatedBy: admin.id };
  const sample: SampleRequest = {
    id: "demo-sample-a", orgId, teamId, creatorId: creatorA.id, cooperationId: null, applicantId: bdA.id,
    lines: [{ id: "demo-sample-line-a", productId: product.id, quantity: 2 }],
    recipient: { recipientName: "演示收件人", phone: null, address: "演示地址-仅用于界面验证" },
    shippingBlocked: false,
    reason: "合成演示样品申请", status: "pending_shipment", decidedBy: manager.id, decidedAt: at,
    decisionReason: "演示审批通过", closeReason: null, originalRequestId: null,
    version: 1, createdAt: at, createdBy: bdA.id, updatedAt: at, updatedBy: manager.id,
  };
  const task: WorkTask = {
    id: "demo-task-a", orgId, teamId, creatorId: creatorA.id, kind: "sample_shipment", title: "演示样品待发货",
    ownerMemberId: ops.id, requiredCapability: null, dueAt: "2026-10-15T09:00:00+08:00", status: "open", relatedType: "sample", relatedId: sample.id,
    completedAt: null, completionNote: null, priority: "normal", version: 1,
    createdAt: at, createdBy: bdA.id, updatedAt: at, updatedBy: bdA.id,
  };
  const audit: AuditEvent = { id: "demo-audit-sample", orgId, teamId, actorId: manager.id, entityType: "sample", entityId: sample.id, action: "sample.approved", occurredAt: at, reason: "合成演示数据", before: { status: "pending_approval" }, after: { status: "pending_shipment" } };

  const state: DomainState = createEmptyState(orgId, "demo");
  state.teams = [
    { id: teamId, orgId, name: "演示商务一组", active: true, version: 1 },
    { id: otherTeamId, orgId, name: "演示其他团队", active: true, version: 1 },
  ];
  state.members = [admin, manager, bdA, bdB, ops, other];
  state.creators = [creatorA, creatorB, publicCreator, otherCreator];
  state.ownerAssignments = assignments;
  state.creatorStageEvents = stageEvents;
  state.products = [product];
  state.samples = [sample];
  state.tasks = [task];
  state.auditEvents = [audit];
  return state;
}
