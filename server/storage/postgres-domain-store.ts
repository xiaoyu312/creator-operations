import type { PostgresJsDatabase } from "@lark-apaas/fullstack-nestjs-core";
import { sql, type SQL } from "drizzle-orm";
import type {
  AuditEvent,
  DomainState,
  Member,
} from "../../shared/types.ts";
import { CREATOR_COMMERCE_TYPES, PLATFORMS, type Platform } from "../../shared/types.ts";

const PAGE_SIZE = 500;
const COLLECTIONS = [
  "teams",
  "members",
  "creators",
  "ownerAssignments",
  "creatorStageEvents",
  "followups",
  "creatorSessions",
  "salesReports",
  "tasks",
  "products",
  "manualStores",
  "storeAssortments",
  "creatorProductProposals",
  "partnerResources",
  "cooperationPartnerLinks",
  "contentAssets",
  "contentObservations",
  "commercialLedgerEntries",
  "teamMonthlyTargets",
  "samples",
  "samplePackages",
  "cooperations",
  "schedules",
  "deliveries",
  "orders",
  "refunds",
  "ownerCorrections",
  "importBatches",
] as const;

type Collection = (typeof COLLECTIONS)[number];
type Entity = { id: string; [key: string]: unknown };
const TEAM_SCOPED_BUSINESS_COLLECTIONS = [
  "manualStores",
  "storeAssortments",
  "creatorProductProposals",
  "partnerResources",
  "cooperationPartnerLinks",
  "contentAssets",
  "contentObservations",
  "commercialLedgerEntries",
  "teamMonthlyTargets",
  "salesReports",
] as const satisfies readonly Collection[];
const adaptedDatabases = new WeakSet<object>();

interface QueryResult {
  rows: Record<string, unknown>[];
}

/** Small app-owned seam used by the local PGlite test harness. Production uses PostgresJsDatabase. */
export interface DomainStoreDatabase {
  execute(query: SQL): Promise<QueryResult>;
  transaction<T>(callback: (tx: DomainStoreExecutor) => Promise<T>): Promise<T>;
}

export interface DomainStoreExecutor {
  execute(query: SQL): Promise<QueryResult>;
}

export interface PostgresDomainStoreOptions {
  /** Fixed organization chosen by trusted server configuration, never request input. */
  orgId: string;
}

export class DomainStoreIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainStoreIntegrityError";
  }
}

/**
 * Production persistence adapter for the platform-provided Drizzle/PostgreSQL binding.
 * The migration is applied separately; this class never performs DDL or demo seeding.
 */
export class PostgresDomainStore {
  private readonly database: DomainStoreDatabase;
  private readonly orgId: string;

  constructor(database: PostgresJsDatabase, options: PostgresDomainStoreOptions);
  constructor(database: DomainStoreDatabase, options: PostgresDomainStoreOptions);
  constructor(
    database: PostgresJsDatabase | DomainStoreDatabase,
    options: PostgresDomainStoreOptions,
  ) {
    if (!options.orgId.trim()) {
      throw new DomainStoreIntegrityError("DABO_ORG_ID must be configured before creating the production store");
    }
    this.orgId = options.orgId;
    this.database = isDomainStoreDatabase(database)
      ? database
      : adaptPostgresDatabase(database);
  }

  async read(): Promise<DomainState> {
    return this.database.transaction(async (tx) => {
      await this.assertRuntimeRole(tx);
      const meta = await tx.execute(sql`
        SELECT schema_version, data_mode, revision
        FROM domain_state_meta
        WHERE org_id = ${this.orgId}
        FOR SHARE
      `);
      if (meta.rows.length === 0) {
        return this.readUninitializedOrg(tx);
      }
      if (meta.rows.length !== 1) {
        throw new DomainStoreIntegrityError("Organization metadata is not unique");
      }
      this.assertMeta(meta.rows[0]);
      return this.loadState(tx);
    });
  }

  async transaction<T>(fn: (draft: DomainState) => T | Promise<T>): Promise<T> {
    return this.database.transaction(async (tx) => {
      await this.assertRuntimeRole(tx);
      // The metadata row is the per-organization serialization lock. First writes
      // validate that there is no orphan data before establishing that lock row.
      let meta = await tx.execute(sql`
        SELECT schema_version, data_mode, revision
        FROM domain_state_meta
        WHERE org_id = ${this.orgId}
        FOR UPDATE
      `);
      if (meta.rows.length === 0) {
        await this.assertNoOrphanedOrgData(tx);
        await tx.execute(sql`
          INSERT INTO domain_state_meta (org_id, schema_version, data_mode, revision)
          VALUES (${this.orgId}, 1, 'production', 0)
          ON CONFLICT (org_id) DO NOTHING
        `);
        meta = await tx.execute(sql`
          SELECT schema_version, data_mode, revision
          FROM domain_state_meta
          WHERE org_id = ${this.orgId}
          FOR UPDATE
        `);
      }
      if (meta.rows.length !== 1) {
        throw new DomainStoreIntegrityError("Organization metadata row could not be locked");
      }
      this.assertMeta(meta.rows[0]);

      const before = await this.loadState(tx);
      const draft = structuredClone(before);
      const result = await fn(draft);
      for (const member of draft.members) {
        member.role = null;
        member.capabilities = null;
      }
      this.validateState(draft, before);
      validateCreatorAccountUniqueness(draft.creators);
      validateOrderRefundIdentityUniqueness(draft.orders, draft.refunds);
      await this.persistDiff(tx, before, draft);
      const currentRevision = asInteger(meta.rows[0].revision, "metadata revision");
      await tx.execute(sql`
        UPDATE domain_state_meta
        SET revision = ${currentRevision + 1}, _updated_at = CURRENT_TIMESTAMP,
            _updated_by = ${platformUserProfileSql()}
        WHERE org_id = ${this.orgId}
      `);
      return result;
    });
  }

  private async readUninitializedOrg(executor: DomainStoreExecutor): Promise<DomainState> {
    await this.assertNoOrphanedOrgData(executor);
    return emptyState(this.orgId);
  }

  private async assertNoOrphanedOrgData(executor: DomainStoreExecutor): Promise<void> {
    const entity = await executor.execute(sql`
      SELECT entity_id FROM domain_entity WHERE org_id = ${this.orgId} LIMIT 1
    `);
    const audit = await executor.execute(sql`
      SELECT event_id FROM domain_audit_event WHERE org_id = ${this.orgId} LIMIT 1
    `);
    if (entity.rows.length > 0 || audit.rows.length > 0) {
      throw new DomainStoreIntegrityError("Organization data exists without its metadata row");
    }
  }

  private assertMeta(row: Record<string, unknown>): void {
    if (asInteger(row.schema_version, "schema version") !== 1) {
      throw new DomainStoreIntegrityError("Unsupported domain state schema version");
    }
    if (row.data_mode !== "production") {
      throw new DomainStoreIntegrityError("Production store rejected a non-production data mode");
    }
    asInteger(row.revision, "metadata revision");
  }

  private async assertRuntimeRole(executor: DomainStoreExecutor): Promise<void> {
    const result = await executor.execute(sql`SELECT current_user AS runtime_role`);
    if (result.rows.length !== 1 || result.rows[0].runtime_role !== "service_role") {
      throw new DomainStoreIntegrityError("The PostgreSQL runtime role is not the approved service_role");
    }
  }

  private async loadState(executor: DomainStoreExecutor): Promise<DomainState> {
    const state = emptyState(this.orgId);
    for (const collection of COLLECTIONS) {
      const values = await this.loadCollection(executor, collection);
      (state[collection] as unknown[]) = values;
    }
    state.auditEvents = await this.loadAuditEvents(executor);
    return state;
  }

  private async loadCollection(
    executor: DomainStoreExecutor,
    collection: Collection,
  ): Promise<Entity[]> {
    const output: Entity[] = [];
    let cursor: string | null = null;
    while (true) {
      const page = cursor === null
        ? await executor.execute(sql`
            SELECT entity_id, payload
            FROM domain_entity
            WHERE org_id = ${this.orgId} AND collection = ${collection}
            ORDER BY entity_id ASC
            LIMIT ${PAGE_SIZE}
          `)
        : await executor.execute(sql`
            SELECT entity_id, payload
            FROM domain_entity
            WHERE org_id = ${this.orgId} AND collection = ${collection}
              AND entity_id > ${cursor}
            ORDER BY entity_id ASC
            LIMIT ${PAGE_SIZE}
          `);
      for (const row of page.rows) {
        const entityId = requireString(row.entity_id, "entity id");
        const entity = parsePayload(row.payload, collection, entityId);
        output.push(entity);
        cursor = entityId;
      }
      if (page.rows.length < PAGE_SIZE) break;
    }
    return output;
  }

  private async loadAuditEvents(executor: DomainStoreExecutor): Promise<AuditEvent[]> {
    const output: AuditEvent[] = [];
    let cursor: string | null = null;
    while (true) {
      const page = cursor === null
        ? await executor.execute(sql`
            SELECT event_id, payload
            FROM domain_audit_event
            WHERE org_id = ${this.orgId}
            ORDER BY event_id ASC
            LIMIT ${PAGE_SIZE}
          `)
        : await executor.execute(sql`
            SELECT event_id, payload
            FROM domain_audit_event
            WHERE org_id = ${this.orgId} AND event_id > ${cursor}
            ORDER BY event_id ASC
            LIMIT ${PAGE_SIZE}
          `);
      for (const row of page.rows) {
        const eventId = requireString(row.event_id, "audit event id");
        output.push(parsePayload(row.payload, "auditEvents", eventId) as unknown as AuditEvent);
        cursor = eventId;
      }
      if (page.rows.length < PAGE_SIZE) break;
    }
    return output;
  }

  private validateState(next: DomainState, previous: DomainState): void {
    if (next.schemaVersion !== 1 || next.dataMode !== "production" || next.orgId !== this.orgId) {
      throw new DomainStoreIntegrityError("Transaction changed the configured organization or production state metadata");
    }
    for (const collection of COLLECTIONS) {
      const current = next[collection] as unknown as Entity[];
      const original = previous[collection] as unknown as Entity[];
      validateCollection(current, original, collection, this.orgId);
    }
    validateBusinessCollectionScopes(next, this.orgId);
    validateCreatorSessions(next);
    validateSalesReports(next);
    validateAppendOnlyCollection(
      next.contentObservations as unknown as Entity[],
      previous.contentObservations as unknown as Entity[],
      "contentObservations",
    );
    validateAuditEvents(next.auditEvents, previous.auditEvents, this.orgId);
  }

  private async persistDiff(
    tx: DomainStoreExecutor,
    before: DomainState,
    after: DomainState,
  ): Promise<void> {
    for (const collection of COLLECTIONS) {
      const oldRows = indexById(before[collection] as unknown as Entity[], collection);
      const newRows = indexById(after[collection] as unknown as Entity[], collection);
      for (const [id, entity] of newRows) {
        const payload = normalizeEntity(collection, entity);
        if (oldRows.has(id) && stableJson(oldRows.get(id)) === stableJson(payload)) continue;
        const teamId = optionalString(payload.teamId);
        const ownerId = optionalString(payload.ownerMemberId) ?? optionalString(payload.memberId);
        const version = typeof payload.version === "number" && Number.isInteger(payload.version)
          ? payload.version
          : 1;
        await tx.execute(sql`
          INSERT INTO domain_entity
            (org_id, collection, entity_id, team_id, owner_id, version, payload)
          VALUES
            (${this.orgId}, ${collection}, ${id}, ${teamId}, ${ownerId}, ${version}, ${JSON.stringify(payload)}::jsonb)
          ON CONFLICT (org_id, collection, entity_id) DO UPDATE SET
            team_id = EXCLUDED.team_id,
            owner_id = EXCLUDED.owner_id,
            version = EXCLUDED.version,
            payload = EXCLUDED.payload,
            _updated_at = CURRENT_TIMESTAMP,
            _updated_by = ${platformUserProfileSql()}
          WHERE domain_entity.payload IS DISTINCT FROM EXCLUDED.payload
             OR domain_entity.team_id IS DISTINCT FROM EXCLUDED.team_id
             OR domain_entity.owner_id IS DISTINCT FROM EXCLUDED.owner_id
             OR domain_entity.version IS DISTINCT FROM EXCLUDED.version
        `);
      }
    }

    const priorEvents = indexAuditEvents(before.auditEvents);
    for (const event of after.auditEvents) {
      if (priorEvents.has(event.id)) continue;
      await tx.execute(sql`
        INSERT INTO domain_audit_event (org_id, event_id, payload)
        VALUES (${this.orgId}, ${event.id}, ${JSON.stringify(event)}::jsonb)
      `);
    }
  }
}

export function createPostgresDomainStore(
  database: PostgresJsDatabase,
  options: PostgresDomainStoreOptions,
): PostgresDomainStore {
  return new PostgresDomainStore(database, options);
}

/** Adapter helper for PGlite or other local Drizzle-compatible test databases. */
export function adaptDrizzleDomainStoreDatabase(database: {
  execute(query: never): PromiseLike<unknown>;
  transaction<T>(callback: (tx: { execute(query: never): PromiseLike<unknown> }) => Promise<T>): Promise<T>;
}): DomainStoreDatabase {
  // The app and the platform re-export Drizzle through different module conditions,
  // which duplicates SQLWrapper's private type identity. All queries here are created
  // locally with Drizzle's `sql` tag, so the narrow boundary coercion is safe.
  const executor = (client: { execute(query: never): PromiseLike<unknown> }): DomainStoreExecutor => ({
    execute: async (query) => normalizeQueryResult(await client.execute(query as never)),
  });
  const adapted: DomainStoreDatabase = {
    ...executor(database),
    transaction: (callback) => database.transaction((tx) => callback(executor(tx))),
  };
  adaptedDatabases.add(adapted);
  return adapted;
}

function adaptPostgresDatabase(database: PostgresJsDatabase): DomainStoreDatabase {
  return adaptDrizzleDomainStoreDatabase(database);
}

function isDomainStoreDatabase(
  database: PostgresJsDatabase | DomainStoreDatabase,
): database is DomainStoreDatabase {
  return adaptedDatabases.has(database as object);
}

function normalizeQueryResult(result: unknown): QueryResult {
  if (typeof result !== "object" || result === null || !("rows" in result) || !Array.isArray(result.rows)) {
    throw new DomainStoreIntegrityError("Drizzle query did not return a row result");
  }
  return { rows: result.rows as Record<string, unknown>[] };
}

function emptyState(orgId: string): DomainState {
  return {
    schemaVersion: 1,
    dataMode: "production",
    orgId,
    teams: [],
    members: [],
    creators: [],
    ownerAssignments: [],
    creatorStageEvents: [],
    followups: [],
    creatorSessions: [],
    salesReports: [],
    tasks: [],
    products: [],
    manualStores: [],
    storeAssortments: [],
    creatorProductProposals: [],
    partnerResources: [],
    cooperationPartnerLinks: [],
    contentAssets: [],
    contentObservations: [],
    commercialLedgerEntries: [],
    teamMonthlyTargets: [],
    samples: [],
    samplePackages: [],
    cooperations: [],
    schedules: [],
    deliveries: [],
    orders: [],
    refunds: [],
    ownerCorrections: [],
    importBatches: [],
    auditEvents: [],
  };
}

function validateCollection(
  current: Entity[],
  original: Entity[],
  collection: Collection,
  orgId: string,
): void {
  const oldIds = new Set(original.map((entity) => entity.id));
  const newIds = new Set<string>();
  for (const entity of current) {
    if (!entity || typeof entity.id !== "string" || entity.id.length === 0) {
      throw new DomainStoreIntegrityError(`Collection ${collection} contains an entity without an id`);
    }
    if (newIds.has(entity.id)) {
      throw new DomainStoreIntegrityError(`Collection ${collection} contains duplicate id ${entity.id}`);
    }
    newIds.add(entity.id);
    if ("orgId" in entity && entity.orgId !== orgId) {
      throw new DomainStoreIntegrityError(`Collection ${collection} contains an entity from another organization`);
    }
  }
  if ([...oldIds].some((id) => !newIds.has(id))) {
    throw new DomainStoreIntegrityError(`Collection ${collection} is append/upsert only; historical rows cannot be removed`);
  }
}

function validateBusinessCollectionScopes(state: DomainState, orgId: string): void {
  const teamIds = new Set(state.teams.filter((team) => team.orgId === orgId).map((team) => team.id));
  for (const collection of TEAM_SCOPED_BUSINESS_COLLECTIONS) {
    const rows = state[collection] as unknown as Array<Entity & { orgId?: unknown; teamId?: unknown }>;
    for (const row of rows) {
      if (row.orgId !== orgId) {
        throw new DomainStoreIntegrityError(`Collection ${collection} contains an entity from another organization`);
      }
      if (typeof row.teamId !== "string" || row.teamId.length === 0) {
        throw new DomainStoreIntegrityError(`Collection ${collection} contains an entity without a team id`);
      }
      if (!teamIds.has(row.teamId)) {
        throw new DomainStoreIntegrityError(`Collection ${collection} references a team outside this organization`);
      }
    }
  }
}

function validateCreatorSessions(state: DomainState): void {
  const creators = new Map(state.creators.map((creator) => [creator.id, creator]));
  const products = new Map(state.products.map((product) => [product.id, product]));
  for (const session of state.creatorSessions) {
    const creator = creators.get(session.creatorId);
    const account = creator?.accounts.find((candidate) => candidate.id === session.creatorAccountId);
    if (!creator || !account || account.platform !== session.platform) {
      throw new DomainStoreIntegrityError("Creator session account does not belong to its creator or platform");
    }
    if (session.productIds.some((productId) => products.get(productId)?.teamId !== session.teamId)) {
      throw new DomainStoreIntegrityError("Creator session references a product outside the organization");
    }
  }
}

function validateSalesReports(state: DomainState): void {
  const creators = new Map(state.creators.map((creator) => [creator.id, creator]));
  const products = new Map(state.products.map((product) => [product.id, product]));
  const stores = new Map(state.manualStores.map((store) => [store.id, store]));
  const members = new Set(state.members.map((member) => member.id));

  for (const report of state.salesReports) {
    const creator = creators.get(report.creatorId);
    const account = creator?.accounts.find((item) => item.id === report.creatorAccountId);
    if (!creator || !account || account.platform !== report.platform
        || account.externalAccountId !== report.externalAccountId) {
      throw new DomainStoreIntegrityError("Sales report account does not belong to its creator or platform");
    }

    const store = stores.get(report.storeId);
    if (!store || store.teamId !== report.teamId || store.platform !== report.platform
        || store.externalShopId !== report.shopId) {
      throw new DomainStoreIntegrityError("Sales report store does not belong to its brand or shop");
    }

    if (new Set(report.productIds).size !== report.productIds.length
        || report.productIds.some((productId) => products.get(productId)?.teamId !== report.teamId)) {
      throw new DomainStoreIntegrityError("Sales report references a product outside its brand");
    }

    const memberIds = [
      report.ownerMemberId,
      report.createdBy,
      report.updatedBy,
      report.reviewedBy,
      report.reconciledBy,
    ];
    if (memberIds.some((memberId) => memberId !== null && !members.has(memberId))) {
      throw new DomainStoreIntegrityError("Sales report owner or audit member is outside its brand");
    }
  }
}

function validateAppendOnlyCollection(
  current: Entity[],
  previous: Entity[],
  collection: Collection,
): void {
  const currentById = indexById(current, collection);
  for (const prior of previous) {
    const next = currentById.get(prior.id);
    if (!next || stableJson(next) !== stableJson(prior)) {
      throw new DomainStoreIntegrityError(`Collection ${collection} is append-only; existing rows cannot be changed`);
    }
  }
}

function validateAuditEvents(current: AuditEvent[], previous: AuditEvent[], orgId: string): void {
  const old = indexAuditEvents(previous);
  const ids = new Set<string>();
  for (const event of current) {
    if (!event || typeof event.id !== "string" || !event.id) {
      throw new DomainStoreIntegrityError("Audit event is missing its id");
    }
    if (ids.has(event.id)) throw new DomainStoreIntegrityError(`Duplicate audit event id ${event.id}`);
    ids.add(event.id);
    if (event.orgId !== orgId) throw new DomainStoreIntegrityError("Audit event belongs to another organization");
    const existing = old.get(event.id);
    if (existing && stableJson(existing) !== stableJson(event)) {
      throw new DomainStoreIntegrityError(`Audit event ${event.id} is immutable`);
    }
  }
  if (ids.size < old.size || [...old.keys()].some((id) => !ids.has(id))) {
    throw new DomainStoreIntegrityError("Audit history cannot be removed");
  }
}

function indexById(rows: Entity[], collection: Collection): Map<string, Entity> {
  const result = new Map<string, Entity>();
  for (const row of rows) {
    if (result.has(row.id)) throw new DomainStoreIntegrityError(`Collection ${collection} contains duplicate id ${row.id}`);
    result.set(row.id, row);
  }
  return result;
}

function indexAuditEvents(events: AuditEvent[]): Map<string, AuditEvent> {
  const result = new Map<string, AuditEvent>();
  for (const event of events) {
    if (result.has(event.id)) throw new DomainStoreIntegrityError(`Duplicate audit event id ${event.id}`);
    result.set(event.id, event);
  }
  return result;
}

function normalizeEntity(collection: Collection, entity: Entity): Entity {
  if (collection !== "members") return entity;
  const member = entity as unknown as Member;
  return { ...member, role: null, capabilities: null };
}

function validateCreatorAccountUniqueness(creators: DomainState["creators"]): void {
  const seen = new Map<string, string>();
  for (const creator of creators) {
    for (const account of creator.accounts) {
      const platform = storedPlatform(account.platform, "Creator account");
      const identity = `${platform}\u0000${account.externalAccountId.trim()}`;
      const existingCreatorId = seen.get(identity);
      if (existingCreatorId && existingCreatorId !== creator.id) {
        throw new DomainStoreIntegrityError("Creator platform account is already linked to another creator");
      }
      if (existingCreatorId === creator.id) {
        throw new DomainStoreIntegrityError("Creator contains a duplicate platform account");
      }
      seen.set(identity, creator.id);
    }
  }
}

function validateOrderRefundIdentityUniqueness(
  orders: DomainState["orders"],
  refunds: DomainState["refunds"],
): void {
  const orderIdentities = new Set<string>();
  for (const order of orders) {
    const platform = storedPlatform(order.platform, "Order");
    const identity = JSON.stringify([platform, order.shopId?.trim() ?? "", order.externalOrderId.trim(), order.externalLineId.trim()]);
    if (orderIdentities.has(identity)) {
      throw new DomainStoreIntegrityError("Duplicate order platform, shop and external order identity");
    }
    orderIdentities.add(identity);
  }

  const refundIdentities = new Set<string>();
  for (const refund of refunds) {
    const platform = storedPlatform(refund.platform, "Refund");
    const identity = JSON.stringify([platform, refund.shopId?.trim() ?? "", refund.externalRefundId.trim()]);
    if (refundIdentities.has(identity)) {
      throw new DomainStoreIntegrityError("Duplicate refund platform, shop and external refund identity");
    }
    refundIdentities.add(identity);
  }
}

function storedPlatform(value: unknown, entity: string): Platform {
  // Rows written before platform support are legacy Douyin data.
  if (value === undefined) return "douyin";
  if (typeof value !== "string" || !(PLATFORMS as readonly string[]).includes(value)) {
    throw new DomainStoreIntegrityError(`${entity} contains an unsupported platform`);
  }
  return value as Platform;
}

function parsePayload(value: unknown, collection: Collection | "auditEvents", id: string): Entity {
  const payload = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new DomainStoreIntegrityError(`Invalid JSON payload in ${collection} row ${id}`);
  }
  const entity = payload as Entity;
  if (entity.id !== id && collection !== "auditEvents") {
    throw new DomainStoreIntegrityError(`Payload id does not match ${collection} row ${id}`);
  }
  if (collection === "auditEvents" && entity.id !== id) {
    throw new DomainStoreIntegrityError(`Payload id does not match audit row ${id}`);
  }
  if (collection === "members") {
    entity.role = null;
    entity.capabilities = null;
  } else if (collection === "creators") {
    normalizeCreatorAccounts(entity, id);
  }
  return entity;
}

function normalizeCreatorAccounts(entity: Entity, creatorId: string): void {
  if (!Array.isArray(entity.accounts)) {
    throw new DomainStoreIntegrityError(`Creator ${creatorId} has invalid accounts`);
  }
  entity.accounts = entity.accounts.map((value, index) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new DomainStoreIntegrityError(`Creator ${creatorId} has an invalid account at index ${index}`);
    }
    const account = value as Record<string, unknown>;
    const commerceTypes = account.commerceTypes ?? [];
    if (!Array.isArray(commerceTypes)
        || commerceTypes.some((item) => !CREATOR_COMMERCE_TYPES.includes(item as (typeof CREATOR_COMMERCE_TYPES)[number]))
        || new Set(commerceTypes).size !== commerceTypes.length) {
      throw new DomainStoreIntegrityError(`Creator ${creatorId} has invalid commerce types`);
    }
    const accountVersion = account.accountVersion ?? 1;
    if (typeof accountVersion !== "number" || !Number.isInteger(accountVersion) || accountVersion < 1) {
      throw new DomainStoreIntegrityError(`Creator ${creatorId} has an invalid account version`);
    }
    return { ...account, commerceTypes, accountVersion };
  });
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value !== "object" || value === null) return value;
  const source = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(source).sort().map((key) => [key, sortKeys(source[key])]));
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) {
    throw new DomainStoreIntegrityError(`Database returned an invalid ${label}`);
  }
  return value;
}

function asInteger(value: unknown, label: string): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new DomainStoreIntegrityError(`Database returned an invalid ${label}`);
  }
  return number;
}

function platformUserProfileSql(): SQL {
  return sql`CASE
    WHEN COALESCE(NULLIF(current_setting('app.user_id', TRUE), ''), '') = '' THEN NULL
    ELSE concat('(', current_setting('app.user_id', TRUE), ')')::user_profile
  END`;
}
