import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { Request, Response } from "../http/contracts.ts";
import type { Actor, DomainState, OrderLine, RefundEvent, WorkspaceSnapshot } from "../../shared/types.ts";
import type { CsvImportRequest, SessionResponse } from "../../shared/http.ts";
import { createDemoState } from "../../shared/seed.ts";
import { DomainService, type DomainStore } from "../domain/domain-service.ts";
import { DaboApiService, exportSnapshot } from "../modules/dabo/dabo-api.service.ts";
import { IdentityProvider } from "../modules/dabo/identity.ts";
import { parseCsv, prepareCsv } from "../modules/dabo/csv.ts";

const manager: Actor = { principalId: "demo:manager" };
const IMPORT_TIME = "2026-10-13T10:00:00+08:00";

class StaticIdentityProvider extends IdentityProvider {
  readonly mode = "demo" as const;

  constructor(private readonly actorValue: Actor) {
    super();
  }

  actor(_request: Request): Actor { return this.actorValue; }

  async session(_request: Request, _response: Response, domain: DomainService): Promise<SessionResponse> {
    return { ...(await domain.getSession(this.actorValue)), appName: "Test" };
  }

  assertWrite(_request: Request): void {}
}

function fixture() {
  let state = structuredClone(createDemoState());
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
  const domain = new DomainService(store, {
    runtime: { now: () => IMPORT_TIME, id: (prefix) => `${prefix}-${++sequence}` },
  });
  return { store, domain, state: () => state };
}

function legacyDigest(payload: {
  kind: CsvImportRequest["kind"];
  sourceName: string;
  creators: unknown[];
  orders: unknown[];
  refunds: unknown[];
}): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function legacyBatchId(actor: Actor, digest: string): string {
  return `csv-${createHash("sha256").update(`${actor.principalId}:${digest}`).digest("hex").slice(0, 40)}`;
}

test("workspace reads keep export-only selectors out of strict workspace filters", async () => {
  const app = fixture();
  const api = new DaboApiService(app.store, new StaticIdentityProvider(manager));
  const request = { headers: {} } as Request;

  const defaultWorkspace = await api.workspace(request, {});
  const closedWorkspace = await api.workspace(request, { includeClosed: true });
  assert.deepEqual(defaultWorkspace.orders, closedWorkspace.orders);
  assert.deepEqual(defaultWorkspace.refunds, closedWorkspace.refunds);
});

test("legacy no-platform creator, order and refund CSV replay existing batches without new audit events", async () => {
  const app = fixture();
  const api = new DaboApiService(app.store, new StaticIdentityProvider(manager));
  const request = { headers: {} } as Request;
  const cases: Array<{
    input: CsvImportRequest;
    legacyPayload: { kind: CsvImportRequest["kind"]; sourceName: string; creators: unknown[]; orders: unknown[]; refunds: unknown[] };
  }> = [
    {
      input: {
        kind: "creators",
        sourceName: "legacy-creators.csv",
        csvText: "name,externalAccountId,displayName,category,tags\nLegacy Synthetic Creator,LEGACY-CREATOR,Legacy Account,Synthetic,test",
      },
      legacyPayload: {
        kind: "creators", sourceName: "legacy-creators.csv",
        creators: [{
          rowNumber: 2, platform: "douyin", externalAccountId: "LEGACY-CREATOR",
          name: "Legacy Synthetic Creator", displayName: "Legacy Account", profileUrl: null,
          category: "Synthetic", tags: ["test"], source: "csv", contact: null,
        }],
        orders: [], refunds: [],
      },
    },
    {
      input: {
        kind: "orders",
        sourceName: "legacy-orders.csv",
        csvText: "shopId,externalOrderId,externalLineId,creatorAccountId,paidAt,status,paidAmount\nLEGACY-SHOP,LEGACY-ORDER,LEGACY-LINE,DEMO-DY-ALPHA-001,2026-10-13 10:00:00,paid,100.00",
      },
      legacyPayload: {
        kind: "orders", sourceName: "legacy-orders.csv", creators: [],
        orders: [{
          rowNumber: 2, shopId: "LEGACY-SHOP", externalOrderId: "LEGACY-ORDER", externalLineId: "LEGACY-LINE",
          creatorAccountId: "DEMO-DY-ALPHA-001", productId: null, sku: null,
          paidAt: "2026-10-13T10:00:00+08:00", sourceStatus: "paid", status: "paid",
          paidAmountCents: 10000, rawAmount: "100.00",
        }],
        refunds: [],
      },
    },
    {
      input: {
        kind: "refunds",
        sourceName: "legacy-refunds.csv",
        csvText: "shopId,externalRefundId,externalOrderId,externalLineId,refundedAt,status,amount,direction\nLEGACY-SHOP,LEGACY-REFUND,LEGACY-ORDER,LEGACY-LINE,2026-10-13 11:00:00,succeeded,30.00,refund",
      },
      legacyPayload: {
        kind: "refunds", sourceName: "legacy-refunds.csv", creators: [], orders: [],
        refunds: [{
          rowNumber: 2, shopId: "LEGACY-SHOP", externalRefundId: "LEGACY-REFUND",
          externalOrderId: "LEGACY-ORDER", externalLineId: "LEGACY-LINE",
          refundedAt: "2026-10-13T11:00:00+08:00", sourceStatus: "succeeded", status: "succeeded",
          amountCents: 3000, rawAmount: "30.00", direction: "refund",
        }],
      },
    },
  ];

  for (const { input, legacyPayload } of cases) {
    const prepared = prepareCsv(input);
    const oldDigest = legacyDigest(legacyPayload);
    assert.equal(prepared.digest, oldDigest, "the parser must keep the historical digest shape for no-platform CSVs");
    const batchId = legacyBatchId(manager, oldDigest);
    await app.domain.execute(manager, {
      ...prepared.command,
      type: "import.commit",
      batchId,
      creators: prepared.command.creators,
      orders: prepared.command.orders.map(({ platform: _platform, ...row }) => row),
      refunds: prepared.command.refunds.map(({ platform: _platform, ...row }) => row),
    });

    const priorBatchIds = app.state().importBatches.map((batch) => batch.id);
    const priorAuditIds = app.state().auditEvents.map((event) => event.id);
    const preview = await api.preview(request, input);
    assert.equal(preview.result?.batchId, batchId);
    await api.commit(request, { ...input, previewHash: preview.previewHash });
    assert.deepEqual(app.state().importBatches.map((batch) => batch.id), priorBatchIds);
    assert.deepEqual(app.state().auditEvents.map((event) => event.id), priorAuditIds);
  }
});

test("explicit platform values distinguish otherwise identical CSV payloads", () => {
  const rows = ["platform,externalOrderId,externalLineId,status,paidAmount", "PLATFORM,SHARED-ORDER,SHARED-LINE,paid,100.00"];
  const douyin = prepareCsv({ kind: "orders", csvText: rows.join("\n").replace("PLATFORM", "douyin") });
  const channels = prepareCsv({ kind: "orders", csvText: rows.join("\n").replace("PLATFORM", "channels") });
  assert.notEqual(douyin.digest, channels.digest);
});

test("creator, order, and refund exports include platform identity", () => {
  const snapshot = {
    dataMode: "demo",
    members: [],
    creators: [{
      id: "creator-a", name: "Synthetic creator",
      accounts: [
        { platform: "douyin", externalAccountId: "shared-account" },
        { platform: "channels", externalAccountId: "shared-account" },
      ],
      category: null, tags: [], crmStage: "uncontacted", ownerMemberId: null,
    }],
    orders: ["douyin", "channels"].map((platform) => ({
      platform,
      externalOrderId: "shared-order", externalLineId: "shared-line", creatorId: null,
      paidAt: null, status: "paid", paidAmountCents: 10000,
      ownerSnapshot: { memberId: null }, importBatchId: `batch-${platform}`,
    })),
    refunds: ["douyin", "channels"].map((platform) => ({
      platform,
      externalRefundId: "shared-refund", orderLineId: `order-${platform}`,
      refundedAt: null, status: "succeeded", direction: "refund", amountCents: 1000,
      importBatchId: `batch-${platform}`,
    })),
  } as unknown as WorkspaceSnapshot;

  const creatorsCsv = parseCsv(exportSnapshot(snapshot, "creators"));
  assert.deepEqual(creatorsCsv.rows[0]?.values["平台"], "douyin;channels");
  assert.deepEqual(creatorsCsv.rows[0]?.values["平台账号ID"], "shared-account;shared-account");

  const ordersCsv = parseCsv(exportSnapshot(snapshot, "orders"));
  assert.deepEqual(ordersCsv.rows.map((row) => row.values["平台"]), ["douyin", "channels"]);
  assert.deepEqual(ordersCsv.rows.map((row) => row.values["订单号"]), ["shared-order", "shared-order"]);

  const refundsCsv = parseCsv(exportSnapshot(snapshot, "refunds"));
  assert.deepEqual(refundsCsv.rows.map((row) => row.values["平台"]), ["douyin", "channels"]);
  assert.deepEqual(refundsCsv.rows.map((row) => row.values["退款ID"]), ["shared-refund", "shared-refund"]);
});

test("order and refund exports match date, product search, platform, creator, owner correction, and audit filters", async () => {
  const app = fixture();
  const state = app.state();
  const teamId = "demo-team-main";
  const creatorId = "demo-creator-a";
  const productId = "demo-product-a";
  const correctedOwnerId = "demo-member-bd-b";
  state.products.find((product) => product.id === productId)!.name = "SyntheticProductName";
  const makeOrder = (overrides: Partial<OrderLine> = {}): OrderLine => ({
    id: "target", orgId: state.orgId, teamId, platform: "channels", shopId: null,
    externalOrderId: "target-order", externalLineId: "target-line", productId, sku: "SYNTH-SKU",
    creatorAccountId: "DEMO-DY-ALPHA-001", creatorId, paidAt: "2026-10-14T10:00:00+08:00",
    sourceStatus: "已支付", status: "paid", paidAmountCents: 1000, rawAmount: "10.00",
    ownerSnapshot: { memberId: "demo-member-bd-a", assignedAt: "2026-10-14T10:00:00+08:00", ruleVersion: "paid_at_owner_v1", reason: "matched" },
    sourceEvidenceUrl: null, importBatchId: "synthetic", sourceRowNumber: 2, contentFingerprint: "fp-target",
    createdAt: "2026-10-14T10:00:00+08:00", createdBy: "demo-member-manager", updatedAt: "2026-10-14T10:00:00+08:00", updatedBy: "demo-member-manager", version: 1,
    ...overrides,
  });
  const target = makeOrder();
  state.orders = [
    target,
    makeOrder({ id: "outside-range", externalOrderId: "outside-order", externalLineId: "outside-line", paidAt: "2026-09-14T10:00:00+08:00", contentFingerprint: "fp-outside" }),
    makeOrder({ id: "wrong-platform", externalOrderId: "wrong-platform-order", externalLineId: "wrong-platform-line", platform: "douyin", contentFingerprint: "fp-platform" }),
    makeOrder({ id: "wrong-creator", externalOrderId: "wrong-creator-order", externalLineId: "wrong-creator-line", creatorId: "demo-creator-a", contentFingerprint: "fp-creator" }),
  ];
  const makeRefund = (overrides: Partial<RefundEvent> = {}): RefundEvent => ({
    id: "refund-target", orgId: state.orgId, teamId, platform: "channels", shopId: null,
    externalRefundId: "refund-target", orderLineId: "target", refundedAt: "2026-10-14T11:00:00+08:00",
    sourceStatus: "退款成功", status: "succeeded", amountCents: 100, direction: "refund", rawAmount: "1.00",
    sourceEvidenceUrl: null, importBatchId: "synthetic-refund", sourceRowNumber: 2, contentFingerprint: "fp-refund-target",
    createdAt: "2026-10-14T11:00:00+08:00", createdBy: "demo-member-manager", version: 1,
    ...overrides,
  });
  state.refunds = [
    makeRefund(),
    makeRefund({ id: "refund-outside", externalRefundId: "refund-outside", refundedAt: "2026-09-14T11:00:00+08:00", contentFingerprint: "fp-refund-outside" }),
  ];
  state.ownerCorrections = [{
    id: "correction-target", orgId: state.orgId, teamId, orderLineId: "target",
    previousMemberId: "demo-member-bd-a", correctedMemberId: correctedOwnerId,
    correctedAt: "2026-10-14T12:00:00+08:00", recordedAt: "2026-10-14T12:00:00+08:00",
    correctedBy: "demo-member-manager", reason: "Synthetic owner correction",
  }];

  const api = new DaboApiService(app.store, new StaticIdentityProvider(manager));
  const request = { headers: {} } as Request;
  const commonFilters = {
    dateFrom: "2026-10-14", dateTo: "2026-10-14", teamId, platform: "channels",
    creatorId, ownerMemberId: correctedOwnerId,
  };
  const ordersCsv = parseCsv(await api.export(request, "orders", { ...commonFilters, search: "SyntheticProductName" }));
  assert.deepEqual(ordersCsv.rows.map((row) => row.values["订单号"]), ["target-order"]);
  const creatorSearchCsv = parseCsv(await api.export(request, "orders", { ...commonFilters, search: "虚构达人·林间日记" }));
  assert.deepEqual(creatorSearchCsv.rows.map((row) => row.values["订单号"]), ["target-order"]);

  const refundsCsv = parseCsv(await api.export(request, "refunds", { ...commonFilters, search: "refund-target" }));
  assert.deepEqual(refundsCsv.rows.map((row) => row.values["退款ID"]), ["refund-target"]);

  const audit = app.state().auditEvents.filter((event) => event.action === "export.refunds").at(-1);
  assert.equal(audit?.after?.dateFrom, "2026-10-14");
  assert.equal(audit?.after?.dateTo, "2026-10-14");
  assert.equal(audit?.after?.teamId, teamId);
  assert.equal(audit?.after?.ownerMemberId, correctedOwnerId);
  assert.equal(audit?.after?.platform, "channels");
  assert.equal(audit?.after?.creatorId, creatorId);
  assert.equal(audit?.after?.searchApplied, true);
});
