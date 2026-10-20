import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectMemberInvitation, memberInvitationUrl } from '../client/src/api/index.ts';
import { approvalOutcome, invitationActions, isInvitationToken, resolveInvitationToken } from '../client/src/lib/member-invitations.ts';

test('invite fragments override an older tab token, while reload without a fragment restores the current tab token', () => {
  const oldToken = 'O'.repeat(43);
  const freshToken = 'N'.repeat(43);

  assert.deepEqual(resolveInvitationToken(`#invite=${freshToken}`, oldToken), {
    token: freshToken,
    hasIncomingInvite: true,
    shouldClearHash: true,
  });
  assert.deepEqual(resolveInvitationToken('#section=members', freshToken), {
    token: freshToken,
    hasIncomingInvite: false,
    shouldClearHash: false,
  });
  assert.deepEqual(resolveInvitationToken('#invite=malformed', oldToken), {
    token: null,
    hasIncomingInvite: true,
    shouldClearHash: true,
  }, 'an invalid new invite must not fall back to a previous invite from sessionStorage');
  assert.equal(resolveInvitationToken('', 'bad-token').token, null);
  assert.equal(isInvitationToken('A'.repeat(43)), true);
  assert.equal(isInvitationToken('A'.repeat(42)), false);
  assert.equal(isInvitationToken(`${'A'.repeat(42)}.`), false);
});

test('server action flags preserve expired revocation and stale provisioning recovery without inferring from display status', () => {
  assert.deepEqual(invitationActions({ approve: false, revoke: true, recover: false }), {
    canApprove: false, canRevoke: true, canRecover: false,
  }, 'an expired claimed invitation can still be revoked');
  assert.deepEqual(invitationActions({ approve: false, revoke: false, recover: false }), {
    canApprove: false, canRevoke: false, canRecover: false,
  }, 'a fresh provisioning lease exposes no write actions');
  assert.deepEqual(invitationActions({ approve: true, revoke: false, recover: true }), {
    canApprove: true, canRevoke: false, canRecover: true,
  }, 'a stale provisioning lease can be retried or recovered but cannot be revoked');
  assert.deepEqual(invitationActions({ approve: false, revoke: false, recover: true }), {
    canApprove: false, canRevoke: false, canRecover: true,
  }, 'expired provisioning can only be recovered before it becomes revocable');
  assert.deepEqual(invitationActions(undefined), {
    canApprove: false, canRevoke: false, canRecover: false,
  }, 'older DTOs without actions default to no writes');
});

test('HTTP 200 approval outcomes remain partial or failed until the server says completed', () => {
  assert.equal(approvalOutcome({ status: 'completed', roleGranted: true }), 'completed');
  assert.equal(approvalOutcome({ status: 'provision_failed', roleGranted: true }), 'partial');
  assert.equal(approvalOutcome({ status: 'provision_failed', roleGranted: false }), 'failed');
  assert.equal(approvalOutcome({ status: 'provisioning', roleGranted: false }), 'processing');
  assert.equal(approvalOutcome({ status: 'claimed', roleGranted: false }), 'not-completed');
});

test('created invite links keep the token in the fragment and inspect sends it in a POST body', async () => {
  const originalFetch = globalThis.fetch;
  const previousWindow = globalThis.window;
  const token = 'T'.repeat(43);
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { origin: 'https://client.example' }, csrfToken: 'csrf', dispatchEvent: () => true },
  });
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: new URL(String(input), 'https://client.example'), init });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const link = new URL(memberInvitationUrl(`/join#invite=${token}`));
    assert.equal(link.origin, 'https://client.example');
    assert.equal(link.pathname, '/join');
    assert.equal(link.hash, `#invite=${token}`);
    assert.equal(link.search, '');

    await inspectMemberInvitation(token);
    const call = calls[0]!;
    assert.equal(call.url.pathname, '/api/member-invitations/inspect');
    assert.equal(call.url.search, '');
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.credentials, 'same-origin');
    assert.deepEqual(JSON.parse(String(call.init.body)), { token });
    assert.equal(new Headers(call.init.headers).get('x-suda-csrf-token'), 'csrf');
    assert.throws(() => memberInvitationUrl(`/join?invite=${token}`), /邀请链接无效/u);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousWindow === undefined) Reflect.deleteProperty(globalThis, 'window');
    else Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow });
  }
});
