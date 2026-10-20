import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getActiveNavigationModule, getActiveNavigationRoute, getBusinessNavigationModules } from '../client/src/lib/navigation.ts';

test('business navigation contains the five requested modules and retains hidden route context', () => {
  const modules = getBusinessNavigationModules({ role: 'manager', capabilities: ['audit.read'], canSeeTeamMetrics: true }, true);
  assert.deepEqual(modules.map((item) => item.label), ['工作台', '达人', '商品', '寄样', '排期', '团队与业绩']);
  assert.deepEqual(modules.find((item) => item.id === 'products')?.routes.map((item) => item.pathname), ['/products']);
  assert.deepEqual(modules.find((item) => item.id === 'samples')?.routes.map((item) => item.id), ['samples', 'source-samples']);
  assert.equal(getActiveNavigationModule(modules, '/schedule')?.id, 'broadcast');
  assert.equal(getActiveNavigationModule(modules, '/source-records/samples')?.id, 'samples');
  assert.equal(getActiveNavigationModule(modules, '/dashboard')?.id, 'team');
  const team = modules.find((item) => item.id === 'team');
  assert.ok(team);
  assert.equal(getActiveNavigationRoute(team, '/team', '?tab=management')?.id, 'team');
  assert.equal(getActiveNavigationRoute(team, '/team', '?tab=progress')?.id, 'business-progress');
  assert.equal(getActiveNavigationRoute(team, '/team', '')?.id, 'dashboard');
});

test('BD gets performance only while fulfillment keeps its limited modules', () => {
  const bd = getBusinessNavigationModules({ role: 'bd', capabilities: ['audit.read'], canSeeTeamMetrics: false }, false);
  assert.deepEqual(bd.find((item) => item.id === 'team')?.routes.map((item) => item.id), ['dashboard', 'orders']);
  assert.equal(bd.flatMap((item) => item.routes).some((item) => ['team', 'rules', 'brands', 'business-progress'].includes(item.id)), false);
  const ops = getBusinessNavigationModules({ role: 'ops', capabilities: ['sample.fulfill', 'audit.read'], canSeeTeamMetrics: false }, false);
  assert.deepEqual(ops.map((item) => item.id), ['work', 'samples']);
});
