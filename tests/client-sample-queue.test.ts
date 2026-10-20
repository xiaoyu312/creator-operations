import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Creator, CreatorAccount, SamplePackage, SampleRequest, WorkspaceSnapshot } from '../shared/types.ts';
import { homeApprovalListPath, selectActionableSamples, selectAwaitingReceiptSamples, selectEligibleSampleCreators, selectPendingApprovalRoster, selectSampleCreatorAccounts, sampleMatchesPlatform, type SelectActionableSamplesInput } from '../client/src/lib/sample-queue.ts';
import { homeFocusesFirstSetup, homeHeroSentence, homePaidAmountText, isContentDeliveryPending } from '../client/src/lib/home-insights.ts';

function sample(id: string, status: SampleRequest['status'], input: Partial<SampleRequest> = {}): SampleRequest {
  return {
    id,
    creatorId: 'creator-a',
    applicantId: 'member-a',
    status,
    createdAt: '2026-10-14T00:00:00.000Z',
    ...input,
  } as SampleRequest;
}

function creator(id: string, ownerMemberId: string | null, archived = false): Creator {
  return { id, ownerMemberId, archived } as Creator;
}

function samplePackage(sampleId: string, receivedAt: string | null = null): SamplePackage {
  return { id: `package-${sampleId}-${receivedAt ?? 'open'}`, sampleId, receivedAt } as SamplePackage;
}

function actor(input: Partial<WorkspaceSnapshot['actor']> = {}): SelectActionableSamplesInput['actor'] {
  return { memberId: 'member-a', role: 'manager', capabilities: [], ...input };
}

test('sample creator eligibility excludes BD public-pool, other-owner, and archived creators while managers can choose visible non-archived creators', () => {
  const creators = [
    creator('mine', 'member-a'),
    creator('other-owner', 'member-b'),
    creator('public-pool', null),
    creator('archived-mine', 'member-a', true),
  ];

  assert.deepEqual(selectEligibleSampleCreators({ creators, actor: actor({ role: 'bd' }) }).map((item) => item.id), ['mine']);
  assert.deepEqual(selectEligibleSampleCreators({ creators, actor: actor({ role: 'admin' }) }).map((item) => item.id), ['mine', 'other-owner', 'public-pool']);
});

test('preserves actor scope and approval authorization, excluding an actor own pending approval', () => {
  const samples = [
    sample('own-approval', 'pending_approval', { applicantId: 'member-a' }),
    sample('other-approval', 'pending_approval', { applicantId: 'member-b' }),
    sample('other-owner-approval', 'pending_approval', { applicantId: 'member-c', creatorId: 'creator-b' }),
  ];
  const result = selectActionableSamples({
    samples,
    creators: [creator('creator-a', 'member-a'), creator('creator-b', 'member-b')],
    samplePackages: [],
    actor: actor({ role: 'bd', capabilities: ['sample.approve'] }),
  });

  assert.deepEqual(result.map((item) => item.id), ['other-approval']);
});

test('requires fulfillment capability and counts each request once even when several packages await receipt', () => {
  const samples = [
    sample('pending-shipment', 'pending_shipment'),
    sample('waiting-receipt', 'shipped'),
    sample('already-received', 'shipped'),
    sample('shipped-without-package', 'shipped'),
  ];
  const samplePackages = [
    samplePackage('waiting-receipt'),
    samplePackage('waiting-receipt'),
    samplePackage('already-received', '2026-10-14T01:00:00.000Z'),
  ];

  assert.deepEqual(selectActionableSamples({ samples, creators: [], samplePackages, actor: actor() }), []);
  const result = selectActionableSamples({ samples, creators: [], samplePackages, actor: actor({ capabilities: ['sample.fulfill'] }) });
  assert.deepEqual(result.map((item) => item.id), ['pending-shipment', 'waiting-receipt']);
});

test('orders the queue by approval, shipment, receipt, then creation time', () => {
  const samples = [
    sample('receipt', 'shipped', { createdAt: '2026-10-13T00:00:00.000Z' }),
    sample('shipment', 'pending_shipment'),
    sample('approval-later', 'pending_approval', { applicantId: 'member-b', createdAt: '2026-10-14T02:00:00.000Z' }),
    sample('approval-earlier', 'pending_approval', { applicantId: 'member-b', createdAt: '2026-10-14T01:00:00.000Z' }),
  ];
  const result = selectActionableSamples({
    samples,
    creators: [],
    samplePackages: [samplePackage('receipt')],
    actor: actor({ capabilities: ['sample.approve', 'sample.fulfill'] }),
  });

  assert.deepEqual(result.map((item) => item.id), ['approval-earlier', 'approval-later', 'shipment', 'receipt']);
});

test('sample selection only includes recorded active accounts in the selected platform and allowed creator scope', () => {
  const account = (id: string, platform: CreatorAccount['platform'], active = true): CreatorAccount => ({
    id, platform, externalAccountId: id, displayName: id, active, profileUrl: null,
    firstSeenAt: '2026-10-14T00:00:00Z', lastVerifiedAt: null,
  });
  const creators = [
    { ...creator('mine', 'member-a'), accounts: [account('my-douyin', 'douyin'), account('my-video', 'xiaohongshu'), account('inactive', 'douyin', false)] },
    { ...creator('other', 'member-b'), accounts: [account('other-douyin', 'douyin')] },
  ];
  assert.deepEqual(selectSampleCreatorAccounts({ creators, actor: actor({ role: 'bd' }), platform: 'douyin' }).map((item) => item.account.id), ['my-douyin']);
  assert.deepEqual(selectSampleCreatorAccounts({ creators, actor: actor({ role: 'ops' }), platform: 'all' }), []);
});

test('home approval roster keeps the viewer own pending request and does not send people without approval into the reviewer queue', () => {
  const samples = [
    sample('bd-own', 'pending_approval', { applicantId: 'member-bd', creatorId: 'creator-bd', teamId: 'team-a' }),
    sample('bd-owned-creator', 'pending_approval', { applicantId: 'member-other', creatorId: 'creator-bd', teamId: 'team-a' }),
    sample('stranger', 'pending_approval', { applicantId: 'member-other', creatorId: 'creator-other', teamId: 'team-a' }),
    sample('manager-own', 'pending_approval', { applicantId: 'member-manager', creatorId: 'creator-manager', teamId: 'team-a' }),
  ];
  const creators = [creator('creator-bd', 'member-bd'), creator('creator-other', 'member-other'), creator('creator-manager', 'member-manager')];
  const bd = selectPendingApprovalRoster({ samples, creators, actor: actor({ memberId: 'member-bd', role: 'bd' }), teamIds: ['team-a'] });
  const manager = selectPendingApprovalRoster({ samples, creators, actor: actor({ memberId: 'member-manager', role: 'manager' }), teamIds: ['team-a'] });
  assert.deepEqual(bd.map((item) => item.id), ['bd-own', 'bd-owned-creator']);
  assert.equal(manager.some((item) => item.id === 'manager-own'), true);
  assert.equal(homeApprovalListPath(false), '/samples?status=pending_approval');
  assert.equal(homeApprovalListPath(true), '/samples?queue=approval');
});

test('awaiting receipt counts one application even with two open packages and skips a shipped request whose packages are received', () => {
  const samples = [
    sample('two-open', 'shipped', { teamId: 'team-a' }),
    sample('already-signed', 'shipped', { teamId: 'team-a', applicantId: 'member-bd', creatorId: 'creator-bd' }),
  ];
  const samplePackages = [
    samplePackage('two-open'),
    samplePackage('two-open'),
    samplePackage('already-signed', '2026-10-14T01:00:00.000Z'),
  ];
  const creators = [creator('creator-a', 'member-a'), creator('creator-bd', 'member-bd')];
  const manager = selectAwaitingReceiptSamples({ samples, creators, samplePackages, actor: actor({ role: 'manager' }), teamIds: ['team-a'] });
  const bd = selectAwaitingReceiptSamples({ samples, creators, samplePackages, actor: actor({ memberId: 'member-bd', role: 'bd' }), teamIds: ['team-a'] });
  assert.deepEqual(manager.map((item) => item.id), ['two-open']);
  assert.deepEqual(bd.map((item) => item.id), []);
});

test('content delivery list includes a cooperation that still has a pending delivery', () => {
  assert.equal(isContentDeliveryPending({ id: 'coop-1', status: 'pending_samples_shipment' }, [{ cooperationId: 'coop-1', status: 'pending_submission' }]), true);
  assert.equal(isContentDeliveryPending({ id: 'coop-2', status: 'pending_samples_shipment' }, [{ cooperationId: 'coop-1', status: 'pending_submission' }]), false);
  assert.equal(isContentDeliveryPending({ id: 'coop-3', status: 'pending_delivery' }, []), true);
});

test('unknown paid amounts and the first setup do not pretend there is a zero result', () => {
  assert.equal(homePaidAmountText({ paidCount: 2, paidUnknownCount: 2 }), '金额待补充');
  assert.equal(homePaidAmountText({ paidCount: 2, paidUnknownCount: 1 }), null);
  assert.equal(homePaidAmountText({ paidCount: 0, paidUnknownCount: 0 }), null);
  assert.equal(homeFocusesFirstSetup({ nextTaskTitle: '录入店铺与商品', creatorCount: 0, nonDraftSampleCount: 0 }), true);
  assert.equal(homeFocusesFirstSetup({ nextTaskTitle: '录入店铺与商品', creatorCount: 1, nonDraftSampleCount: 0 }), false);
  assert.equal(homeHeroSentence({ firstSetup: true, nextTaskTitle: '录入店铺与商品', cards: [] }), '先做一件事：录入店铺与商品');
  assert.equal(homeHeroSentence({ firstSetup: false, nextTaskTitle: null, cards: [{ label: '样品待签收', count: 2 }, { label: '逾期跟进', count: 1 }] }), '先处理「样品待签收」，一共 2 件');
});

test('historical sample requests without a recorded platform are not attributed to every creator account', () => {
  assert.equal(sampleMatchesPlatform({}, 'all'), true);
  assert.equal(sampleMatchesPlatform({}, 'douyin'), false);
  assert.equal(sampleMatchesPlatform({ platform: 'douyin' }, 'douyin'), true);
  assert.equal(sampleMatchesPlatform({ platform: 'douyin' }, 'xiaohongshu'), false);
});
