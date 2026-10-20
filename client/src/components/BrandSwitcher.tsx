import { useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronsUpDown, Layers3 } from 'lucide-react';
import { isUnavailableDemoBrand } from '@shared/scenario-brand';
import { useWorkbench } from '../workbench-context';
import { brandNavigationUrl, getWorkbookContext } from '../lib/workbook-context';
import '../brand-management.css';

export default function BrandSwitcher() {
  const { session } = useWorkbench();
  const queryClient = useQueryClient();
  const workbook = getWorkbookContext(session);
  const currentBrandId = session.businessWorkspace?.brandId ?? workbook?.brandId ?? null;
  const brands = useMemo(() => {
    const visible = (session.brands ?? []).filter((brand) => !isUnavailableDemoBrand(brand));
    if (!currentBrandId || visible.some((brand) => brand.id === currentBrandId)) return visible;
    const currentName = session.businessWorkspace?.brandName ?? workbook?.brandName ?? '当前品牌';
    if (isUnavailableDemoBrand({ name: currentName })) return visible;
    return [{ id: currentBrandId, name: currentName, active: true, version: 0, createdAt: '', updatedAt: '' }, ...visible];
  }, [session.brands, currentBrandId, session.businessWorkspace?.brandName, workbook]);

  if (!currentBrandId) return null;

  async function switchBrand(nextBrandId: string) {
    if (!nextBrandId || nextBrandId === currentBrandId) return;
    await queryClient.cancelQueries();
    queryClient.clear();
    window.location.assign(brandNavigationUrl(window.location.href, nextBrandId));
  }

  return <label className="brand-switcher">
    <Layers3 size={15} aria-hidden="true" />
    <span className="brand-switcher-label">品牌</span>
    <select value={currentBrandId} onChange={(event) => void switchBrand(event.target.value)} aria-label="切换品牌">
      {brands.map((brand) => <option key={brand.id} value={brand.id} disabled={!brand.active}>{brand.name}{brand.active ? '' : '（已停用）'}</option>)}
    </select>
    <ChevronsUpDown size={13} aria-hidden="true" />
  </label>;
}
