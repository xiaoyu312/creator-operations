import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  INVITATION_ROLES,
  type CreatedInvitation, type InvitationDirectory, type InvitationJoinContext,
  type InvitationJoinView, type InvitationRole, type MemberInvitation,
} from '../../../shared/invitations.ts';
import { isUnavailableDemoBrand } from '../../../shared/scenario-brand.ts';
import { DomainError } from '../../domain/errors.ts';
import type { InvitationActor, InvitationRoleGateway, InvitationStore, StoredInvitation } from '../../invitations/contracts.ts';
import type { WorkbookWorkspaceRegistry } from '../../workbook/storage.ts';
import { WorkbookIdentityService, type WorkbookModuleConfig, type WorkbookPlatformContext } from '../workbook/identity.ts';

export interface InvitationPlatformContext extends WorkbookPlatformContext { userType?: string }
export interface MemberInvitationsOptions {
  storage: 'local' | 'cloud';
  /** Explicit deployment gate. No application request may change it. */
  enabled: boolean;
  clock?: () => number;
}

const brandBindingSchema = z.object({
  brandId: z.string().uuid(), businessOwnerName: z.string().trim().min(1).max(200).nullable(),
}).strict();
const createSchema = z.object({
  recipientName: z.string().trim().min(1).max(100),
  role: z.enum(INVITATION_ROLES),
  brands: z.array(brandBindingSchema).min(1).max(20),
  expiresInDays: z.union([z.literal(1), z.literal(3), z.literal(7)]),
}).strict();
const tokenSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/u) }).strict();
const versionSchema = z.object({ expectedVersion: z.number().int().min(1) }).strict();
const approveSchema = versionSchema.extend({ confirmIdentity: z.literal(true) }).strict();
const disabledMessage = '邀请功能尚未启用，请管理员完成发布前的访问范围与岗位权限检查。';
const broadRoleMessage = '存在企业全员或互联网公开岗位授权，暂不能开通邀请。请管理员先核对应用分享中的默认角色。';

/** An invitation is a workflow record, never a substitute for platform authentication or roles. */
export class MemberInvitationsService {
  private readonly now: () => number;
  constructor(
    private readonly registry: WorkbookWorkspaceRegistry,
    private readonly config: WorkbookModuleConfig,
    private readonly store: InvitationStore,
    private readonly roles: InvitationRoleGateway,
    private readonly options: MemberInvitationsOptions,
  ) { this.now = options.clock ?? Date.now; }

  joinContext(context: InvitationPlatformContext | undefined): InvitationJoinContext {
    const actor = this.actor(context);
    return { displayName: actor.displayName, userType: actor.userType, localPreview: this.options.storage === 'local' };
  }

  async list(context: InvitationPlatformContext | undefined): Promise<InvitationDirectory> {
    const actor = this.manager(context);
    const readiness = await this.readiness(actor);
    if (!this.options.enabled) return { invitations: [], availableRoles: [], readiness };
    const records = await this.store.call(actor, 'list', {});
    if (!Array.isArray(records)) throw new Error('Invalid invitation directory');
    return {
      invitations: records.map((record) => this.toDto(record)),
      availableRoles: this.configuredRoles(), readiness,
    };
  }

  async create(context: InvitationPlatformContext | undefined, input: unknown): Promise<CreatedInvitation> {
    const actor = this.manager(context);
    await this.requireReady(actor);
    const parsed = createSchema.parse(input);
    if (new Set(parsed.brands.map((brand) => brand.brandId)).size !== parsed.brands.length) {
      throw new DomainError('VALIDATION_ERROR', '不能重复选择同一个品牌。');
    }
    if (!this.configuredRoles().includes(parsed.role)) throw new DomainError('VALIDATION_ERROR', '该岗位尚未配置，不能创建邀请。');
    for (const binding of parsed.brands) {
      if (parsed.role === 'bd' && !binding.businessOwnerName) throw new DomainError('VALIDATION_ERROR', '商务邀请需要填写每个品牌的商务名称。');
      if (parsed.role !== 'bd' && binding.businessOwnerName !== null) throw new DomainError('VALIDATION_ERROR', '非商务岗位无需绑定商务名称。');
    }
    const availableBrands = await this.registry.listBrands();
    const brands = parsed.brands.map((binding) => {
      const brand = availableBrands.find((item) => item.id === binding.brandId);
      if (!brand || !brand.active || isUnavailableDemoBrand(brand)) throw new DomainError('FORBIDDEN', '所选品牌不可用，请刷新后重新选择。');
      return { ...binding, brandName: brand.name };
    });
    const token = randomBytes(32).toString('base64url');
    const now = this.now();
    const record: StoredInvitation = {
      id: randomUUID(), recipientName: parsed.recipientName, role: parsed.role,
      roleId: this.roleId(parsed.role), brands, tokenHash: hashToken(token),
      status: 'pending', createdBy: actor.principalId, createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + parsed.expiresInDays * 86_400_000).toISOString(),
      claimant: null, approval: null, completedAt: null, revokedAt: null,
      roleGranted: false, issueCode: null, version: 1,
    };
    const saved = this.record(await this.store.call(actor, 'create', { invitation: record }));
    return { invitation: this.toDto(saved), invitationPath: `/join#invite=${token}` };
  }

  async inspect(context: InvitationPlatformContext | undefined, input: unknown): Promise<InvitationJoinView> {
    this.requireEnabled();
    const actor = this.actor(context);
    const { token } = tokenSchema.parse(input);
    const record = this.record(await this.store.call(actor, 'inspect', { tokenHash: hashToken(token) }));
    return this.toJoinView(record, actor, context!);
  }

  async claim(context: InvitationPlatformContext | undefined, input: unknown): Promise<InvitationJoinView> {
    this.requireEnabled();
    const actor = this.actor(context);
    const { token } = tokenSchema.parse(input);
    const tokenHash = hashToken(token);
    const prior = this.record(await this.store.call(actor, 'inspect', { tokenHash }));
    this.assertClaimantRole(actor, prior);
    const record = this.record(await this.store.call(actor, 'claim', { tokenHash }));
    return this.toJoinView(record, actor, context!);
  }

  async revoke(context: InvitationPlatformContext | undefined, id: unknown, input: unknown): Promise<MemberInvitation> {
    this.requireEnabled();
    const actor = this.manager(context);
    const checkedId = z.string().uuid().parse(id);
    const { expectedVersion } = versionSchema.parse(input);
    return this.toDto(this.record(await this.store.call(actor, 'revoke', { id: checkedId, expectedVersion })));
  }

  async approve(context: InvitationPlatformContext | undefined, id: unknown, input: unknown): Promise<MemberInvitation> {
    const actor = this.manager(context);
    await this.requireReady(actor);
    const checkedId = z.string().uuid().parse(id);
    const { expectedVersion } = approveSchema.parse(input);
    const before = this.record(await this.store.call(actor, 'get', { id: checkedId }));
    if (!before.claimant) throw new DomainError('BUSINESS_RULE_VIOLATION', '同事尚未领取邀请。');
    if (before.roleId !== this.roleId(before.role)) throw new DomainError('BUSINESS_RULE_VIOLATION', '岗位配置已变化，请撤销并重新创建邀请。');
    this.assertClaimantRole(before.claimant, before);
    const attemptId = randomUUID();
    const reserved = this.record(await this.store.call(actor, 'reserve', { id: checkedId, expectedVersion, attemptId }));
    if (!reserved.claimant) throw new Error('Invitation reservation has no claimant');
    let roleGranted = reserved.roleGranted;
    try {
      // The actor is the administrator SDK context. Never impersonate the target user.
      await this.roles.grantAndVerify(reserved.roleId, reserved.claimant.principalId);
      roleGranted = true;
      return this.toDto(this.record(await this.store.call(actor, 'complete', { id: checkedId, attemptId })));
    } catch {
      // A failed readback does not prove that the platform write was rolled back.
      // Persist a retryable outcome; never remove a user's potentially pre-existing role.
      try {
        return this.toDto(this.record(await this.store.call(actor, 'fail', {
          id: checkedId, attemptId, roleGranted,
          issueCode: roleGranted ? 'brand_binding_failed' : 'platform_grant_unverified',
        })));
      } catch {
        throw new DomainError('BUSINESS_RULE_VIOLATION', '开通尚未完成，请刷新邀请状态后重试。不要重新给此账号添加其他岗位。');
      }
    }
  }

  /** Ends an abandoned reservation without making any new platform grant. */
  async recover(context: InvitationPlatformContext | undefined, id: unknown, input: unknown): Promise<MemberInvitation> {
    this.requireEnabled();
    const actor = this.manager(context);
    const checkedId = z.string().uuid().parse(id);
    const { expectedVersion } = versionSchema.parse(input);
    const record = this.record(await this.store.call(actor, 'get', { id: checkedId }));
    if (record.version !== expectedVersion) throw new DomainError('VERSION_CONFLICT', '邀请状态已变化，请刷新后重试。');
    if (record.status !== 'provisioning' || !record.approval
      || this.now() - Date.parse(record.approval.startedAt) < 120_000) {
      throw new DomainError('BUSINESS_RULE_VIOLATION', '开通仍在处理中，请稍后刷新；不能结束正在执行的请求。');
    }
    return this.toDto(this.record(await this.store.call(actor, 'fail', {
      id: checkedId, attemptId: record.approval.attemptId, roleGranted: record.roleGranted,
      issueCode: record.roleGranted ? 'brand_binding_failed' : 'platform_grant_unverified',
    })));
  }

  private actor(context: InvitationPlatformContext | undefined): InvitationActor {
    const id = context?.userId;
    if (!context || typeof id !== 'string' || !/^[1-9][0-9]{0,18}$/u.test(id)
      || BigInt(id) > 9223372036854775807n || context.appId !== this.config.expectedAppId
      || context.isSystemAccount === true || !['_employee', '_externalUser'].includes(context.userType ?? '')) {
      throw new DomainError('UNAUTHENTICATED', '请使用自己的飞书账号登录后打开邀请。');
    }
    if (!Array.isArray(context.roles) || context.roles.some((role) => typeof role !== 'string' || !role.trim())) {
      throw new DomainError('FORBIDDEN', '当前账号的岗位信息不完整，请重新登录后重试。');
    }
    const plainName = typeof context.userName === 'string' ? context.userName.trim() : '';
    const localizedName = typeof context.userNameI18n?.zh_cn === 'string' ? context.userNameI18n.zh_cn.trim() : '';
    const displayName = (plainName || localizedName).slice(0, 200);
    if (!displayName) throw new DomainError('UNAUTHENTICATED', '无法核对当前登录账号，请重新登录。');
    return {
      principalId: id, displayName,
      userType: context.userType === '_externalUser' ? 'external' : 'internal',
      roleIds: [...context.roles], manager: this.config.roleMapping.manager.some((role) => context.roles!.includes(role)),
    };
  }

  private manager(context: InvitationPlatformContext | undefined): InvitationActor {
    const actor = this.actor(context);
    if (!actor.manager) throw new DomainError('FORBIDDEN', '只有系统管理员可以管理成员邀请。');
    return actor;
  }

  private requireEnabled(): void {
    if (!this.options.enabled) throw new DomainError('BUSINESS_RULE_VIOLATION', disabledMessage);
  }

  private async readiness(actor: InvitationActor) {
    const base = { canCreate: false, canApprove: false, localPreview: this.options.storage === 'local' };
    if (!this.options.enabled) return { ...base, message: disabledMessage };
    try {
      const directory = await this.roles.directory(actor);
      const mappedIds = [...this.config.roleMapping.manager, ...this.configuredRoles().map((role) => this.roleId(role))];
      if (mappedIds.some((id) => !directory.roleIds.includes(id))) {
        return { ...base, message: '岗位配置与平台角色不一致，请管理员核对后重试。' };
      }
      if (directory.unsafeBroadRoles) return { ...base, message: broadRoleMessage };
      return { canCreate: true, canApprove: true, message: null, localPreview: base.localPreview };
    } catch {
      return { ...base, message: '暂时无法核验平台岗位范围，邀请开通已暂停。请稍后刷新或联系管理员。' };
    }
  }

  private async requireReady(actor: InvitationActor): Promise<void> {
    const readiness = await this.readiness(actor);
    if (!readiness.canApprove) throw new DomainError('BUSINESS_RULE_VIOLATION', readiness.message!);
  }

  private configuredRoles(): InvitationRole[] {
    return INVITATION_ROLES.filter((role) => this.config.roleMapping[role]?.length === 1);
  }

  private roleId(role: InvitationRole): string {
    const ids = this.config.roleMapping[role];
    if (!ids || ids.length !== 1 || !ids[0]?.trim()) throw new DomainError('BUSINESS_RULE_VIOLATION', '该岗位未完成唯一角色配置。');
    return ids[0];
  }

  private assertClaimantRole(actor: InvitationActor, invitation: StoredInvitation): void {
    if (actor.manager) throw new DomainError('BUSINESS_RULE_VIOLATION', '此账号已有全局管理权限，不能通过普通岗位邀请调整权限。');
    const mapped = INVITATION_ROLES.filter((role) => (this.config.roleMapping[role] ?? []).some((id) => actor.roleIds.includes(id)));
    if (mapped.some((role) => role !== invitation.role) || mapped.length > 1) {
      throw new DomainError('BUSINESS_RULE_VIOLATION', '此账号已有其他岗位，请管理员先核对现有权限，不要重复添加岗位。');
    }
  }

  private toDto(record: StoredInvitation): MemberInvitation {
    const terminal = record.status === 'completed' || record.status === 'revoked';
    const expired = !terminal && Date.parse(record.expiresAt) <= this.now();
    const abandoned = record.status === 'provisioning' && !!record.approval
      && this.now() - Date.parse(record.approval.startedAt) >= 120_000;
    return {
      id: record.id, recipientName: record.recipientName, role: record.role,
      brands: record.brands.map((brand) => ({ ...brand })),
      status: expired ? 'expired' : record.status,
      createdAt: record.createdAt, expiresAt: record.expiresAt,
      claimant: record.claimant ? {
        principalId: record.claimant.principalId, displayName: record.claimant.displayName,
        userType: record.claimant.userType, claimedAt: record.claimant.claimedAt,
      } : null,
      completedAt: record.completedAt, revokedAt: record.revokedAt, roleGranted: record.roleGranted,
      issue: record.issueCode === 'brand_binding_failed'
        ? '平台岗位已核验，品牌绑定尚未完成。请检查品牌状态后重试。'
        : record.issueCode === 'platform_grant_unverified'
          ? '平台岗位配置或回读尚未完成。请重试核验，不要重复添加其他岗位。' : null,
      version: record.version,
      actions: {
        approve: !expired && (record.status === 'claimed' || record.status === 'provision_failed' || abandoned),
        revoke: !terminal && record.status !== 'provisioning',
        recover: abandoned,
      },
    };
  }

  private async toJoinView(record: StoredInvitation, actor: InvitationActor, context: InvitationPlatformContext): Promise<InvitationJoinView> {
    const dto = this.toDto(record);
    const claimedByYou = record.claimant?.principalId === actor.principalId;
    let canEnter = false;
    let message: string | null = null;
    if (dto.status === 'completed' && claimedByYou) {
      try {
        this.assertClaimantRole(actor, record);
        if (!actor.roleIds.includes(record.roleId)) throw new Error('Role not yet present');
        await new WorkbookIdentityService(this.registry, this.config).authorize(context, record.brands[0]!.brandId);
        canEnter = true;
      } catch { message = '岗位或品牌权限尚未生效，请刷新登录状态；如仍无法进入，请联系管理员核对。'; }
      if (this.options.storage === 'local') {
        canEnter = false;
        message = '本机模拟开通已完成。真实飞书账号的登录与工作区访问需发布后另行验证。';
      }
    }
    return {
      invitation: {
        recipientName: dto.recipientName, role: dto.role, brands: dto.brands,
        status: dto.status, expiresAt: dto.expiresAt, completedAt: dto.completedAt,
      },
      displayName: actor.displayName, claimedByYou,
      canClaim: dto.status === 'pending' && !actor.manager, canEnter, message,
      localPreview: this.options.storage === 'local',
    };
  }

  private record(result: StoredInvitation | StoredInvitation[]): StoredInvitation {
    if (Array.isArray(result)) throw new Error('Invalid invitation response');
    return result;
  }
}

function hashToken(token: string): string { return createHash('sha256').update(token).digest('hex'); }
