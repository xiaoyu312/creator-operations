import type { AuthorizationSDK } from '@lark-apaas/fullstack-nestjs-core';
import type { InvitationActor, InvitationRoleDirectory, InvitationRoleGateway } from './contracts.ts';
import { DomainError } from '../domain/errors.ts';

interface RoleSdk {
  roles: Pick<AuthorizationSDK['roles'], 'list'>;
  members: Pick<AuthorizationSDK['members'], 'add' | 'list'>;
}

/** Platform-managed roles remain the only authority; this adapter never stores grants locally. */
export class PlatformInvitationRoles implements InvitationRoleGateway {
  private readonly managedRoleIds: Set<string>;
  constructor(private readonly sdk: RoleSdk, roleIds: readonly string[],
    private readonly globalManagerRoleIds: readonly string[], private readonly scopeReviewApproved = false) {
    this.managedRoleIds = new Set(roleIds);
  }

  async directory(actor: InvitationActor): Promise<InvitationRoleDirectory> {
    if (!actor.manager) throw new DomainError('FORBIDDEN', '只有管理员可以核验岗位范围。');
    if (!this.scopeReviewApproved) throw new Error('The application role scopes have not been independently reviewed');
    const roles = await this.sdk.roles.list({ needMember: true });
    if (!Array.isArray(roles) || roles.length === 0) throw new Error('Role directory unavailable');
    const relevant = roles.filter((role) => typeof role.bizID === 'string' && this.managedRoleIds.has(role.bizID));
    // The SDK normalizes absent flags to false. The independent deployment review
    // above supplies the scope assurance; these fields only catch known broad or
    // visibly incomplete results, and never prove every default permission is safe.
    if (relevant.length !== this.managedRoleIds.size || relevant.some((role) =>
      !role.roleMembers || !['custom', 'all'].includes(role.memberScope ?? ''))) {
      throw new Error('Role scopes are incomplete');
    }
    return {
      roleIds: relevant.map((role) => role.bizID!),
      unsafeBroadRoles: relevant.some((role) => role.memberScope === 'all'
        || role.roleMembers?.allEmployees === true || role.roleMembers?.public === true),
    };
  }

  async grantAndVerify(roleId: string, principalId: string): Promise<void> {
    if (!this.scopeReviewApproved) throw new Error('The application role scopes have not been independently reviewed');
    if (!this.managedRoleIds.has(roleId) || this.globalManagerRoleIds.includes(roleId)
      || !/^[1-9][0-9]{0,18}$/u.test(principalId)
      || BigInt(principalId) > 9223372036854775807n) throw new Error('Invalid invitation role target');
    // A prior timed-out request may already have added the role. Read before
    // retrying so an API that rejects duplicate members cannot strand the invite.
    if (await this.hasDirectMembership(roleId, principalId)) return;
    // The outer SDK userID means the requesting administrator. Omit it so the
    // platform obtains that identity from the real request; never impersonate the invitee.
    try { await this.sdk.members.add(roleId, { members: { userList: [{ userID: principalId }] } }); }
    catch {
      if (await this.hasDirectMembership(roleId, principalId)) return;
      throw new Error('Platform role grant has not been verified');
    }
    if (await this.hasDirectMembership(roleId, principalId)) return;
    throw new Error('Role membership has not been verified');
  }

  private async hasDirectMembership(roleId: string, principalId: string): Promise<boolean> {
    for (let page = 1; page <= 20; page += 1) {
      const result = await this.sdk.members.list(roleId, { type: 'User', page, pageSize: 100 });
      if (!result || !result.members || typeof result.hasMore !== 'boolean') throw new Error('Role membership readback incomplete');
      if (result.members.userList?.some((user) => user.userID === principalId)) return true;
      if (!result.hasMore) return false;
    }
    throw new Error('Role membership readback exceeded the supported page limit');
  }
}
