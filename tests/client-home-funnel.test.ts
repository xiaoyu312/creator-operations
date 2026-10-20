import assert from 'node:assert/strict';
import test from 'node:test';
import { buildHomeFunnels, formatHomeFunnelCount, formatHomeFunnelRate, homeFunnelBarWidths, homeFunnelHasActivity, showHomeCreatorFunnel, type HomeFunnelQuery, type HomeFunnelRecords } from '../client/src/lib/home-funnel.ts';
import type { AuditEvent, Creator, CrmStage, Delivery, Followup, OrderLine, OwnerCorrection, Platform, Role, SamplePackage, SampleRequest, SampleStatus } from '../shared/types.ts';

const TEAM = 'team-a';
const OTHER_TEAM = 'team-b';
const RANGE = { from: '2026-10-01', to: '2026-10-16' };
const OBSERVED_AT = '2026-10-16T18:00:00+08:00';

test('creator funnel keeps each stage inside the previous stage and uses claimed creators as stock', () => {
  const creators = [
    creator('owned', { ownerMemberId: 'bd-1', crmStage: 'contacted' }),
    creator('followed', { ownerMemberId: 'bd-1', crmStage: 'uncontacted' }),
    creator('sampled', { ownerMemberId: 'bd-1', crmStage: 'responded' }),
    creator('shipped', { ownerMemberId: 'bd-1', crmStage: 'negotiating' }),
    creator('delivered', { ownerMemberId: 'bd-1', crmStage: 'cooperating' }),
    creator('ordered', { ownerMemberId: 'bd-1', crmStage: 'cooperating' }),
    creator('public', { ownerMemberId: null, crmStage: 'contacted' }),
    creator('archived', { ownerMemberId: 'bd-1', archived: true, crmStage: 'cooperating' }),
    creator('other-team', { teamId: OTHER_TEAM, ownerMemberId: 'bd-1', crmStage: 'cooperating' }),
  ];
  const records = emptyRecords({
    creators,
    followups: [
      followup('followed', '2026-10-03T10:00:00+08:00'),
      followup('public', '2026-10-03T10:00:00+08:00'),
      followup('owned', '2026-09-20T10:00:00+08:00'),
    ],
    stageTouches: [
      { creatorId: 'owned', stage: 'contacted', at: '2026-10-02T09:00:00+08:00' },
      { creatorId: 'sampled', stage: 'responded', at: '2026-10-04T09:00:00+08:00' },
      { creatorId: 'shipped', stage: 'negotiating', at: '2026-10-04T09:00:00+08:00' },
      { creatorId: 'delivered', stage: 'cooperating', at: '2026-10-04T09:00:00+08:00' },
      { creatorId: 'ordered', stage: 'cooperating', at: '2026-10-04T09:00:00+08:00' },
      { creatorId: 'owned-late', stage: 'contacted', at: '2026-09-01T09:00:00+08:00' },
    ],
    samples: [
      sample('sample-pending', 'sampled', 'pending_approval', '2026-10-05T09:00:00+08:00'),
      sample('sample-shipped', 'shipped', 'shipped', '2026-10-06T09:00:00+08:00'),
      sample('sample-delivered', 'delivered', 'received', '2026-10-07T09:00:00+08:00'),
      sample('sample-ordered', 'ordered', 'received', '2026-10-08T09:00:00+08:00'),
      sample('sample-old', 'ordered', 'received', '2026-09-01T09:00:00+08:00'),
      sample('sample-draft', 'ordered', 'draft', '2026-10-08T09:00:00+08:00'),
      sample('sample-public', 'public', 'shipped', '2026-10-08T09:00:00+08:00'),
    ],
    samplePackages: [parcel('sample-shipped'), parcel('sample-delivered'), parcel('sample-ordered')],
    deliveries: [
      delivery('delivery-1', 'delivered', '2026-10-09T09:00:00+08:00'),
      delivery('delivery-2', 'ordered', '2026-10-10T09:00:00+08:00'),
      delivery('delivery-cancelled', 'ordered', '2026-10-10T09:00:00+08:00', 'cancelled'),
      delivery('delivery-old', 'ordered', '2026-09-02T09:00:00+08:00'),
    ],
    orders: [
      order('order-1', 'ordered', '2026-10-11T09:00:00+08:00'),
      order('order-2', 'ordered', '2026-10-12T09:00:00+08:00'),
      order('order-pending', 'ordered', '2026-10-12T09:00:00+08:00', 'pending'),
      order('order-before', 'ordered', '2026-09-30T15:00:00Z'),
      order('order-stray', 'shipped', '2026-10-12T09:00:00+08:00'),
    ],
  });

  const funnels = buildHomeFunnels(managerQuery(), records);
  const counts = Object.fromEntries(funnels.creators.stages.map((item) => [item.key, item.count]));
  assert.deepEqual(counts, { claimed: 6, contacted: 6, sampled: 4, shipped: 3, delivered: 2, ordered: 1 });
  assertSubset(funnels.creators.stages.map((item) => item.ids));
  assert.equal(funnels.creators.overall, 1 / 6);
  assert.equal(funnels.creators.rates[0].value, 1);
  assert.equal(funnels.creators.rates[4].value, 0.5);
  assert.equal(funnels.creators.stages[0].hint, '当前在管');
  assert.ok(!funnels.creators.stages[0].ids.includes('public'));
  assert.ok(!funnels.creators.stages[5].ids.includes('shipped'));
  assert.deepEqual(funnels.samples.stages.map((item) => item.count), [5, 4, 2, 3]);
  assert.ok(funnels.samples.stages[1].ids.every((id) => funnels.samples.stages[0].ids.includes(id)));
  assert.equal(funnels.samples.overall, null);
  assert.equal(formatHomeFunnelRate(funnels.samples.overall), '—');
  assert.ok((funnels.samples.rates[1].value ?? 0) < 1);
});

test('a followup in period counts as contact even while the creator is still uncontacted', () => {
  const records = emptyRecords({
    creators: [creator('quiet', { crmStage: 'uncontacted' })],
    followups: [followup('quiet', '2026-10-02T11:00:00+08:00', { result: 'no_answer' })],
  });
  const funnels = buildHomeFunnels(managerQuery(), records);
  assert.deepEqual(funnels.creators.stages.map((item) => item.count), [1, 1, 0, 0, 0, 0]);
  assert.equal(funnels.creators.rates[0].value, 1);
  assert.equal(funnels.creators.rates[1].value, 0);
  assert.equal(funnels.creators.rates[2].value, null);
});

test('stage updates in period count only when the creator is no longer uncontacted', () => {
  const records = emptyRecords({
    creators: [
      creator('audit-in', { crmStage: 'contacted' }),
      creator('audit-out', { crmStage: 'contacted' }),
      creator('audit-back', { crmStage: 'uncontacted' }),
      creator('progress-in', { crmStage: 'responded' }),
      creator('progress-out', { crmStage: 'responded' }),
    ],
    auditEvents: [
      stageAudit('audit-in', '2026-10-04T10:00:00+08:00', 'contacted'),
      stageAudit('audit-out', '2026-09-12T10:00:00+08:00', 'contacted'),
      stageAudit('audit-back', '2026-10-04T10:00:00+08:00', 'contacted'),
    ],
    stageTouches: [
      { creatorId: 'progress-in', stage: 'responded', at: '2026-10-05T10:00:00+08:00' },
      { creatorId: 'progress-out', stage: 'responded', at: '2026-09-05T10:00:00+08:00' },
      { creatorId: 'audit-in', stage: 'uncontacted', at: '2026-10-05T10:00:00+08:00' },
    ],
  });
  const ids = buildHomeFunnels(managerQuery(), records).creators.stages[1].ids;
  assert.deepEqual(ids, ['audit-in', 'progress-in']);
});

test('followups and stage updates outside the period stay out, including the Shanghai date boundary', () => {
  const records = emptyRecords({
    creators: [
      creator('before', { crmStage: 'uncontacted' }),
      creator('after', { crmStage: 'uncontacted' }),
      creator('boundary', { crmStage: 'uncontacted' }),
      creator('future', { crmStage: 'contacted' }),
    ],
    followups: [
      followup('before', '2026-09-30T23:30:00+08:00'),
      followup('after', '2026-10-17T00:30:00+08:00'),
      followup('boundary', '2026-09-30T16:00:00Z'),
      followup('future', '2026-10-16T18:30:00+08:00'),
    ],
  });
  const ids = buildHomeFunnels(managerQuery(), records).creators.stages[1].ids;
  assert.deepEqual(ids, ['boundary']);
});

test('platform filter keeps only that platform account, request and paid order', () => {
  const records = emptyRecords({
    creators: [
      creator('douyin-only', { crmStage: 'contacted', accounts: [account('acc-dy', 'douyin')] }),
      creator('channels-only', { crmStage: 'contacted', accounts: [account('acc-ch', 'channels')] }),
    ],
    followups: [
      followup('douyin-only', '2026-10-03T10:00:00+08:00', { accountId: 'acc-dy' }),
      followup('channels-only', '2026-10-03T10:00:00+08:00', { accountId: 'acc-ch' }),
    ],
    stageTouches: [
      { creatorId: 'douyin-only', stage: 'contacted', at: '2026-10-02T10:00:00+08:00' },
      { creatorId: 'channels-only', stage: 'contacted', at: '2026-10-02T10:00:00+08:00' },
    ],
    samples: [
      sample('dy-request', 'douyin-only', 'pending_shipment', '2026-10-04T10:00:00+08:00', { platform: 'douyin', creatorAccountId: 'acc-dy' }),
      sample('ch-request', 'channels-only', 'shipped', '2026-10-04T10:00:00+08:00', { platform: 'channels', creatorAccountId: 'acc-ch' }),
      sample('unknown-platform', 'douyin-only', 'shipped', '2026-10-04T10:00:00+08:00'),
    ],
    deliveries: [delivery('dy-delivery', 'douyin-only', '2026-10-08T10:00:00+08:00')],
    orders: [
      order('dy-order', 'douyin-only', '2026-10-09T10:00:00+08:00', 'paid', 'douyin'),
      order('ch-order', 'douyin-only', '2026-10-09T10:00:00+08:00', 'paid', 'channels'),
    ],
  });
  const funnels = buildHomeFunnels(managerQuery('douyin'), records);
  assert.deepEqual(funnels.creators.stages.map((item) => item.count), [1, 1, 1, 0, 0, 0]);
  assert.deepEqual(funnels.creators.stages[0].ids, ['douyin-only']);
  assert.deepEqual(funnels.samples.stages.map((item) => item.count), [1, 0, 0, 1]);
  assert.deepEqual(funnels.samples.stages[0].ids, ['dy-request']);
  assert.deepEqual(funnels.samples.stages[3].ids, ['dy-order']);
});

test('a followup tied to another platform does not count, and an unassigned followup still does', () => {
  const records = emptyRecords({
    creators: [creator('both', {
      crmStage: 'uncontacted',
      accounts: [account('acc-dy', 'douyin'), account('acc-ch', 'channels')],
    })],
    followups: [
      followup('both', '2026-10-03T10:00:00+08:00', { accountId: 'acc-ch' }),
    ],
  });
  assert.equal(buildHomeFunnels(managerQuery('douyin'), records).creators.stages[1].count, 0);
  records.followups.push(followup('both', '2026-10-04T10:00:00+08:00', { id: 'follow-open', accountId: null }));
  assert.equal(buildHomeFunnels(managerQuery('douyin'), records).creators.stages[1].count, 1);
});

test('business role scope follows the home: bd sees own creators and requests, manager sees the team', () => {
  const records = emptyRecords({
    creators: [
      creator('mine', { ownerMemberId: 'bd-1', crmStage: 'contacted' }),
      creator('peer', { ownerMemberId: 'bd-2', crmStage: 'contacted' }),
    ],
    stageTouches: [
      { creatorId: 'mine', stage: 'contacted', at: '2026-10-02T10:00:00+08:00' },
      { creatorId: 'peer', stage: 'contacted', at: '2026-10-02T10:00:00+08:00' },
    ],
    samples: [
      sample('mine-request', 'mine', 'pending_approval', '2026-10-05T10:00:00+08:00', { applicantId: 'bd-1' }),
      sample('peer-request', 'peer', 'pending_approval', '2026-10-05T10:00:00+08:00', { applicantId: 'bd-2' }),
      sample('my-application', 'peer', 'pending_approval', '2026-10-06T10:00:00+08:00', { applicantId: 'bd-1' }),
    ],
    orders: [
      order('mine-order', 'mine', '2026-10-08T10:00:00+08:00', 'paid', 'douyin', 'bd-1'),
      order('peer-order', 'peer', '2026-10-08T10:00:00+08:00', 'paid', 'douyin', 'bd-2'),
    ],
  });
  const bd = buildHomeFunnels(queryFor('bd', 'bd-1'), records);
  assert.deepEqual(bd.creators.stages[0].ids, ['mine']);
  assert.deepEqual(bd.samples.stages[0].ids, ['mine-request', 'my-application']);
  assert.deepEqual(bd.samples.stages[3].ids, ['mine-order']);
  const manager = buildHomeFunnels(managerQuery(), records);
  assert.deepEqual(manager.creators.stages[0].ids, ['mine', 'peer']);
  assert.equal(manager.samples.stages[0].count, 3);
  assert.equal(manager.samples.stages[3].count, 2);
});

test('an owner correction moves the paid order to the corrected business owner', () => {
  const records = emptyRecords({
    creators: [creator('handed', { ownerMemberId: 'bd-1', crmStage: 'cooperating' })],
    stageTouches: [{ creatorId: 'handed', stage: 'cooperating', at: '2026-10-02T10:00:00+08:00' }],
    samples: [sample('handed-sample', 'handed', 'received', '2026-10-03T10:00:00+08:00')],
    deliveries: [delivery('handed-delivery', 'handed', '2026-10-04T10:00:00+08:00', 'approved', 'bd-2')],
    orders: [order('handed-order', 'handed', '2026-10-05T10:00:00+08:00', 'paid', 'douyin', 'bd-1')],
    ownerCorrections: [{
      id: 'correction-1', orgId: 'org', teamId: TEAM, orderLineId: 'handed-order',
      previousMemberId: 'bd-1', correctedMemberId: 'bd-2', correctedAt: '2026-10-06T10:00:00+08:00',
      recordedAt: '2026-10-06T10:00:00+08:00', correctedBy: 'manager', reason: '交接',
    } satisfies OwnerCorrection],
  });
  const giver = buildHomeFunnels(queryFor('bd', 'bd-1'), records);
  const receiver = buildHomeFunnels(queryFor('bd', 'bd-2'), records);
  assert.equal(giver.samples.stages[3].count, 0);
  assert.deepEqual(receiver.samples.stages[3].ids, ['handed-order']);
  assert.equal(receiver.creators.stages[0].count, 0);
  assert.equal(receiver.creators.stages[5].count, 0);
});

test('ops can count sample fulfillment and leaves delivery and orders blank instead of zero', () => {
  const records = emptyRecords({
    creators: [creator('owned', { ownerMemberId: 'bd-1', crmStage: 'cooperating' })],
    followups: [followup('owned', '2026-10-02T10:00:00+08:00')],
    samples: [
      sample('visible', 'owned', 'shipped', '2026-10-04T10:00:00+08:00'),
      sample('waiting', 'owned', 'pending_shipment', '2026-10-05T10:00:00+08:00'),
    ],
    samplePackages: [parcel('visible')],
    deliveries: [delivery('hidden-delivery', 'owned', '2026-10-06T10:00:00+08:00')],
    orders: [order('hidden-order', 'owned', '2026-10-07T10:00:00+08:00')],
  });
  const funnels = buildHomeFunnels(queryFor('ops', 'ops-1'), records);
  assert.deepEqual(funnels.creators.stages.map((item) => item.count), [0, 0, 0, 0, null, null]);
  assert.equal(funnels.creators.overall, null);
  assert.equal(funnels.creators.rates[4].value, null);
  assert.deepEqual(funnels.samples.stages.map((item) => item.count), [2, 1, null, null]);
  assert.equal(funnels.samples.overall, null);
  assert.equal(funnels.samples.rates[0].value, 0.5);
  assert.equal(funnels.samples.rates[1].value, null);
  assert.equal(formatHomeFunnelCount(null), '—');
  assert.equal(formatHomeFunnelRate(null), '—');
});

test('sample counts can exceed the previous stage, and a package marks a request as shipped', () => {
  const records = emptyRecords({
    creators: [creator('busy', { crmStage: 'cooperating' })],
    stageTouches: [{ creatorId: 'busy', stage: 'cooperating', at: '2026-10-02T10:00:00+08:00' }],
    samples: [
      sample('packed', 'busy', 'pending_shipment', '2026-10-03T10:00:00+08:00'),
      sample('rejected', 'busy', 'rejected', '2026-10-03T11:00:00+08:00'),
    ],
    samplePackages: [parcel('packed'), parcel('outside', OTHER_TEAM)],
    deliveries: [
      delivery('once', 'busy', '2026-09-20T10:00:00+08:00', 'approved', 'bd-1', '2026-10-08T10:00:00+08:00'),
      delivery('twice', 'busy', '2026-10-09T10:00:00+08:00'),
      delivery('other-person', 'stranger', '2026-10-09T10:00:00+08:00'),
    ],
    orders: [
      order('line-1', 'busy', '2026-10-10T10:00:00+08:00'),
      order('line-2', 'busy', '2026-10-10T11:00:00+08:00'),
      order('line-3', 'stranger', '2026-10-10T12:00:00+08:00'),
    ],
  });
  const funnels = buildHomeFunnels(managerQuery(), records);
  assert.deepEqual(funnels.samples.stages.map((item) => item.count), [2, 1, 2, 3]);
  assert.equal(funnels.samples.rates[1].value, 2);
  assert.equal(funnels.samples.overall, null);
  assert.equal(formatHomeFunnelRate(funnels.samples.overall), '—');
  assert.equal(formatHomeFunnelRate(2), '200%');
  assert.equal(formatHomeFunnelRate(1.5), '150%');
  assert.deepEqual(funnels.creators.stages.map((item) => item.count), [1, 1, 1, 1, 1, 1]);
  assert.equal(funnels.samples.stages[1].ids.includes('rejected'), false);
});

test('sample funnel overall stays blank when paid orders are not a subset of sample requests', () => {
  const records = emptyRecords({
    creators: [creator('busy', { crmStage: 'cooperating' })],
    stageTouches: [{ creatorId: 'busy', stage: 'cooperating', at: '2026-10-02T10:00:00+08:00' }],
    samples: Array.from({ length: 8 }, (_, index) => sample(`sample-${index}`, 'busy', 'received', '2026-10-03T10:00:00+08:00')),
    orders: Array.from({ length: 90 }, (_, index) => order(`order-${index}`, 'busy', '2026-10-10T10:00:00+08:00')),
  });
  const funnels = buildHomeFunnels(managerQuery(), records);
  assert.equal(funnels.samples.stages[0].count, 8);
  assert.equal(funnels.samples.stages[3].count, 90);
  assert.equal(funnels.samples.overall, null);
  assert.equal(funnels.samples.overallNote, '出单不从本次申样计算');
  assert.equal(funnels.creators.overallLabel, '出单/认领');
  assert.equal(formatHomeFunnelRate(funnels.samples.overall), '—');
  assert.equal(formatHomeFunnelRate(90 / 8), '1125%');
  const widths = homeFunnelBarWidths(funnels.samples.stages);
  assert.ok(widths[3] > widths[0], 'a larger later stage draws wider than the first stage');
});

test('zero activity stays zero and a zero denominator stays blank', () => {
  const records = emptyRecords({
    creators: [creator('owned', { crmStage: 'uncontacted' })],
  });
  const funnels = buildHomeFunnels(managerQuery(), records);
  assert.deepEqual(funnels.creators.stages.map((item) => item.count), [1, 0, 0, 0, 0, 0]);
  assert.equal(funnels.creators.overall, 0);
  assert.equal(funnels.creators.rates[0].value, 0);
  assert.equal(funnels.creators.rates[1].value, null);
  assert.equal(funnels.samples.overall, null);
  assert.equal(formatHomeFunnelCount(0), '0');
  assert.equal(formatHomeFunnelRate(0), '0%');
  assert.equal(formatHomeFunnelRate(1 / 3), '33.33%');
  assert.equal(formatHomeFunnelRate(0.00001), '<0.01%');
  assert.equal(homeFunnelHasActivity(funnels.samples.stages), false);
  assert.deepEqual(homeFunnelBarWidths(funnels.creators.stages).slice(1), [0, 0, 0, 0, 0]);
  assert.equal(showHomeCreatorFunnel('ops', funnels.samples.stages), false);
  assert.equal(showHomeCreatorFunnel('manager', funnels.creators.stages), true);
});

test('records outside the team or an invalid period do not enter the funnel', () => {
  const records = emptyRecords({
    creators: [creator('outsider', { teamId: OTHER_TEAM, crmStage: 'cooperating' })],
    followups: [followup('outsider', '2026-10-02T10:00:00+08:00', { teamId: OTHER_TEAM })],
    samples: [sample('outside-sample', 'outsider', 'shipped', '2026-10-03T10:00:00+08:00', { teamId: OTHER_TEAM })],
    orders: [order('outside-order', 'outsider', '2026-10-04T10:00:00+08:00', 'paid', 'douyin', 'bd-1', OTHER_TEAM)],
  });
  const funnels = buildHomeFunnels(managerQuery(), records);
  assert.deepEqual(funnels.creators.stages.map((item) => item.count), [0, 0, 0, 0, 0, 0]);
  assert.deepEqual(funnels.samples.stages.map((item) => item.count), [0, 0, 0, 0]);
  const invalid = buildHomeFunnels({ ...managerQuery(), range: { from: '2026-10-20', to: '2026-10-01' } }, emptyRecords({
    creators: [creator('owned', { crmStage: 'uncontacted' })],
    followups: [followup('owned', '2026-10-02T10:00:00+08:00')],
    samples: [sample('late', 'owned', 'shipped', '2026-10-03T10:00:00+08:00')],
  }));
  assert.equal(invalid.creators.stages[0].count, 1);
  assert.equal(invalid.creators.stages[1].count, 0);
  assert.equal(invalid.samples.stages[0].count, 0);
});

function assertSubset(groups: string[][]) {
  for (let index = 1; index < groups.length; index += 1) {
    const parent = new Set(groups[index - 1]);
    assert.ok(groups[index].every((id) => parent.has(id)), `${groups[index].join(',')} is outside the previous stage`);
  }
}

function managerQuery(platform: HomeFunnelQuery['platform'] = 'all'): HomeFunnelQuery {
  return queryFor('manager', 'manager-1', platform);
}

function queryFor(role: Role, memberId: string, platform: HomeFunnelQuery['platform'] = 'all'): HomeFunnelQuery {
  return {
    scope: { role, memberId, teamIds: [TEAM] },
    range: RANGE,
    platform,
    observedAt: OBSERVED_AT,
  };
}

function emptyRecords(overrides: Partial<HomeFunnelRecords> = {}): HomeFunnelRecords {
  return {
    creators: [],
    followups: [],
    auditEvents: [],
    stageTouches: [],
    samples: [],
    samplePackages: [],
    deliveries: [],
    orders: [],
    ownerCorrections: [],
    ...overrides,
  };
}

function creator(id: string, overrides: Partial<Creator> = {}): Creator {
  return {
    id, orgId: 'org', teamId: TEAM, version: 1,
    createdAt: '2026-09-01T09:00:00+08:00', createdBy: 'manager-1',
    updatedAt: '2026-09-01T09:00:00+08:00', updatedBy: 'manager-1',
    name: id, category: null, tags: [], source: '测试',
    accounts: [account(`${id}-douyin`, 'douyin')],
    ownerMemberId: 'bd-1', crmStage: 'uncontacted', pausedFromStage: null,
    pauseReason: null, reviewAt: null, declineReason: null, contact: null,
    internalNote: null, archived: false, mergedIntoCreatorId: null,
    ...overrides,
  };
}

function account(id: string, platform: Platform): Creator['accounts'][number] {
  return {
    id, platform, externalAccountId: id, displayName: id, profileUrl: null, active: true,
    firstSeenAt: '2026-09-01T09:00:00+08:00', lastVerifiedAt: null,
  };
}

function followup(creatorId: string, occurredAt: string, overrides: Partial<Followup> = {}): Followup {
  return {
    id: overrides.id ?? `follow-${creatorId}-${occurredAt}`,
    orgId: 'org', teamId: TEAM, version: 1,
    createdAt: occurredAt, createdBy: 'bd-1', updatedAt: occurredAt, updatedBy: 'bd-1',
    creatorId, occurredAt, channel: 'wechat', result: 'contacted', summary: '跟进',
    accountId: null, evidenceUrl: null,
    ...overrides,
  };
}

function stageAudit(creatorId: string, occurredAt: string, stage: CrmStage): AuditEvent {
  return {
    id: `audit-${creatorId}`, orgId: 'org', teamId: TEAM, actorId: 'bd-1',
    entityType: 'creator', entityId: creatorId, action: 'creator.stage_changed',
    occurredAt, reason: null, before: { stage: 'uncontacted' }, after: { stage },
  };
}

function sample(id: string, creatorId: string, status: SampleStatus, createdAt: string, overrides: Partial<SampleRequest> = {}): SampleRequest {
  return {
    id, orgId: 'org', teamId: TEAM, version: 1,
    createdAt, createdBy: 'bd-1', updatedAt: createdAt, updatedBy: 'bd-1',
    creatorId, applicantId: 'bd-1', lines: [], recipient: null, shippingBlocked: false,
    reason: '申样', status, decidedBy: null, decidedAt: null, decisionReason: null,
    closeReason: null, originalRequestId: null, cooperationId: null,
    ...overrides,
  };
}

function parcel(sampleId: string, teamId = TEAM): SamplePackage {
  return {
    id: `parcel-${sampleId}-${teamId}`, orgId: 'org', teamId, version: 1,
    createdAt: '2026-10-06T10:00:00+08:00', createdBy: 'ops-1', updatedAt: '2026-10-06T10:00:00+08:00', updatedBy: 'ops-1',
    sampleId, carrier: '测试快递', trackingNumber: sampleId, lines: [],
    shippedAt: '2026-10-06T10:00:00+08:00', shippedBy: 'ops-1', receivedAt: null, receivedBy: null, receiptEvidenceUrl: null,
  };
}

function delivery(
  id: string,
  creatorId: string,
  createdAt: string,
  status: Delivery['status'] = 'pending_submission',
  ownerMemberId = 'bd-1',
  submittedAt?: string,
): Delivery {
  return {
    id, orgId: 'org', teamId: TEAM, version: 1,
    createdAt, createdBy: ownerMemberId, updatedAt: createdAt, updatedBy: ownerMemberId,
    creatorId, cooperationId: 'cooperation', cooperationLineId: null, scheduleId: null,
    ownerMemberId, type: 'short_video', title: id, dueAt: createdAt, required: true,
    status, submissions: submittedAt ? [{ submittedAt, submittedBy: ownerMemberId, contentUrl: null, platformContentId: null, evidenceUrl: null, note: null }] : [],
    reviews: [], cancellationReason: status === 'cancelled' ? '取消' : null,
  };
}

function order(
  id: string,
  creatorId: string,
  paidAt: string,
  status: OrderLine['status'] = 'paid',
  platform: Platform = 'douyin',
  ownerMemberId = 'bd-1',
  teamId = TEAM,
): OrderLine {
  return {
    id, orgId: 'org', teamId, platform, shopId: null, externalOrderId: id, externalLineId: id,
    productId: null, sku: null, creatorAccountId: null, creatorId, paidAt, sourceStatus: status, status,
    paidAmountCents: 1000, rawAmount: '10.00',
    ownerSnapshot: { memberId: status === 'paid' ? ownerMemberId : null, assignedAt: paidAt, ruleVersion: 'paid_at_owner_v1', reason: 'matched' },
    sourceEvidenceUrl: null, importBatchId: 'batch', sourceRowNumber: 1, contentFingerprint: id,
    createdAt: paidAt, createdBy: ownerMemberId, updatedAt: paidAt, updatedBy: ownerMemberId, version: 1,
  };
}
