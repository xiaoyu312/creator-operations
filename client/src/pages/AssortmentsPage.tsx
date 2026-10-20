import { useMemo, useState, type FormEvent } from 'react';
import '../operations-surfaces.css';
import { toast } from 'sonner';
import { Link } from 'react-router-dom';
import { Plus, Search, Tag } from 'lucide-react';
import type { ManualStore, Product, StoreAssortment } from '@shared/types';
import { useWorkbench } from '../workbench-context';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { EmptyState, FormField, Modal, PageHeading, Panel, StatusPill, formatDate, formatMoney, shanghaiDateTimeInput, shanghaiInputToIso } from '../components/workbench';
import { parseNonnegativeCents } from '../lib/business-ui';

export default function AssortmentsPage() {
  const { workspace, session } = useWorkbench();
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<StoreAssortment | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const canManage = session.actor.role === 'manager' || session.actor.role === 'admin';
  const activeStores = workspace.manualStores.filter((store) => store.active);
  const activeProducts = workspace.products.filter((product) => product.active);
  const hasAvailablePair = activeStores.some((store) => activeProducts.some((product) => product.teamId === store.teamId));
  const visible = useMemo(() => workspace.storeAssortments.filter((item) => {
    const store = workspace.manualStores.find((record) => record.id === item.storeId);
    const product = workspace.products.find((record) => record.id === item.productId);
    const text = `${store?.name ?? ''} ${store?.externalShopId ?? ''} ${product?.brand ?? ''} ${product?.name ?? ''} ${product?.sku ?? ''} ${item.productGroups.join(' ')} ${item.mainSellingPoints.join(' ')}`.toLowerCase();
    return !query.trim() || text.includes(query.trim().toLowerCase());
  }).sort((a, b) => (workspace.products.find((product) => product.id === a.productId)?.name ?? '').localeCompare(workspace.products.find((product) => product.id === b.productId)?.name ?? '')), [workspace.storeAssortments, workspace.manualStores, workspace.products, query]);

  return <div className="page-stack ops-page ops-page--assortments">
    <PageHeading title="商品货盘" actions={canManage && <Button onClick={() => setCreateOpen(true)} disabled={!hasAvailablePair}><Plus size={15} />新增货盘商品</Button>} />
    <Panel title="货盘记录">
      <div className="toolbar"><label className="search-field"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索商品、SKU、店铺或卖点" aria-label="搜索货盘" /></label><span className="toolbar-spacer" /><span className="table-result-count">{visible.length} 条货盘记录</span>{canManage && <Link className="link-button" to="/products">维护商品目录</Link>}</div>
      {visible.length ? <div className="table-wrap"><table className="data-table assortment-table"><thead><tr><th>店铺 / 商品</th><th>到手价 / 直播价</th><th>达人佣金</th><th>主推卖点 / 分组</th><th>有效期</th><th>状态</th>{canManage && <th className="text-right">操作</th>}</tr></thead><tbody>{visible.map((item) => {
        const store = workspace.manualStores.find((record) => record.id === item.storeId);
        const product = workspace.products.find((record) => record.id === item.productId);
        const now = Date.now();
        const withinValidity = (!item.validFrom || Date.parse(item.validFrom) <= now) && (!item.validUntil || Date.parse(item.validUntil) >= now);
        const isAvailable = item.active && Boolean(store?.active) && Boolean(product?.active) && withinValidity;
        return <tr key={item.id}>
          <td><span className="table-primary">{product ? `${product.brand} · ${product.name}` : '商品信息暂不可用'}</span><span className="table-secondary">{store?.name ?? '店铺信息暂不可用'} · {product?.sku ?? product?.specification ?? '无 SKU'}</span></td>
          <td>{formatMoney(item.priceCents)}<span className="table-secondary">直播价 {formatMoney(item.livePriceCents)}</span></td>
          <td>{item.creatorCommissionBps === null ? '—' : `${(item.creatorCommissionBps / 100).toFixed(2)}%`}<span className="table-secondary">达人推广佣金</span></td>
          <td>{item.mainSellingPoints.length ? item.mainSellingPoints.join('、') : '未填写'}<span className="table-secondary">{item.productGroups.length ? `分组：${item.productGroups.join('、')}` : '未分组'}</span>{item.sellingPointEvidenceUrl && <a className="table-secondary" href={item.sellingPointEvidenceUrl} target="_blank" rel="noreferrer">卖点依据 ↗</a>}</td>
          <td>{item.validFrom ? formatDate(item.validFrom) : '不限'}<span className="table-secondary">至 {item.validUntil ? formatDate(item.validUntil) : '不限'}</span></td>
          <td><StatusPill value={isAvailable ? 'active' : 'inactive'} label={isAvailable ? '可推品' : !item.active ? '已停用' : !withinValidity ? '超出有效期' : '商品或店铺不可用'} tone={isAvailable ? 'green' : 'neutral'} /></td>
          {canManage && <td className="table-action-cell"><Button variant="outline" size="sm" className="small-button" onClick={() => setEditing(item)}>编辑</Button></td>}
        </tr>;
      })}</tbody></table></div> : <EmptyState title={query ? '没有匹配货盘' : '还没有货盘记录'} description={query ? '调整搜索词。' : canManage ? '先添加店铺和商品，再设置货盘价格与佣金。' : '本团队还没有店铺货盘。'} icon={<Tag size={21} />} action={canManage && !query && <Button size="sm" onClick={() => setCreateOpen(true)} disabled={!hasAvailablePair}><Plus size={14} />新增货盘商品</Button>} />}
    </Panel>
    {canManage && <AssortmentDialog stores={workspace.manualStores} products={workspace.products} open={createOpen} onOpenChange={setCreateOpen} />}
    {canManage && editing && <AssortmentDialog stores={workspace.manualStores} products={workspace.products} assortment={editing} open onOpenChange={(open) => { if (!open) setEditing(null); }} />}
  </div>;
}

function AssortmentDialog({ stores, products, assortment, open, onOpenChange }: { stores: ManualStore[]; products: Product[]; assortment?: StoreAssortment; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { run, running, refresh } = useWorkbench();
  const [error, setError] = useState('');
  const [storeId, setStoreId] = useState(assortment?.storeId ?? '');
  const [productId, setProductId] = useState(assortment?.productId ?? '');
  const selectedStore = stores.find((store) => store.id === storeId);
  const selectableStores = stores.filter((store) => store.active || store.id === assortment?.storeId);
  const selectableProducts = products.filter((product) => (product.active || product.id === assortment?.productId) && (!selectedStore || product.teamId === selectedStore.teamId));
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('');
    const form = new FormData(event.currentTarget);
    try {
      const optionalCents = (value: FormDataEntryValue | null) => {
        const amount = String(value ?? '').trim();
        if (!amount) return null;
        const cents = parseNonnegativeCents(amount);
        if (cents === null) throw new Error('价格格式无效，请输入不超过两位小数的非负金额。');
        return cents;
      };
      const commissionText = String(form.get('creatorCommissionPercent') ?? '').trim();
      const commissionBps = commissionText ? Math.round(Number(commissionText) * 100) : null;
      const sellingPoints = String(form.get('mainSellingPoints') ?? '').split(/[\n，,]/).map((value) => value.trim()).filter(Boolean);
      const groups = String(form.get('productGroups') ?? '').split(/[\n，,]/).map((value) => value.trim()).filter(Boolean);
      const validFrom = String(form.get('validFrom') ?? '');
      const validUntil = String(form.get('validUntil') ?? '');
      if (assortment) {
        await run({ type: 'assortment.update', assortmentId: assortment.id, expectedVersion: assortment.version, priceCents: optionalCents(form.get('price')), livePriceCents: optionalCents(form.get('livePrice')), creatorCommissionBps: commissionBps, mainSellingPoints: sellingPoints, sellingPointEvidenceUrl: String(form.get('sellingPointEvidenceUrl') ?? '') || null, salesCardUrl: String(form.get('salesCardUrl') ?? '') || null, productGroups: groups, validFrom: validFrom ? shanghaiInputToIso(validFrom) : null, validUntil: validUntil ? shanghaiInputToIso(validUntil) : null, active: form.get('active') === 'on' });
        toast.success('货盘条款已更新');
      } else {
        await run({ type: 'assortment.create', storeId, productId, priceCents: optionalCents(form.get('price')), livePriceCents: optionalCents(form.get('livePrice')), creatorCommissionBps: commissionBps, mainSellingPoints: sellingPoints, sellingPointEvidenceUrl: String(form.get('sellingPointEvidenceUrl') ?? '') || null, salesCardUrl: String(form.get('salesCardUrl') ?? '') || null, productGroups: groups, validFrom: validFrom ? shanghaiInputToIso(validFrom) : null, validUntil: validUntil ? shanghaiInputToIso(validUntil) : null });
        toast.success('店铺货盘已添加');
      }
      await refresh(); onOpenChange(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败'); }
  }
  const existingStore = stores.find((store) => store.id === assortment?.storeId);
  const existingProduct = products.find((product) => product.id === assortment?.productId);
  return <Modal open={open} onOpenChange={onOpenChange} title={assortment ? '编辑货盘条款' : '新增货盘商品'}>
    <form className="modal-form" onSubmit={submit}>
      <div className="form-grid">
        <FormField label="店铺" required><select className="native-select" name="storeId" required disabled={Boolean(assortment)} value={storeId} onChange={(event) => { setStoreId(event.target.value); setProductId(''); }}><option value="">选择店铺</option>{selectableStores.map((store) => <option key={store.id} value={store.id}>{store.name} · {store.externalShopId}{!store.active ? ' · 已停用' : ''}</option>)}</select></FormField>
        <FormField label="商品" required><select className="native-select" name="productId" required disabled={Boolean(assortment)} value={productId} onChange={(event) => setProductId(event.target.value)}><option value="">选择商品</option>{selectableProducts.map((product) => <option key={product.id} value={product.id}>{product.brand} · {product.name}{product.sku ? ` · ${product.sku}` : ''}{!product.active ? ' · 已停用' : ''}</option>)}{assortment && existingProduct && !selectableProducts.some((product) => product.id === existingProduct.id) && <option value={existingProduct.id}>{existingProduct.brand} · {existingProduct.name} · 已停用</option>}</select></FormField>
        <FormField label="日常售价（元）"><Input name="price" type="number" min={0} step="0.01" defaultValue={assortment?.priceCents === null || assortment?.priceCents === undefined ? '' : (assortment.priceCents / 100).toFixed(2)} /></FormField>
        <FormField label="直播价（元）"><Input name="livePrice" type="number" min={0} step="0.01" defaultValue={assortment?.livePriceCents === null || assortment?.livePriceCents === undefined ? '' : (assortment.livePriceCents / 100).toFixed(2)} /></FormField>
        <FormField label="达人推广佣金（%）"><Input name="creatorCommissionPercent" type="number" min={0} max={100} step="0.01" defaultValue={assortment?.creatorCommissionBps === null || assortment?.creatorCommissionBps === undefined ? '' : (assortment.creatorCommissionBps / 100).toFixed(2)} /></FormField>
        <FormField label="有效开始"><Input name="validFrom" type="datetime-local" defaultValue={assortment?.validFrom ? shanghaiDateTimeInput(new Date(assortment.validFrom)) : ''} /></FormField>
        <FormField label="有效截止"><Input name="validUntil" type="datetime-local" defaultValue={assortment?.validUntil ? shanghaiDateTimeInput(new Date(assortment.validUntil)) : ''} /></FormField>
        <FormField label="商品分组" hint="多个分组用逗号或换行分隔。"><Input name="productGroups" defaultValue={assortment?.productGroups.join(', ') ?? ''} /></FormField>
        <FormField label="主推卖点" className="span-2"><Textarea name="mainSellingPoints" rows={3} defaultValue={assortment?.mainSellingPoints.join('\n') ?? ''} /></FormField>
        <FormField label="卖点依据链接"><Input name="sellingPointEvidenceUrl" type="url" defaultValue={assortment?.sellingPointEvidenceUrl ?? ''} placeholder="https://" /></FormField>
        <FormField label="商品卡链接"><Input name="salesCardUrl" type="url" defaultValue={assortment?.salesCardUrl ?? ''} placeholder="https://" /></FormField>
      </div>
      {assortment && <label className="check-row"><input name="active" type="checkbox" defaultChecked={assortment.active} />允许用于新推品</label>}
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="modal-actions"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button><Button type="submit" disabled={running || (!assortment && (!storeId || !productId))}>{running ? '保存中…' : assortment ? '保存货盘' : '添加货盘'}</Button></div>
    </form>
  </Modal>;
}
