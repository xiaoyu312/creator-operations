import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Actor, Capability, Cooperation, DomainState, LiveSchedule, OrderLine } from '../shared/types.ts';
import { createDemoState } from '../shared/seed.ts';
import { DomainService, type DomainStore } from '../server/domain/domain-service.ts';
import { getActiveNavigationModule, getActiveNavigationRoute, getNavigationModules } from '../client/src/lib/navigation.ts';
import { selectDailyStartingPoint, selectDemoWalkthrough } from '../client/src/lib/presentation.ts';

const NOW = '2026-10-13T09:00:00+08:00';

function makeDomainService(initial: DomainState = createDemoState()) {
  let state = structuredClone(initial);
  let sequence = 0;
  const store: DomainStore = {
    read: async () => structuredClone(state),
    transaction: async <T>(action: (draft: DomainState) => T | Promise<T>): Promise<T> => {
      const draft = structuredClone(state);
      const result = await action(draft);
      state = draft;
      return structuredClone(result);
    },
  };
  const service = new DomainService(store, { runtime: { now: () => NOW, id: (prefix) => `${prefix}-${++sequence}` } });
  return { service, state: () => state };
}

function demoActor(profile: string): Actor {
  return { principalId: `demo:${profile}` };
}

function routePaths(role: 'admin' | 'manager' | 'bd' | 'ops', capabilities: Capability[], canSeeTeamMetrics: boolean) {
  return getNavigationModules({ role, capabilities, canSeeTeamMetrics });
}

function versionFields(memberId = 'demo-member-bd-a') {
  return { version: 1, createdAt: NOW, createdBy: memberId, updatedAt: NOW, updatedBy: memberId };
}

function cooperationRecord(id: string, creatorId: string, teamId: string, status: Cooperation['status'] = 'pending_delivery'): Cooperation {
  return {
    id, orgId: 'demo-org', teamId, creatorId, ownerMemberId: 'demo-member-bd-a', title: `测试合作 ${id}`,
    lines: [], sampleRequirement: 'required', requiredSampleIds: [], deliveryRequirement: '交付一条内容', status,
    applicantId: 'demo-member-bd-a', decidedBy: null, decidedAt: null, decisionReason: null,
    rejectionReason: null, cancellationReason: null, waivedSamplesReason: null, startAt: null, endAt: null, note: null,
    ...versionFields(),
  };
}

function scheduleRecord(id: string, creatorId: string, teamId: string, cooperationId: string): LiveSchedule {
  return {
    id, orgId: 'demo-org', teamId, creatorId, cooperationId, cooperationLineId: null, ownerMemberId: 'demo-member-bd-a',
    platform: 'douyin', roomId: null, title: `测试排期 ${id}`, plannedStartAt: '2026-10-20T12:00:00+08:00',
    plannedEndAt: '2026-10-20T14:00:00+08:00', history: [], status: 'planned', changeReason: null,
    actualStartAt: null, actualEndAt: null, reviewUrl: null, ...versionFields(),
  };
}

function orderLineRecord(id: string, creatorId: string, teamId: string, status: OrderLine['status'] = 'paid'): OrderLine {
  return {
    id, orgId: 'demo-org', teamId, platform: 'douyin', shopId: null, externalOrderId: id, externalLineId: `${id}-line`,
    productId: null, sku: null, creatorAccountId: 'demo-account-a', creatorId, paidAt: status === 'paid' ? '2026-10-20T13:00:00+08:00' : null,
    sourceStatus: status === 'paid' ? '已支付' : '待支付', status, paidAmountCents: status === 'paid' ? 12_900 : null,
    rawAmount: status === 'paid' ? '129' : null,
    ownerSnapshot: { memberId: 'demo-member-bd-a', assignedAt: NOW, ruleVersion: 'paid_at_owner_v1', reason: status === 'paid' ? 'matched' : 'payment_not_finalized' },
    sourceEvidenceUrl: null, importBatchId: 'demo-import-orders', sourceRowNumber: 1, contentFingerprint: id,
    createdAt: NOW, createdBy: 'demo-member-bd-a', updatedAt: NOW, updatedBy: 'demo-member-bd-a', version: 1,
  };
}

test('管理员和主管仅从产品导航进入保留模块，合作/内容/费用模块不出现在导航中', () => {
  const state = createDemoState();
  const expectedPaths = [
    '/', '/tasks', '/guide', '/creators', '/public-pool', '/partners', '/assortments', '/products',
    '/stores', '/proposals', '/samples', '/schedule', '/orders', '/dashboard', '/targets', '/team', '/rules', '/audit',
  ];
  const excludedPaths = ['/cooperations', '/content', '/expenses'];

  for (const profile of ['admin', 'manager'] as const) {
    const member = state.members.find((item) => item.principalId === `demo:${profile}`)!;
    const modules = routePaths(profile, member.capabilities ?? [], true);
    const paths = new Set(modules.flatMap((item) => item.routes.map((entry) => entry.pathname)));
    assert.deepEqual(expectedPaths.filter((path) => !paths.has(path)), [], `${profile} 保留页面应在导航中可达`);
    assert.deepEqual(excludedPaths.filter((path) => paths.has(path)), [], `${profile} 不应显示排除模块`);
    assert.ok(modules.every((item) => item.routes.length <= 4), `${profile} 每个模块最多四个子入口`);
    assert.equal(modules.find((item) => item.id === 'products')?.routes.some((entry) => entry.pathname === '/proposals'), true, '推品提案仍归商品模块');
    assert.equal(modules.find((item) => item.id === 'broadcast')?.routes.some((entry) => entry.pathname === '/schedule'), true, '排期仍归上播设置');
  }
});

test('商务不显示排除模块或主管入口，团队/我的 query 激活与菜单一致', () => {
  const modules = routePaths('bd', [], false);
  const paths = new Set(modules.flatMap((item) => item.routes.map((entry) => entry.pathname)));
  assert.equal(paths.has('/expenses'), false);
  assert.equal(paths.has('/targets'), false);
  assert.equal(paths.has('/team'), false);
  assert.equal(paths.has('/rules'), false);
  assert.equal(paths.has('/cooperations'), false);
  assert.equal(paths.has('/content'), false);

  const creators = modules.find((item) => item.id === 'creators');
  assert.ok(creators);
  assert.equal(getActiveNavigationModule(modules, '/creators')?.id, 'creators');
  assert.equal(getActiveNavigationRoute(creators, '/creators', '')?.id, 'creators-mine');
  assert.equal(getActiveNavigationRoute(creators, '/creators', '?scope=mine')?.id, 'creators-mine');

  const managerState = createDemoState();
  const manager = managerState.members.find((member) => member.principalId === 'demo:manager')!;
  const managerModules = routePaths('manager', manager.capabilities ?? [], true);
  const managerCreators = managerModules.find((item) => item.id === 'creators');
  assert.ok(managerCreators);
  assert.equal(getActiveNavigationRoute(managerCreators, '/creators', '')?.id, 'creators-team');
  assert.equal(getActiveNavigationRoute(managerCreators, '/creators', '?scope=team')?.id, 'creators-team');
  assert.equal(getActiveNavigationRoute(managerCreators, '/creators', '?scope=mine')?.id, 'creators-mine');
});

test('样品运营只有工作台和样品模块（团队指标不可见）', () => {
  const modules = routePaths('ops', ['sample.fulfill'], false);
  assert.deepEqual(modules.map((item) => item.id), ['work', 'samples']);
  assert.deepEqual(new Set(modules.flatMap((item) => item.routes.map((entry) => entry.pathname))), new Set(['/', '/tasks', '/guide', '/samples']));
  assert.equal(modules.some((item) => item.routes.some((entry) => ['/cooperations', '/content', '/expenses', '/schedule'].includes(entry.pathname))), false);
});

test('production 不启动演示；样品运营仅从样品起点开始，商务演示链接使用真实当前记录', async () => {
  const { service } = makeDomainService();
  const managerWorkspace = await service.getWorkspace(demoActor('manager'));
  const manager = { memberId: managerWorkspace.actor.memberId, role: managerWorkspace.actor.role };

  assert.equal(selectDemoWalkthrough(managerWorkspace, manager, 'production').status, 'not_demo');
  const opsWorkspace = await service.getWorkspace(demoActor('ops'));
  const ops = { memberId: opsWorkspace.actor.memberId, role: opsWorkspace.actor.role };
  const opsResult = selectDemoWalkthrough(opsWorkspace, ops, 'demo');
  assert.equal(opsResult.status, 'unsupported_role');
  if (opsResult.status === 'unsupported_role') assert.equal(opsResult.fallbackHref, '/samples');
  assert.equal(selectDailyStartingPoint(opsWorkspace, ops).href, '/samples');

  const bdWorkspace = await service.getWorkspace(demoActor('bd-a'));
  const bd = { memberId: bdWorkspace.actor.memberId, role: bdWorkspace.actor.role };
  const result = selectDemoWalkthrough(bdWorkspace, bd, 'demo');
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  assert.equal(result.plan.creatorId, 'demo-creator-a');
  assert.equal(result.plan.caseLabel, '当前可见案例');
  assert.deepEqual(result.plan.steps.map((step) => step.id), ['creator', 'sample', 'schedule', 'orders']);
  assert.match(result.plan.steps[0].href ?? '', /q=DEMO-DY-ALPHA-001/);
  const sampleUrl = new URL(result.plan.steps[1].href ?? '/', 'https://app.invalid');
  assert.equal(sampleUrl.pathname, '/samples');
  assert.equal(sampleUrl.searchParams.get('status'), 'all');
  assert.equal(sampleUrl.searchParams.get('q'), 'demo-sample-a');
  assert.equal(result.plan.steps[2].available, false);
  assert.equal(result.plan.steps[2].href, null);
  assert.equal(result.plan.steps[3].available, false);
  assert.equal(result.plan.steps[3].href, null);
  assert.equal(result.plan.relatedCooperationId, null);
});

test('BD 演示选择仅从本人负责达人中取案例', async () => {
  const { service } = makeDomainService();
  const bdBWorkspace = await service.getWorkspace(demoActor('bd-b'));
  const actor = { memberId: bdBWorkspace.actor.memberId, role: bdBWorkspace.actor.role };
  const result = selectDemoWalkthrough(bdBWorkspace, actor, 'demo');

  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  assert.equal(result.plan.creatorId, 'demo-creator-b');
  assert.notEqual(result.plan.creatorId, 'demo-creator-a');
  assert.notEqual(result.plan.creatorId, 'demo-creator-other');
});

test('寄样、排期和订单只按同达人筛选；不同合作不被强行关联', async () => {
  const { service, state } = makeDomainService();
  const creatorId = 'demo-creator-a';
  const teamId = 'demo-team-main';
  const sampleCooperationId = 'case-sample-cooperation';
  const scheduleCooperationId = 'case-schedule-cooperation';
  const creatorSample = state().samples.find((sample) => sample.creatorId === creatorId)!;
  creatorSample.cooperationId = sampleCooperationId;
  state().cooperations.push(cooperationRecord(sampleCooperationId, creatorId, teamId), cooperationRecord(scheduleCooperationId, creatorId, teamId, 'draft'));
  state().schedules.push(scheduleRecord('case-schedule-selected', creatorId, teamId, scheduleCooperationId));
  state().orders.push(orderLineRecord('case-order-paid', creatorId, teamId), orderLineRecord('case-order-pending', creatorId, teamId, 'pending'));
  state().orders.push(orderLineRecord('case-order-other-creator', 'demo-creator-b', teamId));

  const workspace = await service.getWorkspace(demoActor('manager'));
  const result = selectDemoWalkthrough(workspace, { memberId: workspace.actor.memberId, role: workspace.actor.role }, 'demo');
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;

  assert.equal(result.plan.relatedCooperationId, null);
  const sampleStep = result.plan.steps.find((step) => step.id === 'sample')!;
  const scheduleStep = result.plan.steps.find((step) => step.id === 'schedule')!;
  const ordersStep = result.plan.steps.find((step) => step.id === 'orders')!;
  const sampleUrl = new URL(sampleStep.href ?? '/', 'https://app.invalid');
  assert.equal(sampleUrl.pathname, '/samples');
  assert.equal(sampleUrl.searchParams.get('status'), 'all');
  assert.equal(sampleUrl.searchParams.get('q'), creatorSample.id);
  const scheduleUrl = new URL(scheduleStep.href ?? '/', 'https://app.invalid');
  assert.equal(scheduleUrl.pathname, '/schedule');
  assert.equal(scheduleUrl.searchParams.get('scheduleId'), 'case-schedule-selected');
  assert.match(sampleStep.explanation, /没有证明它们关联到同一笔合作/u);
  assert.match(scheduleStep.explanation, /没有证明它们关联到同一笔合作/u);
  const ordersUrl = new URL(ordersStep.href ?? '/', 'https://app.invalid');
  assert.equal(ordersUrl.pathname, '/orders');
  assert.equal(ordersUrl.searchParams.get('creatorId'), creatorId);
  assert.match(ordersStep.explanation, /1 笔已支付订单/u);
  for (const step of result.plan.steps) {
    for (const href of [step.href, step.relatedHref]) {
      if (!href) continue;
      assert.equal(['/cooperations', '/content', '/expenses'].includes(new URL(href, 'https://app.invalid').pathname), false);
    }
  }

  creatorSample.cooperationId = scheduleCooperationId;
  const linkedWorkspace = await service.getWorkspace(demoActor('manager'));
  const linked = selectDemoWalkthrough(linkedWorkspace, { memberId: linkedWorkspace.actor.memberId, role: linkedWorkspace.actor.role }, 'demo');
  assert.equal(linked.status, 'ready');
  if (linked.status !== 'ready') return;
  assert.equal(linked.plan.relatedCooperationId, scheduleCooperationId);
  assert.match(linked.plan.steps[1].explanation, /能证明这两条记录关联到同一笔合作/u);
});

test('缺少寄样、排期和订单时没有假深链接；没有可见达人则回到当前权限范围', async () => {
  const { service } = makeDomainService();
  const base = await service.getWorkspace(demoActor('manager'));
  const workspace = structuredClone(base);
  workspace.cooperations = [];
  workspace.samples = [];
  workspace.schedules = [];
  workspace.orders = [];
  const result = selectDemoWalkthrough(workspace, { memberId: workspace.actor.memberId, role: workspace.actor.role }, 'demo');

  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  assert.equal(result.plan.relatedCooperationId, null);
  assert.ok(result.plan.steps[0].href);
  assert.equal(result.plan.steps[1].available, false);
  assert.equal(result.plan.steps[1].href, null);
  assert.equal(result.plan.steps[2].available, false);
  assert.equal(result.plan.steps[2].href, null);
  assert.equal(result.plan.steps[3].available, false);
  assert.equal(result.plan.steps[3].href, null);

  workspace.creators = [];
  const missing = selectDemoWalkthrough(workspace, { memberId: workspace.actor.memberId, role: workspace.actor.role }, 'demo');
  assert.equal(missing.status, 'missing_creator');
  if (missing.status === 'missing_creator') assert.equal(missing.fallbackHref, '/creators?scope=team');
});
