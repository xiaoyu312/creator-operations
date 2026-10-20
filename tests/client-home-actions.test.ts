import assert from 'node:assert/strict';
import { test } from 'node:test';
import { brandScopedHref, homeCreateActions, homeDateRange } from '../client/src/lib/home-actions.ts';
import { getNavigationModules } from '../client/src/lib/navigation.ts';
import type { Role } from '../shared/types.ts';

test('quick date ranges include today and handle month, year and leap-day boundaries', () => {
  assert.deepEqual(homeDateRange('today', '2026-10-15'), { from: '2026-10-15', to: '2026-10-15' });
  assert.deepEqual(homeDateRange('month', '2026-10-15'), { from: '2026-10-01', to: '2026-10-15' });
  assert.deepEqual(homeDateRange('last7', '2027-01-03'), { from: '2026-12-28', to: '2027-01-03' });
  assert.deepEqual(homeDateRange('last7', '2028-03-01'), { from: '2028-02-24', to: '2028-03-01' });
});

test('create links remain within the current brand and the visible role modules', () => {
  for (const role of ['admin', 'manager', 'bd', 'ops'] satisfies Role[]) {
    const modules = getNavigationModules({ role, capabilities: [], canSeeTeamMetrics: role !== 'ops' });
    const actions = homeCreateActions(role, modules, 'brand-current');
    assert.equal(actions.length, role === 'ops' ? 0 : 3);
    for (const action of actions) {
      const target = new URL(action.href, 'https://workbench.invalid');
      assert.equal(target.searchParams.get('brandId'), 'brand-current');
      assert.equal(target.searchParams.get('create'), '1');
    }
  }
  assert.deepEqual(homeCreateActions('manager', [{ id: 'samples' }], 'brand-a').map((item) => item.id), ['samples']);
});

test('brand scoped links retain queue, record and date filters without leaking another brand', () => {
  const url = new URL(brandScopedHref('/samples?queue=todo&q=sample-a&brandId=old', 'brand-b'), 'https://workbench.invalid');
  assert.equal(url.searchParams.get('brandId'), 'brand-b');
  assert.equal(url.searchParams.get('queue'), 'todo');
  assert.equal(url.searchParams.get('q'), 'sample-a');
  assert.equal(brandScopedHref('/schedule?weekStart=2026-10-12&view=list'), '/schedule?weekStart=2026-10-12&view=list');
});
