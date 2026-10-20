import { z } from "zod";
import {
  CAPABILITIES,
  CRM_STAGES,
  type Actor,
  type AuditEntityType,
  type Capability,
  type Cooperation,
  type Creator,
  type CreatorSessionRecord,
  type CrmStage,
  type DomainCommandResult,
  type DomainState,
  type Id,
  type ImportBatch,
  type Member,
  type OwnerCorrection,
  type RecipientInfo,
  type Role,
  type SampleLine,
  type SampleRequest,
  type WorkspaceFilters,
  type WorkspaceSnapshot,
  type SessionSnapshot,
  type CreatorContact,
  type LiveSchedule,
  type Delivery,
  type WorkTask,
  type Product,
  type SamplePackage,
  type OwnerSnapshot,
  type OrderLine,
  type RefundEvent,
  type Platform,
} from "../../shared/types.ts";
import { parseCommand, type DomainCommand } from "../../shared/commands.ts";
import { resolveAuth, requireAdmin, requireCapability, requireManagerOrAdmin, type AuthContext } from "./auth.ts";
import { DomainError, domainError } from "./errors.ts";
import { calculateMetrics, effectiveOwner, shanghaiDate } from "./metrics.ts";
import { commitImport, creatorIdsInMergeFamily, previewImport } from "./imports.ts";
import { taskDueAt } from "./sla.ts";
import { projectScenarioInfo } from "./scenario-info.ts";
import { buildBusinessProgress } from "./business-progress.ts";
import { businessProgressSourceFromDomainState } from "./business-progress-source.ts";
import { BusinessDomainExtension, isBusinessDomainCommand } from "./business-extension.ts";
import {
  executeSalesPerformanceCommand,
  projectSalesPerformanceWorkspace,
} from "./sales-performance.ts";
import {
  addAudit,
  addCents,
  assertIsoDateTime,
  checkVersion,
  defaultRuntime,
  fingerprint,
  incrementVersion,
  normalizeKey,
  stableStringify,
  type DomainRuntime,
} from "./utils.ts";

export { SYSTEM_TASK_SLA_HOURS } from "./sla.ts";

function isWorkflowTask(task: WorkTask): boolean {
  return task.requiredCapability !== null || (task.kind !== "followup" && task.kind !== "other");
}

function taskCapabilityForKind(kind: WorkTask["kind"]): Capability | null {
  if (kind === "sample_approval") return "sample.approve";
  if (kind === "sample_shipment" || kind === "sample_receipt") return "sample.fulfill";
  if (kind === "cooperation_approval" || kind === "delivery_review") return "cooperation.approve";
  return null;
}

export interface DomainStore {
  read(): Promise<DomainState>;
  transaction<T>(fn: (draft: DomainState) => T | Promise<T>): Promise<T>;
}

export interface DomainServiceOptions {
  runtime?: Partial<DomainRuntime>;
  businessProgressOwnerSecret?: string;
}

const workspaceFiltersSchema = z.object({
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  teamId: z.string().trim().min(1).max(160).optional(),
  ownerMemberId: z.string().trim().min(1).max(160).optional(),
  search: z.string().trim().max(300).optional(),
  includeClosed: z.boolean().optional(),
}).strict().superRefine((filters, context) => {
  for (const [field, value] of [["dateFrom", filters.dateFrom], ["dateTo", filters.dateTo]] as const) {
    if (!value) continue;
    const date = new Date(`${value}T00:00:00+08:00`);
    if (!Number.isFinite(date.getTime()) || shanghaiDate(`${value}T00:00:00+08:00`) !== value) context.addIssue({ code: "custom", path: [field], message: "日期无效" });
  }
  if (filters.dateFrom && filters.dateTo && filters.dateFrom > filters.dateTo) context.addIssue({ code: "custom", path: ["dateTo"], message: "结束日期不能早于开始日期" });
});

type MutationCommand = Exclude<DomainCommand, { type: "import.preview" | "import.commit" | "export.record" }>;

export function parseWorkspaceFilters(input: unknown = {}): WorkspaceFilters {
  try {
    return workspaceFiltersSchema.parse(input);
  } catch (error) {
    const message = error instanceof z.ZodError ? error.issues[0]?.message ?? "筛选条件无效" : "筛选条件无效";
    domainError("VALIDATION_ERROR", message, error instanceof z.ZodError ? error.issues : null);
  }
}

export class DomainService {
  private readonly runtime: DomainRuntime;
  private readonly businessExtension = new BusinessDomainExtension();
  private readonly businessProgressOwnerSecret: string | undefined;

  constructor(private readonly store: DomainStore, options: DomainServiceOptions = {}) {
    this.runtime = { now: options.runtime?.now ?? defaultRuntime.now, id: options.runtime?.id ?? defaultRuntime.id };
    this.businessProgressOwnerSecret = options.businessProgressOwnerSecret;
  }

  async getSession(actor: Actor): Promise<SessionSnapshot> {
    const state = await this.store.read();
    const auth = resolveAuth(state, actor);
    return {
      dataMode: state.dataMode,
      actor: {
        memberId: auth.member.id,
        principalId: auth.member.principalId,
        displayName: auth.member.displayName,
        role: auth.role,
        capabilities: [...auth.capabilities],
        teamId: auth.member.teamId,
      },
      allowedDemoProfiles: state.dataMode === "demo"
        ? state.members.filter((member) => member.active && member.orgId === state.orgId && member.role !== null).map((member) => ({
          principalId: member.principalId,
          memberId: member.id,
          displayName: member.displayName,
          role: member.role as Role,
          teamId: member.teamId,
        }))
        : [],
    };
  }

  async getWorkspace(actor: Actor, inputFilters: unknown = {}): Promise<WorkspaceSnapshot> {
    const filters = parseWorkspaceFilters(inputFilters);
    const state = await this.store.read();
    const auth = resolveAuth(state, actor);
    return this.workspaceFromState(state, auth, filters);
  }

  async execute(actor: Actor, input: unknown): Promise<DomainCommandResult> {
    const parsed = this.parseInput(input);
    if (parsed.type === "import.preview") {
      const state = await this.store.read();
      const auth = resolveAuth(state, actor);
      const result = previewImport(state, auth.member, auth.role, auth.capabilities, parsed);
      return { command: parsed.type, result, notices: [] };
    }
    if (parsed.type === "import.commit") {
      return this.store.transaction((state) => {
        const auth = resolveAuth(state, actor);
        const committed = commitImport(state, auth.member, auth.role, auth.capabilities, parsed, this.runtime);
        return { command: parsed.type, result: committed.result, notices: committed.replayed ? ["此批次此前已成功提交，返回既有结果"] : [] };
      });
    }
    return this.store.transaction(async (state) => {
      const auth = resolveAuth(state, actor);
      if (parsed.type === "export.record") {
        return this.recordExport(state, auth, parsed);
      }
      const result = await this.mutate(state, auth, parsed as MutationCommand);
      return { command: parsed.type, result, notices: [] };
    });
  }

  private parseInput(input: unknown): DomainCommand {
    try {
      return parseCommand(input);
    } catch (error) {
      if (error instanceof z.ZodError) domainError("VALIDATION_ERROR", error.issues[0]?.message ?? "命令参数无效", error.issues);
      throw error;
    }
  }

  private async mutate(state: DomainState, auth: AuthContext, command: MutationCommand): Promise<unknown> {
    if (isBusinessDomainCommand(command)) {
      return this.businessExtension.execute(state, auth, command, this.runtime, {
        create: (cooperationCommand) => this.createCooperation(state, auth, cooperationCommand),
        createProduct: (productCommand) => this.createProduct(state, auth, productCommand),
      });
    }
    switch (command.type) {
      case "salesReport.create":
      case "salesReport.update":
      case "salesReport.review":
      case "salesReport.reconcile":
        return executeSalesPerformanceCommand(state, auth, command, this.runtime);
      case "creator.create": return this.createCreator(state, auth, command);
      case "creator.update": return this.updateCreator(state, auth, command);
      case "creator.addAccount": return this.addCreatorAccount(state, auth, command);
      case "creator.updateAccount": return this.updateCreatorAccount(state, auth, command);
      case "creator.claim": return this.claimCreator(state, auth, command);
      case "creator.transfer": return this.transferCreator(state, auth, command);
      case "creator.setStage": return this.setCreatorStage(state, auth, command);
      case "creator.merge": return this.mergeCreators(state, auth, command);
      case "followup.add": return this.addFollowup(state, auth, command);
      case "creator.session.create": return this.createCreatorSession(state, auth, command);
      case "creator.session.update": return this.updateCreatorSession(state, auth, command);
      case "task.create": return this.createTask(state, auth, command);
      case "task.complete": return this.completeTask(state, auth, command);
      case "product.create": return this.createProduct(state, auth, command);
      case "product.update": return this.updateProduct(state, auth, command);
      case "sample.create": return this.createSample(state, auth, command);
      case "sample.request": return this.requestSample(state, auth, command);
      case "sample.updateDraft": return this.updateSampleDraft(state, auth, command);
      case "sample.submit": return this.submitSample(state, auth, command);
      case "sample.decide": return this.decideSample(state, auth, command);
      case "sample.addPackage": return this.addSamplePackage(state, auth, command);
      case "sample.confirmReceipt": return this.confirmSampleReceipt(state, auth, command);
      case "sample.close": return this.closeSample(state, auth, command);
      case "cooperation.create": return this.createCooperation(state, auth, command);
      case "cooperation.updateDraft": return this.updateCooperationDraft(state, auth, command);
      case "cooperation.submit": return this.submitCooperation(state, auth, command);
      case "cooperation.decide": return this.decideCooperation(state, auth, command);
      case "cooperation.waiveSamples": return this.waiveSamples(state, auth, command);
      case "cooperation.cancel": return this.cancelCooperation(state, auth, command);
      case "schedule.create": return this.createSchedule(state, auth, command);
      case "schedule.reschedule": return this.rescheduleSchedule(state, auth, command);
      case "schedule.complete": return this.completeSchedule(state, auth, command);
      case "schedule.cancel": return this.cancelSchedule(state, auth, command);
      case "delivery.create": return this.createDelivery(state, auth, command);
      case "delivery.submit": return this.submitDelivery(state, auth, command);
      case "delivery.review": return this.reviewDelivery(state, auth, command);
      case "delivery.cancel": return this.cancelDelivery(state, auth, command);
      case "order.reconcileSource": return this.reconcileOrderSource(state, auth, command);
      case "refund.reconcileSource": return this.reconcileRefundSource(state, auth, command);
      case "order.correctOwner": return this.correctOrderOwner(state, auth, command);
      case "member.create": return this.createMember(state, auth, command);
      case "member.update": return this.updateMember(state, auth, command);
      case "member.handoff": return this.handoffMember(state, auth, command);
      default: return this.unreachableCommand(command);
    }
  }

  private unreachableCommand(command: never): never {
    return domainError("VALIDATION_ERROR", `不支持的命令：${String(command)}`);
  }

  private workspaceFromState(state: DomainState, auth: AuthContext, filters: WorkspaceFilters): WorkspaceSnapshot {
    if (filters.teamId) {
      const team = state.teams.find((item) => item.id === filters.teamId && item.orgId === state.orgId && item.active);
      if (!team) domainError("NOT_FOUND", "团队不存在");
      if (auth.role !== "admin" && auth.member.teamId !== filters.teamId) domainError("FORBIDDEN", "筛选范围不能超出当前团队");
    }
    if (filters.ownerMemberId) {
      const owner = state.members.find((item) => item.id === filters.ownerMemberId && item.orgId === state.orgId && item.active);
      if (!owner || (auth.role !== "admin" && owner.teamId !== auth.member.teamId)) domainError("FORBIDDEN", "成员筛选范围不能超出当前权限");
      if (auth.role === "bd" && filters.ownerMemberId !== auth.member.id) domainError("FORBIDDEN", "商务只能筛选本人记录");
      if (auth.role === "ops") domainError("FORBIDDEN", "样品运营不能筛选商务数据");
    }
    const requestedTeam = filters.teamId;
    const selectedOwner = filters.ownerMemberId;
    const inTeam = (scope: { orgId: string; teamId: string }) => scope.orgId === state.orgId && (!requestedTeam ? auth.role === "admin" || scope.teamId === auth.member.teamId : scope.teamId === requestedTeam);
    const allInTeamCreators = state.creators.filter((creator) => inTeam(creator) && !creator.archived);
    const visibleCreatorsBase = allInTeamCreators.filter((creator) => {
      if (auth.role === "admin" || auth.role === "manager") return !selectedOwner || creator.ownerMemberId === selectedOwner;
      if (auth.role === "bd") return (creator.ownerMemberId === auth.member.id || creator.ownerMemberId === null) && (!selectedOwner || creator.ownerMemberId === selectedOwner);
      return false;
    });
    const search = filters.search?.toLocaleLowerCase() ?? "";
    const searchedCreators = !search ? visibleCreatorsBase : visibleCreatorsBase.filter((creator) =>
      creator.name.toLocaleLowerCase().includes(search)
      || creator.accounts.some((account) => account.externalAccountId.toLocaleLowerCase().includes(search) || account.displayName.toLocaleLowerCase().includes(search))
      || creator.tags.some((tag) => tag.toLocaleLowerCase().includes(search))
      || (creator.category ?? "").toLocaleLowerCase().includes(search),
    );
    const creatorIds = new Set(searchedCreators.map((creator) => creator.id));
    const byCreatorOwner = (creatorId: string) => {
      const creator = state.creators.find((item) => item.id === creatorId);
      return Boolean(creator && creatorIds.has(creator.id) && (!selectedOwner || creator.ownerMemberId === selectedOwner));
    };

    const visibleCreators = searchedCreators.map((creator) => {
      const copy = clone(creator);
      if (auth.role === "bd" && creator.ownerMemberId === null) {
        copy.contact = null;
        copy.internalNote = null;
      }
      return copy;
    });
    const visibleCreatorIds = new Set(visibleCreators.map((creator) => creator.id));
    const ownedCreatorIds = new Set(visibleCreators.filter((creator) => creator.ownerMemberId === auth.member.id).map((creator) => creator.id));

    let samples = state.samples.filter((sample) => inTeam(sample) && (auth.role === "ops"
      ? auth.capabilities.includes("sample.fulfill") || auth.capabilities.includes("sample.approve")
      : visibleCreatorIds.has(sample.creatorId)
        || (auth.role === "bd" && !selectedOwner && ((sample.status === "pending_approval" && auth.capabilities.includes("sample.approve"))
          || (["pending_shipment", "shipped"].includes(sample.status) && auth.capabilities.includes("sample.fulfill"))))));
    if (!filters.includeClosed) samples = samples.filter((sample) => !["rejected", "closed", "received"].includes(sample.status));
    const sampleIds = new Set(samples.map((sample) => sample.id));
    const samplePackages = state.samplePackages.filter((pkg) => inTeam(pkg) && sampleIds.has(pkg.sampleId)).map((pkg) => clone(pkg));
    const visibleSamples = samples.map((sample) => {
      const copy = clone(sample);
      const ownerCanRead = auth.role === "bd" && byCreatorOwner(sample.creatorId);
      const operationsCanRead = auth.capabilities.includes("sample.fulfill") && ["pending_shipment", "shipped"].includes(sample.status);
      if (!ownerCanRead && !operationsCanRead) copy.recipient = null;
      return copy;
    });

    const allCooperations = auth.role === "ops" ? [] : state.cooperations.filter((item) => inTeam(item)
      && ((visibleCreatorIds.has(item.creatorId) && (!selectedOwner || item.ownerMemberId === selectedOwner))
        || (auth.role === "bd" && !selectedOwner && item.status === "pending_approval" && auth.capabilities.includes("cooperation.approve"))));
    const cooperationIds = new Set(allCooperations.map((item) => item.id));
    const cooperations = !filters.includeClosed ? allCooperations.filter((item) => !["rejected", "delivered", "cancelled"].includes(item.status)) : allCooperations;
    const allSchedules = auth.role === "ops" ? [] : state.schedules.filter((item) => inTeam(item) && cooperationIds.has(item.cooperationId));
    let schedules = allSchedules;
    if (!filters.includeClosed) schedules = schedules.filter((item) => !["completed", "cancelled"].includes(item.status));
    const allDeliveries = auth.role === "ops" ? [] : state.deliveries.filter((item) => inTeam(item)
      && (cooperationIds.has(item.cooperationId) || (auth.role === "bd" && !selectedOwner && item.status === "pending_review" && auth.capabilities.includes("cooperation.approve"))));
    let deliveries = allDeliveries;
    if (!filters.includeClosed) deliveries = deliveries.filter((item) => !["approved", "cancelled"].includes(item.status));
    let followups = auth.role === "ops" ? [] : state.followups.filter((item) => inTeam(item) && visibleCreatorIds.has(item.creatorId) && byCreatorOwner(item.creatorId));
    let tasks = state.tasks.filter((item) => {
      if (!inTeam(item)) return false;
      if (auth.role === "admin" || auth.role === "manager") return true;
      if (item.requiredCapability !== null && auth.capabilities.includes(item.requiredCapability)) return true;
      if (item.ownerMemberId !== auth.member.id) return false;
      if (item.creatorId === null || visibleCreatorIds.has(item.creatorId)) return true;
      return auth.role === "ops" && item.relatedType === "sample" && item.relatedId !== null && sampleIds.has(item.relatedId)
        && ["sample_approval", "sample_shipment", "sample_receipt"].includes(item.kind);
    });
    if (!filters.includeClosed) tasks = tasks.filter((item) => item.status === "open");
    if (selectedOwner) tasks = tasks.filter((item) => item.ownerMemberId === selectedOwner);

    let orders: OrderLine[] = [];
    if (auth.role === "admin" || auth.role === "manager") {
      orders = state.orders.filter((item) => inTeam(item));
    } else if (auth.role === "bd") {
      orders = state.orders.filter((item) => inTeam(item) && effectiveOwner(item, state.ownerCorrections) === auth.member.id);
    }
    if (search) {
      orders = orders.filter((order) => order.externalOrderId.toLocaleLowerCase().includes(search)
        || order.externalLineId.toLocaleLowerCase().includes(search)
        || (order.sku ?? "").toLocaleLowerCase().includes(search)
        || (order.creatorId !== null && visibleCreatorIds.has(order.creatorId)));
    }
    if (selectedOwner && auth.role !== "bd") orders = orders.filter((order) => effectiveOwner(order, state.ownerCorrections) === selectedOwner);
    const orderIds = new Set(orders.map((item) => item.id));
    const refunds = auth.role === "ops" ? [] : state.refunds.filter((item) => inTeam(item) && orderIds.has(item.orderLineId));
    const ownerCorrections = auth.role === "ops" ? [] : state.ownerCorrections.filter((item) => orderIds.has(item.orderLineId));
    const creatorSessions = auth.role === "ops" ? [] : state.creatorSessions.filter((session) => inTeam(session)
      && visibleCreatorIds.has(session.creatorId)
      && (auth.role !== "bd" || ownedCreatorIds.has(session.creatorId))
      && (!filters.creatorId || filters.creatorId === session.creatorId)
      && (!filters.platform || filters.platform === "all" || filters.platform === session.platform)
      && (!filters.dateFrom || session.occurredOn >= filters.dateFrom)
      && (!filters.dateTo || session.occurredOn <= filters.dateTo)
      && (!search || session.title.toLocaleLowerCase().includes(search)));

    const productIdsUsedBySamples = new Set(samples.flatMap((sample) => sample.lines.map((line) => line.productId)));
    const productIdsUsedByCooperations = new Set(cooperations.flatMap((cooperation) => cooperation.lines.map((line) => line.productId).filter((value): value is string => value !== null)));
    const products = state.products.filter((item) => (auth.role === "admin" || auth.role === "manager" || auth.role === "bd"
      ? inTeam(item)
      : productIdsUsedBySamples.has(item.id)) && (!search || item.name.toLocaleLowerCase().includes(search) || item.sku?.toLocaleLowerCase().includes(search) || productIdsUsedByCooperations.has(item.id)));
    const visibleProducts = products.map(clone);

    const creatorHistoryScope = auth.role === "bd" ? ownedCreatorIds : visibleCreatorIds;
    const historyCreatorIds = new Set([...creatorHistoryScope].flatMap((creatorId) => [...creatorIdsInMergeFamily(state, creatorId)]));
    const ownerAssignments = state.ownerAssignments.filter((assignment) => inTeam(assignment) && historyCreatorIds.has(assignment.creatorId)).map(clone);
    const stageEvents = state.creatorStageEvents.filter((event) => inTeam(event) && creatorHistoryScope.has(event.creatorId));
    const importBatches = auth.capabilities.includes("import.manage") && (auth.role === "admin" || auth.role === "manager")
      ? state.importBatches.filter((batch) => inTeam(batch)).map(clone)
      : [];
    const members = state.members.filter((member) => member.orgId === state.orgId && (auth.role === "admin" ? (!requestedTeam || member.teamId === requestedTeam) : member.teamId === auth.member.teamId))
      .map(({ id, displayName, role, teamId, active, version }) => ({ id, displayName, role, teamId, active, version }));
    const teams = state.teams.filter((team) => team.orgId === state.orgId && team.active && (auth.role === "admin" ? (!requestedTeam || team.id === requestedTeam) : team.id === auth.member.teamId)).map(clone);
    const auditEvents = state.auditEvents.filter((event) => {
      if (auth.role === "admin") return auth.capabilities.includes("audit.read") && inTeam(event);
      if (auth.role === "manager") return auth.capabilities.includes("audit.read") && inTeam(event);
      if (auth.role === "bd") return event.orgId === state.orgId && ownedCreatorIds.has(event.entityId);
      return (auth.capabilities.includes("audit.read") || auth.capabilities.includes("sample.fulfill")) && sampleIds.has(event.entityId);
    }).map(clone);

    const visibleSamplesCloned = visibleSamples.map(clone);
    const visibleCooperations = cooperations.map(clone);
    const visibleSchedules = schedules.map(clone);
    const visibleDeliveries = deliveries.map(clone);
    const visibleFollowups = followups.map(clone);
    const visibleTasks = tasks.map((item) => {
      const copy = clone(item);
      if (auth.role === "ops" && copy.creatorId !== null && !visibleCreatorIds.has(copy.creatorId)) copy.creatorId = null;
      return copy;
    });
    const visibleOrders = orders.map(clone);
    const visibleRefunds = refunds.map(clone);
    const visibleCorrections = ownerCorrections.map(clone);
    const visibleImportBatches = importBatches.map(clone);
    const visibleMembers = members.map(clone);
    const visibleTeams = teams.map(clone);
    const visiblePackages = samplePackages.map(clone);
    const salesReports = projectSalesPerformanceWorkspace(
      state,
      auth,
      requestedTeam ?? null,
      selectedOwner,
      filters.dateFrom,
      filters.dateTo,
      search,
    );
    const now = this.runtime.now();
    const metrics = calculateMetrics({
      creators: this.creatorsForAuthorizedWork(state, auth, visibleCreators, visibleCreatorIds, visibleSamplesCloned, visibleCooperations, visibleDeliveries),
      stageEvents,
      samples: visibleSamplesCloned,
      samplePackages: visiblePackages,
      cooperations: allCooperations.map(clone),
      schedules: allSchedules.map(clone),
      deliveries: allDeliveries.map(clone),
      orders: visibleOrders,
      refunds: visibleRefunds,
      ownerCorrections: visibleCorrections,
      tasks: visibleTasks,
      importBatches: visibleImportBatches,
      importHistoryVisible: auth.capabilities.includes("import.manage") && (auth.role === "admin" || auth.role === "manager"),
      includeSales: auth.role !== "ops",
    }, filters, now);
    const scenarioInfo = projectScenarioInfo(state.auditEvents, state.orgId, visibleTeams.map((team) => team.id));
    // Progress includes terminal workflow evidence and is intentionally independent
    // of the legacy list's includeClosed/search/date filters. Sales are filtered in
    // the management view using its safe ledger; organization/team scope stays fixed.
    const businessProgress = this.businessProgressOwnerSecret && (auth.role === "admin" || auth.role === "manager")
      ? buildBusinessProgress(
        businessProgressSourceFromDomainState(state, visibleTeams.map((team) => team.id)),
        now,
        this.businessProgressOwnerSecret,
      )
      : undefined;

    return {
      dataMode: state.dataMode,
      ...(scenarioInfo ? { scenarioInfo } : {}),
      ...(businessProgress ? { businessProgress } : {}),
      actor: { memberId: auth.member.id, displayName: auth.member.displayName, role: auth.role, capabilities: [...auth.capabilities], teamId: auth.member.teamId },
      scope: {
        teamIds: auth.role === "admin" ? state.teams.filter((team) => team.orgId === state.orgId && team.active).map((team) => team.id) : [auth.member.teamId],
        canSeeTeamMetrics: auth.role === "admin" || auth.role === "manager",
        canManageMembers: auth.role === "admin",
      },
      metrics,
      members: visibleMembers,
      teams: visibleTeams,
      creators: visibleCreators,
      ownerAssignments,
      followups: visibleFollowups,
      creatorSessions: creatorSessions.map(clone),
      salesReports,
      tasks: visibleTasks,
      products: visibleProducts,
      samples: visibleSamplesCloned,
      samplePackages: visiblePackages,
      cooperations: visibleCooperations,
      schedules: visibleSchedules,
      deliveries: visibleDeliveries,
      orders: visibleOrders,
      refunds: visibleRefunds,
      ownerCorrections: visibleCorrections,
      importBatches: visibleImportBatches,
      auditEvents,
      ...this.businessExtension.projectWorkspace(state, auth, filters, now),
    };
  }

  private recordExport(state: DomainState, auth: AuthContext, command: Extract<DomainCommand, { type: "export.record" }>): DomainCommandResult {
    requireCapability(auth, "export.run", "当前账号未获得数据导出权限");
    const filters: WorkspaceFilters = command.filters ?? {};
    const workspace = this.workspaceFromState(state, auth, filters);
    const records = workspace[command.dataset];
    const audit = addAudit(state, this.runtime, auth.member.id, auth.member, "export", this.runtime.id("export"), `export.${command.dataset}`, null, null, {
      dataset: command.dataset,
      dateFrom: filters.dateFrom ?? null,
      dateTo: filters.dateTo ?? null,
      teamId: filters.teamId ?? null,
      ownerMemberId: filters.ownerMemberId ?? null,
      platform: filters.platform ?? null,
      creatorId: filters.creatorId ?? null,
      searchApplied: Boolean(filters.search),
    });
    return { command: "export.record", result: { dataset: command.dataset, rows: records, auditEventId: audit.id }, notices: [] };
  }

  private createCreator(state: DomainState, auth: AuthContext, command: Extract<DomainCommand, { type: "creator.create" }>): Creator {
    this.assertBusinessRole(auth);
    if (command.makePublic && auth.role === "bd") domainError("FORBIDDEN", "商务不能把自己新建的达人放入公海");
    const platform = command.platform ?? "douyin";
    const externalId = normalizeKey(command.externalAccountId);
    if (state.creators.some((creator) => creator.accounts.some((account) => account.platform === platform && account.externalAccountId === externalId))) {
      domainError("IDENTITY_CONFLICT", "该平台账号 ID 已映射到达人，请打开现有档案或提交身份合并核对");
    }
    const now = this.runtime.now();
    const ownerId = auth.role === "bd" ? auth.member.id : null;
    const creator: Creator = {
      id: this.runtime.id("creator"), orgId: auth.member.orgId, teamId: auth.member.teamId,
      name: command.name, category: command.category ?? null, tags: unique(command.tags), source: command.source,
      accounts: [{ id: this.runtime.id("account"), platform, externalAccountId: externalId, displayName: command.displayName, profileUrl: command.profileUrl ?? null, active: true, commerceTypes: command.commerceTypes ?? [], accountVersion: 1, firstSeenAt: now, lastVerifiedAt: null }],
      ownerMemberId: ownerId, crmStage: "uncontacted", pausedFromStage: null, pauseReason: null, reviewAt: null,
      declineReason: null, contact: normalizeContact(command.contact), internalNote: command.internalNote ?? null,
      archived: false, mergedIntoCreatorId: null, version: 1, createdAt: now, createdBy: auth.member.id, updatedAt: now, updatedBy: auth.member.id,
    };
    state.creators.push(creator);
    state.ownerAssignments.push({ id: this.runtime.id("owner"), creatorId: creator.id, orgId: creator.orgId, teamId: creator.teamId, memberId: ownerId, validFrom: now, validTo: null, changedBy: auth.member.id, reason: ownerId ? "创建时归属商务" : "新达人进入公海" });
    state.creatorStageEvents.push({ id: this.runtime.id("stage"), creatorId: creator.id, orgId: creator.orgId, teamId: creator.teamId, stage: "uncontacted", occurredAt: now, recordedAt: now, actorId: auth.member.id, reason: null });
    addAudit(state, this.runtime, auth.member.id, creator, "creator", creator.id, "creator.created", null, null, { name: creator.name, stage: creator.crmStage, ownerMemberId: ownerId, platform, externalAccountId: externalId });
    return clone(creator);
  }

  private updateCreator(state: DomainState, auth: AuthContext, command: Extract<DomainCommand, { type: "creator.update" }>): Creator {
    const creator = this.mutableCreator(state, auth, command.creatorId);
    checkVersion(creator, command.expectedVersion);
    if (creator.profileId) {
      const changesSharedProfile = (command.name !== undefined && command.name !== creator.name)
        || ("category" in command && (command.category ?? null) !== creator.category)
        || (command.tags !== undefined && JSON.stringify(unique(command.tags)) !== JSON.stringify(creator.tags));
      if (changesSharedProfile) {
        requireManagerOrAdmin(auth, "共享达人基础档案由管理岗维护；商务可编辑当前品牌的联系信息和备注");
        if (command.expectedProfileVersion !== creator.profileVersion) {
          domainError("VERSION_CONFLICT", "共享达人基础档案已更新，请刷新后再保存");
        }
      }
      const nextContact = command.contact === null ? null : mergeContact(creator.contact, command.contact);
      if ("contact" in command && JSON.stringify(nextContact) !== JSON.stringify(creator.contact)
        && command.expectedContactVersion !== (creator.contactVersion ?? 0)) {
        domainError("VERSION_CONFLICT", "当前品牌的达人联系信息已更新，请刷新后再保存");
      }
    }
    const before = { name: creator.name, category: creator.category, tags: creator.tags, internalNote: creator.internalNote };
    if (command.name !== undefined) creator.name = command.name;
    if ("category" in command) creator.category = command.category ?? null;
    if (command.tags !== undefined) creator.tags = unique(command.tags);
    if ("contact" in command) creator.contact = command.contact === null ? null : mergeContact(creator.contact, command.contact);
    if ("internalNote" in command) creator.internalNote = command.internalNote ?? null;
    incrementVersion(creator, this.runtime.now(), auth.member.id);
    addAudit(state, this.runtime, auth.member.id, creator, "creator", creator.id, "creator.updated", null, before, { name: creator.name, category: creator.category, tags: creator.tags, internalNote: creator.internalNote });
    return clone(creator);
  }

  private addCreatorAccount(state: DomainState, auth: AuthContext, command: Extract<DomainCommand, { type: "creator.addAccount" }>): Creator {
    const creator = this.mutableCreator(state, auth, command.creatorId);
    checkVersion(creator, command.expectedVersion);
    if (creator.profileId) {
      requireManagerOrAdmin(auth, "共享达人平台账号由管理岗核对并维护");
      if (command.expectedProfileVersion !== creator.profileVersion) {
        domainError("VERSION_CONFLICT", "共享达人基础档案已更新，请刷新后再添加账号");
      }
    }
    const platform = command.platform ?? "douyin";
    const externalId = normalizeKey(command.externalAccountId);
    const owner = state.creators.flatMap((item) => item.accounts.map((account) => ({ creator: item, account })))
      .find(({ account }) => account.platform === platform && account.externalAccountId === externalId);
    if (owner) {
      if (owner.creator.id !== creator.id) domainError("IDENTITY_CONFLICT", "此稳定账号已关联到其他达人，需由主管核对身份");
      const account = owner.account;
      const nextCommerceTypes = command.commerceTypes ?? account.commerceTypes ?? [];
      if (account.displayName === command.displayName && account.profileUrl === (command.profileUrl ?? null)
        && stableStringify(account.commerceTypes ?? []) === stableStringify(nextCommerceTypes)) return clone(creator);
      const before = { displayName: account.displayName, profileUrl: account.profileUrl, commerceTypes: account.commerceTypes ?? [] };
      account.displayName = command.displayName;
      account.profileUrl = command.profileUrl ?? null;
      account.commerceTypes = [...nextCommerceTypes];
      account.lastVerifiedAt = this.runtime.now();
      account.accountVersion = (account.accountVersion ?? 1) + 1;
      incrementVersion(creator, this.runtime.now(), auth.member.id);
      addAudit(state, this.runtime, auth.member.id, creator, "creator", creator.id, "creator.account_updated", "平台账号资料核对", before, { displayName: account.displayName, profileUrl: account.profileUrl, commerceTypes: account.commerceTypes });
      return clone(creator);
    }
    creator.accounts.push({ id: this.runtime.id("account"), platform, externalAccountId: externalId, displayName: command.displayName, profileUrl: command.profileUrl ?? null, active: true, commerceTypes: command.commerceTypes ?? [], accountVersion: 1, firstSeenAt: this.runtime.now(), lastVerifiedAt: null });
    incrementVersion(creator, this.runtime.now(), auth.member.id);
    addAudit(state, this.runtime, auth.member.id, creator, "creator", creator.id, "creator.account_added", null, null, { platform, externalAccountId: externalId, displayName: command.displayName });
    return clone(creator);
  }

  private updateCreatorAccount(state: DomainState, auth: AuthContext, command: Extract<DomainCommand, { type: "creator.updateAccount" }>): Creator {
    requireManagerOrAdmin(auth, "共享达人平台账号由管理岗核对并维护");
    const creator = this.mutableCreator(state, auth, command.creatorId);
    checkVersion(creator, command.expectedVersion);
    const profileVersion = creator.profileVersion ?? 1;
    if (command.expectedProfileVersion !== profileVersion) {
      domainError("VERSION_CONFLICT", "共享达人基础档案已更新，请刷新后再保存");
    }
    const account = creator.accounts.find((item) => item.id === command.accountId);
    if (!account) domainError("NOT_FOUND", "平台账号不存在或不属于当前达人");
    const accountVersion = account.accountVersion ?? 1;
    if (command.expectedAccountVersion !== accountVersion) {
      domainError("VERSION_CONFLICT", "平台账号已更新，请刷新后再保存");
    }
    const hasUpdate = command.displayName !== undefined || "profileUrl" in command
      || command.active !== undefined || command.commerceTypes !== undefined;
    if (!hasUpdate) domainError("VALIDATION_ERROR", "请提供至少一个账号更新字段");
    const before = {
      displayName: account.displayName,
      profileUrl: account.profileUrl,
      active: account.active,
      commerceTypes: account.commerceTypes ?? [],
    };
    if (command.displayName !== undefined) account.displayName = command.displayName;
    if ("profileUrl" in command) account.profileUrl = command.profileUrl ?? null;
    if (command.active !== undefined) account.active = command.active;
    if (command.commerceTypes !== undefined) account.commerceTypes = [...command.commerceTypes];
    account.accountVersion = accountVersion + 1;
    account.lastVerifiedAt = this.runtime.now();
    incrementVersion(creator, this.runtime.now(), auth.member.id);
    addAudit(state, this.runtime, auth.member.id, creator, "creator", creator.id, "creator.account_updated", "平台账号资料维护", before, {
      displayName: account.displayName,
      profileUrl: account.profileUrl,
      active: account.active,
      commerceTypes: account.commerceTypes ?? [],
    });
    return clone(creator);
  }

  private claimCreator(state: DomainState, auth: AuthContext, command: Extract<DomainCommand, { type: "creator.claim" }>): Creator {
    if (auth.role !== "bd") domainError("FORBIDDEN", "公海认领由商务本人执行；主管请使用转交操作");
    const creator = this.mutableCreator(state, auth, command.creatorId, true);
    checkVersion(creator, command.expectedVersion);
    if (creator.ownerMemberId !== null) domainError("BUSINESS_RULE_VIOLATION", "该达人已被认领，请刷新负责人状态");
    this.changeCreatorOwner(state, auth, creator, auth.member, this.runtime.now(), "商务认领公海");
    return clone(creator);
  }

  private transferCreator(state: DomainState, auth: AuthContext, command: Extract<DomainCommand, { type: "creator.transfer" }>): Creator {
    requireManagerOrAdmin(auth, "只有主管或管理员可以转交达人");
    const creator = this.mutableCreator(state, auth, command.creatorId);
    checkVersion(creator, command.expectedVersion);
    const target = this.targetMember(state, auth, command.targetMemberId);
    if (creator.ownerMemberId === target.id) domainError("BUSINESS_RULE_VIOLATION", "该达人当前已归属目标商务");
    this.businessExtension.assertCreatorTransferAllowed(state, creator, target.teamId);
    const now = this.runtime.now();
    this.assertEffectiveAt(command.effectiveAt, now);
    const before = { ownerMemberId: creator.ownerMemberId, teamId: creator.teamId };
    const previousOwnerId = creator.ownerMemberId;
    this.changeCreatorOwner(state, auth, creator, target, command.effectiveAt, command.reason);
    this.moveOpenCreatorWork(state, auth, creator, target, command.effectiveAt, previousOwnerId);
    addAudit(state, this.runtime, auth.member.id, creator, "creator", creator.id, "creator.transferred", command.reason, before, { ownerMemberId: target.id, teamId: target.teamId, effectiveAt: command.effectiveAt });
    return clone(creator);
  }

  private setCreatorStage(state: DomainState, auth: AuthContext, command: Extract<DomainCommand, { type: "creator.setStage" }>): Creator {
    const creator = this.mutableCreator(state, auth, command.creatorId);
    checkVersion(creator, command.expectedVersion);
    if (!this.isAllowedStageTransition(creator, command.stage, auth)) domainError("INVALID_TRANSITION", `不能从“${creator.crmStage}”转到“${command.stage}”`);
    this.assertStageEvidence(state, creator, command.stage, command.occurredAt, command.reason ?? null, command.reviewAt ?? null);
    const before = { stage: creator.crmStage, pauseReason: creator.pauseReason, declineReason: creator.declineReason, reviewAt: creator.reviewAt };
    if (command.stage === "paused") {
      creator.pausedFromStage = creator.crmStage === "paused" ? creator.pausedFromStage : creator.crmStage;
      creator.pauseReason = command.reason ?? null;
      creator.reviewAt = command.reviewAt ?? null;
    } else if (command.stage === "declined") {
      creator.declineReason = command.reason ?? null;
      creator.pausedFromStage = null;
      creator.pauseReason = null;
      creator.reviewAt = null;
    } else {
      creator.pausedFromStage = null;
      creator.pauseReason = null;
      creator.reviewAt = null;
      creator.declineReason = null;
    }
    creator.crmStage = command.stage;
    incrementVersion(creator, this.runtime.now(), auth.member.id);
    state.creatorStageEvents.push({ id: this.runtime.id("stage"), creatorId: creator.id, orgId: creator.orgId, teamId: creator.teamId, stage: command.stage, occurredAt: command.occurredAt, recordedAt: this.runtime.now(), actorId: auth.member.id, reason: command.reason ?? null });
    addAudit(state, this.runtime, auth.member.id, creator, "creator", creator.id, "creator.stage_changed", command.reason ?? null, before, { stage: creator.crmStage, reviewAt: creator.reviewAt });
    return clone(creator);
  }

  private mergeCreators(state: DomainState, auth: AuthContext, command: Extract<DomainCommand, { type: "creator.merge" }>): Creator {
    requireManagerOrAdmin(auth, "只有主管或管理员可以合并达人身份");
    if (command.sourceCreatorId === command.targetCreatorId) domainError("VALIDATION_ERROR", "不能把达人合并到自身");
    const source = this.mutableCreator(state, auth, command.sourceCreatorId);
    const target = this.mutableCreator(state, auth, command.targetCreatorId);
    checkVersion(source, command.expectedSourceVersion);
    checkVersion(target, command.expectedTargetVersion);
    if (source.teamId !== target.teamId) domainError("IDENTITY_CONFLICT", "跨团队达人身份需先完成责任交接，再由管理员合并");
    if (source.contact && target.contact && stableStringify(source.contact) !== stableStringify(target.contact)) domainError("IDENTITY_CONFLICT", "两份档案的联系信息不同，请先人工核对后再合并");
    const mergedCurrentOwner = this.mergeOwnerHistories(state, source, target);
    this.coalesceOwnerHistoryAtMerge(state, auth, source, target, mergedCurrentOwner, this.runtime.now());
    const before = { sourceCreatorId: source.id, targetCreatorId: target.id, sourceAccounts: source.accounts.length, targetAccounts: target.accounts.length };
    const targetAccountsByKey = new Map(target.accounts.map((account) => [`${account.platform}:${account.externalAccountId}`, account]));
    const accountIdMap = new Map<string, string>();
    for (const account of source.accounts) {
      const key = `${account.platform}:${account.externalAccountId}`;
      const existing = targetAccountsByKey.get(key);
      if (existing) {
        if (existing.displayName !== account.displayName || existing.profileUrl !== account.profileUrl
          || stableStringify(existing.commerceTypes ?? []) !== stableStringify(account.commerceTypes ?? [])) {
          domainError("IDENTITY_CONFLICT", "重复的平台账号资料不同，请先核对昵称、主页链接或带货类型");
        }
        accountIdMap.set(account.id, existing.id);
      } else {
        target.accounts.push(account);
        targetAccountsByKey.set(key, account);
        accountIdMap.set(account.id, account.id);
      }
    }
    this.businessExtension.reassignCreatorReferencesOnMerge(state, auth, source, target, this.runtime, accountIdMap);
    target.tags = unique([...target.tags, ...source.tags]);
    target.contact = target.contact ?? source.contact;
    target.internalNote = [target.internalNote, source.internalNote].filter(Boolean).join("\n--- 合并档案 ---\n") || null;
    if (!target.category) target.category = source.category;
    state.creatorStageEvents.filter((item) => item.creatorId === source.id).forEach((item) => { item.creatorId = target.id; item.teamId = target.teamId; });
    for (const item of state.followups.filter((record) => record.creatorId === source.id)) { item.creatorId = target.id; item.teamId = target.teamId; }
    for (const item of state.tasks.filter((record) => record.creatorId === source.id)) { item.creatorId = target.id; item.teamId = target.teamId; }
    for (const item of state.samples.filter((record) => record.creatorId === source.id)) {
      if (item.creatorAccountId !== undefined) {
        const mappedAccountId = accountIdMap.get(item.creatorAccountId);
        const mappedAccount = mappedAccountId
          ? target.accounts.find((account) => account.id === mappedAccountId)
          : undefined;
        if (!mappedAccount) domainError("IDENTITY_CONFLICT", "样品申请引用的平台账号无法映射到合并后的达人");
        if (item.platform !== undefined && item.platform !== mappedAccount.platform) {
          domainError("IDENTITY_CONFLICT", "样品申请的平台与引用账号不一致，不能合并达人");
        }
        item.creatorAccountId = mappedAccount.id;
        item.platform = mappedAccount.platform;
      }
      item.creatorId = target.id;
      item.teamId = target.teamId;
    }
    for (const item of state.cooperations.filter((record) => record.creatorId === source.id)) { item.creatorId = target.id; item.teamId = target.teamId; }
    for (const item of state.schedules.filter((record) => record.creatorId === source.id)) { item.creatorId = target.id; item.teamId = target.teamId; }
    for (const item of state.deliveries.filter((record) => record.creatorId === source.id)) { item.creatorId = target.id; item.teamId = target.teamId; }
    for (const item of state.orders.filter((record) => record.creatorId === source.id)) item.creatorId = target.id; // ownerSnapshot is immutable.
    for (const item of state.salesReports.filter((record) => record.creatorId === source.id)) {
      const mappedAccountId = accountIdMap.get(item.creatorAccountId);
      const mappedAccount = mappedAccountId
        ? target.accounts.find((account) => account.id === mappedAccountId)
        : undefined;
      if (!mappedAccount || mappedAccount.platform !== item.platform
        || mappedAccount.externalAccountId !== item.externalAccountId) {
        domainError("IDENTITY_CONFLICT", "带货业绩引用的平台账号无法映射到合并后的达人");
      }
      const beforeReport = {
        creatorId: item.creatorId,
        creatorAccountId: item.creatorAccountId,
      };
      item.creatorId = target.id;
      item.creatorAccountId = mappedAccount.id;
      item.teamId = target.teamId;
      incrementVersion(item, this.runtime.now(), auth.member.id);
      addAudit(state, this.runtime, auth.member.id, item, "sales_report", item.id,
        "sales_report.creator_merged", "达人身份合并", beforeReport, {
          creatorId: item.creatorId,
          creatorAccountId: item.creatorAccountId,
          externalAccountId: item.externalAccountId,
          ownerMemberId: item.ownerMemberId,
          status: item.status,
        });
    }
    source.accounts = [];
    source.archived = true;
    source.mergedIntoCreatorId = target.id;
    source.ownerMemberId = null;
    source.updatedAt = this.runtime.now();
    source.updatedBy = auth.member.id;
    source.version += 1;
    target.ownerMemberId = mergedCurrentOwner;
    incrementVersion(target, this.runtime.now(), auth.member.id);
    addAudit(state, this.runtime, auth.member.id, target, "creator", target.id, "creator.merged", command.reason, before, { sourceCreatorId: source.id, targetCreatorId: target.id, accounts: target.accounts.length });
    addAudit(state, this.runtime, auth.member.id, source, "creator", source.id, "creator.merged_into", command.reason, { archived: false }, { archived: true, mergedIntoCreatorId: target.id });
    return clone(target);
  }

  private addFollowup(state: DomainState, auth: AuthContext, command: Extract<DomainCommand, { type: "followup.add" }>): unknown {
    const creator = this.mutableCreator(state, auth, command.creatorId);
    checkVersion(creator, command.expectedCreatorVersion);
    const now = this.runtime.now();
    const followup = {
      id: this.runtime.id("followup"), orgId: creator.orgId, teamId: creator.teamId, creatorId: creator.id,
      occurredAt: command.occurredAt, channel: command.channel, result: command.result, summary: command.summary,
      accountId: command.accountId ?? null, evidenceUrl: command.evidenceUrl ?? null,
      version: 1, createdAt: now, createdBy: auth.member.id, updatedAt: now, updatedBy: auth.member.id,
    };
    state.followups.push(followup);
    const autoStages = this.followupStagePath(creator.crmStage, command.result);
    if (autoStages.length > 0) {
      const before = { stage: creator.crmStage };
      for (const autoStage of autoStages) {
        creator.crmStage = autoStage;
        if (autoStage === "declined") creator.declineReason = command.summary;
        state.creatorStageEvents.push({ id: this.runtime.id("stage"), orgId: creator.orgId, teamId: creator.teamId, creatorId: creator.id, stage: autoStage, occurredAt: command.occurredAt, recordedAt: now, actorId: auth.member.id, reason: autoStage === "declined" ? command.summary : `由跟进结果“${command.result}”记录` });
      }
      incrementVersion(creator, now, auth.member.id);
      addAudit(state, this.runtime, auth.member.id, creator, "creator", creator.id, "creator.stage_advanced_from_followup", command.result === "not_interested" ? command.summary : null, before, { stage: creator.crmStage, path: autoStages });
    }
    if (command.nextAction) {
      const task: WorkTask = {
        id: this.runtime.id("task"), orgId: creator.orgId, teamId: creator.teamId, creatorId: creator.id,
        kind: "followup", title: command.nextAction.title, ownerMemberId: auth.member.id, requiredCapability: null, dueAt: command.nextAction.dueAt,
        status: "open", relatedType: "creator", relatedId: creator.id, completedAt: null, completionNote: null,
        priority: command.nextAction.priority, version: 1, createdAt: now, createdBy: auth.member.id, updatedAt: now, updatedBy: auth.member.id,
      };
      state.tasks.push(task);
      addAudit(state, this.runtime, auth.member.id, task, "task", task.id, "task.created", null, null, { kind: task.kind, ownerMemberId: task.ownerMemberId, dueAt: task.dueAt });
    }
    addAudit(state, this.runtime, auth.member.id, creator, "followup", followup.id, "followup.created", null, null, { creatorId: creator.id, occurredAt: followup.occurredAt, channel: followup.channel, result: followup.result });
    return { followup: clone(followup), creator: clone(creator), task: command.nextAction ? clone(state.tasks[state.tasks.length - 1]) : null };
  }

  private createCreatorSession(
    state: DomainState,
    auth: AuthContext,
    command: Extract<DomainCommand, { type: "creator.session.create" }>,
  ): CreatorSessionRecord {
    this.assertBusinessRole(auth);
    const creator = this.mutableCreator(state, auth, command.creatorId);
    const account = creator.accounts.find((item) => item.id === command.creatorAccountId && item.active);
    if (!account) domainError("NOT_FOUND", "有效平台账号不存在或不属于当前达人");
    const productIds = unique(command.productIds ?? []).map((productId) => this.requireProduct(state, auth, productId).id);
    const now = this.runtime.now();
    const session: CreatorSessionRecord = {
      id: this.runtime.id("creator-session"), orgId: creator.orgId, teamId: creator.teamId,
      creatorId: creator.id, creatorAccountId: account.id, platform: account.platform,
      commerceType: command.commerceType, occurredOn: command.occurredOn, title: command.title,
      productIds, gmvCents: command.gmvCents ?? null, orderCount: command.orderCount ?? null,
      contentUrl: command.contentUrl ?? null, note: command.note ?? null, source: "manual",
      version: 1, createdAt: now, createdBy: auth.member.id, updatedAt: now, updatedBy: auth.member.id,
    };
    state.creatorSessions.push(session);
    addAudit(state, this.runtime, auth.member.id, session, "creator_session", session.id, "creator_session.created", null, null, {
      creatorId: creator.id, creatorAccountId: account.id, platform: account.platform,
      commerceType: session.commerceType, occurredOn: session.occurredOn,
      productCount: session.productIds.length, source: session.source,
    });
    return clone(session);
  }

  private updateCreatorSession(
    state: DomainState,
    auth: AuthContext,
    command: Extract<DomainCommand, { type: "creator.session.update" }>,
  ): CreatorSessionRecord {
    this.assertBusinessRole(auth);
    const session = state.creatorSessions.find((item) => item.id === command.sessionId && item.orgId === state.orgId);
    if (!session) domainError("NOT_FOUND", "历史表现记录不存在或当前账号无权访问");
    const creator = this.mutableCreator(state, auth, session.creatorId);
    if (session.teamId !== creator.teamId) domainError("NOT_FOUND", "历史表现记录不存在或当前账号无权访问");
    checkVersion(session, command.expectedVersion);
    const hasPatch = command.creatorAccountId !== undefined || command.commerceType !== undefined
      || command.occurredOn !== undefined || command.title !== undefined || command.productIds !== undefined
      || "gmvCents" in command || "orderCount" in command || "contentUrl" in command || "note" in command;
    if (!hasPatch) domainError("VALIDATION_ERROR", "请提供至少一个历史表现更新字段");
    const accountId = command.creatorAccountId ?? session.creatorAccountId;
    const account = creator.accounts.find((item) => item.id === accountId);
    if (!account || (accountId !== session.creatorAccountId && !account.active)) {
      domainError("NOT_FOUND", "有效平台账号不存在或不属于当前达人");
    }
    const before = {
      creatorAccountId: session.creatorAccountId, commerceType: session.commerceType,
      occurredOn: session.occurredOn, productIds: [...session.productIds],
      hasGmv: session.gmvCents !== null, hasOrderCount: session.orderCount !== null,
      hasContentUrl: session.contentUrl !== null, hasNote: session.note !== null,
    };
    if (command.creatorAccountId !== undefined) {
      session.creatorAccountId = account.id;
      session.platform = account.platform;
    }
    if (command.commerceType !== undefined) session.commerceType = command.commerceType;
    if (command.occurredOn !== undefined) session.occurredOn = command.occurredOn;
    if (command.title !== undefined) session.title = command.title;
    if (command.productIds !== undefined) {
      session.productIds = unique(command.productIds).map((productId) => this.requireProduct(state, auth, productId).id);
    }
    if ("gmvCents" in command) session.gmvCents = command.gmvCents ?? null;
    if ("orderCount" in command) session.orderCount = command.orderCount ?? null;
    if ("contentUrl" in command) session.contentUrl = command.contentUrl ?? null;
    if ("note" in command) session.note = command.note ?? null;
    incrementVersion(session, this.runtime.now(), auth.member.id);
    addAudit(state, this.runtime, auth.member.id, session, "creator_session", session.id, "creator_session.updated", null, before, {
      creatorAccountId: session.creatorAccountId, platform: session.platform,
      commerceType: session.commerceType, occurredOn: session.occurredOn,
      productCount: session.productIds.length, hasGmv: session.gmvCents !== null,
      hasOrderCount: session.orderCount !== null, hasContentUrl: session.contentUrl !== null, hasNote: session.note !== null,
    });
    return clone(session);
  }

  private createTask(state: DomainState, auth: AuthContext, command: Extract<DomainCommand, { type: "task.create" }>): WorkTask {
    this.assertBusinessRole(auth);
    if (command.kind !== "followup" && command.kind !== "other") domainError("BUSINESS_RULE_VIOLATION", "审批、发货、签收和交付验收任务由业务状态自动维护");
    if (command.kind === "other" && command.relatedType && command.relatedType !== "creator") domainError("BUSINESS_RULE_VIOLATION", "通用待办不能挂接审批、物流或交付状态流程");
    const owner = this.targetMember(state, auth, command.ownerMemberId);
    if (auth.role === "bd" && owner.id !== auth.member.id) domainError("FORBIDDEN", "商务只能给自己创建待办");
    let creator = command.creatorId ? this.mutableCreator(state, auth, command.creatorId) : null;
    let relatedType = command.relatedType ?? null;
    let relatedId = command.relatedId ?? null;
    if (Boolean(relatedType) !== Boolean(relatedId)) domainError("VALIDATION_ERROR", "待办关联类型和关联 ID 必须同时提供");
    if (creator && relatedType === null && relatedId === null) {
      relatedType = "creator";
      relatedId = creator.id;
    }
    if (relatedType && relatedId && !this.relatedExists(state, relatedType, relatedId)) domainError("NOT_FOUND", "待办关联对象不存在");
    if (relatedType === "creator" && relatedId) {
      const relatedCreator = this.mutableCreator(state, auth, relatedId);
      if (creator && relatedCreator.id !== creator.id) domainError("VALIDATION_ERROR", "待办达人与关联对象不一致");
      creator = relatedCreator;
    } else if (creator) {
      domainError("VALIDATION_ERROR", "达人待办只允许关联该达人主档");
    }
    const now = this.runtime.now();
    const task: WorkTask = {
      id: this.runtime.id("task"), orgId: auth.member.orgId, teamId: creator?.teamId ?? owner.teamId,
      creatorId: creator?.id ?? command.creatorId ?? null, kind: command.kind, title: command.title,
      ownerMemberId: owner.id, requiredCapability: null, dueAt: command.dueAt, status: "open", relatedType,
      relatedId, completedAt: null, completionNote: null, priority: command.priority,
      version: 1, createdAt: now, createdBy: auth.member.id, updatedAt: now, updatedBy: auth.member.id,
    };
    state.tasks.push(task);
    addAudit(state, this.runtime, auth.member.id, task, "task", task.id, "task.created", null, null, { kind: task.kind, ownerMemberId: task.ownerMemberId, dueAt: task.dueAt });
    return clone(task);
  }

  private completeTask(state: DomainState, auth: AuthContext, command: Extract<DomainCommand, { type: "task.complete" }>): WorkTask {
    const task = state.tasks.find((item) => item.id === command.taskId && item.orgId === state.orgId);
    if (!task) domainError("NOT_FOUND", "待办不存在或当前账号无权访问");
    this.assertScopeForAction(state, auth, task);
    if (auth.role === "bd" || auth.role === "ops") {
      if (task.ownerMemberId !== auth.member.id) domainError("NOT_FOUND", "待办不存在或当前账号无权访问");
    }
    if (task.kind !== "followup" && task.kind !== "other") domainError("INVALID_TRANSITION", "此任务由关联业务状态完成，请使用对应业务操作");
    if (task.ownerMemberId === null || task.requiredCapability !== null) domainError("INVALID_TRANSITION", "审批和履约任务需通过对应业务操作完成");
    checkVersion(task, command.expectedVersion);
    if (task.status !== "open") domainError("INVALID_TRANSITION", "只有开放待办可以完成");
    const before = { status: task.status };
    task.status = "completed";
    task.completedAt = command.completedAt;
    task.completionNote = command.note ?? null;
    incrementVersion(task, this.runtime.now(), auth.member.id);
    addAudit(state, this.runtime, auth.member.id, task, "task", task.id, "task.completed", command.note ?? null, before, { status: task.status, completedAt: task.completedAt });
    return clone(task);
  }

  private createProduct(state: DomainState, auth: AuthContext, command: Extract<DomainCommand, { type: "product.create" }>): Product {
    requireManagerOrAdmin(auth, "只有主管或管理员可以维护商品目录");
    const product: Product = {
      id: this.runtime.id("product"), orgId: auth.member.orgId, teamId: auth.member.teamId,
      brand: command.brand, name: command.name, sku: command.sku ?? null, specification: command.specification ?? null,
      sampleCostCents: command.sampleCostCents ?? null, active: true, note: command.note ?? null,
      version: 1, createdAt: this.runtime.now(), createdBy: auth.member.id, updatedAt: this.runtime.now(), updatedBy: auth.member.id,
    };
    state.products.push(product);
    addAudit(state, this.runtime, auth.member.id, product, "product", product.id, "product.created", null, null, { brand: product.brand, name: product.name, sku: product.sku });
    return clone(product);
  }

  private updateProduct(state: DomainState, auth: AuthContext, command: Extract<DomainCommand, { type: "product.update" }>): Product {
    requireManagerOrAdmin(auth, "只有主管或管理员可以维护商品目录");
    const product = state.products.find((item) => item.id === command.productId && item.orgId === state.orgId);
    if (!product) domainError("NOT_FOUND", "商品不存在或当前账号无权访问");
    this.assertScopeForAction(state, auth, product);
    checkVersion(product, command.expectedVersion);
    const before = { brand: product.brand, name: product.name, sku: product.sku, active: product.active };
    if (command.brand !== undefined) product.brand = command.brand;
    if (command.name !== undefined) product.name = command.name;
    if ("sku" in command) product.sku = command.sku ?? null;
    if ("specification" in command) product.specification = command.specification ?? null;
    if ("sampleCostCents" in command) product.sampleCostCents = command.sampleCostCents ?? null;
    if (command.active !== undefined) product.active = command.active;
    if ("note" in command) product.note = command.note ?? null;
    incrementVersion(product, this.runtime.now(), auth.member.id);
    addAudit(state, this.runtime, auth.member.id, product, "product", product.id, "product.updated", null, before, { brand: product.brand, name: product.name, sku: product.sku, active: product.active });
    return clone(product);
  }

  private createSample(state: DomainState, auth: AuthContext, command: Extract<DomainCommand, { type: "sample.create" }>): SampleRequest {
    const creator = this.mutableCreator(state, auth, command.creatorId);
    checkVersion(creator, command.expectedCreatorVersion);
    const products = command.lines.map((line) => this.requireProduct(state, auth, line.productId));
    const cooperationId = command.cooperationId ?? null;
    const superseded = command.originalRequestId ? this.requireSample(state, auth, command.originalRequestId) : null;
    if (superseded) {
      if (superseded.creatorId !== creator.id || (superseded.status !== "rejected" && superseded.status !== "closed")) {
        domainError("BUSINESS_RULE_VIOLATION", "只能为同一达人已驳回或关闭的样品申请创建补样");
      }
      if (superseded.cooperationId !== cooperationId) domainError("BUSINESS_RULE_VIOLATION", "补样必须保留原样品申请的合作单关联");
    }
    let cooperation: Cooperation | null = null;
    if (cooperationId) {
      cooperation = this.requireCooperation(state, auth, cooperationId);
      if (cooperation.creatorId !== creator.id) domainError("BUSINESS_RULE_VIOLATION", "样品申请与合作单的达人不一致");
      if (cooperation.sampleRequirement !== "required") domainError("BUSINESS_RULE_VIOLATION", "该合作未要求寄样，不能关联样品申请");
      if (!["pending_samples_shipment", "pending_samples_receipt"].includes(cooperation.status)) domainError("INVALID_TRANSITION", "当前合作阶段不能新增必需样品");
    }
    const now = this.runtime.now();
    const sample: SampleRequest = {
      id: this.runtime.id("sample"), orgId: creator.orgId, teamId: creator.teamId, creatorId: creator.id,
      cooperationId, applicantId: auth.member.id,
      lines: command.lines.map((line, index) => ({ id: this.runtime.id("sample-line"), productId: products[index].id, quantity: line.quantity })),
      recipient: command.recipient ? normalizeRecipient(command.recipient) : null, shippingBlocked: false, reason: command.reason, status: "draft",
      decidedBy: null, decidedAt: null, decisionReason: null, closeReason: null, originalRequestId: command.originalRequestId ?? null,
      version: 1, createdAt: now, createdBy: auth.member.id, updatedAt: now, updatedBy: auth.member.id,
    };
    state.samples.push(sample);
    if (cooperation) {
      if (superseded) {
        const oldIndex = cooperation.requiredSampleIds.indexOf(superseded.id);
        if (oldIndex < 0) domainError("BUSINESS_RULE_VIOLATION", "原样品申请不在合作单的必需寄样清单中，不能自动替换");
        const previousRequiredSampleIds = [...cooperation.requiredSampleIds];
        const previousStatus = cooperation.status;
        const required = [...cooperation.requiredSampleIds];
        required[oldIndex] = sample.id;
        cooperation.requiredSampleIds = unique(required);
        if (cooperation.status === "pending_samples_receipt") {
          cooperation.status = "pending_samples_shipment";
          incrementVersion(cooperation, now, auth.member.id);
          addAudit(state, this.runtime, auth.member.id, cooperation, "cooperation", cooperation.id, "cooperation.sample_reapplication", command.reason, { status: previousStatus, requiredSampleIds: previousRequiredSampleIds }, { status: cooperation.status, requiredSampleIds: cooperation.requiredSampleIds, replacementSampleId: sample.id });
        } else {
          incrementVersion(cooperation, now, auth.member.id);
          addAudit(state, this.runtime, auth.member.id, cooperation, "cooperation", cooperation.id, "cooperation.sample_replaced", command.reason, { status: previousStatus, requiredSampleIds: previousRequiredSampleIds }, { status: cooperation.status, requiredSampleIds: cooperation.requiredSampleIds, replacementSampleId: sample.id });
        }
        addAudit(state, this.runtime, auth.member.id, superseded, "sample", superseded.id, "sample.superseded_for_reapplication", command.reason, { status: superseded.status }, { status: superseded.status, supersededBySampleId: sample.id });
      } else {
        cooperation.requiredSampleIds = unique([...cooperation.requiredSampleIds, sample.id]);
        incrementVersion(cooperation, now, auth.member.id);
        addAudit(state, this.runtime, auth.member.id, cooperation, "cooperation", cooperation.id, "cooperation.sample_linked", null, null, { sampleId: sample.id });
      }
    }
    addAudit(state, this.runtime, auth.member.id, sample, "sample", sample.id, "sample.created", null, null, { creatorId: creator.id, cooperationId, lines: sample.lines.length, status: sample.status });
    return this.sampleForActor(state, auth, sample);
  }

  private requestSample(state: DomainState, auth: AuthContext, command: Extract<DomainCommand, { type: "sample.request" }>): SampleRequest {
    this.assertBusinessRole(auth);
    if (!command.recipient) domainError("BUSINESS_RULE_VIOLATION", "直接寄样前请填写收件信息");
    const creator = this.mutableCreator(state, auth, command.creatorId);
    const account = creator.accounts.find((item) => item.id === command.creatorAccountId && item.active);
    if (!account) domainError("NOT_FOUND", "有效平台账号不存在或不属于当前达人");
    const created = this.createSample(state, auth, {
      type: "sample.create",
      creatorId: command.creatorId,
      expectedCreatorVersion: command.expectedCreatorVersion,
      cooperationId: command.cooperationId,
      lines: command.lines,
      recipient: command.recipient,
      reason: command.reason,
      originalRequestId: command.originalRequestId,
    });
    const sample = state.samples.find((item) => item.id === created.id);
    if (!sample) domainError("BUSINESS_RULE_VIOLATION", "样品申请创建后无法读取");
    sample.creatorAccountId = account.id;
    sample.platform = account.platform;
    sample.status = "pending_shipment";
    const cooperation = sample.cooperationId
      ? state.cooperations.find((item) => item.id === sample.cooperationId)
      : undefined;
    if (cooperation?.status === "pending_samples_receipt") {
      const previousStatus = cooperation.status;
      cooperation.status = "pending_samples_shipment";
      incrementVersion(cooperation, this.runtime.now(), auth.member.id);
      addAudit(state, this.runtime, auth.member.id, cooperation, "cooperation", cooperation.id, "cooperation.sample_reapplication", command.reason, { status: previousStatus }, { status: cooperation.status, replacementSampleId: sample.id });
    }
    this.enqueueReviewTask(state, auth, "sample_shipment", sample.creatorId, "寄出已登记样品", "sample", sample.id, "sample.fulfill");
    addAudit(state, this.runtime, auth.member.id, sample, "sample", sample.id, "sample.directly_requested", command.reason, { status: "draft" }, {
      status: sample.status, source: "direct_submission", actorId: auth.member.id,
    });
    return this.sampleForActor(state, auth, sample);
  }

  private updateSampleDraft(state: DomainState, auth: AuthContext, command: Extract<DomainCommand, { type: "sample.updateDraft" }>): SampleRequest {
    const sample = this.requireSample(state, auth, command.sampleId);
    this.assertSampleEdit(state, auth, sample);
    checkVersion(sample, command.expectedVersion);
    if (sample.status !== "draft") domainError("INVALID_TRANSITION", "只有草稿样品申请可以修改");
    const before = { lines: sample.lines, reason: sample.reason, recipient: sample.recipient };
    if (command.lines) {
      const productIds = command.lines.map((line) => this.requireProduct(state, auth, line.productId).id);
      sample.lines = command.lines.map((line, index) => ({ id: sample.lines[index]?.id ?? this.runtime.id("sample-line"), productId: productIds[index], quantity: line.quantity }));
    }
    if ("recipient" in command) sample.recipient = command.recipient ? normalizeRecipient(command.recipient) : null;
    if (command.reason !== undefined) sample.reason = command.reason;
    incrementVersion(sample, this.runtime.now(), auth.member.id);
    addAudit(state, this.runtime, auth.member.id, sample, "sample", sample.id, "sample.draft_updated", null, before, { lines: sample.lines, reason: sample.reason, status: sample.status });
    return this.sampleForActor(state, auth, sample);
  }

  private submitSample(state: DomainState, auth: AuthContext, command: Extract<DomainCommand, { type: "sample.submit" }>): SampleRequest {
    const sample = this.requireSample(state, auth, command.sampleId);
    this.assertSampleEdit(state, auth, sample);
    checkVersion(sample, command.expectedVersion);
    if (sample.status !== "draft") domainError("INVALID_TRANSITION", "只有草稿样品申请可以提交审核");
    if (sample.lines.length === 0 || sample.lines.some((line) => line.quantity <= 0)) domainError("BUSINESS_RULE_VIOLATION", "提交前需要至少一项有效商品和数量");
    if (!sample.recipient) domainError("BUSINESS_RULE_VIOLATION", "提交寄样审核前请填写收件信息");
    const before = { status: sample.status };
    sample.status = "pending_approval";
    incrementVersion(sample, this.runtime.now(), auth.member.id);
    this.enqueueReviewTask(state, auth, "sample_approval", sample.creatorId, "审核样品申请", "sample", sample.id, "sample.approve", command.submittedAt);
    addAudit(state, this.runtime, auth.member.id, sample, "sample", sample.id, "sample.submitted", null, before, { status: sample.status });
    return this.sampleForActor(state, auth, sample);
  }

  private decideSample(state: DomainState, auth: AuthContext, command: Extract<DomainCommand, { type: "sample.decide" }>): SampleRequest {
    requireCapability(auth, "sample.approve", "需要样品审批能力");
    const sample = this.requireSample(state, auth, command.sampleId);
    this.assertScopeForAction(state, auth, sample);
    checkVersion(sample, command.expectedVersion);
    if (sample.status !== "pending_approval") domainError("INVALID_TRANSITION", "样品申请当前不在待审核状态");
    if (sample.applicantId === auth.member.id) domainError("FORBIDDEN", "申请人不能审批自己的样品申请");
    const reason = command.reason ?? null;
    if (command.decision === "rejected" && !reason?.trim()) domainError("BUSINESS_RULE_VIOLATION", "驳回样品申请必须填写原因");
    const before = { status: sample.status };
    sample.status = command.decision === "approved" ? "pending_shipment" : "rejected";
    sample.decidedBy = auth.member.id;
    sample.decidedAt = command.decidedAt;
    sample.decisionReason = reason;
    incrementVersion(sample, this.runtime.now(), auth.member.id);
    this.completeTasks(state, auth.member.id, "sample", sample.id, command.decidedAt, `样品申请已${command.decision === "approved" ? "通过" : "驳回"}`, "sample_approval");
    if (sample.status === "pending_shipment") this.enqueueReviewTask(state, auth, "sample_shipment", sample.creatorId, "寄出已审批样品", "sample", sample.id, "sample.fulfill", command.decidedAt);
    this.refreshCooperationAfterSamples(state, auth.member.id, sample, command.decidedAt);
    addAudit(state, this.runtime, auth.member.id, sample, "sample", sample.id, `sample.${command.decision}`, reason, before, { status: sample.status, decidedAt: sample.decidedAt });
    return this.sampleForActor(state, auth, sample);
  }

  private addSamplePackage(state: DomainState, auth: AuthContext, command: Extract<DomainCommand, { type: "sample.addPackage" }>): SamplePackage {
    requireCapability(auth, "sample.fulfill", "需要样品物流能力");
    const sample = this.requireSample(state, auth, command.sampleId);
    this.assertScopeForAction(state, auth, sample);
    checkVersion(sample, command.expectedVersion);
    if (sample.status !== "pending_shipment" && sample.status !== "shipped") domainError("INVALID_TRANSITION", "样品申请当前不在待发货状态");
    if (sample.shippingBlocked) domainError("INVALID_TRANSITION", "该样品已停止新增包裹，只能继续登记现有包裹签收");
    if (!sample.recipient) domainError("BUSINESS_RULE_VIOLATION", "未记录收件信息，不能发货");
    if (unique(command.lines.map((line) => line.sampleLineId)).length !== command.lines.length) domainError("VALIDATION_ERROR", "同一包裹内的样品行不能重复，请先汇总数量");
    const trackKey = normalizeKey(command.trackingNumber);
    if (state.samplePackages.some((pkg) => pkg.orgId === sample.orgId && pkg.trackingNumber === trackKey)) domainError("DUPLICATE", "该物流单号已经登记");
    const lineMap = new Map(sample.lines.map((line) => [line.id, line]));
    const remaining = new Map(sample.lines.map((sampleLine) => [sampleLine.id, sampleLine.quantity - state.samplePackages.filter((pkg) => pkg.sampleId === sample.id).flatMap((pkg) => pkg.lines).filter((shipmentLine) => shipmentLine.sampleLineId === sampleLine.id).reduce((sum, shipmentLine) => sum + shipmentLine.quantity, 0)]));
    for (const line of command.lines) {
      const source = lineMap.get(line.sampleLineId);
      if (!source || source.productId !== line.productId) domainError("BUSINESS_RULE_VIOLATION", "包裹商品必须来自原样品申请");
      if (line.quantity > (remaining.get(line.sampleLineId) ?? 0)) domainError("BUSINESS_RULE_VIOLATION", "包裹数量超过样品申请剩余数量");
      remaining.set(line.sampleLineId, (remaining.get(line.sampleLineId) ?? 0) - line.quantity);
    }
    const now = this.runtime.now();
    const pkg: SamplePackage = {
      id: this.runtime.id("package"), orgId: sample.orgId, teamId: sample.teamId, sampleId: sample.id,
      carrier: command.carrier, trackingNumber: trackKey, lines: command.lines.map((line) => ({ ...line })),
      shippedAt: command.shippedAt, shippedBy: auth.member.id, receivedAt: null, receivedBy: null, receiptEvidenceUrl: null,
      version: 1, createdAt: now, createdBy: auth.member.id, updatedAt: now, updatedBy: auth.member.id,
    };
    const before = { status: sample.status };
    state.samplePackages.push(pkg);
    sample.status = "shipped";
    incrementVersion(sample, now, auth.member.id);
    this.completeTasks(state, auth.member.id, "sample", sample.id, command.shippedAt, "样品已登记发货", "sample_shipment");
    this.enqueueReviewTask(state, auth, "sample_receipt", sample.creatorId, "确认样品签收", "sample", sample.id, "sample.fulfill", command.shippedAt);
    this.refreshCooperationAfterSamples(state, auth.member.id, sample, command.shippedAt);
    addAudit(state, this.runtime, auth.member.id, pkg, "sample_package", pkg.id, "sample.package_shipped", null, null, { sampleId: sample.id, trackingNumber: pkg.trackingNumber, lines: pkg.lines.length, shippedAt: pkg.shippedAt });
    addAudit(state, this.runtime, auth.member.id, sample, "sample", sample.id, "sample.shipped", null, before, { status: sample.status, packageId: pkg.id });
    return clone(pkg);
  }

  private confirmSampleReceipt(state: DomainState, auth: AuthContext, command: Extract<DomainCommand, { type: "sample.confirmReceipt" }>): SampleRequest {
    requireCapability(auth, "sample.fulfill", "需要样品物流能力");
    const sample = this.requireSample(state, auth, command.sampleId);
    this.assertScopeForAction(state, auth, sample);
    checkVersion(sample, command.expectedSampleVersion);
    if (sample.status !== "shipped") domainError("INVALID_TRANSITION", "只有已发货的样品申请可以确认签收");
    const pkg = state.samplePackages.find((item) => item.id === command.packageId && item.sampleId === sample.id);
    if (!pkg) domainError("NOT_FOUND", "物流包裹不存在");
    checkVersion(pkg, command.expectedPackageVersion);
    if (pkg.receivedAt) domainError("INVALID_TRANSITION", "该物流包裹已经确认签收");
    if (Date.parse(command.receivedAt) < Date.parse(pkg.shippedAt)) domainError("BUSINESS_RULE_VIOLATION", "签收时间不能早于发货时间");
    const beforePackage = { receivedAt: pkg.receivedAt };
    pkg.receivedAt = command.receivedAt;
    pkg.receivedBy = auth.member.id;
    pkg.receiptEvidenceUrl = command.evidenceUrl ?? null;
    incrementVersion(pkg, this.runtime.now(), auth.member.id);
    const beforeSample = { status: sample.status };
    sample.status = this.sampleFullyReceived(state, sample) ? "received" : "shipped";
    incrementVersion(sample, this.runtime.now(), auth.member.id);
    if (sample.status === "received") this.completeTasks(state, auth.member.id, "sample", sample.id, command.receivedAt, "全部必需样品已签收", "sample_receipt");
    this.refreshCooperationAfterSamples(state, auth.member.id, sample, command.receivedAt);
    addAudit(state, this.runtime, auth.member.id, pkg, "sample_package", pkg.id, "sample.package_received", null, beforePackage, { receivedAt: pkg.receivedAt, evidenceUrl: pkg.receiptEvidenceUrl });
    addAudit(state, this.runtime, auth.member.id, sample, "sample", sample.id, "sample.receipt_updated", null, beforeSample, { status: sample.status, packageId: pkg.id });
    return this.sampleForActor(state, auth, sample);
  }

  private closeSample(state: DomainState, auth: AuthContext, command: Extract<DomainCommand, { type: "sample.close" }>): SampleRequest {
    const sample = this.requireSample(state, auth, command.sampleId);
    this.assertSampleEdit(state, auth, sample);
    checkVersion(sample, command.expectedVersion);
    if (!["draft", "pending_approval", "pending_shipment", "shipped"].includes(sample.status)) domainError("INVALID_TRANSITION", "当前样品申请不能关闭");
    const hasPackages = state.samplePackages.some((pkg) => pkg.sampleId === sample.id);
    if (hasPackages) domainError("INVALID_TRANSITION", "已有发货包裹的申请不能关闭，请先完成现有包裹签收；发货事实会保留");
    const before = { status: sample.status, shippingBlocked: sample.shippingBlocked };
    sample.status = "closed";
    sample.shippingBlocked = true;
    sample.closeReason = command.reason;
    incrementVersion(sample, this.runtime.now(), auth.member.id);
    this.completeAllRelatedTasks(state, auth.member.id, "sample", sample.id, command.closedAt, "样品申请已关闭");
    this.refreshCooperationAfterSamples(state, auth.member.id, sample, command.closedAt);
    addAudit(state, this.runtime, auth.member.id, sample, "sample", sample.id, "sample.closed", command.reason, before, { status: sample.status });
    return this.sampleForActor(state, auth, sample);
  }

  private createCooperation(state: DomainState, auth: AuthContext, command: Extract<DomainCommand, { type: "cooperation.create" }>): Cooperation {
    const creator = this.mutableCreator(state, auth, command.creatorId);
    checkVersion(creator, command.expectedCreatorVersion);
    if (command.startAt && command.endAt && Date.parse(command.endAt) < Date.parse(command.startAt)) domainError("VALIDATION_ERROR", "合作结束时间不能早于开始时间");
    const lines = command.lines.map((line) => {
      if (line.productId) this.requireProduct(state, auth, line.productId);
      this.assertCooperationLineOfferScope(state, creator.teamId, line);
      return {
        id: this.runtime.id("cooperation-line"), productId: line.productId ?? null,
        productName: line.productName, sku: line.sku ?? null, specification: line.specification ?? null,
        agreedPriceCents: line.agreedPriceCents ?? null, agreedQuantity: line.agreedQuantity ?? null,
        deliveryRequirement: line.deliveryRequirement, note: line.note ?? null,
        storeId: line.storeId ?? null, storeAssortmentId: line.storeAssortmentId ?? null,
        assortmentVersion: line.assortmentVersion ?? null, livePriceCents: line.livePriceCents ?? null,
        creatorCommissionBps: line.creatorCommissionBps ?? null, sellingPointsSnapshot: line.sellingPointsSnapshot ? [...line.sellingPointsSnapshot] : [],
        sellingPointEvidenceUrl: line.sellingPointEvidenceUrl ?? null, salesCardUrl: line.salesCardUrl ?? null,
        productGroupsSnapshot: line.productGroupsSnapshot ? [...line.productGroupsSnapshot] : [],
      };
    });
    const now = this.runtime.now();
    const cooperation: Cooperation = {
      id: this.runtime.id("cooperation"), orgId: creator.orgId, teamId: creator.teamId,
      creatorId: creator.id, ownerMemberId: auth.member.id, title: command.title, lines,
      sampleRequirement: command.sampleRequirement, requiredSampleIds: [], deliveryRequirement: command.deliveryRequirement,
      status: "draft", applicantId: auth.member.id, decidedBy: null, decidedAt: null,
      decisionReason: null, rejectionReason: null, cancellationReason: null, waivedSamplesReason: null,
      startAt: command.startAt ?? null, endAt: command.endAt ?? null, note: command.note ?? null,
      version: 1, createdAt: now, createdBy: auth.member.id, updatedAt: now, updatedBy: auth.member.id,
    };
    state.cooperations.push(cooperation);
    addAudit(state, this.runtime, auth.member.id, cooperation, "cooperation", cooperation.id, "cooperation.created", null, null, { creatorId: creator.id, title: cooperation.title, productLines: cooperation.lines.length });
    return clone(cooperation);
  }

  private updateCooperationDraft(state: DomainState, auth: AuthContext, command: Extract<DomainCommand, { type: "cooperation.updateDraft" }>): Cooperation {
    const cooperation = this.requireCooperation(state, auth, command.cooperationId);
    this.assertCooperationEdit(auth, cooperation);
    checkVersion(cooperation, command.expectedVersion);
    if (cooperation.status !== "draft") domainError("INVALID_TRANSITION", "只有草稿合作单可以修改");
    const before = { title: cooperation.title, lines: cooperation.lines, sampleRequirement: cooperation.sampleRequirement, deliveryRequirement: cooperation.deliveryRequirement };
    if (command.title !== undefined) cooperation.title = command.title;
    if (command.lines) {
      cooperation.lines = command.lines.map((line) => {
        if (line.productId) this.requireProduct(state, auth, line.productId);
        this.assertCooperationLineOfferScope(state, cooperation.teamId, line);
        return {
          id: this.runtime.id("cooperation-line"), productId: line.productId ?? null,
          productName: line.productName, sku: line.sku ?? null, specification: line.specification ?? null,
          agreedPriceCents: line.agreedPriceCents ?? null, agreedQuantity: line.agreedQuantity ?? null,
          deliveryRequirement: line.deliveryRequirement, note: line.note ?? null,
          storeId: line.storeId ?? null, storeAssortmentId: line.storeAssortmentId ?? null,
          assortmentVersion: line.assortmentVersion ?? null, livePriceCents: line.livePriceCents ?? null,
          creatorCommissionBps: line.creatorCommissionBps ?? null, sellingPointsSnapshot: line.sellingPointsSnapshot ? [...line.sellingPointsSnapshot] : [],
          sellingPointEvidenceUrl: line.sellingPointEvidenceUrl ?? null, salesCardUrl: line.salesCardUrl ?? null,
          productGroupsSnapshot: line.productGroupsSnapshot ? [...line.productGroupsSnapshot] : [],
        };
      });
    }
    if (command.sampleRequirement !== undefined) cooperation.sampleRequirement = command.sampleRequirement;
    if (command.deliveryRequirement !== undefined) cooperation.deliveryRequirement = command.deliveryRequirement;
    if ("startAt" in command) cooperation.startAt = command.startAt ?? null;
    if ("endAt" in command) cooperation.endAt = command.endAt ?? null;
    if ("note" in command) cooperation.note = command.note ?? null;
    if (cooperation.startAt && cooperation.endAt && Date.parse(cooperation.endAt) < Date.parse(cooperation.startAt)) domainError("VALIDATION_ERROR", "合作结束时间不能早于开始时间");
    incrementVersion(cooperation, this.runtime.now(), auth.member.id);
    addAudit(state, this.runtime, auth.member.id, cooperation, "cooperation", cooperation.id, "cooperation.draft_updated", null, before, { title: cooperation.title, lines: cooperation.lines, sampleRequirement: cooperation.sampleRequirement, deliveryRequirement: cooperation.deliveryRequirement });
    return clone(cooperation);
  }

  private submitCooperation(state: DomainState, auth: AuthContext, command: Extract<DomainCommand, { type: "cooperation.submit" }>): Cooperation {
    const cooperation = this.requireCooperation(state, auth, command.cooperationId);
    this.assertCooperationEdit(auth, cooperation);
    checkVersion(cooperation, command.expectedVersion);
    if (cooperation.status !== "draft") domainError("INVALID_TRANSITION", "只有草稿合作单可以提交审核");
    if (cooperation.lines.length === 0 || !cooperation.deliveryRequirement.trim()) domainError("BUSINESS_RULE_VIOLATION", "提交合作单前至少需要一个商品和交付要求");
    const before = { status: cooperation.status };
    cooperation.status = "pending_approval";
    incrementVersion(cooperation, this.runtime.now(), auth.member.id);
    this.enqueueReviewTask(state, auth, "cooperation_approval", cooperation.creatorId, "审核合作单", "cooperation", cooperation.id, "cooperation.approve", command.submittedAt);
    addAudit(state, this.runtime, auth.member.id, cooperation, "cooperation", cooperation.id, "cooperation.submitted", null, before, { status: cooperation.status, submittedAt: command.submittedAt });
    return clone(cooperation);
  }

  private decideCooperation(state: DomainState, auth: AuthContext, command: Extract<DomainCommand, { type: "cooperation.decide" }>): Cooperation {
    requireCapability(auth, "cooperation.approve", "需要合作审批能力");
    const cooperation = this.requireCooperation(state, auth, command.cooperationId);
    this.assertScopeForAction(state, auth, cooperation);
    checkVersion(cooperation, command.expectedVersion);
    if (cooperation.status !== "pending_approval") domainError("INVALID_TRANSITION", "合作单当前不在待审核状态");
    if (cooperation.applicantId === auth.member.id) domainError("FORBIDDEN", "申请人不能审批自己的合作单");
    const reason = command.reason ?? null;
    if (command.decision === "rejected" && !reason?.trim()) domainError("BUSINESS_RULE_VIOLATION", "驳回合作单必须填写原因");
    const before = { status: cooperation.status };
    cooperation.status = command.decision === "rejected" ? "rejected" : cooperation.sampleRequirement === "required" ? "pending_samples_shipment" : "pending_delivery";
    cooperation.decidedBy = auth.member.id;
    cooperation.decidedAt = command.decidedAt;
    cooperation.decisionReason = command.decision === "approved" ? reason : null;
    cooperation.rejectionReason = command.decision === "rejected" ? reason : null;
    incrementVersion(cooperation, this.runtime.now(), auth.member.id);
    this.completeTasks(state, auth.member.id, "cooperation", cooperation.id, command.decidedAt, `合作单已${command.decision === "approved" ? "通过" : "驳回"}`, "cooperation_approval");
    addAudit(state, this.runtime, auth.member.id, cooperation, "cooperation", cooperation.id, `cooperation.${command.decision}`, reason, before, { status: cooperation.status, decidedAt: cooperation.decidedAt });
    return clone(cooperation);
  }

  private waiveSamples(state: DomainState, auth: AuthContext, command: Extract<DomainCommand, { type: "cooperation.waiveSamples" }>): Cooperation {
    requireCapability(auth, "cooperation.approve", "需要合作审批能力");
    const cooperation = this.requireCooperation(state, auth, command.cooperationId);
    this.assertScopeForAction(state, auth, cooperation);
    checkVersion(cooperation, command.expectedVersion);
    if (!["pending_samples_shipment", "pending_samples_receipt"].includes(cooperation.status)) domainError("INVALID_TRANSITION", "当前合作不在样品处理阶段");
    if (cooperation.applicantId === auth.member.id) domainError("FORBIDDEN", "合作申请人不能审批免寄样");
    const linkedSamples = cooperation.requiredSampleIds.map((id) => state.samples.find((sample) => sample.id === id)).filter((sample): sample is SampleRequest => sample !== undefined);
    if (linkedSamples.some((sample) => state.samplePackages.some((pkg) => pkg.sampleId === sample.id))) {
      domainError("BUSINESS_RULE_VIOLATION", "已有样品包裹出库，不能免寄或免签收；请先完成现有包裹签收");
    }
    for (const sample of linkedSamples.filter((item) => item.status !== "rejected" && item.status !== "closed" && item.status !== "received")) {
      const beforeSample = { status: sample.status, shippingBlocked: sample.shippingBlocked };
      sample.status = "closed";
      sample.shippingBlocked = true;
      sample.closeReason = command.reason;
      incrementVersion(sample, this.runtime.now(), auth.member.id);
      this.completeAllRelatedTasks(state, auth.member.id, "sample", sample.id, command.waivedAt, "合作免寄样后关闭申请");
      addAudit(state, this.runtime, auth.member.id, sample, "sample", sample.id, "sample.closed_by_waiver", command.reason, beforeSample, { status: sample.status, shippingBlocked: sample.shippingBlocked });
    }
    const before = { status: cooperation.status };
    cooperation.status = "pending_delivery";
    cooperation.waivedSamplesReason = command.reason;
    incrementVersion(cooperation, this.runtime.now(), auth.member.id);
    addAudit(state, this.runtime, auth.member.id, cooperation, "cooperation", cooperation.id, "cooperation.samples_waived", command.reason, before, { status: cooperation.status, waivedAt: command.waivedAt });
    return clone(cooperation);
  }

  private cancelCooperation(state: DomainState, auth: AuthContext, command: Extract<DomainCommand, { type: "cooperation.cancel" }>): Cooperation {
    const cooperation = this.requireCooperation(state, auth, command.cooperationId);
    this.assertCooperationEdit(auth, cooperation);
    checkVersion(cooperation, command.expectedVersion);
    if (["delivered", "cancelled", "rejected"].includes(cooperation.status)) domainError("INVALID_TRANSITION", "已结束或已驳回的合作单不能再次取消");
    const before = { status: cooperation.status };
    cooperation.status = "cancelled";
    cooperation.cancellationReason = command.reason;
    incrementVersion(cooperation, this.runtime.now(), auth.member.id);
    this.completeAllRelatedTasks(state, auth.member.id, "cooperation", cooperation.id, command.cancelledAt, "合作单已取消");
    for (const schedule of state.schedules.filter((item) => item.cooperationId === cooperation.id && (item.status === "planned" || item.status === "rescheduled"))) {
      const beforeSchedule = { status: schedule.status, changeReason: schedule.changeReason };
      schedule.status = "cancelled";
      schedule.changeReason = command.reason;
      incrementVersion(schedule, this.runtime.now(), auth.member.id);
      this.completeAllRelatedTasks(state, auth.member.id, "schedule", schedule.id, command.cancelledAt, "合作取消后关闭排期");
      addAudit(state, this.runtime, auth.member.id, schedule, "schedule", schedule.id, "schedule.cancelled_by_cooperation", command.reason, beforeSchedule, { status: schedule.status, changeReason: schedule.changeReason });
    }
    for (const delivery of state.deliveries.filter((item) => item.cooperationId === cooperation.id && ["pending_submission", "pending_review", "returned"].includes(item.status))) {
      const beforeDelivery = { status: delivery.status };
      delivery.status = "cancelled";
      delivery.cancellationReason = command.reason;
      incrementVersion(delivery, this.runtime.now(), auth.member.id);
      this.completeAllRelatedTasks(state, auth.member.id, "delivery", delivery.id, command.cancelledAt, "合作取消后关闭交付");
      addAudit(state, this.runtime, auth.member.id, delivery, "delivery", delivery.id, "delivery.cancelled_by_cooperation", command.reason, beforeDelivery, { status: delivery.status });
    }
    for (const sample of cooperation.requiredSampleIds.map((id) => state.samples.find((item) => item.id === id)).filter((item): item is SampleRequest => item !== undefined)) {
      const packages = state.samplePackages.filter((pkg) => pkg.sampleId === sample.id);
      if (packages.length > 0) {
        const beforeSample = { status: sample.status, shippingBlocked: sample.shippingBlocked };
        sample.shippingBlocked = true;
        sample.closeReason = command.reason;
        incrementVersion(sample, this.runtime.now(), auth.member.id);
        this.completeTasks(state, auth.member.id, "sample", sample.id, command.cancelledAt, "合作取消，停止新增包裹", "sample_approval");
        this.completeTasks(state, auth.member.id, "sample", sample.id, command.cancelledAt, "合作取消，停止新增包裹", "sample_shipment");
        addAudit(state, this.runtime, auth.member.id, sample, "sample", sample.id, "sample.shipping_halted_by_cooperation_cancel", command.reason, beforeSample, { status: sample.status, shippingBlocked: sample.shippingBlocked });
      } else if (sample.status !== "rejected" && sample.status !== "closed" && sample.status !== "received") {
        const beforeSample = { status: sample.status, shippingBlocked: sample.shippingBlocked };
        sample.status = "closed";
        sample.shippingBlocked = true;
        sample.closeReason = command.reason;
        incrementVersion(sample, this.runtime.now(), auth.member.id);
        this.completeAllRelatedTasks(state, auth.member.id, "sample", sample.id, command.cancelledAt, "合作取消后关闭样品申请");
        addAudit(state, this.runtime, auth.member.id, sample, "sample", sample.id, "sample.closed_by_cooperation_cancel", command.reason, beforeSample, { status: sample.status, shippingBlocked: sample.shippingBlocked });
      }
    }
    addAudit(state, this.runtime, auth.member.id, cooperation, "cooperation", cooperation.id, "cooperation.cancelled", command.reason, before, { status: cooperation.status });
    return clone(cooperation);
  }

  private createSchedule(state: DomainState, auth: AuthContext, command: Extract<DomainCommand, { type: "schedule.create" }>): LiveSchedule {
    const cooperation = this.requireCooperation(state, auth, command.cooperationId);
    this.assertCooperationEdit(auth, cooperation);
    checkVersion(cooperation, command.expectedCooperationVersion);
    if (["draft", "pending_approval", "rejected", "cancelled", "delivered"].includes(cooperation.status)) domainError("INVALID_TRANSITION", "该合作阶段不能新增排期");
    this.assertWindow(command.plannedStartAt, command.plannedEndAt, "排期结束时间必须晚于开始时间");
    if (command.cooperationLineId && !cooperation.lines.some((line) => line.id === command.cooperationLineId)) domainError("BUSINESS_RULE_VIOLATION", "排期商品行不属于此合作单");
    const now = this.runtime.now();
    const schedule: LiveSchedule = {
      id: this.runtime.id("schedule"), orgId: cooperation.orgId, teamId: cooperation.teamId,
      creatorId: cooperation.creatorId, cooperationId: cooperation.id, cooperationLineId: command.cooperationLineId ?? null,
      ownerMemberId: cooperation.ownerMemberId, platform: command.platform, roomId: command.roomId ?? null,
      title: command.title, plannedStartAt: command.plannedStartAt, plannedEndAt: command.plannedEndAt,
      history: [], status: "planned", changeReason: null, actualStartAt: null, actualEndAt: null, reviewUrl: null,
      version: 1, createdAt: now, createdBy: auth.member.id, updatedAt: now, updatedBy: auth.member.id,
    };
    state.schedules.push(schedule);
    addAudit(state, this.runtime, auth.member.id, schedule, "schedule", schedule.id, "schedule.created", null, null, { cooperationId: cooperation.id, plannedStartAt: schedule.plannedStartAt, plannedEndAt: schedule.plannedEndAt });
    return clone(schedule);
  }

  private rescheduleSchedule(state: DomainState, auth: AuthContext, command: Extract<DomainCommand, { type: "schedule.reschedule" }>): LiveSchedule {
    const schedule = this.requireSchedule(state, auth, command.scheduleId);
    this.assertScheduleEdit(auth, schedule);
    checkVersion(schedule, command.expectedVersion);
    if (schedule.status !== "planned" && schedule.status !== "rescheduled") domainError("INVALID_TRANSITION", "只有未来排期可以改期");
    this.assertWindow(command.plannedStartAt, command.plannedEndAt, "新排期结束时间必须晚于开始时间");
    const before = { plannedStartAt: schedule.plannedStartAt, plannedEndAt: schedule.plannedEndAt, status: schedule.status };
    schedule.history.push({ plannedStartAt: schedule.plannedStartAt, plannedEndAt: schedule.plannedEndAt, changedAt: command.changedAt, changedBy: auth.member.id, reason: command.reason });
    schedule.plannedStartAt = command.plannedStartAt;
    schedule.plannedEndAt = command.plannedEndAt;
    schedule.status = "rescheduled";
    schedule.changeReason = command.reason;
    incrementVersion(schedule, this.runtime.now(), auth.member.id);
    addAudit(state, this.runtime, auth.member.id, schedule, "schedule", schedule.id, "schedule.rescheduled", command.reason, before, { plannedStartAt: schedule.plannedStartAt, plannedEndAt: schedule.plannedEndAt, status: schedule.status });
    return clone(schedule);
  }

  private completeSchedule(state: DomainState, auth: AuthContext, command: Extract<DomainCommand, { type: "schedule.complete" }>): LiveSchedule {
    const schedule = this.requireSchedule(state, auth, command.scheduleId);
    this.assertScheduleEdit(auth, schedule);
    checkVersion(schedule, command.expectedVersion);
    if (schedule.status !== "planned" && schedule.status !== "rescheduled") domainError("INVALID_TRANSITION", "当前排期不能标记完成");
    const actualStart = command.actualStartAt ?? schedule.plannedStartAt;
    if (Date.parse(command.actualEndAt) < Date.parse(actualStart)) domainError("VALIDATION_ERROR", "实际结束时间不能早于实际开始时间");
    const before = { status: schedule.status, actualStartAt: schedule.actualStartAt, actualEndAt: schedule.actualEndAt };
    schedule.actualStartAt = actualStart;
    schedule.actualEndAt = command.actualEndAt;
    schedule.reviewUrl = command.reviewUrl ?? null;
    schedule.status = "completed";
    incrementVersion(schedule, this.runtime.now(), auth.member.id);
    this.completeAllRelatedTasks(state, auth.member.id, "schedule", schedule.id, command.actualEndAt, "排期已完成");
    addAudit(state, this.runtime, auth.member.id, schedule, "schedule", schedule.id, "schedule.completed", null, before, { status: schedule.status, actualStartAt: schedule.actualStartAt, actualEndAt: schedule.actualEndAt });
    return clone(schedule);
  }

  private cancelSchedule(state: DomainState, auth: AuthContext, command: Extract<DomainCommand, { type: "schedule.cancel" }>): LiveSchedule {
    const schedule = this.requireSchedule(state, auth, command.scheduleId);
    this.assertScheduleEdit(auth, schedule);
    checkVersion(schedule, command.expectedVersion);
    if (schedule.status === "completed" || schedule.status === "cancelled") domainError("INVALID_TRANSITION", "已结束的排期不能再次取消");
    const before = { status: schedule.status };
    schedule.status = "cancelled";
    schedule.changeReason = command.reason;
    incrementVersion(schedule, this.runtime.now(), auth.member.id);
    this.completeAllRelatedTasks(state, auth.member.id, "schedule", schedule.id, command.cancelledAt, "排期已取消");
    addAudit(state, this.runtime, auth.member.id, schedule, "schedule", schedule.id, "schedule.cancelled", command.reason, before, { status: schedule.status });
    return clone(schedule);
  }

  private createDelivery(state: DomainState, auth: AuthContext, command: Extract<DomainCommand, { type: "delivery.create" }>): Delivery {
    const cooperation = this.requireCooperation(state, auth, command.cooperationId);
    this.assertCooperationEdit(auth, cooperation);
    checkVersion(cooperation, command.expectedCooperationVersion);
    if (!["pending_samples_shipment", "pending_samples_receipt", "pending_delivery"].includes(cooperation.status)) domainError("INVALID_TRANSITION", "当前合作阶段不能新增交付项");
    if (command.cooperationLineId && !cooperation.lines.some((line) => line.id === command.cooperationLineId)) domainError("BUSINESS_RULE_VIOLATION", "交付商品行不属于此合作单");
    if (command.scheduleId) {
      const schedule = state.schedules.find((item) => item.id === command.scheduleId && item.cooperationId === cooperation.id);
      if (!schedule) domainError("BUSINESS_RULE_VIOLATION", "交付关联的排期不属于此合作单");
    }
    const now = this.runtime.now();
    const delivery: Delivery = {
      id: this.runtime.id("delivery"), orgId: cooperation.orgId, teamId: cooperation.teamId,
      creatorId: cooperation.creatorId, cooperationId: cooperation.id, cooperationLineId: command.cooperationLineId ?? null,
      scheduleId: command.scheduleId ?? null, ownerMemberId: cooperation.ownerMemberId, type: command.deliveryType, title: command.title,
      dueAt: command.dueAt, required: command.required, status: "pending_submission", submissions: [], reviews: [], cancellationReason: null,
      version: 1, createdAt: now, createdBy: auth.member.id, updatedAt: now, updatedBy: auth.member.id,
    };
    state.deliveries.push(delivery);
    incrementVersion(cooperation, now, auth.member.id);
    addAudit(state, this.runtime, auth.member.id, delivery, "delivery", delivery.id, "delivery.created", null, null, { cooperationId: cooperation.id, dueAt: delivery.dueAt, required: delivery.required });
    return clone(delivery);
  }

  private submitDelivery(state: DomainState, auth: AuthContext, command: Extract<DomainCommand, { type: "delivery.submit" }>): Delivery {
    const delivery = this.requireDelivery(state, auth, command.deliveryId);
    this.assertDeliveryEdit(auth, delivery);
    checkVersion(delivery, command.expectedVersion);
    if (delivery.status !== "pending_submission" && delivery.status !== "returned") domainError("INVALID_TRANSITION", "只有待提交或已退回的交付项可以提交");
    if (!command.contentUrl && !command.platformContentId && !command.evidenceUrl) domainError("BUSINESS_RULE_VIOLATION", "提交交付时至少附一个内容链接、平台 ID 或凭证");
    const wasReturned = delivery.status === "returned";
    const before = { status: delivery.status, submissions: delivery.submissions.length };
    delivery.submissions.push({ submittedAt: command.submittedAt, submittedBy: auth.member.id, contentUrl: command.contentUrl ?? null, platformContentId: command.platformContentId ?? null, evidenceUrl: command.evidenceUrl ?? null, note: command.note ?? null });
    delivery.status = "pending_review";
    incrementVersion(delivery, this.runtime.now(), auth.member.id);
    if (wasReturned) this.completeOwnedTasks(state, auth.member.id, "delivery", delivery.id, delivery.ownerMemberId, command.submittedAt, "交付已修改并重新提交", "delivery_review");
    this.enqueueReviewTask(state, auth, "delivery_review", delivery.creatorId, "验收交付内容", "delivery", delivery.id, "cooperation.approve", command.submittedAt);
    addAudit(state, this.runtime, auth.member.id, delivery, "delivery", delivery.id, "delivery.submitted", command.note ?? null, before, { status: delivery.status, submissionIndex: delivery.submissions.length - 1, submittedAt: command.submittedAt });
    return clone(delivery);
  }

  private reviewDelivery(state: DomainState, auth: AuthContext, command: Extract<DomainCommand, { type: "delivery.review" }>): Delivery {
    requireCapability(auth, "cooperation.approve", "需要交付验收能力");
    const delivery = this.requireDelivery(state, auth, command.deliveryId);
    this.assertScopeForAction(state, auth, delivery);
    checkVersion(delivery, command.expectedVersion);
    if (delivery.status !== "pending_review" || delivery.submissions.length === 0) domainError("INVALID_TRANSITION", "交付当前不在待验收状态");
    const lastSubmission = delivery.submissions[delivery.submissions.length - 1];
    if (lastSubmission.submittedBy === auth.member.id) domainError("FORBIDDEN", "提交人不能验收自己的交付");
    const cooperation = state.cooperations.find((item) => item.id === delivery.cooperationId);
    if (cooperation?.applicantId === auth.member.id) domainError("FORBIDDEN", "合作申请人不能验收自己合作单下的交付");
    if (command.decision === "returned" && !command.reason?.trim()) domainError("BUSINESS_RULE_VIOLATION", "退回交付必须填写修改原因");
    const before = { status: delivery.status };
    delivery.reviews.push({ decision: command.decision, reviewedAt: command.reviewedAt, reviewedBy: auth.member.id, reason: command.reason ?? null, submissionIndex: delivery.submissions.length - 1 });
    delivery.status = command.decision === "approved" ? "approved" : "returned";
    incrementVersion(delivery, this.runtime.now(), auth.member.id);
    this.completeTasks(state, auth.member.id, "delivery", delivery.id, command.reviewedAt, `交付已${command.decision === "approved" ? "验收通过" : "退回"}`, "delivery_review");
    if (cooperation && command.decision === "returned") this.enqueueOwnerTask(state, auth.member.id, cooperation.ownerMemberId, cooperation, "delivery_review", "修改并重新提交交付", "delivery", delivery.id, delivery.dueAt, "high");
    if (cooperation && command.decision === "approved") this.refreshCooperationAfterDelivery(state, auth.member.id, cooperation, command.reviewedAt);
    addAudit(state, this.runtime, auth.member.id, delivery, "delivery", delivery.id, `delivery.${command.decision}`, command.reason ?? null, before, { status: delivery.status, reviewedAt: command.reviewedAt, submissionIndex: delivery.submissions.length - 1 });
    return clone(delivery);
  }

  private cancelDelivery(state: DomainState, auth: AuthContext, command: Extract<DomainCommand, { type: "delivery.cancel" }>): Delivery {
    const delivery = this.requireDelivery(state, auth, command.deliveryId);
    this.assertDeliveryEdit(auth, delivery);
    checkVersion(delivery, command.expectedVersion);
    if (delivery.status === "approved" || delivery.status === "cancelled") domainError("INVALID_TRANSITION", "已验收或已取消的交付不能再次取消");
    const before = { status: delivery.status };
    delivery.status = "cancelled";
    delivery.cancellationReason = command.reason;
    incrementVersion(delivery, this.runtime.now(), auth.member.id);
    this.completeAllRelatedTasks(state, auth.member.id, "delivery", delivery.id, command.cancelledAt, "交付项已取消");
    addAudit(state, this.runtime, auth.member.id, delivery, "delivery", delivery.id, "delivery.cancelled", command.reason, before, { status: delivery.status });
    return clone(delivery);
  }

  private reconcileOrderSource(state: DomainState, auth: AuthContext, command: Extract<DomainCommand, { type: "order.reconcileSource" }>): OrderLine {
    requireManagerOrAdmin(auth, "只有主管或管理员可以核对订单来源");
    requireCapability(auth, "import.manage", "需要订单导入与复核权限");
    const order = state.orders.find((item) => item.id === command.orderLineId && item.orgId === state.orgId);
    if (!order) domainError("NOT_FOUND", "订单行不存在或当前账号无权访问");
    this.assertScopeForAction(state, auth, order);
    checkVersion(order, command.expectedVersion);
    if (order.status !== "pending" && order.status !== "unknown") domainError("INVALID_TRANSITION", "只有待确认订单可以核对来源；已定稿订单不可用此动作改写");
    if (command.resolution === "paid" && !command.paidAt) domainError("BUSINESS_RULE_VIOLATION", "核对为已支付订单时必须提供支付时间");
    const now = this.runtime.now();
    if (command.paidAt) assertIsoDateTime(command.paidAt, "支付时间");
    const externalAccountId = command.creatorAccountId !== undefined ? command.creatorAccountId : order.creatorAccountId;
    const creator = externalAccountId ? this.creatorByStableAccount(state, order.platform, externalAccountId) : order.creatorId ? state.creators.find((item) => item.id === order.creatorId && !item.archived) ?? null : null;
    if (creator && auth.role !== "admin" && creator.teamId !== auth.member.teamId) domainError("NOT_FOUND", "达人不存在或当前账号无权访问");
    const before = {
      status: order.status, paidAt: order.paidAt, paidAmountCents: order.paidAmountCents,
      creatorAccountId: order.creatorAccountId, creatorId: order.creatorId,
      ownerSnapshot: order.ownerSnapshot, fingerprint: order.contentFingerprint,
    };
    const candidate = { ...order, status: command.resolution };
    if (command.resolution === "paid") {
      const paidAt = command.paidAt!;
      candidate.paidAt = paidAt;
      candidate.ownerSnapshot = this.ownerSnapshotAt(state, creator, paidAt);
    } else {
      if (command.paidAt !== undefined) candidate.paidAt = command.paidAt;
      candidate.ownerSnapshot = { memberId: null, assignedAt: null, ruleVersion: "paid_at_owner_v1", reason: "payment_not_finalized" };
    }
    candidate.sourceStatus = command.sourceStatus;
    if ("paidAmountCents" in command) candidate.paidAmountCents = command.paidAmountCents ?? null;
    if ("rawAmount" in command) candidate.rawAmount = command.rawAmount ?? null;
    if (command.creatorAccountId !== undefined) candidate.creatorAccountId = command.creatorAccountId;
    candidate.creatorId = creator?.id ?? null;
    if (creator && auth.role === "admin") candidate.teamId = creator.teamId;
    if (command.sourceEvidenceUrl !== undefined) candidate.sourceEvidenceUrl = command.sourceEvidenceUrl ?? null;
    if (candidate.status === "paid") this.assertExistingRefundsCompatibleWithOrder(state, candidate);
    else if (state.refunds.some((refund) => refund.orderLineId === order.id && refund.status === "succeeded")) {
      domainError("BUSINESS_RULE_VIOLATION", "该订单已有成功退款，不能核对为已关闭");
    }
    Object.assign(order, candidate);
    order.contentFingerprint = orderContentFingerprint(order);
    incrementVersion(order, now, auth.member.id);
    addAudit(state, this.runtime, auth.member.id, order, "order", order.id, "order.source_reconciled", command.reason, before, {
      status: order.status, paidAt: order.paidAt, paidAmountCents: order.paidAmountCents,
      creatorAccountId: order.creatorAccountId, creatorId: order.creatorId,
      ownerSnapshot: order.ownerSnapshot, fingerprint: order.contentFingerprint, sourceEvidenceUrl: order.sourceEvidenceUrl,
    });
    return clone(order);
  }

  private reconcileRefundSource(state: DomainState, auth: AuthContext, command: Extract<DomainCommand, { type: "refund.reconcileSource" }>): RefundEvent {
    requireManagerOrAdmin(auth, "只有主管或管理员可以核对退款来源");
    requireCapability(auth, "import.manage", "需要订单导入与复核权限");
    const refund = state.refunds.find((item) => item.id === command.refundId && item.orgId === state.orgId);
    if (!refund) domainError("NOT_FOUND", "退款事件不存在或当前账号无权访问");
    this.assertScopeForAction(state, auth, refund);
    checkVersion(refund, command.expectedVersion);
    if (refund.status !== "pending" && refund.status !== "unknown") domainError("INVALID_TRANSITION", "只有待确认退款可以核对来源；已定稿退款不可用此动作改写");
    const order = state.orders.find((item) => item.id === refund.orderLineId && item.orgId === state.orgId);
    if (!order) domainError("NOT_FOUND", "关联订单不存在或当前账号无权访问");
    this.assertScopeForAction(state, auth, order);
    if (order.status !== "paid" || !order.paidAt) domainError("BUSINESS_RULE_VIOLATION", "退款核对需要已确认支付且有支付时间的订单");
    if (Date.parse(command.refundedAt) < Date.parse(order.paidAt)) domainError("BUSINESS_RULE_VIOLATION", "退款时间不能早于关联订单的支付时间");
    if (command.resolution === "succeeded" && refund.direction === "reversal" && command.amountCents === null) {
      domainError("BUSINESS_RULE_VIOLATION", "确认冲正成功时必须提供冲正金额");
    }
    const before = {
      status: refund.status, refundedAt: refund.refundedAt, amountCents: refund.amountCents,
      sourceStatus: refund.sourceStatus, fingerprint: refund.contentFingerprint,
    };
    const candidate: RefundEvent = {
      ...refund,
      status: command.resolution,
      refundedAt: command.refundedAt,
      amountCents: command.amountCents,
      sourceStatus: command.sourceStatus,
      rawAmount: command.rawAmount,
      sourceEvidenceUrl: command.sourceEvidenceUrl !== undefined ? command.sourceEvidenceUrl : refund.sourceEvidenceUrl,
    };
    if (candidate.status === "succeeded") this.assertRefundTimeline(state, order, candidate);
    Object.assign(refund, candidate);
    refund.contentFingerprint = refundContentFingerprint(refund, order);
    refund.version += 1;
    addAudit(state, this.runtime, auth.member.id, refund, "refund", refund.id, "refund.source_reconciled", command.reason, before, {
      status: refund.status, refundedAt: refund.refundedAt, amountCents: refund.amountCents,
      sourceStatus: refund.sourceStatus, fingerprint: refund.contentFingerprint, sourceEvidenceUrl: refund.sourceEvidenceUrl,
    });
    return clone(refund);
  }

  private creatorByStableAccount(state: DomainState, platform: Platform, externalAccountId: string): Creator | null {
    const matches = state.creators.filter((creator) => !creator.archived && creator.accounts.some((account) => account.platform === platform && account.externalAccountId === normalizeKey(externalAccountId)));
    if (matches.length > 1) domainError("IDENTITY_CONFLICT", "该稳定账号映射到多个达人，需先核对身份");
    return matches[0] ?? null;
  }

  private ownerSnapshotAt(state: DomainState, creator: Creator | null, paidAt: string): OwnerSnapshot {
    if (!creator) return { memberId: null, assignedAt: null, ruleVersion: "paid_at_owner_v1", reason: "creator_unmatched" };
    const family = creatorIdsInMergeFamily(state, creator.id);
    const timestamp = Date.parse(paidAt);
    const assignments = state.ownerAssignments.filter((item) => family.has(item.creatorId)
      && Date.parse(item.validFrom) <= timestamp && (item.validTo === null || timestamp < Date.parse(item.validTo)));
    const owners = new Set(assignments.map((item) => item.memberId));
    if (owners.size > 1) return { memberId: null, assignedAt: null, ruleVersion: "paid_at_owner_v1", reason: "ambiguous_owner" };
    const assignment = assignments.sort((a, b) => Date.parse(a.validFrom) - Date.parse(b.validFrom))[0];
    if (!assignment?.memberId) return { memberId: null, assignedAt: null, ruleVersion: "paid_at_owner_v1", reason: "no_owner_at_paid_at" };
    return { memberId: assignment.memberId, assignedAt: assignment.validFrom, ruleVersion: "paid_at_owner_v1", reason: "matched" };
  }

  private assertRefundTimeline(state: DomainState, order: OrderLine, candidate: RefundEvent): void {
    const earlierUnknownRefund = state.refunds.some((item) => item.orderLineId === order.id && item.id !== candidate.id
      && item.status === "succeeded" && item.direction === "refund" && item.amountCents === null
      && item.refundedAt !== null && Date.parse(item.refundedAt) <= Date.parse(candidate.refundedAt ?? ""));
    if (candidate.direction === "reversal" && earlierUnknownRefund) {
      domainError("BUSINESS_RULE_VIOLATION", "存在金额未知的前序退款，无法确认本次冲正上限");
    }
    const events = state.refunds.filter((item) => item.orderLineId === order.id && item.status === "succeeded" && item.id !== candidate.id).concat(candidate)
      .sort((a, b) => Date.parse(a.refundedAt ?? "") - Date.parse(b.refundedAt ?? "") || a.externalRefundId.localeCompare(b.externalRefundId));
    let net = 0;
    for (const event of events) {
      if (!event.refundedAt) domainError("BUSINESS_RULE_VIOLATION", "已有成功退款缺少发生时间，无法安全核对累计退款");
      if (event.amountCents === null) continue;
      net += event.direction === "refund" ? event.amountCents : -event.amountCents;
      if (net < 0) domainError("BUSINESS_RULE_VIOLATION", "退款冲正超过此前已确认的退款金额");
      if (!Number.isSafeInteger(net) || (order.paidAmountCents !== null && net > order.paidAmountCents)) domainError("BUSINESS_RULE_VIOLATION", "累计退款超过订单行已知实付金额");
    }
  }

  private assertExistingRefundsCompatibleWithOrder(state: DomainState, order: OrderLine): void {
    if (!order.paidAt) domainError("BUSINESS_RULE_VIOLATION", "确认订单支付时必须提供支付时间");
    const successfulRefunds = state.refunds.filter((refund) => refund.orderLineId === order.id && refund.status === "succeeded");
    for (const refund of successfulRefunds) {
      if (!refund.refundedAt || Date.parse(refund.refundedAt) < Date.parse(order.paidAt)) {
        domainError("BUSINESS_RULE_VIOLATION", "已有成功退款时间早于订单支付时间，需先人工核对退款记录");
      }
      this.assertRefundTimeline(state, order, refund);
    }
  }

  private correctOrderOwner(state: DomainState, auth: AuthContext, command: Extract<DomainCommand, { type: "order.correctOwner" }>): OwnerCorrection {
    requireManagerOrAdmin(auth, "只有主管或管理员可以核对订单归属");
    const order = state.orders.find((item) => item.id === command.orderLineId && item.orgId === state.orgId);
    if (!order) domainError("NOT_FOUND", "订单行不存在或当前账号无权访问");
    this.assertScopeForAction(state, auth, order);
    checkVersion(order, command.expectedVersion);
    const recordedAt = this.runtime.now();
    this.assertEffectiveAt(command.correctedAt, recordedAt);
    const target = command.correctedMemberId ? this.targetMember(state, auth, command.correctedMemberId) : null;
    const previousMemberId = effectiveOwner(order, state.ownerCorrections);
    if (previousMemberId === (target?.id ?? null)) domainError("BUSINESS_RULE_VIOLATION", "该订单当前已归属此成员");
    const correction: OwnerCorrection = {
      id: this.runtime.id("owner-correction"), orgId: order.orgId, teamId: order.teamId,
      orderLineId: order.id, previousMemberId, correctedMemberId: target?.id ?? null,
      correctedAt: command.correctedAt, recordedAt, correctedBy: auth.member.id, reason: command.reason,
    };
    state.ownerCorrections.push(correction);
    incrementVersion(order, recordedAt, auth.member.id);
    addAudit(state, this.runtime, auth.member.id, order, "order", order.id, "order.owner_corrected", command.reason, { ownerMemberId: previousMemberId }, { ownerMemberId: correction.correctedMemberId, correctedAt: correction.correctedAt, recordedAt, orderVersion: order.version });
    return clone(correction);
  }

  private createMember(state: DomainState, auth: AuthContext, command: Extract<DomainCommand, { type: "member.create" }>): Member {
    requireAdmin(auth, "只有管理员可以管理成员档案");
    if (state.dataMode === "production" && (command.role !== undefined || command.capabilities !== undefined)) {
      domainError("FORBIDDEN", "生产角色与能力由飞书平台授权管理，成员档案接口不接受角色变更");
    }
    if (state.members.some((member) => member.principalId === command.principalId)) domainError("DUPLICATE", "该平台身份已经映射到成员档案");
    const team = state.teams.find((item) => item.id === command.teamId && item.orgId === state.orgId && item.active);
    if (!team) domainError("NOT_FOUND", "目标团队不存在");
    if (state.dataMode === "demo" && !command.role) domainError("VALIDATION_ERROR", "演示成员需要选择演示角色");
    const now = this.runtime.now();
    const member: Member = {
      id: this.runtime.id("member"), principalId: command.principalId, displayName: command.displayName,
      orgId: state.orgId, teamId: team.id,
      role: state.dataMode === "demo" ? command.role ?? null : null,
      capabilities: state.dataMode === "demo" ? command.capabilities ?? [] : null,
      active: true, version: 1, createdAt: now, createdBy: auth.member.id, updatedAt: now, updatedBy: auth.member.id,
    };
    state.members.push(member);
    addAudit(state, this.runtime, auth.member.id, member, "member", member.id, "member.created", null, null, { displayName: member.displayName, teamId: member.teamId, active: member.active });
    return clone(member);
  }

  private updateMember(state: DomainState, auth: AuthContext, command: Extract<DomainCommand, { type: "member.update" }>): Member {
    requireAdmin(auth, "只有管理员可以管理成员档案");
    if (state.dataMode === "production" && (command.role !== undefined || command.capabilities !== undefined)) {
      domainError("FORBIDDEN", "生产角色与能力由飞书平台授权管理，成员档案接口不接受角色变更");
    }
    const member = state.members.find((item) => item.id === command.memberId && item.orgId === state.orgId);
    if (!member) domainError("NOT_FOUND", "成员不存在");
    checkVersion(member, command.expectedVersion);
    const before = { displayName: member.displayName, teamId: member.teamId, active: member.active };
    if (command.teamId && command.teamId !== member.teamId) {
      const team = state.teams.find((item) => item.id === command.teamId && item.orgId === state.orgId && item.active);
      if (!team) domainError("NOT_FOUND", "目标团队不存在");
      if (this.memberHasOpenWork(state, member.id)) domainError("BUSINESS_RULE_VIOLATION", "成员仍有未完成工作，请先执行团队交接再调整成员团队");
      member.teamId = team.id;
    }
    if (command.displayName !== undefined) member.displayName = command.displayName;
    if (command.active !== undefined) {
      if (!command.active && member.id === auth.member.id) domainError("BUSINESS_RULE_VIOLATION", "不能停用当前登录管理员");
      if (!command.active && this.memberHasOpenWork(state, member.id)) domainError("BUSINESS_RULE_VIOLATION", "成员仍有未完成工作，请先完成交接");
      member.active = command.active;
    }
    if (state.dataMode === "demo") {
      if (command.role !== undefined) member.role = command.role;
      if (command.capabilities !== undefined) member.capabilities = unique(command.capabilities);
    }
    incrementVersion(member, this.runtime.now(), auth.member.id);
    addAudit(state, this.runtime, auth.member.id, member, "member", member.id, "member.updated", null, before, { displayName: member.displayName, teamId: member.teamId, active: member.active });
    return clone(member);
  }

  private handoffMember(state: DomainState, auth: AuthContext, command: Extract<DomainCommand, { type: "member.handoff" }>): unknown {
    requireManagerOrAdmin(auth, "只有主管或管理员可以交接成员工作");
    if (command.sourceMemberId === command.targetMemberId) domainError("VALIDATION_ERROR", "交接来源和接手人不能相同");
    const source = state.members.find((item) => item.id === command.sourceMemberId && item.orgId === state.orgId);
    const target = this.targetMember(state, auth, command.targetMemberId);
    if (!source || !source.active) domainError("NOT_FOUND", "交接来源成员不存在或已停用");
    if (auth.role !== "admin" && source.teamId !== auth.member.teamId) domainError("FORBIDDEN", "主管只能交接本团队成员");
    this.assertEffectiveAt(command.effectiveAt, this.runtime.now());
    let creatorCount = 0;
    const moved = { samples: 0, cooperations: 0, schedules: 0, deliveries: 0, tasks: 0 };
    const creatorsToMove = state.creators.filter((item) => item.orgId === state.orgId && !item.archived && item.ownerMemberId === source.id);
    for (const creator of creatorsToMove) this.businessExtension.assertCreatorTransferAllowed(state, creator, target.teamId);
    for (const creator of creatorsToMove) {
      this.changeCreatorOwner(state, auth, creator, target, command.effectiveAt, command.reason);
      const result = this.moveOpenCreatorWork(state, auth, creator, target, command.effectiveAt, source.id);
      creatorCount += 1;
      moved.samples += result.samples;
      moved.cooperations += result.cooperations;
      moved.schedules += result.schedules;
      moved.deliveries += result.deliveries;
      moved.tasks += result.tasks;
    }
    let cooperationCount = moved.cooperations;
    for (const cooperation of state.cooperations.filter((item) => item.orgId === state.orgId && item.ownerMemberId === source.id && !["delivered", "cancelled", "rejected"].includes(item.status))) {
      const before = { ownerMemberId: cooperation.ownerMemberId, teamId: cooperation.teamId };
      cooperation.ownerMemberId = target.id;
      cooperation.teamId = target.teamId;
      incrementVersion(cooperation, this.runtime.now(), auth.member.id);
      addAudit(state, this.runtime, auth.member.id, cooperation, "cooperation", cooperation.id, "cooperation.handed_off", command.reason, before, { ownerMemberId: target.id, teamId: target.teamId });
      cooperationCount += 1;
    }
    let scheduleCount = moved.schedules;
    for (const schedule of state.schedules.filter((item) => item.orgId === state.orgId && item.ownerMemberId === source.id && (item.status === "planned" || item.status === "rescheduled"))) {
      schedule.ownerMemberId = target.id;
      schedule.teamId = target.teamId;
      incrementVersion(schedule, this.runtime.now(), auth.member.id);
      scheduleCount += 1;
    }
    let deliveryCount = moved.deliveries;
    for (const delivery of state.deliveries.filter((item) => item.orgId === state.orgId && item.ownerMemberId === source.id && !["approved", "cancelled"].includes(item.status))) {
      delivery.ownerMemberId = target.id;
      delivery.teamId = target.teamId;
      incrementVersion(delivery, this.runtime.now(), auth.member.id);
      deliveryCount += 1;
    }
    let taskCount = moved.tasks;
    for (const task of state.tasks.filter((item) => item.orgId === state.orgId && item.ownerMemberId === source.id && item.status === "open")) {
      const before = { ownerMemberId: task.ownerMemberId, teamId: task.teamId };
      const workflowTask = isWorkflowTask(task);
      task.ownerMemberId = workflowTask ? null : target.id;
      if (workflowTask) task.requiredCapability = task.requiredCapability ?? taskCapabilityForKind(task.kind);
      task.teamId = target.teamId;
      incrementVersion(task, this.runtime.now(), auth.member.id);
      addAudit(state, this.runtime, auth.member.id, task, "task", task.id, "task.handed_off", command.reason, before, { ownerMemberId: task.ownerMemberId, requiredCapability: task.requiredCapability, teamId: task.teamId });
      taskCount += 1;
    }
    if (command.deactivateSource) {
      if (source.id === auth.member.id) domainError("BUSINESS_RULE_VIOLATION", "不能在当前会话中停用自己");
      source.active = false;
      incrementVersion(source, this.runtime.now(), auth.member.id);
    }
    const summary = { sourceMemberId: source.id, targetMemberId: target.id, creatorCount, sampleCount: moved.samples, cooperationCount, scheduleCount, deliveryCount, taskCount, deactivated: command.deactivateSource };
    addAudit(state, this.runtime, auth.member.id, source, "member", source.id, "member.handoff_completed", command.reason, { active: !command.deactivateSource }, summary);
    return summary;
  }

  private creatorsForAuthorizedWork(
    state: DomainState,
    auth: AuthContext,
    owned: Creator[],
    ownedIds: Set<Id>,
    samples: SampleRequest[],
    cooperations: Cooperation[],
    deliveries: Delivery[],
  ): Creator[] {
    if (auth.role !== "ops" && !(auth.role === "bd" && (auth.capabilities.includes("sample.approve") || auth.capabilities.includes("sample.fulfill") || auth.capabilities.includes("cooperation.approve")))) return owned;
    const creatorIds = new Set<Id>();
    for (const item of [...samples, ...cooperations, ...deliveries]) if (!ownedIds.has(item.creatorId)) creatorIds.add(item.creatorId);
    const stubs = this.creatorStubsForIds(state, creatorIds);
    return [...owned, ...stubs];
  }

  private sampleForActor(state: DomainState, auth: AuthContext, sample: SampleRequest): SampleRequest {
    const copy = clone(sample);
    const creator = state.creators.find((item) => item.id === sample.creatorId && item.orgId === state.orgId);
    const ownerCanRead = auth.role === "bd" && creator?.ownerMemberId === auth.member.id;
    const operationsCanRead = auth.capabilities.includes("sample.fulfill") && ["pending_shipment", "shipped"].includes(sample.status);
    if (!ownerCanRead && !operationsCanRead) copy.recipient = null;
    return copy;
  }

  private creatorStubsForIds(state: DomainState, creatorIds: Set<Id>): Creator[] {
    return state.creators.filter((creator) => creatorIds.has(creator.id) && !creator.archived).map((creator) => {
      const stub = clone(creator);
      stub.contact = null;
      stub.internalNote = null;
      return stub;
    });
  }

  private assertBusinessRole(auth: AuthContext): void {
    if (auth.role === "ops") domainError("FORBIDDEN", "样品运营账号不能维护达人商务数据");
  }

  private mutableCreator(state: DomainState, auth: AuthContext, creatorId: Id, allowPublicClaim = false): Creator {
    const creator = state.creators.find((item) => item.id === creatorId && item.orgId === state.orgId && !item.archived);
    if (!creator) domainError("NOT_FOUND", "达人不存在或当前账号无权访问");
    if (auth.role === "admin") return creator;
    if (creator.teamId !== auth.member.teamId) domainError("NOT_FOUND", "达人不存在或当前账号无权访问");
    if (auth.role === "manager") return creator;
    if (auth.role === "bd" && (creator.ownerMemberId === auth.member.id || (allowPublicClaim && creator.ownerMemberId === null))) return creator;
    domainError("NOT_FOUND", "达人不存在或当前账号无权访问");
  }

  private targetMember(state: DomainState, auth: AuthContext, memberId: Id): Member {
    const member = state.members.find((item) => item.id === memberId && item.orgId === state.orgId && item.active);
    if (!member) domainError("NOT_FOUND", "目标成员不存在或已停用");
    if (auth.role !== "admin" && member.teamId !== auth.member.teamId) domainError("FORBIDDEN", "不能跨团队指定负责人");
    const team = state.teams.find((item) => item.id === member.teamId && item.orgId === state.orgId && item.active);
    if (!team) domainError("FORBIDDEN", "目标成员没有有效团队");
    return member;
  }

  private changeCreatorOwner(state: DomainState, auth: AuthContext, creator: Creator, target: Member, effectiveAt: string, reason: string): void {
    const open = state.ownerAssignments.filter((item) => item.creatorId === creator.id && item.validTo === null);
    if (open.length !== 1) domainError("BUSINESS_RULE_VIOLATION", "达人当前负责人历史不唯一，需先核对历史记录");
    const current = open[0];
    if (Date.parse(effectiveAt) < Date.parse(current.validFrom)) domainError("BUSINESS_RULE_VIOLATION", "交接生效时间不能早于当前负责人区间");
    if (current.memberId === target.id) domainError("BUSINESS_RULE_VIOLATION", "目标商务已经是当前负责人");
    current.validTo = effectiveAt;
    const before = { ownerMemberId: creator.ownerMemberId, teamId: creator.teamId };
    state.ownerAssignments.push({
      id: this.runtime.id("owner"), creatorId: creator.id, orgId: creator.orgId, teamId: target.teamId,
      memberId: target.id, validFrom: effectiveAt, validTo: null, changedBy: auth.member.id, reason,
    });
    creator.ownerMemberId = target.id;
    creator.teamId = target.teamId;
    incrementVersion(creator, this.runtime.now(), auth.member.id);
    addAudit(state, this.runtime, auth.member.id, creator, "creator", creator.id, "creator.owner_changed", reason, before, { ownerMemberId: creator.ownerMemberId, teamId: creator.teamId, effectiveAt });
  }

  private moveOpenCreatorWork(
    state: DomainState,
    auth: AuthContext,
    creator: Creator,
    target: Member,
    effectiveAt: string,
    previousOwnerId: string | null,
  ): { samples: number; cooperations: number; schedules: number; deliveries: number; tasks: number } {
    const counts = { samples: 0, cooperations: 0, schedules: 0, deliveries: 0, tasks: 0 };
    for (const sample of state.samples.filter((item) => item.creatorId === creator.id && !["rejected", "closed", "received"].includes(item.status))) {
      const before = { teamId: sample.teamId };
      sample.teamId = target.teamId;
      incrementVersion(sample, this.runtime.now(), auth.member.id);
      addAudit(state, this.runtime, auth.member.id, sample, "sample", sample.id, "sample.team_handoff", "达人责任交接", before, { teamId: sample.teamId, effectiveAt });
      counts.samples += 1;
      for (const pkg of state.samplePackages.filter((item) => item.sampleId === sample.id)) {
        const beforePackage = { teamId: pkg.teamId };
        pkg.teamId = target.teamId;
        incrementVersion(pkg, this.runtime.now(), auth.member.id);
        addAudit(state, this.runtime, auth.member.id, pkg, "sample_package", pkg.id, "sample.package_scope_handed_off", "达人责任交接", beforePackage, { teamId: pkg.teamId, effectiveAt });
      }
    }
    for (const cooperation of state.cooperations.filter((item) => item.creatorId === creator.id && !["delivered", "cancelled", "rejected"].includes(item.status))) {
      const before = { ownerMemberId: cooperation.ownerMemberId, teamId: cooperation.teamId };
      cooperation.ownerMemberId = target.id;
      cooperation.teamId = target.teamId;
      incrementVersion(cooperation, this.runtime.now(), auth.member.id);
      addAudit(state, this.runtime, auth.member.id, cooperation, "cooperation", cooperation.id, "cooperation.handed_off", "达人责任交接", before, { ownerMemberId: target.id, teamId: target.teamId, effectiveAt });
      counts.cooperations += 1;
    }
    for (const schedule of state.schedules.filter((item) => item.creatorId === creator.id && (item.status === "planned" || item.status === "rescheduled"))) {
      const before = { ownerMemberId: schedule.ownerMemberId, teamId: schedule.teamId };
      schedule.ownerMemberId = target.id;
      schedule.teamId = target.teamId;
      incrementVersion(schedule, this.runtime.now(), auth.member.id);
      addAudit(state, this.runtime, auth.member.id, schedule, "schedule", schedule.id, "schedule.handed_off", "达人责任交接", before, { ownerMemberId: target.id, teamId: target.teamId, effectiveAt });
      counts.schedules += 1;
    }
    for (const delivery of state.deliveries.filter((item) => item.creatorId === creator.id && !["approved", "cancelled"].includes(item.status))) {
      const before = { ownerMemberId: delivery.ownerMemberId, teamId: delivery.teamId };
      delivery.ownerMemberId = target.id;
      delivery.teamId = target.teamId;
      incrementVersion(delivery, this.runtime.now(), auth.member.id);
      addAudit(state, this.runtime, auth.member.id, delivery, "delivery", delivery.id, "delivery.handed_off", "达人责任交接", before, { ownerMemberId: target.id, teamId: target.teamId, effectiveAt });
      counts.deliveries += 1;
    }
    for (const task of state.tasks.filter((item) => item.creatorId === creator.id && item.status === "open")) {
      const workflowTask = isWorkflowTask(task);
      if (!workflowTask && task.ownerMemberId !== previousOwnerId) continue;
      const before = { ownerMemberId: task.ownerMemberId, teamId: task.teamId };
      task.ownerMemberId = workflowTask ? null : target.id;
      if (workflowTask) task.requiredCapability = task.requiredCapability ?? taskCapabilityForKind(task.kind);
      task.teamId = target.teamId;
      if (before.ownerMemberId === task.ownerMemberId && before.teamId === task.teamId) continue;
      incrementVersion(task, this.runtime.now(), auth.member.id);
      addAudit(state, this.runtime, auth.member.id, task, "task", task.id, "task.handed_off", "达人责任交接", before, { ownerMemberId: task.ownerMemberId, requiredCapability: task.requiredCapability, teamId: task.teamId, effectiveAt });
      counts.tasks += 1;
    }
    return counts;
  }

  private mergeOwnerHistories(state: DomainState, source: Creator, target: Creator): Id | null {
    const family = new Set([...creatorIdsInMergeFamily(state, source.id), ...creatorIdsInMergeFamily(state, target.id)]);
    const histories = state.ownerAssignments.filter((item) => family.has(item.creatorId));
    for (let leftIndex = 0; leftIndex < histories.length; leftIndex += 1) {
      const left = histories[leftIndex];
      const leftStart = Date.parse(left.validFrom);
      const leftEnd = left.validTo === null ? Number.POSITIVE_INFINITY : Date.parse(left.validTo);
      for (let rightIndex = leftIndex + 1; rightIndex < histories.length; rightIndex += 1) {
        const right = histories[rightIndex];
        const rightStart = Date.parse(right.validFrom);
        const rightEnd = right.validTo === null ? Number.POSITIVE_INFINITY : Date.parse(right.validTo);
        const overlaps = leftStart < rightEnd && rightStart < leftEnd;
        if (overlaps && left.memberId !== right.memberId) {
          domainError("IDENTITY_CONFLICT", "两份达人档案的负责人历史时间重叠且负责人不同，不能自动合并");
        }
      }
    }
    const currentOwners = new Set(histories.filter((item) => item.validTo === null).map((item) => item.memberId));
    if (currentOwners.size > 1) domainError("IDENTITY_CONFLICT", "两份达人档案存在不同的当前负责人，不能自动合并");
    if (currentOwners.size === 0) return null;
    return [...currentOwners][0];
  }

  private coalesceOwnerHistoryAtMerge(state: DomainState, auth: AuthContext, source: Creator, target: Creator, currentOwner: Id | null, mergedAt: string): void {
    const sourceFamily = creatorIdsInMergeFamily(state, source.id);
    const targetFamily = creatorIdsInMergeFamily(state, target.id);
    const targetOpen = state.ownerAssignments.filter((item) => targetFamily.has(item.creatorId) && item.validTo === null);
    if (targetOpen.length > 1) domainError("BUSINESS_RULE_VIOLATION", "目标达人负责人历史存在多个当前区间，不能安全合并");
    const duplicateOpen = state.ownerAssignments.filter((item) => sourceFamily.has(item.creatorId) && item.validTo === null);
    if (targetOpen.length === 0) {
      for (const assignment of duplicateOpen) {
        assignment.validTo = mergedAt;
        addAudit(state, this.runtime, auth.member.id, target, "creator", target.id, "creator.owner_history_coalesced", "达人身份合并", { assignmentId: assignment.id, creatorId: assignment.creatorId, memberId: assignment.memberId, validTo: null }, { assignmentId: assignment.id, creatorId: assignment.creatorId, memberId: assignment.memberId, validTo: mergedAt });
      }
      state.ownerAssignments.push({
        id: this.runtime.id("owner"), creatorId: target.id, orgId: target.orgId, teamId: target.teamId,
        memberId: currentOwner, validFrom: mergedAt, validTo: null, changedBy: auth.member.id, reason: "身份合并后的当前负责人区间",
      });
      return;
    }
    const canonical = targetOpen[0];
    if (canonical.memberId !== currentOwner) domainError("IDENTITY_CONFLICT", "合并后的当前负责人无法与目标达人当前区间一致");
    for (const assignment of duplicateOpen) {
      if (assignment.memberId !== canonical.memberId) domainError("IDENTITY_CONFLICT", "合并后的当前负责人区间不一致");
      assignment.validTo = mergedAt;
      addAudit(state, this.runtime, auth.member.id, target, "creator", target.id, "creator.owner_history_coalesced", "达人身份合并", { assignmentId: assignment.id, creatorId: assignment.creatorId, memberId: assignment.memberId, validTo: null }, { assignmentId: assignment.id, creatorId: assignment.creatorId, memberId: assignment.memberId, validTo: mergedAt });
    }
  }

  private assertEffectiveAt(effectiveAt: string, now: string): void {
    assertIsoDateTime(effectiveAt, "生效时间");
    if (Date.parse(effectiveAt) > Date.parse(now)) domainError("BUSINESS_RULE_VIOLATION", "负责人交接生效时间不能晚于当前时间");
  }

  private isAllowedStageTransition(creator: Creator, next: CrmStage, auth: AuthContext): boolean {
    if (creator.crmStage === next) return false;
    if (creator.crmStage === "declined") return (auth.role === "manager" || auth.role === "admin") && (next === "uncontacted" || next === "contacted");
    if (creator.crmStage === "paused") return next === "declined" || next === creator.pausedFromStage;
    const allowed: Record<Exclude<CrmStage, "paused" | "declined">, CrmStage[]> = {
      uncontacted: ["contacted", "paused", "declined"],
      contacted: ["responded", "negotiating", "paused", "declined"],
      responded: ["negotiating", "paused", "declined"],
      negotiating: ["cooperating", "paused", "declined"],
      cooperating: ["paused", "declined"],
    };
    return allowed[creator.crmStage as Exclude<CrmStage, "paused" | "declined">]?.includes(next) ?? false;
  }

  private assertStageEvidence(state: DomainState, creator: Creator, stage: CrmStage, occurredAt: string, reason: string | null, reviewAt: string | null): void {
    if (stage === "paused") {
      if (!reason?.trim() || !reviewAt || Date.parse(reviewAt) <= Date.parse(occurredAt)) domainError("BUSINESS_RULE_VIOLATION", "暂停阶段需要填写原因和晚于暂停时间的复查时间");
    }
    if (stage === "declined" && !reason?.trim()) domainError("BUSINESS_RULE_VIOLATION", "不合作阶段需要填写关闭原因");
    const hasFollowup = (results: string[]) => state.followups.some((item) => item.creatorId === creator.id && results.includes(item.result) && Date.parse(item.occurredAt) <= Date.parse(occurredAt));
    if (stage === "contacted" && !hasFollowup(["contacted", "responded", "negotiating"])) domainError("BUSINESS_RULE_VIOLATION", "进入已触达前必须记录一次有效联系");
    if (stage === "responded" && !hasFollowup(["responded", "negotiating"])) domainError("BUSINESS_RULE_VIOLATION", "进入有回应前必须记录对方回应");
    if (stage === "negotiating" && !hasFollowup(["negotiating"])) domainError("BUSINESS_RULE_VIOLATION", "进入洽谈中前必须记录明确洽谈或报价跟进");
    if (stage === "cooperating" && !state.cooperations.some((item) => item.creatorId === creator.id && item.status !== "rejected" && item.status !== "cancelled" && item.decidedBy !== null && Date.parse(item.decidedAt ?? "") <= Date.parse(occurredAt))) {
      domainError("BUSINESS_RULE_VIOLATION", "进入合作中前必须存在已审批且未取消的合作单");
    }
  }

  private followupStagePath(current: CrmStage, result: string): CrmStage[] {
    if (current === "paused" || current === "declined") return [];
    if (result === "not_interested") return ["declined"];
    if (result === "contacted" && current === "uncontacted") return ["contacted"];
    if (result === "responded") {
      if (current === "uncontacted") return ["contacted", "responded"];
      if (current === "contacted") return ["responded"];
    }
    if (result === "negotiating") {
      if (current === "uncontacted") return ["contacted", "responded", "negotiating"];
      if (current === "contacted") return ["responded", "negotiating"];
      if (current === "responded") return ["negotiating"];
    }
    return [];
  }

  private requireProduct(state: DomainState, auth: AuthContext, productId: Id): Product {
    const product = state.products.find((item) => item.id === productId && item.orgId === state.orgId && item.active);
    if (!product) domainError("NOT_FOUND", "商品不存在或已停用");
    if (auth.role !== "admin" && product.teamId !== auth.member.teamId) domainError("NOT_FOUND", "商品不存在或当前账号无权访问");
    if (auth.role === "ops" && !auth.capabilities.includes("sample.fulfill")) domainError("FORBIDDEN", "当前样品运营账号不能查看商品");
    return product;
  }

  private assertCooperationLineOfferScope(
    state: DomainState,
    teamId: Id,
    line: Extract<DomainCommand, { type: "cooperation.create" }>['lines'][number],
  ): void {
    if (line.storeId == null && line.storeAssortmentId == null) return;
    if (line.storeId == null || line.storeAssortmentId == null || line.productId == null || line.assortmentVersion == null) {
      domainError("VALIDATION_ERROR", "货盘快照必须同时包含店铺、货盘、商品和版本");
    }
    const store = state.manualStores.find((item) => item.id === line.storeId && item.orgId === state.orgId && item.teamId === teamId);
    const assortment = state.storeAssortments.find((item) => item.id === line.storeAssortmentId && item.orgId === state.orgId && item.teamId === teamId);
    const product = state.products.find((item) => item.id === line.productId && item.orgId === state.orgId && item.teamId === teamId);
    if (!store || !assortment || !product || assortment.storeId !== store.id || assortment.productId !== product.id) {
      domainError("NOT_FOUND", "货盘快照关联不存在或当前团队无权访问");
    }
    if (!Number.isSafeInteger(line.assortmentVersion) || line.assortmentVersion < 1) domainError("VALIDATION_ERROR", "货盘版本无效");
  }

  private requireSample(state: DomainState, auth: AuthContext, sampleId: Id): SampleRequest {
    const sample = state.samples.find((item) => item.id === sampleId && item.orgId === state.orgId);
    if (!sample) domainError("NOT_FOUND", "样品申请不存在或当前账号无权访问");
    this.assertScopeForAction(state, auth, sample);
    return sample;
  }

  private requireCooperation(state: DomainState, auth: AuthContext, cooperationId: Id): Cooperation {
    const cooperation = state.cooperations.find((item) => item.id === cooperationId && item.orgId === state.orgId);
    if (!cooperation) domainError("NOT_FOUND", "合作单不存在或当前账号无权访问");
    this.assertScopeForAction(state, auth, cooperation);
    return cooperation;
  }

  private requireSchedule(state: DomainState, auth: AuthContext, scheduleId: Id): LiveSchedule {
    const schedule = state.schedules.find((item) => item.id === scheduleId && item.orgId === state.orgId);
    if (!schedule) domainError("NOT_FOUND", "排期不存在或当前账号无权访问");
    this.assertScopeForAction(state, auth, schedule);
    return schedule;
  }

  private requireDelivery(state: DomainState, auth: AuthContext, deliveryId: Id): Delivery {
    const delivery = state.deliveries.find((item) => item.id === deliveryId && item.orgId === state.orgId);
    if (!delivery) domainError("NOT_FOUND", "交付项不存在或当前账号无权访问");
    this.assertScopeForAction(state, auth, delivery);
    return delivery;
  }

  private assertSampleEdit(state: DomainState, auth: AuthContext, sample: SampleRequest): void {
    if (auth.role === "admin") return;
    if (auth.role === "manager" && sample.teamId === auth.member.teamId) return;
    if (auth.role === "bd") {
      this.mutableCreator(state, auth, sample.creatorId);
      return;
    }
    domainError("NOT_FOUND", "样品申请不存在或当前账号无权访问");
  }

  private assertCooperationEdit(auth: AuthContext, cooperation: Cooperation): void {
    if (auth.role === "admin") return;
    if (auth.role === "manager" && cooperation.teamId === auth.member.teamId) return;
    if (auth.role === "bd" && cooperation.teamId === auth.member.teamId && cooperation.ownerMemberId === auth.member.id) return;
    domainError("NOT_FOUND", "合作单不存在或当前账号无权访问");
  }

  private assertScheduleEdit(auth: AuthContext, schedule: LiveSchedule): void {
    if (auth.role === "admin") return;
    if (auth.role === "manager" && schedule.teamId === auth.member.teamId) return;
    if (auth.role === "bd" && schedule.teamId === auth.member.teamId && schedule.ownerMemberId === auth.member.id) return;
    domainError("NOT_FOUND", "排期不存在或当前账号无权访问");
  }

  private assertDeliveryEdit(auth: AuthContext, delivery: Delivery): void {
    if (auth.role === "admin") return;
    if (auth.role === "manager" && delivery.teamId === auth.member.teamId) return;
    if (auth.role === "bd" && delivery.teamId === auth.member.teamId && delivery.ownerMemberId === auth.member.id) return;
    domainError("NOT_FOUND", "交付项不存在或当前账号无权访问");
  }

  private assertScopeForAction<T extends { orgId: string; teamId: string }>(state: DomainState, auth: AuthContext, entity: T): void {
    if (entity.orgId !== auth.member.orgId) domainError("NOT_FOUND", "记录不存在或当前账号无权访问");
    if (auth.role === "admin") return;
    if (entity.teamId !== auth.member.teamId) domainError("NOT_FOUND", "记录不存在或当前账号无权访问");
    if (auth.role === "manager") return;
    const record = entity as T & Record<string, unknown>;
    if (auth.role === "bd") {
      if (typeof record.id === "string" && "ownerSnapshot" in record) {
        if (effectiveOwner(record as unknown as OrderLine, state.ownerCorrections) === auth.member.id) return;
        domainError("NOT_FOUND", "记录不存在或当前账号无权访问");
      }
      if (typeof record.requiredCapability === "string" && auth.capabilities.includes(record.requiredCapability as Capability)) return;
      const creatorId = typeof record.creatorId === "string" ? record.creatorId : null;
      if (creatorId) {
        const creator = state.creators.find((item) => item.id === creatorId && item.orgId === state.orgId && !item.archived);
        if (creator?.ownerMemberId === auth.member.id) return;
        const reviewableSample = "applicantId" in record && record.status === "pending_approval" && auth.capabilities.includes("sample.approve");
        const shippableSample = "applicantId" in record && ["pending_shipment", "shipped"].includes(String(record.status)) && auth.capabilities.includes("sample.fulfill");
        const reviewableCooperation = "requiredSampleIds" in record && record.status === "pending_approval" && auth.capabilities.includes("cooperation.approve");
        const reviewableDelivery = "submissions" in record && record.status === "pending_review" && auth.capabilities.includes("cooperation.approve");
        if (reviewableSample || shippableSample || reviewableCooperation || reviewableDelivery) return;
        domainError("NOT_FOUND", "记录不存在或当前账号无权访问");
      }
      if (record.ownerMemberId === auth.member.id) return;
      domainError("NOT_FOUND", "记录不存在或当前账号无权访问");
    }
    if (auth.role === "ops") {
      const sampleId = typeof record.sampleId === "string" ? record.sampleId : null;
      const sampleEntity = typeof record.id === "string" ? state.samples.find((sample) => sample.id === record.id) : null;
      const relatedSample = sampleId ? state.samples.find((sample) => sample.id === sampleId) : null;
      const isSample = Boolean(sampleEntity || relatedSample);
      if (isSample && (auth.capabilities.includes("sample.fulfill") || auth.capabilities.includes("sample.approve"))) return;
      if (record.requiredCapability && auth.capabilities.includes(record.requiredCapability as Capability)) return;
      domainError("NOT_FOUND", "记录不存在或当前账号无权访问");
    }
    domainError("NOT_FOUND", "记录不存在或当前账号无权访问");
  }

  private relatedExists(state: DomainState, relatedType: "creator" | "sample" | "cooperation" | "schedule" | "delivery", relatedId: Id): boolean {
    const collections = {
      creator: state.creators,
      sample: state.samples,
      cooperation: state.cooperations,
      schedule: state.schedules,
      delivery: state.deliveries,
    } as const;
    return collections[relatedType].some((item) => item.id === relatedId && item.orgId === state.orgId);
  }

  private enqueueReviewTask(
    state: DomainState,
    auth: AuthContext,
    kind: WorkTask["kind"],
    creatorId: Id,
    title: string,
    relatedType: NonNullable<WorkTask["relatedType"]>,
    relatedId: Id,
    requiredCapability: Capability = kind === "sample_approval" ? "sample.approve" : kind === "sample_shipment" || kind === "sample_receipt" ? "sample.fulfill" : "cooperation.approve",
    requestedAt: string = this.runtime.now(),
  ): void {
    if (state.tasks.some((task) => task.relatedType === relatedType && task.relatedId === relatedId && task.kind === kind && task.status === "open" && task.ownerMemberId === null && task.requiredCapability === requiredCapability)) return;
    const creator = state.creators.find((item) => item.id === creatorId);
    const scoped = creator ?? { orgId: auth.member.orgId, teamId: auth.member.teamId };
    const now = this.runtime.now();
    const task: WorkTask = {
      id: this.runtime.id("task"), orgId: scoped.orgId, teamId: scoped.teamId, creatorId: creator?.id ?? null,
      kind, title, ownerMemberId: null, requiredCapability, dueAt: taskDueAt(requestedAt, kind), status: "open", relatedType, relatedId,
      completedAt: null, completionNote: null, priority: "normal", version: 1, createdAt: now, createdBy: auth.member.id, updatedAt: now, updatedBy: auth.member.id,
    };
    state.tasks.push(task);
    addAudit(state, this.runtime, auth.member.id, task, "task", task.id, "task.queued", null, null, { kind, requiredCapability, relatedType, relatedId });
  }

  private enqueueOwnerTask(
    state: DomainState,
    createdBy: Id,
    ownerMemberId: Id,
    scope: { orgId: string; teamId: string; creatorId?: Id },
    kind: WorkTask["kind"],
    title: string,
    relatedType: NonNullable<WorkTask["relatedType"]>,
    relatedId: Id,
    dueAt: string | null,
    priority: WorkTask["priority"],
  ): void {
    if (state.tasks.some((task) => task.relatedType === relatedType && task.relatedId === relatedId && task.kind === kind && task.status === "open" && task.ownerMemberId === ownerMemberId)) return;
    const now = this.runtime.now();
    const task: WorkTask = {
      id: this.runtime.id("task"), orgId: scope.orgId, teamId: scope.teamId, creatorId: scope.creatorId ?? null,
      kind, title, ownerMemberId, requiredCapability: null, dueAt, status: "open", relatedType, relatedId,
      completedAt: null, completionNote: null, priority, version: 1, createdAt: now, createdBy, updatedAt: now, updatedBy: createdBy,
    };
    state.tasks.push(task);
    addAudit(state, this.runtime, createdBy, task, "task", task.id, "task.created", null, null, { kind, ownerMemberId, dueAt });
  }

  private completeTasks(state: DomainState, actorId: Id, relatedType: NonNullable<WorkTask["relatedType"]>, relatedId: Id, at: string, note: string, kind?: WorkTask["kind"]): void {
    for (const task of state.tasks.filter((item) => item.relatedType === relatedType && item.relatedId === relatedId && item.status === "open" && item.requiredCapability !== null && (kind === undefined || item.kind === kind))) {
      const before = { status: task.status };
      task.status = "completed";
      task.completedAt = at;
      task.completionNote = note;
      incrementVersion(task, this.runtime.now(), actorId);
      addAudit(state, this.runtime, actorId, task, "task", task.id, "task.completed_by_business_action", note, before, { status: task.status, completedAt: at });
    }
  }

  private completeOwnedTasks(state: DomainState, actorId: Id, relatedType: NonNullable<WorkTask["relatedType"]>, relatedId: Id, ownerMemberId: Id, at: string, note: string, kind?: WorkTask["kind"]): void {
    for (const task of state.tasks.filter((item) => item.relatedType === relatedType && item.relatedId === relatedId && item.status === "open" && item.ownerMemberId === ownerMemberId && item.requiredCapability === null && (kind === undefined || item.kind === kind))) {
      const before = { status: task.status };
      task.status = "completed";
      task.completedAt = at;
      task.completionNote = note;
      incrementVersion(task, this.runtime.now(), actorId);
      addAudit(state, this.runtime, actorId, task, "task", task.id, "task.completed_by_business_action", note, before, { status: task.status, completedAt: at });
    }
  }

  private completeAllRelatedTasks(state: DomainState, actorId: Id, relatedType: NonNullable<WorkTask["relatedType"]>, relatedId: Id, at: string, note: string): void {
    for (const task of state.tasks.filter((item) => item.relatedType === relatedType && item.relatedId === relatedId && item.status === "open")) {
      const before = { status: task.status, ownerMemberId: task.ownerMemberId, requiredCapability: task.requiredCapability };
      task.status = "completed";
      task.completedAt = at;
      task.completionNote = note;
      incrementVersion(task, this.runtime.now(), actorId);
      addAudit(state, this.runtime, actorId, task, "task", task.id, "task.completed_by_cancellation", note, before, { status: task.status, completedAt: at });
    }
  }

  private sampleFullyShipped(state: DomainState, sample: SampleRequest): boolean {
    if (sample.lines.length === 0) return false;
    const shipped = new Map<Id, number>();
    for (const line of state.samplePackages.filter((pkg) => pkg.sampleId === sample.id).flatMap((pkg) => pkg.lines)) {
      shipped.set(line.sampleLineId, (shipped.get(line.sampleLineId) ?? 0) + line.quantity);
    }
    return sample.lines.every((line) => (shipped.get(line.id) ?? 0) >= line.quantity);
  }

  private sampleFullyReceived(state: DomainState, sample: SampleRequest): boolean {
    const packages = state.samplePackages.filter((pkg) => pkg.sampleId === sample.id);
    return packages.length > 0 && packages.every((pkg) => pkg.receivedAt !== null)
      && (sample.shippingBlocked || this.sampleFullyShipped(state, sample));
  }

  private refreshCooperationAfterSamples(state: DomainState, actorId: Id, sample: SampleRequest, occurredAt: string): void {
    if (!sample.cooperationId) return;
    const cooperation = state.cooperations.find((item) => item.id === sample.cooperationId);
    if (!cooperation || !["pending_samples_shipment", "pending_samples_receipt"].includes(cooperation.status)) return;
    const requiredSamples = cooperation.requiredSampleIds.map((id) => state.samples.find((item) => item.id === id)).filter((item): item is SampleRequest => item !== undefined);
    if (requiredSamples.length === 0) return;
    if (cooperation.status === "pending_samples_shipment" && requiredSamples.every((item) => this.sampleFullyShipped(state, item))) {
      const before = { status: cooperation.status };
      cooperation.status = "pending_samples_receipt";
      incrementVersion(cooperation, this.runtime.now(), actorId);
      addAudit(state, this.runtime, actorId, cooperation, "cooperation", cooperation.id, "cooperation.samples_shipped", null, before, { status: cooperation.status, occurredAt });
    }
    if (cooperation.status === "pending_samples_receipt" && requiredSamples.every((item) => this.sampleFullyReceived(state, item))) {
      const before = { status: cooperation.status };
      cooperation.status = "pending_delivery";
      incrementVersion(cooperation, this.runtime.now(), actorId);
      addAudit(state, this.runtime, actorId, cooperation, "cooperation", cooperation.id, "cooperation.samples_received", null, before, { status: cooperation.status, occurredAt });
    }
  }

  private refreshCooperationAfterDelivery(state: DomainState, actorId: Id, cooperation: Cooperation, occurredAt: string): void {
    if (cooperation.status !== "pending_delivery") return;
    const required = state.deliveries.filter((item) => item.cooperationId === cooperation.id && item.required);
    if (required.length === 0 || !required.every((item) => item.status === "approved")) return;
    const before = { status: cooperation.status };
    cooperation.status = "delivered";
    incrementVersion(cooperation, this.runtime.now(), actorId);
    this.completeTasks(state, actorId, "cooperation", cooperation.id, occurredAt, "全部必需交付已验收");
    addAudit(state, this.runtime, actorId, cooperation, "cooperation", cooperation.id, "cooperation.delivered", null, before, { status: cooperation.status, occurredAt });
  }

  private assertWindow(startAt: string, endAt: string, message: string): void {
    if (Date.parse(endAt) <= Date.parse(startAt)) domainError("VALIDATION_ERROR", message);
  }

  private memberHasOpenWork(state: DomainState, memberId: Id): boolean {
    return state.creators.some((item) => !item.archived && item.ownerMemberId === memberId)
      || state.tasks.some((item) => item.ownerMemberId === memberId && item.status === "open")
      || state.cooperations.some((item) => item.ownerMemberId === memberId && !["delivered", "cancelled", "rejected"].includes(item.status))
      || state.schedules.some((item) => item.ownerMemberId === memberId && (item.status === "planned" || item.status === "rescheduled"))
      || state.deliveries.some((item) => item.ownerMemberId === memberId && !["approved", "cancelled"].includes(item.status));
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function orderContentFingerprint(order: OrderLine): string {
  return fingerprint({
    shopId: order.shopId, externalOrderId: order.externalOrderId, externalLineId: order.externalLineId,
    productId: order.productId, sku: order.sku, creatorAccountId: order.creatorAccountId,
    paidAt: order.paidAt, sourceStatus: order.sourceStatus, status: order.status,
    paidAmountCents: order.paidAmountCents, rawAmount: order.rawAmount,
  });
}

function refundContentFingerprint(refund: RefundEvent, order: OrderLine): string {
  return fingerprint({
    shopId: refund.shopId, externalRefundId: refund.externalRefundId,
    externalOrderId: order.externalOrderId, externalLineId: order.externalLineId,
    refundedAt: refund.refundedAt, sourceStatus: refund.sourceStatus, status: refund.status,
    amountCents: refund.amountCents, direction: refund.direction, rawAmount: refund.rawAmount,
  });
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function normalizeContact(value: Partial<CreatorContact> | null | undefined): CreatorContact | null {
  if (!value) return null;
  return { contactName: value.contactName ?? null, phone: value.phone ?? null, email: value.email ?? null, handle: value.handle ?? null };
}

function mergeContact(current: CreatorContact | null, update: Partial<CreatorContact> | null | undefined): CreatorContact | null {
  if (!update) return current;
  return {
    contactName: update.contactName !== undefined ? update.contactName : current?.contactName ?? null,
    phone: update.phone !== undefined ? update.phone : current?.phone ?? null,
    email: update.email !== undefined ? update.email : current?.email ?? null,
    handle: update.handle !== undefined ? update.handle : current?.handle ?? null,
  };
}

function normalizeRecipient(value: RecipientInfo): RecipientInfo {
  return { recipientName: value.recipientName.trim(), phone: value.phone?.trim() || null, address: value.address.trim() };
}
