import assert from 'node:assert/strict';
import test from 'node:test';
import type { AuthorizationSDK } from '@lark-apaas/fullstack-nestjs-core';
import { PlatformInvitationRoles } from '../invitations/platform-invitation-roles.ts';
import type { InvitationActor } from '../invitations/contracts.ts';

const manager: InvitationActor = {
  principalId: '101', displayName: '管理员', userType: 'internal', manager: true, roleIds: ['manager'],
};
type RoleDirectory = Awaited<ReturnType<AuthorizationSDK['roles']['list']>>;

test('platform invitation role grants use only the trusted target, and verify pages after the write', async () => {
  const calls: Array<{ action: string; roleId: string; params: unknown }> = [];
  let added = false;
  const sdk = {
    roles: { list: async () => [] },
    members: {
      add: async (roleId: string, params: Parameters<AuthorizationSDK['members']['add']>[1]) => {
        calls.push({ action: 'add', roleId, params });
        added = true;
      },
      list: async (roleId: string, params?: Parameters<AuthorizationSDK['members']['list']>[1]) => {
        calls.push({ action: 'list', roleId, params });
        if (!added) return { members: { userList: [] }, total: 0, hasMore: false };
        return params?.page === 1
          ? { members: { userList: [{ userID: '999' }] }, total: 2, hasMore: true }
          : { members: { userList: [{ userID: '201' }] }, total: 2, hasMore: false };
      },
    },
  };
  const gateway = new PlatformInvitationRoles(sdk, ['manager', 'shipping'], ['manager'], true);
  await gateway.grantAndVerify('shipping', '201');
  assert.deepEqual(calls.map((call) => call.action), ['list', 'add', 'list', 'list']);
  assert.deepEqual(calls[1]?.params, { members: { userList: [{ userID: '201' }] } });
  for (const call of calls) assert.equal(Object.hasOwn(call.params as object, 'userID'), false);
  await assert.rejects(gateway.grantAndVerify('manager', '201'));
  await assert.rejects(gateway.grantAndVerify('shipping', '9223372036854775808'));
});

test('retry reuses a previously verified direct member without a duplicate platform write', async () => {
  let writes = 0;
  const gateway = new PlatformInvitationRoles({
    roles: { list: async () => [] },
    members: {
      add: async () => { writes += 1; throw new Error('Duplicate members are rejected'); },
      list: async () => ({ members: { userList: [{ userID: '201' }] }, total: 1, hasMore: false }),
    },
  }, ['manager', 'shipping'], ['manager'], true);
  await gateway.grantAndVerify('shipping', '201');
  assert.equal(writes, 0);
});

test('a resolved platform add response never substitutes for actual membership readback', async () => {
  const gateway = new PlatformInvitationRoles({
    roles: { list: async () => [] },
    members: {
      add: async () => ({ arbitrary: 'not a verification contract' }),
      list: async () => ({ members: { userList: [] }, total: 0, hasMore: false }),
    },
  }, ['manager', 'shipping'], ['manager'], true);
  await assert.rejects(gateway.grantAndVerify('shipping', '201'), /not been verified/u);
});

test('role catalogs reject incomplete scope evidence and report broad grants', async () => {
  let directory: RoleDirectory = [{ bizID: 'manager', roleMembers: { allEmployees: false, public: false } }];
  const gateway = new PlatformInvitationRoles({
    roles: { list: async () => directory },
    members: {
      add: async () => undefined,
      list: async () => ({ members: {}, total: 0, hasMore: false }),
    },
  }, ['manager'], ['manager'], true);
  await assert.rejects(gateway.directory(manager), /incomplete/u);
  directory = [{ bizID: 'manager', memberScope: 'custom', roleMembers: { allEmployees: true, public: false } }];
  assert.equal((await gateway.directory(manager)).unsafeBroadRoles, true);
  directory = [{ bizID: 'manager', memberScope: 'all', roleMembers: { allEmployees: false, public: false } }];
  assert.equal((await gateway.directory(manager)).unsafeBroadRoles, true);
  directory = [{ bizID: 'manager', memberScope: 'custom', roleMembers: { allEmployees: false, public: false } }];
  assert.equal((await gateway.directory(manager)).unsafeBroadRoles, false);
  await assert.rejects(gateway.directory({ ...manager, manager: false }));
});

test('a missing independent production scope review rejects before any platform grant', async () => {
  let writes = 0;
  const gateway = new PlatformInvitationRoles({
    roles: { list: async () => [{ bizID: 'manager', memberScope: 'custom', roleMembers: {} }] },
    members: {
      add: async () => { writes += 1; },
      list: async () => ({ members: {}, total: 0, hasMore: false }),
    },
  }, ['manager', 'shipping'], ['manager']);
  await assert.rejects(gateway.directory(manager), /independently reviewed/u);
  await assert.rejects(gateway.grantAndVerify('shipping', '201'), /independently reviewed/u);
  assert.equal(writes, 0);
});
