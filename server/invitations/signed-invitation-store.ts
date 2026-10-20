import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { sql, type SQL } from 'drizzle-orm';
import { INVITATION_ROLES, type InvitationRole } from '../../shared/invitations.ts';
import { DomainError } from '../domain/errors.ts';
import type { DomainStoreDatabase } from '../storage/postgres-domain-store.ts';
import type {
  InvitationActor,
  InvitationStore,
  InvitationStoreOperation,
  StoredInvitation,
} from './contracts.ts';

const SCHEMA_NAME_RE = /^[a-z_][a-z0-9_]{0,62}$/u;
const PRINCIPAL_ID_RE = /^[1-9]\d{0,18}$/u;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TOKEN_HASH_RE = /^[a-f0-9]{64}$/u;
const MAX_RPC_BYTES = 1_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

interface QueryResult { rows: Record<string, unknown>[] }
export interface SignedInvitationDatabase {
  execute(query: SQL): Promise<QueryResult>;
}
export interface SignedInvitationStoreOptions {
  /** Fixed server configuration, never request input. */
  orgId: string;
  /** DATAPAAS_CONFIG.roleSchema, never request input. */
  schemaName: string;
  /** Server-only 32-byte random token as 64 lowercase hex characters. */
  storeToken: string;
  /** Server clock for issuedAt; callers cannot supply time. */
  clock?: () => Date;
}

const adaptedDatabases = new WeakSet<object>();

/** Production member-invitation persistence through the dedicated signed SQL RPC. */
export class SignedInvitationStore implements InvitationStore {
  private readonly database: SignedInvitationDatabase;
  private readonly orgId: string;
  private readonly schemaName: string;
  private readonly signingKey: Buffer;
  private readonly clock: () => Date;

  constructor(
    database: PostgresJsDatabase | SignedInvitationDatabase,
    options: SignedInvitationStoreOptions,
  ) {
    if (!options.orgId.trim()) throw new Error('DABO_ORG_ID must be configured before creating the production invitation store');
    if (!SCHEMA_NAME_RE.test(options.schemaName)) throw new Error('The configured database role schema is invalid');
    if (!/^[a-f0-9]{64}$/u.test(options.storeToken)) {
      throw new Error('DABO_WORKBOOK_STORE_TOKEN must be a 32-byte lowercase hex value');
    }
    this.database = isAdaptedDatabase(database) ? database : adaptPostgresDatabase(database as PostgresJsDatabase);
    this.orgId = options.orgId.trim();
    this.schemaName = options.schemaName;
    this.signingKey = createHash('sha256').update(Buffer.from(options.storeToken, 'hex')).digest();
    this.clock = options.clock ?? (() => new Date());
  }

  async call(
    actor: InvitationActor,
    operation: InvitationStoreOperation,
    params: Record<string, unknown>,
  ): Promise<StoredInvitation | StoredInvitation[]> {
    validateActor(actor);
    const now = this.clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('Signed invitation RPC clock is invalid');
    validateParams(operation, params, actor, now);
    const currentPrincipalId = await this.currentPrincipalId();
    if (currentPrincipalId !== actor.principalId) {
      throw new DomainError('FORBIDDEN', '操作者与当前登录身份不一致。');
    }
    const request = {
      v: 1,
      orgId: this.orgId,
      schemaName: this.schemaName,
      operation,
      principalId: actor.principalId,
      actor: {
        principalId: actor.principalId,
        displayName: actor.displayName,
        userType: actor.userType,
        roleIds: [...actor.roleIds].sort(),
        // The SQL independently derives manager status from app.role_ids and the stored role map.
        manager: actor.manager,
      },
      issuedAt: Math.floor(now.getTime() / 1000),
      nonce: randomBytes(16).toString('hex'),
      params,
    };
    const requestText = stableJson(request);
    if (Buffer.byteLength(requestText, 'utf8') > MAX_RPC_BYTES) {
      throw new DomainError('VALIDATION_ERROR', '成员邀请请求超出大小限制。');
    }
    const signature = createHmac('sha256', this.signingKey).update(requestText, 'utf8').digest('hex');
    let result: QueryResult;
    try {
      result = await this.database.execute(sql`
        SELECT ${sql.identifier(this.schemaName)}.member_invitation_rpc(
          ${requestText}, ${signature}
        ) AS rpc_result
      `);
    } catch {
      throw new Error('Signed member invitation database operation failed');
    }
    if (result.rows.length !== 1) throw new Error('Signed member invitation RPC returned no result');
    const response = parseJsonObject(result.rows[0]!.rpc_result);
    if (typeof response.error === 'string') throw rpcError(response.error);
    if (response.ok !== true) throw new Error('Signed member invitation RPC returned an invalid result');
    const data = response.data;
    if (operation === 'list') {
      if (!Array.isArray(data)) throw new Error('Signed member invitation RPC returned an invalid list');
      return data.map(parseInvitation);
    }
    if (!isRecord(data)) throw new Error('Signed member invitation RPC returned an invalid invitation');
    return parseInvitation(data);
  }

  private async currentPrincipalId(): Promise<string> {
    let result: QueryResult;
    try {
      result = await this.database.execute(sql`
        SELECT NULLIF(current_setting('app.user_id', TRUE), '') AS principal_id
      `);
    } catch {
      throw new Error('The Miaoda authenticated database context is unavailable');
    }
    if (result.rows.length !== 1 || typeof result.rows[0]!.principal_id !== 'string'
        || !PRINCIPAL_ID_RE.test(result.rows[0]!.principal_id)) {
      throw new DomainError('UNAUTHENTICATED', '当前登录身份无效。');
    }
    return result.rows[0]!.principal_id;
  }
}

export function createSignedInvitationStore(
  database: PostgresJsDatabase | SignedInvitationDatabase,
  options: SignedInvitationStoreOptions,
): InvitationStore {
  return new SignedInvitationStore(database, options);
}

/** Test-only adapter for PGlite and Drizzle-compatible query executors. */
export function adaptDrizzleSignedInvitationDatabase(database: {
  execute(query: never): PromiseLike<unknown>;
}): SignedInvitationDatabase {
  const adapted: SignedInvitationDatabase = {
    execute: async (query) => normalizeQueryResult(await database.execute(query as never)),
  };
  adaptedDatabases.add(adapted);
  return adapted;
}

function adaptPostgresDatabase(database: PostgresJsDatabase): SignedInvitationDatabase {
  return adaptDrizzleSignedInvitationDatabase(database as unknown as { execute(query: never): PromiseLike<unknown> });
}

function isAdaptedDatabase(value: unknown): value is SignedInvitationDatabase {
  return typeof value === 'object' && value !== null && adaptedDatabases.has(value);
}

function normalizeQueryResult(value: unknown): QueryResult {
  if (Array.isArray(value)) return { rows: value as Record<string, unknown>[] };
  if (typeof value === 'object' && value !== null && 'rows' in value && Array.isArray((value as { rows: unknown }).rows)) {
    return { rows: (value as { rows: Record<string, unknown>[] }).rows };
  }
  if (typeof value === 'object' && value !== null && 'data' in value && Array.isArray((value as { data: unknown }).data)) {
    return { rows: (value as { data: Record<string, unknown>[] }).data };
  }
  throw new Error('Signed member invitation database returned an invalid query result');
}

function validateActor(actor: InvitationActor): void {
  if (!isRecord(actor) || !PRINCIPAL_ID_RE.test(actor.principalId)
      || typeof actor.displayName !== 'string' || !actor.displayName.trim() || actor.displayName.trim().length > 255
      || (actor.userType !== 'internal' && actor.userType !== 'external')
      || !Array.isArray(actor.roleIds)
      || actor.roleIds.some((roleId) => typeof roleId !== 'string' || !roleId.trim() || roleId.length > 255)
      || typeof actor.manager !== 'boolean') {
    throw new DomainError('UNAUTHENTICATED', '当前登录身份无效。');
  }
}

function validateParams(
  operation: InvitationStoreOperation,
  params: Record<string, unknown>,
  actor: InvitationActor,
  now: Date,
): void {
  if (!isRecord(params)) throw new DomainError('VALIDATION_ERROR', '成员邀请参数无效。');
  switch (operation) {
    case 'list':
      requireKeys(params, []);
      requireManager(actor);
      return;
    case 'get':
      requireKeys(params, ['id']);
      requireManager(actor);
      requireUuid(params.id);
      return;
    case 'create':
      requireKeys(params, ['invitation']);
      requireManager(actor);
      validateCreateInvitation(params.invitation, actor, now);
      return;
    case 'inspect':
    case 'claim':
      requireKeys(params, ['tokenHash']);
      requireTokenHash(params.tokenHash);
      return;
    case 'revoke':
      requireKeys(params, ['id', 'expectedVersion']);
      requireManager(actor);
      requireUuid(params.id);
      requireVersion(params.expectedVersion);
      return;
    case 'reserve':
      requireKeys(params, ['id', 'expectedVersion', 'attemptId']);
      requireManager(actor);
      requireUuid(params.id);
      requireVersion(params.expectedVersion);
      requireUuid(params.attemptId);
      return;
    case 'complete':
      requireKeys(params, ['id', 'attemptId']);
      requireManager(actor);
      requireUuid(params.id);
      requireUuid(params.attemptId);
      return;
    case 'fail':
      requireKeys(params, ['id', 'attemptId', 'issueCode', 'roleGranted']);
      requireManager(actor);
      requireUuid(params.id);
      requireUuid(params.attemptId);
      if (params.issueCode !== 'platform_grant_unverified' && params.issueCode !== 'brand_binding_failed') {
        throw new DomainError('VALIDATION_ERROR', '失败原因无效。');
      }
      if (typeof params.roleGranted !== 'boolean') throw new DomainError('VALIDATION_ERROR', '岗位授予状态无效。');
      return;
    default:
      throw new DomainError('VALIDATION_ERROR', '成员邀请操作无效。');
  }
}

function validateCreateInvitation(value: unknown, actor: InvitationActor, now: Date): void {
  if (!isRecord(value)) throw new DomainError('VALIDATION_ERROR', '邀请数据无效。');
  requireKeys(value, [
    'id', 'recipientName', 'role', 'roleId', 'brands', 'tokenHash', 'status', 'createdBy', 'createdAt', 'expiresAt',
    'claimant', 'approval', 'completedAt', 'revokedAt', 'roleGranted', 'issueCode', 'version',
  ]);
  requireUuid(value.id);
  requireText(value.recipientName, 255, '邀请对象姓名无效。');
  if (typeof value.role !== 'string' || !INVITATION_ROLES.includes(value.role as InvitationRole)) {
    throw new DomainError('VALIDATION_ERROR', '邀请岗位无效。');
  }
  requireText(value.roleId, 255, '平台岗位编号无效。');
  requireTokenHash(value.tokenHash);
  if (value.status !== 'pending' || value.createdBy !== actor.principalId || value.claimant !== null
      || value.approval !== null || value.completedAt !== null || value.revokedAt !== null
      || value.roleGranted !== false || value.issueCode !== null || value.version !== 1) {
    throw new DomainError('VALIDATION_ERROR', '新邀请初始状态无效。');
  }
  const createdAt = requireIso(value.createdAt);
  const expiresAt = requireIso(value.expiresAt);
  const lifetime = Date.parse(expiresAt) - Date.parse(createdAt);
  if (![DAY_MS, 3 * DAY_MS, 7 * DAY_MS].includes(lifetime) || Date.parse(expiresAt) <= now.getTime()) {
    throw new DomainError('VALIDATION_ERROR', '邀请有效期无效。');
  }
  if (!Array.isArray(value.brands) || value.brands.length < 1 || value.brands.length > 50) {
    throw new DomainError('VALIDATION_ERROR', '邀请品牌范围无效。');
  }
  const brandIds = new Set<string>();
  for (const binding of value.brands) {
    if (!isRecord(binding)) throw new DomainError('VALIDATION_ERROR', '邀请品牌范围无效。');
    requireKeys(binding, ['brandId', 'brandName', 'businessOwnerName']);
    const brandId = requireUuid(binding.brandId);
    if (brandIds.has(brandId)) throw new DomainError('VALIDATION_ERROR', '邀请品牌不能重复。');
    brandIds.add(brandId);
    requireText(binding.brandName, 100, '邀请品牌名称无效。');
    if (binding.businessOwnerName !== null) requireText(binding.businessOwnerName, 255, '商务名称无效。');
    if (value.role === 'bd' ? binding.businessOwnerName === null : binding.businessOwnerName !== null) {
      throw new DomainError('VALIDATION_ERROR', '商务名称与邀请岗位不匹配。');
    }
  }
}

function parseInvitation(value: unknown): StoredInvitation {
  if (!isRecord(value)) throw new Error('Signed member invitation RPC returned malformed data');
  const mapped = {
    id: value.id,
    recipientName: value.recipient_name,
    role: value.role,
    roleId: value.role_id,
    brands: value.brands,
    tokenHash: value.token_hash,
    status: value.status,
    createdBy: value.created_by,
    createdAt: value.created_at,
    expiresAt: value.expires_at,
    claimant: value.claimant,
    approval: value.approval,
    completedAt: value.completed_at,
    revokedAt: value.revoked_at,
    roleGranted: value.role_granted,
    issueCode: value.issue_code,
    version: typeof value.version === 'number' ? value.version : Number(value.version),
  };
  if (typeof mapped.tokenHash !== 'string' || !TOKEN_HASH_RE.test(mapped.tokenHash)) {
    throw new Error('Signed member invitation RPC returned malformed data');
  }
  if (typeof mapped.id !== 'string' || !UUID_RE.test(mapped.id)
      || typeof mapped.recipientName !== 'string'
      || typeof mapped.role !== 'string' || !INVITATION_ROLES.includes(mapped.role as InvitationRole)
      || typeof mapped.roleId !== 'string' || !Array.isArray(mapped.brands)
      || typeof mapped.createdBy !== 'string' || (typeof mapped.createdAt !== 'string' && !(mapped.createdAt instanceof Date))
      || (typeof mapped.expiresAt !== 'string' && !(mapped.expiresAt instanceof Date))
      || typeof mapped.status !== 'string' || typeof mapped.version !== 'number' || typeof mapped.roleGranted !== 'boolean') {
    throw new Error('Signed member invitation RPC returned malformed data');
  }
  return {
    ...mapped,
    createdAt: normalizeTime(mapped.createdAt),
    expiresAt: normalizeTime(mapped.expiresAt),
    claimant: parseJsonValue(mapped.claimant) as StoredInvitation['claimant'],
    approval: parseJsonValue(mapped.approval) as StoredInvitation['approval'],
    completedAt: mapped.completedAt === null ? null : normalizeTime(mapped.completedAt),
    revokedAt: mapped.revokedAt === null ? null : normalizeTime(mapped.revokedAt),
    brands: mapped.brands.map((brand) => {
      if (!isRecord(brand) || typeof brand.brandId !== 'string' || typeof brand.brandName !== 'string'
          || (brand.businessOwnerName !== null && typeof brand.businessOwnerName !== 'string')) {
        throw new Error('Signed member invitation RPC returned malformed data');
      }
      return {
        brandId: brand.brandId,
        brandName: brand.brandName,
        businessOwnerName: brand.businessOwnerName,
      };
    }),
  } as StoredInvitation;
}

function requireManager(actor: InvitationActor): void {
  if (actor.manager !== true) throw new DomainError('FORBIDDEN', '只有全局管理员可以管理成员邀请。');
}

function requireKeys(value: Record<string, unknown>, expected: string[]): void {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (keys.length !== sortedExpected.length || keys.some((key, index) => key !== sortedExpected[index])) {
    throw new DomainError('VALIDATION_ERROR', '成员邀请参数包含缺失或不支持的字段。');
  }
}

function requireUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw new DomainError('VALIDATION_ERROR', '邀请编号无效。');
  return value.toLowerCase();
}

function requireTokenHash(value: unknown): void {
  if (typeof value !== 'string' || !TOKEN_HASH_RE.test(value)) throw new DomainError('VALIDATION_ERROR', '邀请凭证无效。');
}

function requireVersion(value: unknown): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new DomainError('VALIDATION_ERROR', '邀请版本号无效。');
}

function requireText(value: unknown, maxLength: number, message: string): void {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
    throw new DomainError('VALIDATION_ERROR', message);
  }
}

function requireIso(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value)
      || !Number.isFinite(Date.parse(value))) throw new DomainError('VALIDATION_ERROR', '邀请时间无效。');
  return new Date(value).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (isRecord(parsed)) return parsed;
    } catch { /* The database result is intentionally reduced to a generic error. */ }
  }
  if (isRecord(value)) return value;
  throw new Error('Signed member invitation RPC returned malformed data');
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value) as unknown; } catch { throw new Error('Signed member invitation RPC returned malformed data'); }
}

function normalizeTime(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error('Signed member invitation RPC returned malformed data');
  return date.toISOString();
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
}

function rpcError(code: string): DomainError {
  switch (code) {
    case 'UNAUTHENTICATED': return new DomainError('UNAUTHENTICATED', '当前登录身份无效。');
    case 'FORBIDDEN': return new DomainError('FORBIDDEN', '当前账号无权执行该邀请操作。');
    case 'NOT_FOUND': return new DomainError('NOT_FOUND', '邀请不存在或已失效。');
    case 'VERSION_CONFLICT': return new DomainError('VERSION_CONFLICT', '邀请状态已变化，请刷新后重试。');
    case 'IDENTITY_CONFLICT': return new DomainError('IDENTITY_CONFLICT', '该账号或品牌绑定需要管理员人工核对。');
    case 'INVALID_TRANSITION': return new DomainError('INVALID_TRANSITION', '邀请当前不可执行此操作。');
    case 'BUSINESS_RULE_VIOLATION': return new DomainError('BUSINESS_RULE_VIOLATION', '邀请不符合当前品牌成员边界。');
    case 'VALIDATION_ERROR': return new DomainError('VALIDATION_ERROR', '成员邀请数据无效。');
    case 'REPLAYED_REQUEST': return new DomainError('UNAUTHENTICATED', '请求已失效，请重试。');
    default: return new DomainError('BUSINESS_RULE_VIOLATION', '成员邀请存储拒绝了该操作。');
  }
}
