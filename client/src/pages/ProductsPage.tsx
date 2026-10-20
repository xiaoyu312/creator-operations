import { useState, type FormEvent } from 'react';
import '../operations-surfaces.css';
import { toast } from 'sonner';
import { PackageSearch, Plus, Search } from 'lucide-react';
import type { Product } from '@shared/types';
import { useWorkbench } from '../workbench-context';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { EmptyState, FormField, Modal, PageHeading, Panel, StatusPill, formatMoney } from '../components/workbench';
import { parseNonnegativeCents } from '../lib/business-ui';

export default function ProductsPage() {
  const { workspace, session, run, running } = useWorkbench();
  const [query, setQuery] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const activeCount = workspace.products.filter((product) => product.active).length;
  const visible = workspace.products.filter((product) => `${product.brand} ${product.name} ${product.sku ?? ''} ${product.specification ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()));
  const canManage = session.actor.role === 'manager' || session.actor.role === 'admin';
  async function toggleActive(product: Product) {
    try { await run({ type: 'product.update', productId: product.id, expectedVersion: product.version, active: !product.active }); toast.success(product.active ? '商品已停用，新业务不可再选择' : '商品已启用'); }
    catch (error) { toast.error(error instanceof Error ? error.message : '更新失败'); }
  }

  return <div className="page-stack ops-page ops-page--products">
    <PageHeading title="商品目录" actions={canManage && <Button onClick={() => setCreateOpen(true)}><Plus size={15} />新增商品</Button>} />
    <div className="page-grid metrics-grid product-metrics"><div className="small-metric"><span>商品总数</span><strong>{workspace.products.length}</strong></div><div className="small-metric"><span>可用于新业务</span><strong>{activeCount}</strong></div></div>
    <Panel title="商品清单">
      <div className="toolbar"><label className="search-field"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索品牌、商品、SKU 或规格" aria-label="搜索商品" /></label><span className="toolbar-spacer" /><span className="table-result-count">{visible.length} 条商品</span></div>
      {visible.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>品牌 / 商品</th><th>SKU / 规格</th><th>样品成本参考</th><th>状态</th>{canManage && <th className="text-right">操作</th>}</tr></thead><tbody>{visible.map((product) => <tr key={product.id}><td><span className="table-primary">{product.name}</span><span className="table-secondary">{product.brand}</span></td><td>{product.sku ?? '—'}<span className="table-secondary">{product.specification ?? '规格未填'}</span></td><td>{formatMoney(product.sampleCostCents)}</td><td><StatusPill value={product.active ? 'active' : 'inactive'} label={product.active ? '可用' : '已停用'} tone={product.active ? 'green' : 'neutral'} /></td>{canManage && <td className="table-action-cell"><div className="inline-actions"><Button variant="outline" size="sm" className="small-button" onClick={() => setEditing(product)}>编辑</Button><Button variant="ghost" size="sm" className={`small-button${product.active ? ' button-danger' : ''}`} onClick={() => void toggleActive(product)} disabled={running}>{product.active ? '停用' : '启用'}</Button></div></td>}</tr>)}</tbody></table></div> : <EmptyState title={query ? '没有匹配商品' : '商品目录为空'} description={query ? '请调整搜索词。' : '先添加商品，再创建样品申请和合作约定。'} icon={<PackageSearch size={21} />} action={canManage && <Button size="sm" onClick={() => setCreateOpen(true)}><Plus size={14} />新增商品</Button>} />}
    </Panel>
    <ProductDialog open={createOpen} onOpenChange={setCreateOpen} />
    {editing && <ProductDialog product={editing} open onOpenChange={(open) => { if (!open) setEditing(null); }} />}
  </div>;
}

function ProductDialog({ product, open, onOpenChange }: { product?: Product; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { run, running } = useWorkbench();
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); const form = new FormData(event.currentTarget);
    try {
      const sampleCost = String(form.get('sampleCost') ?? '').trim();
      const sampleCostCents = sampleCost ? parseNonnegativeCents(sampleCost) : null;
      if (sampleCost && sampleCostCents === null) throw new Error('样品成本格式无效，请输入不超过两位小数的非负金额。');
      if (product) {
        await run({ type: 'product.update', productId: product.id, expectedVersion: product.version, brand: String(form.get('brand') ?? ''), name: String(form.get('name') ?? ''), sku: String(form.get('sku') ?? '') || null, specification: String(form.get('specification') ?? '') || null, sampleCostCents, note: String(form.get('note') ?? '') || null, active: form.get('active') === 'on' });
        toast.success('商品信息已更新');
      } else {
        await run({ type: 'product.create', brand: String(form.get('brand') ?? ''), name: String(form.get('name') ?? ''), sku: String(form.get('sku') ?? '') || null, specification: String(form.get('specification') ?? '') || null, sampleCostCents, note: String(form.get('note') ?? '') || null });
        toast.success('商品已加入目录');
      }
      onOpenChange(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败'); }
  }
  return <Modal open={open} onOpenChange={onOpenChange} title={product ? '编辑商品' : '新增商品'}>
    <form className="modal-form" onSubmit={submit}><div className="form-grid"><FormField label="品牌" required><Input name="brand" required defaultValue={product?.brand ?? ''} /></FormField><FormField label="商品名称" required><Input name="name" required defaultValue={product?.name ?? ''} /></FormField><FormField label="SKU"><Input name="sku" defaultValue={product?.sku ?? ''} /></FormField><FormField label="规格"><Input name="specification" defaultValue={product?.specification ?? ''} /></FormField><FormField label="样品成本参考（元）"><Input name="sampleCost" type="number" min={0} step="0.01" defaultValue={product?.sampleCostCents === null || product?.sampleCostCents === undefined ? '' : (product.sampleCostCents / 100).toFixed(2)} /></FormField><FormField label="备注"><Input name="note" defaultValue={product?.note ?? ''} /></FormField></div>{product && <label className="check-row"><input name="active" type="checkbox" defaultChecked={product.active} />允许用于新样品申请和合作单</label>}{error && <p className="field-error" role="alert">{error}</p>}<div className="modal-actions"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button><Button type="submit" disabled={running}>{running ? '保存中…' : product ? '保存商品' : '添加商品'}</Button></div></form>
  </Modal>;
}
