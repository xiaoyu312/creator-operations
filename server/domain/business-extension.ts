import type {
  Actor,
  BusinessRuleNote,
  CommercialLedgerEntry,
  ContentAsset,
  ContentAssetWorkspaceItem,
  ContentObservation,
  Cooperation,
  CooperationPartnerLink,
  Creator,
  CreatorProductProposal,
  CreatorProductProposalItem,
  DomainState,
  ManualStore,
  PartnerResource,
  Product,
  StoreAssortment,
  TeamMonthlyTarget,
  TeamMonthlyTargetWorkspaceItem,
  WorkspaceFilters,
  WorkspaceSnapshot,
} from "../../shared/types.ts";
import { WORKSPACE_BUSINESS_RULE_NOTES } from "../../shared/types.ts";
import type { DomainCommand } from "../../shared/commands.ts";
import { assertTeamTarget, requireManagerOrAdmin, type AuthContext } from "./auth.ts";
import { domainError } from "./errors.ts";
import {
  addAudit,
  assertIsoDateTime,
  checkVersion,
  incrementVersion,
  normalizeKey,
  type DomainRuntime,
} from "./utils.ts";

export type BusinessDomainCommand = Extract<DomainCommand,
  | { type: "store.create" | "store.update" }
  | { type: "catalog.saveProduct" }
  | { type: "assortment.create" | "assortment.update" }
  | { type: "proposal.create" | "proposal.updateDraft" | "proposal.submit" | "proposal.recordOutcome" | "proposal.cancel" | "proposal.convert" }
  | { type: "partnerResource.create" | "partnerResource.update" }
  | { type: "cooperationPartnerLink.create" | "cooperationPartnerLink.update" }
  | { type: "contentAsset.create" | "contentAsset.registerFromDelivery" | "contentAsset.update" | "contentAsset.updateRights" }
  | { type: "contentObservation.append" }
  | { type: "ledgerEntry.create" | "ledgerEntry.void" }
  | { type: "teamTarget.upsert" }
>;

const BUSINESS_COMMAND_TYPES = new Set<string>([
  "store.create", "store.update", "catalog.saveProduct", "assortment.create", "assortment.update",
  "proposal.create", "proposal.updateDraft", "proposal.submit", "proposal.recordOutcome", "proposal.cancel", "proposal.convert",
  "partnerResource.create", "partnerResource.update", "cooperationPartnerLink.create", "cooperationPartnerLink.update",
  "contentAsset.create", "contentAsset.registerFromDelivery", "contentAsset.update", "contentAsset.updateRights",
  "contentObservation.append", "ledgerEntry.create", "ledgerEntry.void", "teamTarget.upsert",
]);

export function isBusinessDomainCommand(command: DomainCommand): command is BusinessDomainCommand {
  return BUSINESS_COMMAND_TYPES.has(command.type);
}

export interface ProposalCooperationCreator {
  create(command: Extract<DomainCommand, { type: "cooperation.create" }>): Cooperation;
  createProduct(command: Extract<DomainCommand, { type: "product.create" }>): Product;
}

type Projection = Pick<WorkspaceSnapshot,
  | "businessRuleNotes" | "manualStores" | "storeAssortments" | "creatorProductProposals"
  | "partnerResources" | "cooperationPartnerLinks" | "contentAssets" | "contentObservations"
  | "commercialLedgerEntries" | "teamMonthlyTargets"
>;

export class BusinessDomainExtension {
  projectWorkspace(state: DomainState, auth: AuthContext, filters: WorkspaceFilters, now: string): Projection {
    const visibleTeam = (teamId: string) => auth.role === "admin"
      ? (!filters.teamId || filters.teamId === teamId)
      : teamId === auth.member.teamId;
    const teamRows = <T extends { orgId: string; teamId: string }>(rows: T[]) => rows.filter((row) => row.orgId === state.orgId && visibleTeam(row.teamId));
    const memberCanSeeCreator = (creatorId: string) => {
      const creator = state.creators.find((item) => item.id === creatorId && item.orgId === state.orgId && !item.archived);
      if (!creator || !visibleTeam(creator.teamId)) return false;
      return auth.role !== "bd" || creator.ownerMemberId === auth.member.id;
    };

    if (auth.role === "ops") return {
      businessRuleNotes: [...WORKSPACE_BUSINESS_RULE_NOTES], manualStores: [], storeAssortments: [], creatorProductProposals: [],
      partnerResources: [], cooperationPartnerLinks: [], contentAssets: [], contentObservations: [],
      commercialLedgerEntries: [], teamMonthlyTargets: [],
    };

    const stores = teamRows(state.manualStores).filter((item) => filters.includeClosed || item.active);
    const storeIds = new Set(stores.map((item) => item.id));
    const productIds = new Set(teamRows(state.products).filter((item) => filters.includeClosed || item.active).map((item) => item.id));
    const assortments = teamRows(state.storeAssortments).filter((item) => storeIds.has(item.storeId) && productIds.has(item.productId)
      && (filters.includeClosed || item.active));
    const proposals = teamRows(state.creatorProductProposals).filter((item) => (auth.role !== "bd" || memberCanSeeCreator(item.creatorId))
      && (filters.includeClosed || !["rejected", "converted", "cancelled"].includes(item.status)));
    const visiblePartnerResources = teamRows(state.partnerResources).filter((item) => filters.includeClosed || item.active).map((item) => {
      const copy = structuredClone(item);
      if (auth.role === "bd") {
        copy.contactName = null;
        copy.contactPhone = null;
        copy.contactHandle = null;
        copy.privateNote = null;
      }
      return copy;
    });
    const partnershipCooperations = new Set(state.cooperations.filter((item) => item.orgId === state.orgId && visibleTeam(item.teamId)
      && (auth.role !== "bd" || memberCanSeeCreator(item.creatorId))).map((item) => item.id));
    const partnerLinks = teamRows(state.cooperationPartnerLinks).filter((item) => (auth.role !== "bd" || partnershipCooperations.has(item.cooperationId))
      && (filters.includeClosed || item.active));
    const contentAssets = teamRows(state.contentAssets).filter((item) => auth.role !== "bd" || memberCanSeeCreator(item.creatorId)).map((item): ContentAssetWorkspaceItem => {
      const copy = structuredClone(item);
      const creator = state.creators.find((candidate) => candidate.id === copy.creatorId && candidate.orgId === state.orgId && !candidate.archived);
      const validNow = copy.rightsStatus === "authorized"
        && copy.rightsScope.length > 0
        && copy.rightsValidFrom !== null
        && creator?.teamId === copy.teamId
        && Date.parse(copy.rightsValidFrom) <= Date.parse(now)
        && (copy.rightsValidUntil === null || Date.parse(copy.rightsValidUntil) >= Date.parse(now));
      return { ...copy, authorizationEffectiveNow: validNow, effectiveRightsScope: validNow ? [...copy.rightsScope] : [] };
    });
    const contentIds = new Set(contentAssets.map((item) => item.id));
    const observations = teamRows(state.contentObservations).filter((item) => contentIds.has(item.contentAssetId));

    const isFinanceRole = auth.role === "manager" || auth.role === "admin";
    const ledger = isFinanceRole ? teamRows(state.commercialLedgerEntries).filter((item) => filters.includeClosed || item.status === "recorded") : [];
    const targets = isFinanceRole ? teamRows(state.teamMonthlyTargets).map((item) => this.withActual(item, state, now)) : [];
    const allowedPartnerIds = new Set(visiblePartnerResources.map((item) => item.id));
    return {
      businessRuleNotes: [...WORKSPACE_BUSINESS_RULE_NOTES],
      manualStores: stores,
      storeAssortments: assortments,
      creatorProductProposals: proposals,
      partnerResources: visiblePartnerResources,
      cooperationPartnerLinks: partnerLinks.filter((link) => allowedPartnerIds.has(link.partnerResourceId)),
      contentAssets,
      contentObservations: observations,
      commercialLedgerEntries: ledger,
      teamMonthlyTargets: targets,
    };
  }

  execute(
    state: DomainState,
    auth: AuthContext,
    command: BusinessDomainCommand,
    runtime: DomainRuntime,
    cooperationCreator: ProposalCooperationCreator,
  ): unknown {
    switch (command.type) {
      case "store.create": return this.createStore(state, auth, command, runtime);
      case "store.update": return this.updateStore(state, auth, command, runtime);
      case "catalog.saveProduct": return this.saveCatalogProduct(state, auth, command, runtime, cooperationCreator);
      case "assortment.create": return this.createAssortment(state, auth, command, runtime);
      case "assortment.update": return this.updateAssortment(state, auth, command, runtime);
      case "proposal.create": return this.createProposal(state, auth, command, runtime);
      case "proposal.updateDraft": return this.updateProposal(state, auth, command, runtime);
      case "proposal.submit": return this.submitProposal(state, auth, command, runtime);
      case "proposal.recordOutcome": return this.recordProposalOutcome(state, auth, command, runtime);
      case "proposal.cancel": return this.cancelProposal(state, auth, command, runtime);
      case "proposal.convert": return this.convertProposal(state, auth, command, runtime, cooperationCreator);
      case "partnerResource.create": return this.createPartnerResource(state, auth, command, runtime);
      case "partnerResource.update": return this.updatePartnerResource(state, auth, command, runtime);
      case "cooperationPartnerLink.create": return this.createPartnerLink(state, auth, command, runtime);
      case "cooperationPartnerLink.update": return this.updatePartnerLink(state, auth, command, runtime);
      case "contentAsset.create": return this.createContentAsset(state, auth, command, runtime);
      case "contentAsset.registerFromDelivery": return this.registerFromDelivery(state, auth, command, runtime);
      case "contentAsset.update": return this.updateContentAsset(state, auth, command, runtime);
      case "contentAsset.updateRights": return this.updateAssetRights(state, auth, command, runtime);
      case "contentObservation.append": return this.appendObservation(state, auth, command, runtime);
      case "ledgerEntry.create": return this.createLedgerEntry(state, auth, command, runtime);
      case "ledgerEntry.void": return this.voidLedgerEntry(state, auth, command, runtime);
      case "teamTarget.upsert": return this.upsertTeamTarget(state, auth, command, runtime);
    }
  }

  private withActual(target: TeamMonthlyTarget, state: DomainState, now: string): TeamMonthlyTargetWorkspaceItem {
    const [year, month] = target.month.split("-").map(Number);
    const start = new Date(`${target.month}-01T00:00:00+08:00`).getTime();
    const end = new Date(`${month === 12 ? year + 1 : year}-${String(month === 12 ? 1 : month + 1).padStart(2, "0")}-01T00:00:00+08:00`).getTime();
    let actualValue = 0;
    let actualUnknownCount = 0;
    const cutoff = Date.parse(now);
    const monthEvent = (value: string | null) => value !== null && Date.parse(value) >= start && Date.parse(value) < end && Date.parse(value) <= cutoff;
    if (target.metric === "paid_gmv") {
      for (const order of state.orders) {
        if (order.orgId !== target.orgId || order.teamId !== target.teamId || order.status !== "paid" || !monthEvent(order.paidAt)) continue;
        if (order.paidAmountCents === null) actualUnknownCount += 1;
        else actualValue += order.paidAmountCents;
      }
    } else if (target.metric === "approved_deliveries") {
      actualValue = state.deliveries.filter((delivery) => delivery.orgId === target.orgId && delivery.teamId === target.teamId && delivery.status === "approved"
        && monthEvent(delivery.reviews.filter((review) => review.decision === "approved").sort((a, b) => Date.parse(b.reviewedAt) - Date.parse(a.reviewedAt))[0]?.reviewedAt ?? null)).length;
    } else {
      const firstContactAt = new Map<string, number>();
      for (const event of state.creatorStageEvents) {
        if (event.orgId !== target.orgId || event.teamId !== target.teamId || event.stage !== "contacted") continue;
        const at = Date.parse(event.occurredAt);
        if (at > cutoff) continue;
        const prior = firstContactAt.get(event.creatorId);
        if (prior === undefined || at < prior) firstContactAt.set(event.creatorId, at);
      }
      actualValue = [...firstContactAt.values()].filter((at) => at >= start && at < end).length;
    }
    return { ...structuredClone(target), actualValue, actualUnknownCount, actualComplete: actualUnknownCount === 0, actualSource: "visible_domain_records_only" };
  }

  private managerOrAdmin(auth: AuthContext): void {
    requireManagerOrAdmin(auth, "仅主管或管理员可维护团队级资料");
  }

  private financeRole(auth: AuthContext): void {
    if (auth.role !== "manager" && auth.role !== "admin") domainError("FORBIDDEN", "仅主管或管理员可查看或维护费用与月目标");
  }

  private creatorForAction(state: DomainState, auth: AuthContext, creatorId: string): Creator {
    const creator = state.creators.find((item) => item.id === creatorId && item.orgId === state.orgId && !item.archived);
    if (!creator || (auth.role !== "admin" && creator.teamId !== auth.member.teamId)) domainError("NOT_FOUND", "达人不存在或当前账号无权访问");
    if (auth.role === "ops") domainError("NOT_FOUND", "达人不存在或当前账号无权访问");
    return creator;
  }

  private assertCreatorEdit(auth: AuthContext, creator: Creator): void {
    if (auth.role === "admin") return;
    if (auth.role === "manager" && creator.teamId === auth.member.teamId) return;
    if (auth.role === "bd" && creator.teamId === auth.member.teamId && creator.ownerMemberId === auth.member.id) return;
    domainError("NOT_FOUND", "达人不存在或当前账号无权访问");
  }

  assertCreatorTransferAllowed(state: DomainState, creator: Creator, targetTeamId: string): void {
    if (creator.teamId === targetTeamId) return;
    const openProposals = state.creatorProductProposals.filter((item) => item.orgId === state.orgId && item.creatorId === creator.id
      && ["draft", "proposed", "accepted"].includes(item.status));
    const activeCooperations = new Set(state.cooperations.filter((item) => item.orgId === state.orgId && item.creatorId === creator.id
      && !["delivered", "cancelled", "rejected"].includes(item.status)).map((item) => item.id));
    const openPartnerLinks = state.cooperationPartnerLinks.filter((item) => item.orgId === state.orgId && item.active && activeCooperations.has(item.cooperationId));
    if (openProposals.length > 0 || openPartnerLinks.length > 0) {
      domainError("BUSINESS_RULE_VIOLATION", "跨团队转交前请先转换或关闭所有未结推品提案，并停用未结合作的团长/机构关联，避免原团队快照与新团队资源串用");
    }
  }

  reassignCreatorReferencesOnMerge(
    state: DomainState,
    auth: AuthContext,
    source: Creator,
    target: Creator,
    runtime: DomainRuntime,
    accountIdMap: ReadonlyMap<string, string>,
  ): void {
    if (source.teamId !== target.teamId) domainError("IDENTITY_CONFLICT", "跨团队合并不能迁移团队资源引用");
    for (const proposal of state.creatorProductProposals.filter((item) => item.orgId === state.orgId && item.creatorId === source.id)) {
      const before = { creatorId: proposal.creatorId };
      proposal.creatorId = target.id;
      incrementVersion(proposal, runtime.now(), auth.member.id);
      addAudit(state, runtime, auth.member.id, proposal, "creator_product_proposal", proposal.id, "proposal.creator_merged", "达人身份合并", before, { creatorId: proposal.creatorId, version: proposal.version });
    }
    for (const asset of state.contentAssets.filter((item) => item.orgId === state.orgId && item.creatorId === source.id)) {
      const before = { creatorId: asset.creatorId };
      asset.creatorId = target.id;
      incrementVersion(asset, runtime.now(), auth.member.id);
      addAudit(state, runtime, auth.member.id, asset, "content_asset", asset.id, "content_asset.creator_merged", "达人身份合并", before, { creatorId: asset.creatorId, version: asset.version });
    }
    for (const session of state.creatorSessions.filter((item) => item.orgId === state.orgId && item.creatorId === source.id)) {
      const before = { creatorId: session.creatorId, teamId: session.teamId, creatorAccountId: session.creatorAccountId };
      const creatorAccountId = accountIdMap.get(session.creatorAccountId);
      if (!creatorAccountId) domainError("IDENTITY_CONFLICT", "达人历史表现记录引用了待合并账号之外的账号");
      session.creatorId = target.id;
      session.teamId = target.teamId;
      session.creatorAccountId = creatorAccountId;
      incrementVersion(session, runtime.now(), auth.member.id);
      addAudit(state, runtime, auth.member.id, session, "creator_session", session.id, "creator_session.creator_merged", "达人身份合并", before, {
        creatorId: session.creatorId, teamId: session.teamId, version: session.version,
        creatorAccountId: session.creatorAccountId,
      });
    }
  }

  private targetTeam(state: DomainState, auth: AuthContext, teamId: string) {
    assertTeamTarget(state, auth, teamId);
    return state.teams.find((item) => item.id === teamId && item.orgId === state.orgId && item.active)!;
  }

  private storeForAction(state: DomainState, auth: AuthContext, storeId: string): ManualStore {
    const store = state.manualStores.find((item) => item.id === storeId && item.orgId === state.orgId);
    if (!store || (auth.role !== "admin" && store.teamId !== auth.member.teamId)) domainError("NOT_FOUND", "店铺不存在或当前账号无权访问");
    return store;
  }

  private assortmentForAction(state: DomainState, auth: AuthContext, assortmentId: string): StoreAssortment {
    const item = state.storeAssortments.find((entry) => entry.id === assortmentId && entry.orgId === state.orgId);
    if (!item || (auth.role !== "admin" && item.teamId !== auth.member.teamId)) domainError("NOT_FOUND", "货盘记录不存在或当前账号无权访问");
    return item;
  }

  private productForAction(state: DomainState, auth: AuthContext, productId: string, requireActive = true): Product {
    const product = state.products.find((item) => item.id === productId && item.orgId === state.orgId);
    if (!product || (auth.role !== "admin" && product.teamId !== auth.member.teamId)) domainError("NOT_FOUND", "商品不存在或当前账号无权访问");
    if (requireActive && !product.active) domainError("BUSINESS_RULE_VIOLATION", "商品已停用，不能加入可用货盘");
    return product;
  }

  private resourceForAction(state: DomainState, auth: AuthContext, resourceId: string, requireActive = false): PartnerResource {
    const resource = state.partnerResources.find((item) => item.id === resourceId && item.orgId === state.orgId);
    if (!resource || (auth.role !== "admin" && resource.teamId !== auth.member.teamId)) domainError("NOT_FOUND", "团长或机构资源不存在或当前账号无权访问");
    if (requireActive && !resource.active) domainError("BUSINESS_RULE_VIOLATION", "团长或机构资源已停用");
    return resource;
  }

  private assertPeriod(validFrom: string | null, validUntil: string | null, field: string): void {
    if (validFrom) assertIsoDateTime(validFrom, `${field}开始时间`);
    if (validUntil) assertIsoDateTime(validUntil, `${field}结束时间`);
    if (validFrom && validUntil && Date.parse(validUntil) < Date.parse(validFrom)) domainError("VALIDATION_ERROR", `${field}结束时间不能早于开始时间`);
  }

  private requireCurrentAssortment(state: DomainState, auth: AuthContext, id: string, now: string): { assortment: StoreAssortment; store: ManualStore; product: Product } {
    const assortment = this.assortmentForAction(state, auth, id);
    const store = this.storeForAction(state, auth, assortment.storeId);
    const product = this.productForAction(state, auth, assortment.productId);
    if (!assortment.active || !store.active) domainError("BUSINESS_RULE_VIOLATION", "店铺或货盘已停用，不能推品");
    if (assortment.validFrom && Date.parse(assortment.validFrom) > Date.parse(now)) domainError("BUSINESS_RULE_VIOLATION", "货盘有效期尚未开始，不能推品");
    if (assortment.validUntil && Date.parse(assortment.validUntil) < Date.parse(now)) domainError("BUSINESS_RULE_VIOLATION", "货盘已过有效期，不能推品");
    return { assortment, store, product };
  }

  private proposalForAction(state: DomainState, auth: AuthContext, proposalId: string): CreatorProductProposal {
    const proposal = state.creatorProductProposals.find((item) => item.id === proposalId && item.orgId === state.orgId);
    if (!proposal || (auth.role !== "admin" && proposal.teamId !== auth.member.teamId)) domainError("NOT_FOUND", "推品提案不存在或当前账号无权访问");
    const creator = this.creatorForAction(state, auth, proposal.creatorId);
    if (auth.role === "bd" && creator.ownerMemberId !== auth.member.id) domainError("NOT_FOUND", "推品提案不存在或当前账号无权访问");
    return proposal;
  }

  private assertProposalEdit(state: DomainState, auth: AuthContext, proposal: CreatorProductProposal): Creator {
    const creator = this.creatorForAction(state, auth, proposal.creatorId);
    if (auth.role === "bd" && creator.ownerMemberId === auth.member.id) return creator;
    domainError("NOT_FOUND", "推品提案不存在或当前账号无权访问");
  }

  private proposalItems(state: DomainState, auth: AuthContext, assortmentIds: string[], now: string): CreatorProductProposalItem[] {
    if (new Set(assortmentIds).size !== assortmentIds.length) domainError("VALIDATION_ERROR", "推品提案不能重复选择同一货盘");
    return assortmentIds.map((id) => {
      const { assortment, store, product } = this.requireCurrentAssortment(state, auth, id, now);
      return {
        storeAssortmentId: assortment.id, assortmentVersion: assortment.version, storeId: store.id, productId: product.id,
        productVersion: product.version, productName: product.name, sku: product.sku, specification: product.specification,
        priceCents: assortment.priceCents, livePriceCents: assortment.livePriceCents, creatorCommissionBps: assortment.creatorCommissionBps,
        mainSellingPoints: [...assortment.mainSellingPoints], sellingPointEvidenceUrl: assortment.sellingPointEvidenceUrl,
        salesCardUrl: assortment.salesCardUrl, productGroups: [...assortment.productGroups],
      };
    });
  }

  private assertProposalItemsCurrent(state: DomainState, auth: AuthContext, proposal: CreatorProductProposal, now: string): void {
    for (const snapshot of proposal.items) {
      const { assortment, store, product } = this.requireCurrentAssortment(state, auth, snapshot.storeAssortmentId, now);
      if (store.id !== snapshot.storeId || product.id !== snapshot.productId || assortment.productId !== snapshot.productId) {
        domainError("BUSINESS_RULE_VIOLATION", "提案引用的店铺商品已变化，请重新选择当前有效货盘");
      }
    }
  }

  private createStore(state: DomainState, auth: AuthContext, command: Extract<BusinessDomainCommand, { type: "store.create" }>, runtime: DomainRuntime): ManualStore {
    this.managerOrAdmin(auth);
    const teamId = command.teamId ?? auth.member.teamId;
    this.targetTeam(state, auth, teamId);
    const externalShopId = normalizeKey(command.externalShopId);
    if (state.manualStores.some((item) => item.orgId === state.orgId && item.platform === command.platform && normalizeKey(item.externalShopId) === externalShopId)) {
      domainError("IDENTITY_CONFLICT", "该平台店铺 ID 已登记，请检查是否重复或已归属其他团队");
    }
    const now = runtime.now();
    const store: ManualStore = { id: runtime.id("store"), orgId: state.orgId, teamId, platform: command.platform, externalShopId, name: command.name, note: command.note ?? null, active: true, connectionMode: "manual", connectionStatus: "not_connected", version: 1, createdAt: now, createdBy: auth.member.id, updatedAt: now, updatedBy: auth.member.id };
    state.manualStores.push(store);
    addAudit(state, runtime, auth.member.id, store, "manual_store", store.id, "manual_store.created", null, null, { platform: store.platform, name: store.name, active: store.active, connectionStatus: store.connectionStatus });
    return structuredClone(store);
  }

  private saveCatalogProduct(
    state: DomainState,
    auth: AuthContext,
    command: Extract<BusinessDomainCommand, { type: "catalog.saveProduct" }>,
    runtime: DomainRuntime,
    creators: ProposalCooperationCreator,
  ): { store: ManualStore; product: Product; assortment: StoreAssortment } {
    this.managerOrAdmin(auth);
    const hasStoreId = command.storeId !== undefined;
    const hasNewStore = command.newStore !== undefined;
    const hasProductId = command.productId !== undefined;
    const hasNewProduct = command.newProduct !== undefined;
    if (hasStoreId === hasNewStore || hasProductId === hasNewProduct) {
      domainError("VALIDATION_ERROR", "请选择已有店铺或新建店铺，并选择已有商品或新建商品");
    }
    const store = command.newStore
      ? this.createStore(state, auth, { type: "store.create", ...command.newStore }, runtime)
      : this.storeForAction(state, auth, command.storeId!);
    const product = command.newProduct
      ? creators.createProduct({ type: "product.create", ...command.newProduct })
      : this.productForAction(state, auth, command.productId!);
    const assortment = this.createAssortment(state, auth, {
      type: "assortment.create",
      storeId: store.id,
      productId: product.id,
      priceCents: command.priceCents ?? null,
      livePriceCents: command.livePriceCents ?? null,
      creatorCommissionBps: command.creatorCommissionBps ?? null,
      mainSellingPoints: [],
      sellingPointEvidenceUrl: null,
      salesCardUrl: command.salesCardUrl ?? null,
      productGroups: [],
      validFrom: null,
      validUntil: null,
    }, runtime);
    return { store, product, assortment };
  }

  private updateStore(state: DomainState, auth: AuthContext, command: Extract<BusinessDomainCommand, { type: "store.update" }>, runtime: DomainRuntime): ManualStore {
    this.managerOrAdmin(auth);
    const store = this.storeForAction(state, auth, command.storeId);
    checkVersion(store, command.expectedVersion);
    const before = { name: store.name, note: store.note, active: store.active };
    if (command.name !== undefined) store.name = command.name;
    if ("note" in command) store.note = command.note ?? null;
    if (command.active !== undefined) store.active = command.active;
    incrementVersion(store, runtime.now(), auth.member.id);
    addAudit(state, runtime, auth.member.id, store, "manual_store", store.id, "manual_store.updated", null, before, { name: store.name, active: store.active });
    return structuredClone(store);
  }

  private createAssortment(state: DomainState, auth: AuthContext, command: Extract<BusinessDomainCommand, { type: "assortment.create" }>, runtime: DomainRuntime): StoreAssortment {
    this.managerOrAdmin(auth);
    const store = this.storeForAction(state, auth, command.storeId);
    if (!store.active) domainError("BUSINESS_RULE_VIOLATION", "店铺已停用，不能新增货盘");
    const product = this.productForAction(state, auth, command.productId);
    if (product.teamId !== store.teamId) domainError("NOT_FOUND", "商品不存在或当前账号无权访问");
    if (state.storeAssortments.some((item) => item.orgId === state.orgId && item.storeId === store.id && item.productId === product.id)) {
      domainError("BUSINESS_RULE_VIOLATION", "该店铺已存在此商品的货盘，请编辑原记录");
    }
    this.assertPeriod(command.validFrom ?? null, command.validUntil ?? null, "货盘有效期");
    const now = runtime.now();
    const item: StoreAssortment = {
      id: runtime.id("assortment"), orgId: state.orgId, teamId: store.teamId, storeId: store.id, productId: product.id,
      priceCents: command.priceCents ?? null, livePriceCents: command.livePriceCents ?? null, creatorCommissionBps: command.creatorCommissionBps ?? null,
      mainSellingPoints: [...new Set(command.mainSellingPoints)], sellingPointEvidenceUrl: command.sellingPointEvidenceUrl ?? null,
      salesCardUrl: command.salesCardUrl ?? null, productGroups: [...new Set(command.productGroups)],
      validFrom: command.validFrom ?? null, validUntil: command.validUntil ?? null, active: true,
      version: 1, createdAt: now, createdBy: auth.member.id, updatedAt: now, updatedBy: auth.member.id,
    };
    state.storeAssortments.push(item);
    addAudit(state, runtime, auth.member.id, item, "store_assortment", item.id, "assortment.created", null, null, { storeId: item.storeId, productId: item.productId, priceCents: item.priceCents, livePriceCents: item.livePriceCents, creatorCommissionBps: item.creatorCommissionBps, groups: item.productGroups.length });
    return structuredClone(item);
  }

  private updateAssortment(state: DomainState, auth: AuthContext, command: Extract<BusinessDomainCommand, { type: "assortment.update" }>, runtime: DomainRuntime): StoreAssortment {
    this.managerOrAdmin(auth);
    const item = this.assortmentForAction(state, auth, command.assortmentId);
    checkVersion(item, command.expectedVersion);
    this.assertPeriod(command.validFrom !== undefined ? command.validFrom : item.validFrom, command.validUntil !== undefined ? command.validUntil : item.validUntil, "货盘有效期");
    const before = { priceCents: item.priceCents, livePriceCents: item.livePriceCents, creatorCommissionBps: item.creatorCommissionBps, active: item.active };
    if ("priceCents" in command) item.priceCents = command.priceCents ?? null;
    if ("livePriceCents" in command) item.livePriceCents = command.livePriceCents ?? null;
    if ("creatorCommissionBps" in command) item.creatorCommissionBps = command.creatorCommissionBps ?? null;
    if (command.mainSellingPoints !== undefined) item.mainSellingPoints = [...new Set(command.mainSellingPoints)];
    if ("sellingPointEvidenceUrl" in command) item.sellingPointEvidenceUrl = command.sellingPointEvidenceUrl ?? null;
    if ("salesCardUrl" in command) item.salesCardUrl = command.salesCardUrl ?? null;
    if (command.productGroups !== undefined) item.productGroups = [...new Set(command.productGroups)];
    if ("validFrom" in command) item.validFrom = command.validFrom ?? null;
    if ("validUntil" in command) item.validUntil = command.validUntil ?? null;
    if (command.active !== undefined) item.active = command.active;
    incrementVersion(item, runtime.now(), auth.member.id);
    addAudit(state, runtime, auth.member.id, item, "store_assortment", item.id, "assortment.updated", null, before, { priceCents: item.priceCents, livePriceCents: item.livePriceCents, creatorCommissionBps: item.creatorCommissionBps, active: item.active, version: item.version });
    return structuredClone(item);
  }

  private createProposal(state: DomainState, auth: AuthContext, command: Extract<BusinessDomainCommand, { type: "proposal.create" }>, runtime: DomainRuntime): CreatorProductProposal {
    if (auth.role !== "bd") domainError("FORBIDDEN", "推品提案由当前达人负责人记录");
    const creator = this.creatorForAction(state, auth, command.creatorId);
    this.assertCreatorEdit(auth, creator);
    const items = this.proposalItems(state, auth, command.assortmentIds, runtime.now());
    const now = runtime.now();
    const proposal: CreatorProductProposal = {
      id: runtime.id("proposal"), orgId: creator.orgId, teamId: creator.teamId, creatorId: creator.id,
      title: command.title, deliveryRequirement: command.deliveryRequirement, sampleRequirement: command.sampleRequirement,
      items, status: "draft", proposedAt: null, outcomeAt: null, outcomeNote: null, convertedCooperationId: null,
      version: 1, createdAt: now, createdBy: auth.member.id, updatedAt: now, updatedBy: auth.member.id,
    };
    state.creatorProductProposals.push(proposal);
    addAudit(state, runtime, auth.member.id, proposal, "creator_product_proposal", proposal.id, "proposal.created", null, null, { creatorId: proposal.creatorId, itemCount: items.length, status: proposal.status });
    return structuredClone(proposal);
  }

  private updateProposal(state: DomainState, auth: AuthContext, command: Extract<BusinessDomainCommand, { type: "proposal.updateDraft" }>, runtime: DomainRuntime): CreatorProductProposal {
    const proposal = this.proposalForAction(state, auth, command.proposalId);
    const creator = this.assertProposalEdit(state, auth, proposal);
    checkVersion(proposal, command.expectedVersion);
    if (proposal.status !== "draft") domainError("INVALID_TRANSITION", "只有草稿推品提案可以修改");
    const items = command.assortmentIds ? this.proposalItems(state, auth, command.assortmentIds, runtime.now()) : proposal.items;
    const before = { title: proposal.title, itemCount: proposal.items.length, deliveryRequirement: proposal.deliveryRequirement, status: proposal.status };
    if (command.title !== undefined) proposal.title = command.title;
    if (command.deliveryRequirement !== undefined) proposal.deliveryRequirement = command.deliveryRequirement;
    if (command.sampleRequirement !== undefined) proposal.sampleRequirement = command.sampleRequirement;
    proposal.items = structuredClone(items);
    proposal.teamId = creator.teamId;
    incrementVersion(proposal, runtime.now(), auth.member.id);
    addAudit(state, runtime, auth.member.id, proposal, "creator_product_proposal", proposal.id, "proposal.draft_updated", null, before, { title: proposal.title, itemCount: proposal.items.length, status: proposal.status, version: proposal.version });
    return structuredClone(proposal);
  }

  private submitProposal(state: DomainState, auth: AuthContext, command: Extract<BusinessDomainCommand, { type: "proposal.submit" }>, runtime: DomainRuntime): CreatorProductProposal {
    const proposal = this.proposalForAction(state, auth, command.proposalId);
    this.assertProposalEdit(state, auth, proposal);
    checkVersion(proposal, command.expectedVersion);
    if (proposal.status !== "draft") domainError("INVALID_TRANSITION", "只有草稿提案可以标记为已记录推品");
    this.assertProposalItemsCurrent(state, auth, proposal, runtime.now());
    proposal.status = "proposed";
    proposal.proposedAt = runtime.now();
    incrementVersion(proposal, runtime.now(), auth.member.id);
    addAudit(state, runtime, auth.member.id, proposal, "creator_product_proposal", proposal.id, "proposal.proposed_recorded", null, { status: "draft" }, { status: proposal.status, proposedAt: proposal.proposedAt, itemCount: proposal.items.length });
    return structuredClone(proposal);
  }

  private recordProposalOutcome(state: DomainState, auth: AuthContext, command: Extract<BusinessDomainCommand, { type: "proposal.recordOutcome" }>, runtime: DomainRuntime): CreatorProductProposal {
    const proposal = this.proposalForAction(state, auth, command.proposalId);
    this.assertProposalEdit(state, auth, proposal);
    checkVersion(proposal, command.expectedVersion);
    if (proposal.status !== "proposed") domainError("INVALID_TRANSITION", "只有已记录推品的提案可以记录接受或拒绝结果");
    if (command.outcome === "rejected" && !command.note?.trim()) domainError("BUSINESS_RULE_VIOLATION", "记录拒绝结果时必须填写原因");
    const before = { status: proposal.status, outcomeNote: proposal.outcomeNote };
    proposal.status = command.outcome;
    proposal.outcomeAt = runtime.now();
    proposal.outcomeNote = command.note ?? null;
    incrementVersion(proposal, runtime.now(), auth.member.id);
    addAudit(state, runtime, auth.member.id, proposal, "creator_product_proposal", proposal.id, `proposal.${command.outcome}`, command.note ?? null, before, { status: proposal.status, outcomeAt: proposal.outcomeAt });
    return structuredClone(proposal);
  }

  private cancelProposal(state: DomainState, auth: AuthContext, command: Extract<BusinessDomainCommand, { type: "proposal.cancel" }>, runtime: DomainRuntime): CreatorProductProposal {
    const proposal = this.proposalForAction(state, auth, command.proposalId);
    if (auth.role === "bd") this.assertProposalEdit(state, auth, proposal);
    else if (auth.role !== "manager" && auth.role !== "admin") domainError("NOT_FOUND", "推品提案不存在或当前账号无权访问");
    checkVersion(proposal, command.expectedVersion);
    if (!["draft", "proposed", "accepted"].includes(proposal.status)) domainError("INVALID_TRANSITION", "当前提案不能关闭");
    const before = { status: proposal.status, outcomeNote: proposal.outcomeNote };
    proposal.status = "cancelled";
    proposal.outcomeAt = runtime.now();
    proposal.outcomeNote = command.reason;
    incrementVersion(proposal, runtime.now(), auth.member.id);
    addAudit(state, runtime, auth.member.id, proposal, "creator_product_proposal", proposal.id, "proposal.cancelled", command.reason, before, { status: proposal.status, outcomeAt: proposal.outcomeAt });
    return structuredClone(proposal);
  }

  private convertProposal(
    state: DomainState,
    auth: AuthContext,
    command: Extract<BusinessDomainCommand, { type: "proposal.convert" }>,
    runtime: DomainRuntime,
    cooperationCreator: ProposalCooperationCreator,
  ): { proposal: CreatorProductProposal; cooperation: Cooperation; idempotent: boolean } {
    const proposal = this.proposalForAction(state, auth, command.proposalId);
    const creator = this.assertProposalEdit(state, auth, proposal);
    if (proposal.status === "converted" && proposal.convertedCooperationId) {
      const existing = state.cooperations.find((item) => item.id === proposal.convertedCooperationId && item.orgId === state.orgId);
      if (!existing) domainError("BUSINESS_RULE_VIOLATION", "已转换提案缺少关联合作草稿，需管理员核对");
      return { proposal: structuredClone(proposal), cooperation: structuredClone(existing), idempotent: true };
    }
    checkVersion(proposal, command.expectedVersion);
    if (proposal.status !== "accepted") domainError("INVALID_TRANSITION", "只有已接受的提案可以转换为合作草稿");
    this.assertProposalItemsCurrent(state, auth, proposal, runtime.now());
    const cooperation = cooperationCreator.create({
      type: "cooperation.create", creatorId: creator.id, expectedCreatorVersion: creator.version,
      title: proposal.title, sampleRequirement: proposal.sampleRequirement, deliveryRequirement: proposal.deliveryRequirement,
      startAt: null, endAt: null, note: `由推品提案 ${proposal.id} 转换；商品与货盘条款按提案快照冻结。`,
      lines: proposal.items.map((item) => ({
        productId: item.productId, productName: item.productName, sku: item.sku, specification: item.specification,
        agreedPriceCents: item.livePriceCents ?? item.priceCents, livePriceCents: item.livePriceCents,
        creatorCommissionBps: item.creatorCommissionBps, agreedQuantity: null, deliveryRequirement: proposal.deliveryRequirement,
        note: null, storeId: item.storeId, storeAssortmentId: item.storeAssortmentId, assortmentVersion: item.assortmentVersion,
        sellingPointsSnapshot: item.mainSellingPoints, sellingPointEvidenceUrl: item.sellingPointEvidenceUrl,
        salesCardUrl: item.salesCardUrl, productGroupsSnapshot: item.productGroups,
      })),
    });
    const before = { status: proposal.status, convertedCooperationId: proposal.convertedCooperationId };
    proposal.status = "converted";
    proposal.convertedCooperationId = cooperation.id;
    incrementVersion(proposal, runtime.now(), auth.member.id);
    addAudit(state, runtime, auth.member.id, proposal, "creator_product_proposal", proposal.id, "proposal.converted", null, before, { status: proposal.status, cooperationId: cooperation.id, itemCount: proposal.items.length });
    return { proposal: structuredClone(proposal), cooperation, idempotent: false };
  }

  private createPartnerResource(state: DomainState, auth: AuthContext, command: Extract<BusinessDomainCommand, { type: "partnerResource.create" }>, runtime: DomainRuntime): PartnerResource {
    this.managerOrAdmin(auth);
    const teamId = command.teamId ?? auth.member.teamId;
    this.targetTeam(state, auth, teamId);
    const now = runtime.now();
    const resource: PartnerResource = {
      id: runtime.id("partner-resource"), orgId: state.orgId, teamId, kind: command.kind, name: command.name,
      summary: command.summary, tags: [...new Set(command.tags)], contactName: command.contactName ?? null,
      contactPhone: command.contactPhone ?? null, contactHandle: command.contactHandle ?? null,
      privateNote: command.privateNote ?? null, active: true,
      version: 1, createdAt: now, createdBy: auth.member.id, updatedAt: now, updatedBy: auth.member.id,
    };
    state.partnerResources.push(resource);
    addAudit(state, runtime, auth.member.id, resource, "partner_resource", resource.id, "partner_resource.created", null, null, { kind: resource.kind, name: resource.name, tags: resource.tags.length, active: resource.active });
    return structuredClone(resource);
  }

  private updatePartnerResource(state: DomainState, auth: AuthContext, command: Extract<BusinessDomainCommand, { type: "partnerResource.update" }>, runtime: DomainRuntime): PartnerResource {
    this.managerOrAdmin(auth);
    const resource = this.resourceForAction(state, auth, command.resourceId);
    checkVersion(resource, command.expectedVersion);
    const before = { name: resource.name, summary: resource.summary, tags: resource.tags, active: resource.active };
    if (command.name !== undefined) resource.name = command.name;
    if (command.summary !== undefined) resource.summary = command.summary;
    if (command.tags !== undefined) resource.tags = [...new Set(command.tags)];
    if ("contactName" in command) resource.contactName = command.contactName ?? null;
    if ("contactPhone" in command) resource.contactPhone = command.contactPhone ?? null;
    if ("contactHandle" in command) resource.contactHandle = command.contactHandle ?? null;
    if ("privateNote" in command) resource.privateNote = command.privateNote ?? null;
    if (command.active !== undefined) resource.active = command.active;
    incrementVersion(resource, runtime.now(), auth.member.id);
    addAudit(state, runtime, auth.member.id, resource, "partner_resource", resource.id, "partner_resource.updated", null, before, { name: resource.name, summary: resource.summary, tags: resource.tags.length, active: resource.active });
    return structuredClone(resource);
  }

  private cooperationForAction(state: DomainState, auth: AuthContext, cooperationId: string): Cooperation {
    const cooperation = state.cooperations.find((item) => item.id === cooperationId && item.orgId === state.orgId);
    if (!cooperation || (auth.role !== "admin" && cooperation.teamId !== auth.member.teamId)) domainError("NOT_FOUND", "合作单不存在或当前账号无权访问");
    if (auth.role === "ops") domainError("NOT_FOUND", "合作单不存在或当前账号无权访问");
    return cooperation;
  }

  private assertCooperationEditable(auth: AuthContext, cooperation: Cooperation): void {
    if (auth.role === "admin") return;
    if (auth.role === "manager" && cooperation.teamId === auth.member.teamId) return;
    if (auth.role === "bd" && cooperation.teamId === auth.member.teamId && cooperation.ownerMemberId === auth.member.id && cooperation.status === "draft") return;
    domainError("NOT_FOUND", "合作单不存在或当前账号无权访问");
  }

  private partnerLinkForAction(state: DomainState, auth: AuthContext, linkId: string): CooperationPartnerLink {
    const link = state.cooperationPartnerLinks.find((item) => item.id === linkId && item.orgId === state.orgId);
    if (!link || (auth.role !== "admin" && link.teamId !== auth.member.teamId)) domainError("NOT_FOUND", "合作资源关联不存在或当前账号无权访问");
    const cooperation = this.cooperationForAction(state, auth, link.cooperationId);
    this.assertCooperationEditable(auth, cooperation);
    return link;
  }

  private createPartnerLink(state: DomainState, auth: AuthContext, command: Extract<BusinessDomainCommand, { type: "cooperationPartnerLink.create" }>, runtime: DomainRuntime): CooperationPartnerLink {
    const cooperation = this.cooperationForAction(state, auth, command.cooperationId);
    this.assertCooperationEditable(auth, cooperation);
    const resource = this.resourceForAction(state, auth, command.partnerResourceId, true);
    if (resource.teamId !== cooperation.teamId) domainError("NOT_FOUND", "关联资源不存在或当前账号无权访问");
    if (state.cooperationPartnerLinks.some((item) => item.orgId === state.orgId && item.cooperationId === cooperation.id && item.partnerResourceId === resource.id && item.active)) {
      domainError("BUSINESS_RULE_VIOLATION", "该资源已关联到此合作单");
    }
    const now = runtime.now();
    const link: CooperationPartnerLink = {
      id: runtime.id("partner-link"), orgId: state.orgId, teamId: cooperation.teamId, cooperationId: cooperation.id,
      partnerResourceId: resource.id, role: command.role, note: command.note ?? null, active: true,
      version: 1, createdAt: now, createdBy: auth.member.id, updatedAt: now, updatedBy: auth.member.id,
    };
    state.cooperationPartnerLinks.push(link);
    addAudit(state, runtime, auth.member.id, link, "cooperation_partner_link", link.id, "cooperation_partner_link.created", null, null, { cooperationId: link.cooperationId, partnerResourceId: link.partnerResourceId, role: link.role });
    return structuredClone(link);
  }

  private updatePartnerLink(state: DomainState, auth: AuthContext, command: Extract<BusinessDomainCommand, { type: "cooperationPartnerLink.update" }>, runtime: DomainRuntime): CooperationPartnerLink {
    const link = this.partnerLinkForAction(state, auth, command.linkId);
    checkVersion(link, command.expectedVersion);
    const before = { role: link.role, active: link.active };
    if (command.role !== undefined) link.role = command.role;
    if ("note" in command) link.note = command.note ?? null;
    if (command.active !== undefined) link.active = command.active;
    incrementVersion(link, runtime.now(), auth.member.id);
    addAudit(state, runtime, auth.member.id, link, "cooperation_partner_link", link.id, "cooperation_partner_link.updated", null, before, { role: link.role, active: link.active });
    return structuredClone(link);
  }

  private assertSafeUrl(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      domainError("VALIDATION_ERROR", "链接格式无效");
    }
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) domainError("VALIDATION_ERROR", "链接只允许不含账号凭据的 http/https 地址");
  }

  private contentAssetForAction(state: DomainState, auth: AuthContext, assetId: string): ContentAsset {
    const asset = state.contentAssets.find((item) => item.id === assetId && item.orgId === state.orgId);
    if (!asset || (auth.role !== "admin" && asset.teamId !== auth.member.teamId)) domainError("NOT_FOUND", "内容资产不存在或当前账号无权访问");
    const creator = this.creatorForAction(state, auth, asset.creatorId);
    this.assertCreatorEdit(auth, creator);
    return asset;
  }

  private validateAssetProducts(state: DomainState, auth: AuthContext, teamId: string, productIds: string[]): string[] {
    if (new Set(productIds).size !== productIds.length) domainError("VALIDATION_ERROR", "内容资产不能重复关联同一商品");
    return productIds.map((productId) => {
      const product = this.productForAction(state, auth, productId);
      if (product.teamId !== teamId) domainError("NOT_FOUND", "商品不存在或当前账号无权访问");
      return product.id;
    });
  }

  private newContentAsset(
    state: DomainState,
    auth: AuthContext,
    runtime: DomainRuntime,
    creator: Creator,
    deliveryId: string | null,
    sourceUrl: string,
    type: ContentAsset["type"],
    title: string,
    tags: string[],
    productIds: string[],
  ): ContentAsset {
    this.assertSafeUrl(sourceUrl);
    const products = this.validateAssetProducts(state, auth, creator.teamId, productIds);
    const now = runtime.now();
    const asset: ContentAsset = {
      id: runtime.id("content-asset"), orgId: creator.orgId, teamId: creator.teamId, creatorId: creator.id,
      deliveryId, sourceUrl, type, title, tags: [...new Set(tags)], productIds: products,
      rightsStatus: "unknown", rightsScope: [], rightsValidFrom: null, rightsValidUntil: null, rightsEvidenceUrl: null,
      version: 1, createdAt: now, createdBy: auth.member.id, updatedAt: now, updatedBy: auth.member.id,
    };
    state.contentAssets.push(asset);
    addAudit(state, runtime, auth.member.id, asset, "content_asset", asset.id, "content_asset.created", null, null, { creatorId: asset.creatorId, deliveryId: asset.deliveryId, type: asset.type, title: asset.title, tagCount: asset.tags.length, productCount: asset.productIds.length, rightsStatus: asset.rightsStatus });
    return asset;
  }

  private createContentAsset(state: DomainState, auth: AuthContext, command: Extract<BusinessDomainCommand, { type: "contentAsset.create" }>, runtime: DomainRuntime): ContentAsset {
    const creator = this.creatorForAction(state, auth, command.creatorId);
    this.assertCreatorEdit(auth, creator);
    return structuredClone(this.newContentAsset(state, auth, runtime, creator, null, command.sourceUrl, command.assetType, command.title, command.tags, command.productIds));
  }

  private registerFromDelivery(state: DomainState, auth: AuthContext, command: Extract<BusinessDomainCommand, { type: "contentAsset.registerFromDelivery" }>, runtime: DomainRuntime): ContentAsset {
    const delivery = state.deliveries.find((item) => item.id === command.deliveryId && item.orgId === state.orgId);
    if (!delivery || (auth.role !== "admin" && delivery.teamId !== auth.member.teamId)) domainError("NOT_FOUND", "已验收交付不存在或当前账号无权访问");
    checkVersion(delivery, command.expectedDeliveryVersion);
    if (delivery.status !== "approved") domainError("BUSINESS_RULE_VIOLATION", "只有已验收通过的交付可以登记为内容资产");
    const finalReview = delivery.reviews[delivery.reviews.length - 1];
    const acceptedSubmission = finalReview?.decision === "approved" ? delivery.submissions[finalReview.submissionIndex] : undefined;
    const acceptedUrl = acceptedSubmission?.contentUrl ?? acceptedSubmission?.evidenceUrl ?? null;
    if (!acceptedUrl) domainError("BUSINESS_RULE_VIOLATION", "最终验收提交没有可登记的内容或凭证链接，请先补交付链接或手工登记内容资产");
    if (command.sourceUrl !== acceptedUrl) domainError("BUSINESS_RULE_VIOLATION", "登记链接必须与最终验收通过的提交链接一致；其他链接请手工登记为独立资产");
    if (state.contentAssets.some((item) => item.orgId === state.orgId && item.deliveryId === delivery.id)) domainError("BUSINESS_RULE_VIOLATION", "此交付已登记内容资产，请从内容资产中查看");
    const creator = this.creatorForAction(state, auth, delivery.creatorId);
    this.assertCreatorEdit(auth, creator);
    return structuredClone(this.newContentAsset(state, auth, runtime, creator, delivery.id, command.sourceUrl, command.assetType, command.title, command.tags, command.productIds));
  }

  private updateContentAsset(state: DomainState, auth: AuthContext, command: Extract<BusinessDomainCommand, { type: "contentAsset.update" }>, runtime: DomainRuntime): ContentAsset {
    const asset = this.contentAssetForAction(state, auth, command.assetId);
    checkVersion(asset, command.expectedVersion);
    const before = { type: asset.type, title: asset.title, tagCount: asset.tags.length, productCount: asset.productIds.length };
    if (command.assetType !== undefined) asset.type = command.assetType;
    if (command.title !== undefined) asset.title = command.title;
    if (command.tags !== undefined) asset.tags = [...new Set(command.tags)];
    if (command.productIds !== undefined) asset.productIds = this.validateAssetProducts(state, auth, asset.teamId, command.productIds);
    incrementVersion(asset, runtime.now(), auth.member.id);
    addAudit(state, runtime, auth.member.id, asset, "content_asset", asset.id, "content_asset.updated", null, before, { type: asset.type, title: asset.title, tagCount: asset.tags.length, productCount: asset.productIds.length });
    return structuredClone(asset);
  }

  private updateAssetRights(state: DomainState, auth: AuthContext, command: Extract<BusinessDomainCommand, { type: "contentAsset.updateRights" }>, runtime: DomainRuntime): ContentAsset {
    const asset = this.contentAssetForAction(state, auth, command.assetId);
    checkVersion(asset, command.expectedVersion);
    this.assertPeriod(command.rightsValidFrom, command.rightsValidUntil, "内容授权有效期");
    if (command.rightsEvidenceUrl) this.assertSafeUrl(command.rightsEvidenceUrl);
    if (command.rightsStatus === "authorized") {
      if (command.rightsScope.length === 0 || !command.rightsValidFrom || !command.rightsEvidenceUrl) domainError("BUSINESS_RULE_VIOLATION", "授权状态必须记录至少一个授权范围、开始时间和依据链接");
    } else if (command.rightsScope.length > 0) {
      domainError("BUSINESS_RULE_VIOLATION", "未授权、待确认或已撤销状态不能保留可用授权范围");
    }
    const before = { rightsStatus: asset.rightsStatus, rightsScope: asset.rightsScope, rightsValidFrom: asset.rightsValidFrom, rightsValidUntil: asset.rightsValidUntil };
    asset.rightsStatus = command.rightsStatus;
    asset.rightsScope = [...new Set(command.rightsScope)];
    asset.rightsValidFrom = command.rightsValidFrom;
    asset.rightsValidUntil = command.rightsValidUntil;
    asset.rightsEvidenceUrl = command.rightsEvidenceUrl ?? null;
    incrementVersion(asset, runtime.now(), auth.member.id);
    addAudit(state, runtime, auth.member.id, asset, "content_asset", asset.id, "content_asset.rights_updated", command.reason ?? null, before, { rightsStatus: asset.rightsStatus, rightsScope: asset.rightsScope, rightsValidFrom: asset.rightsValidFrom, rightsValidUntil: asset.rightsValidUntil, version: asset.version });
    return structuredClone(asset);
  }

  private appendObservation(state: DomainState, auth: AuthContext, command: Extract<BusinessDomainCommand, { type: "contentObservation.append" }>, runtime: DomainRuntime): ContentObservation {
    const asset = this.contentAssetForAction(state, auth, command.assetId);
    checkVersion(asset, command.expectedAssetVersion);
    assertIsoDateTime(command.observedAt, "观察时间");
    const recordedAt = runtime.now();
    if (Date.parse(command.observedAt) > Date.parse(recordedAt)) domainError("BUSINESS_RULE_VIOLATION", "观察时间不能晚于录入时间");
    const observation: ContentObservation = {
      id: runtime.id("content-observation"), orgId: asset.orgId, teamId: asset.teamId, contentAssetId: asset.id,
      source: command.source, observedAt: command.observedAt, recordedAt, recordedBy: auth.member.id,
      views: command.views ?? null, likes: command.likes ?? null, comments: command.comments ?? null, shares: command.shares ?? null,
      orders: command.orders ?? null, observedPaidCents: command.observedPaidCents ?? null, note: command.note ?? null,
    };
    state.contentObservations.push(observation);
    incrementVersion(asset, recordedAt, auth.member.id);
    addAudit(state, runtime, auth.member.id, asset, "content_observation", observation.id, "content_observation.appended", null, null, {
      contentAssetId: asset.id, source: observation.source, observedAt: observation.observedAt, recordedAt: observation.recordedAt,
      views: observation.views, likes: observation.likes, comments: observation.comments, shares: observation.shares,
      orders: observation.orders, observedPaidCents: observation.observedPaidCents,
    });
    return structuredClone(observation);
  }

  private createLedgerEntry(state: DomainState, auth: AuthContext, command: Extract<BusinessDomainCommand, { type: "ledgerEntry.create" }>, runtime: DomainRuntime): CommercialLedgerEntry {
    this.financeRole(auth);
    this.targetTeam(state, auth, command.teamId);
    const teamId = command.teamId;
    if (command.cooperationId) {
      const cooperation = this.cooperationForAction(state, auth, command.cooperationId);
      if (cooperation.teamId !== teamId) domainError("NOT_FOUND", "合作单不存在或当前账号无权访问");
    }
    if (command.contentAssetId) {
      const asset = state.contentAssets.find((item) => item.id === command.contentAssetId && item.orgId === state.orgId);
      if (!asset || (auth.role !== "admin" && asset.teamId !== auth.member.teamId) || asset.teamId !== teamId) domainError("NOT_FOUND", "内容资产不存在或当前账号无权访问");
    }
    if (command.cooperationId && command.contentAssetId) {
      const asset = state.contentAssets.find((item) => item.id === command.contentAssetId && item.orgId === state.orgId)!;
      const cooperation = state.cooperations.find((item) => item.id === command.cooperationId && item.orgId === state.orgId)!;
      if (asset.teamId !== cooperation.teamId) domainError("NOT_FOUND", "关联对象不存在或当前账号无权访问");
    }
    const now = runtime.now();
    assertIsoDateTime(command.occurredAt, "费用发生时间");
    if (Date.parse(command.occurredAt) > Date.parse(now)) domainError("BUSINESS_RULE_VIOLATION", "费用发生时间不能晚于录入时间；预算不属于已登记费用");
    const entry: CommercialLedgerEntry = {
      id: runtime.id("ledger"), orgId: state.orgId, teamId, title: command.title, kind: command.kind,
      amountCents: command.amountCents, occurredAt: command.occurredAt, source: command.source,
      evidenceUrl: command.evidenceUrl ?? null, cooperationId: command.cooperationId ?? null,
      contentAssetId: command.contentAssetId ?? null, status: "recorded", voidReason: null,
      version: 1, createdAt: now, createdBy: auth.member.id, updatedAt: now, updatedBy: auth.member.id,
    };
    state.commercialLedgerEntries.push(entry);
    addAudit(state, runtime, auth.member.id, entry, "commercial_ledger_entry", entry.id, "ledger_entry.recorded", null, null, { title: entry.title, kind: entry.kind, amountCents: entry.amountCents, occurredAt: entry.occurredAt, source: entry.source, cooperationId: entry.cooperationId, contentAssetId: entry.contentAssetId });
    return structuredClone(entry);
  }

  private ledgerEntryForAction(state: DomainState, auth: AuthContext, entryId: string): CommercialLedgerEntry {
    const entry = state.commercialLedgerEntries.find((item) => item.id === entryId && item.orgId === state.orgId);
    if (!entry || (auth.role !== "admin" && entry.teamId !== auth.member.teamId)) domainError("NOT_FOUND", "费用记录不存在或当前账号无权访问");
    return entry;
  }

  private voidLedgerEntry(state: DomainState, auth: AuthContext, command: Extract<BusinessDomainCommand, { type: "ledgerEntry.void" }>, runtime: DomainRuntime): CommercialLedgerEntry {
    this.financeRole(auth);
    const entry = this.ledgerEntryForAction(state, auth, command.entryId);
    checkVersion(entry, command.expectedVersion);
    if (entry.status !== "recorded") domainError("INVALID_TRANSITION", "已作废费用不能重复作废");
    const before = { status: entry.status, voidReason: entry.voidReason };
    entry.status = "voided";
    entry.voidReason = command.voidReason;
    incrementVersion(entry, runtime.now(), auth.member.id);
    addAudit(state, runtime, auth.member.id, entry, "commercial_ledger_entry", entry.id, "ledger_entry.voided", command.voidReason, before, { status: entry.status, version: entry.version });
    return structuredClone(entry);
  }

  private upsertTeamTarget(state: DomainState, auth: AuthContext, command: Extract<BusinessDomainCommand, { type: "teamTarget.upsert" }>, runtime: DomainRuntime): TeamMonthlyTarget {
    this.financeRole(auth);
    this.targetTeam(state, auth, command.teamId);
    const existing = state.teamMonthlyTargets.find((item) => item.orgId === state.orgId && item.teamId === command.teamId && item.month === command.month && item.metric === command.metric);
    const now = runtime.now();
    if (command.expectedVersion === 0) {
      if (existing) domainError("VERSION_CONFLICT", "该团队、月份和指标的目标已存在，请刷新后更新");
      const target: TeamMonthlyTarget = {
        id: runtime.id("team-target"), orgId: state.orgId, teamId: command.teamId, month: command.month,
        metric: command.metric, targetValue: command.targetValue, version: 1,
        createdAt: now, createdBy: auth.member.id, updatedAt: now, updatedBy: auth.member.id,
      };
      state.teamMonthlyTargets.push(target);
      addAudit(state, runtime, auth.member.id, target, "team_monthly_target", target.id, "team_target.created", null, null, { month: target.month, metric: target.metric, targetValue: target.targetValue });
      return structuredClone(target);
    }
    if (!existing) domainError("NOT_FOUND", "目标不存在或当前账号无权访问");
    checkVersion(existing, command.expectedVersion);
    const before = { targetValue: existing.targetValue };
    existing.targetValue = command.targetValue;
    incrementVersion(existing, now, auth.member.id);
    addAudit(state, runtime, auth.member.id, existing, "team_monthly_target", existing.id, "team_target.updated", null, before, { month: existing.month, metric: existing.metric, targetValue: existing.targetValue, version: existing.version });
    return structuredClone(existing);
  }
}
