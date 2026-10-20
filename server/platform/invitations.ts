import { SignedInvitationStore } from '../invitations/signed-invitation-store.ts';
import { PlatformInvitationRoles } from '../invitations/platform-invitation-roles.ts';
import { MemberInvitationsService } from '../modules/member-invitations/member-invitations.service.ts';
import { loadWorkbookModuleConfig } from '../modules/workbook/config.ts';
import type { WorkbookWorkspaceRegistry } from '../workbook/storage.ts';

/**
 * Original MemberInvitationsModule composition, explicitly injected and opt-in.
 * Never imported by the demo. No fabricated SDK, database or identity is supplied.
 */
export function createPlatformMemberInvitations(
  adapters: {
    registry: WorkbookWorkspaceRegistry;
    database: ConstructorParameters<typeof SignedInvitationStore>[0];
    /** Trusted platform database role schema; never obtained from a request. */
    roleSchema: string;
    sdk: ConstructorParameters<typeof PlatformInvitationRoles>[0];
  },
  env: NodeJS.ProcessEnv = process.env,
) {
  const config = loadWorkbookModuleConfig(env);
  if (!adapters.roleSchema) throw new Error('平台数据服务未配置运行时 role schema。');
  const store = new SignedInvitationStore(adapters.database, {
    orgId: config.orgId,
    schemaName: adapters.roleSchema,
    storeToken: config.storeToken,
  });
  const roles = new PlatformInvitationRoles(
    adapters.sdk,
    Object.values(config.roleMapping).flat(),
    config.roleMapping.manager,
    env.DABO_MEMBER_INVITATIONS_SCOPE_REVIEWED === '1',
  );
  return new MemberInvitationsService(adapters.registry, config, store, roles, {
    storage: 'cloud',
    enabled: env.DABO_MEMBER_INVITATIONS_ENABLED === '1',
  });
}
