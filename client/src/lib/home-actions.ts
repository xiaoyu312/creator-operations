import type { Role } from '../../../shared/types.ts';
import type { NavigationModule } from './navigation.ts';

export type HomeDatePreset = 'today' | 'last7' | 'month';

export function homeDateRange(preset: HomeDatePreset, today: string) {
  const end = new Date(`${today}T00:00:00Z`);
  if (preset === 'last7') end.setUTCDate(end.getUTCDate() - 6);
  return {
    from: preset === 'month' ? `${today.slice(0, 7)}-01` : end.toISOString().slice(0, 10),
    to: today,
  };
}

export function brandScopedHref(path: string, brandId?: string) {
  const target = new URL(path, 'https://workbench.invalid');
  if (brandId) target.searchParams.set('brandId', brandId);
  return `${target.pathname}${target.search}${target.hash}`;
}

export function homeCreateActions(role: Role, modules: Pick<NavigationModule, 'id'>[], brandId?: string) {
  if (role === 'ops') return [];
  const available = new Set(modules.map((module) => module.id));
  const actions: Array<{ id: NavigationModule['id']; label: string; path: string }> = [
    { id: 'creators', label: '新建达人', path: '/creators?create=1' },
    { id: 'samples', label: '新建样品申请', path: '/samples?create=1' },
    { id: 'broadcast', label: '新增直播排期', path: '/schedule?create=1' },
  ];
  return actions.filter((action) => available.has(action.id))
    .map((action) => ({ id: action.id, label: action.label, href: brandScopedHref(action.path, brandId) }));
}
