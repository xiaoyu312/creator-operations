import { useEffect, useMemo, useState, type FormEvent } from 'react';
import '../operations-surfaces.css';
import '../catalog.css';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Plus, Search } from 'lucide-react';
import { PLATFORMS, type ManualStore, type Platform, type Product, type StoreAssortment } from '@shared/types';
import { useWorkbench } from '../workbench-context';
import PlatformTabs from '../components/PlatformTabs';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { EmptyState, FormField, Modal, PageHeading, Panel, StatusPill, formatMoney } from '../components/workbench';
import { parseNonnegativeCents } from '../lib/business-ui';
import { platformLabel } from '../lib/platform-presentation';
import { EmptyIllustration } from '../components/ProductVisuals';
import {
  buildCatalogGroups,
  filterCatalogGroups,
  readCatalogFilters,
  withCatalogFilters,
  type CatalogOffer,
  type CatalogPlatformFilter,
} from '../lib/catalog-view';

type StoreChoice = 'existing' | 'new';
type ProductChoice = 'existing' | 'new';

export default function CatalogPage() {
  const { workspace, session } = useWorkbench();
  const [searchParams, setSearchParams] = useSearchParams();
  const [createOpen, setCreateOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [editingOffer, setEditingOffer] = useState<StoreAssortment | null>(null);
  const canManage = session.actor.role === 'manager' || session.actor.role === 'admin';
  const createRequested = searchParams.get('create') === '1';
  const filters = readCatalogFilters(searchParams);
  const groups = useMemo(() => buildCatalogGroups(workspace.products, workspace.storeAssortments, workspace.manualStores), [workspace.products, workspace.storeAssortments, workspace.manualStores]);
  const storeOptions = workspace.manualStores
    .filter((store) => filters.platform === 'all' || store.platform === filters.platform)
    .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
  const selectedStore = storeOptions.find((store) => store.id === filters.storeId);
  const effectiveFilters = { ...filters, storeId: selectedStore?.id ?? '' };
  const visible = useMemo(() => filterCatalogGroups(groups, effectiveFilters), [groups, filters.platform, filters.query, effectiveFilters.storeId]);
  const offerCount = visible.reduce((count, group) => count + group.offers.length, 0);
  const platformInitial = filters.platform === 'all' ? 'douyin' : filters.platform;

  useEffect(() => {
    if (canManage && createRequested) setCreateOpen(true);
  }, [canManage, createRequested]);

  function changeCreateOpen(open: boolean) {
    setCreateOpen(open);
    if (open || !searchParams.has('create')) return;
    const next = new URLSearchParams(searchParams);
    next.delete('create');
    setSearchParams(next, { replace: true });
  }

  function updateFilters(changes: { platform?: CatalogPlatformFilter; storeId?: string; query?: string }) {
    setSearchParams(withCatalogFilters(searchParams, changes), { replace: true });
  }

  function changePlatform(platform: CatalogPlatformFilter) {
    const next = withCatalogFilters(searchParams, { platform });
    const currentStore = workspace.manualStores.find((store) => store.id === filters.storeId);
    if (currentStore && platform !== 'all' && currentStore.platform !== platform) next.delete('storeId');
    setSearchParams(next, { replace: true });
  }

  return <div className="page-stack ops-page ops-page--catalog">
    <PageHeading title="商品" description="管理各店铺的商品、售价和佣金。" actions={canManage && <Button onClick={() => setCreateOpen(true)}><Plus size={15} />添加商品</Button>} />
    <PlatformTabs value={filters.platform} onChange={changePlatform} allowAll variant="pill" label="按平台筛选商品" />
    <Panel title="商品清单" description="同一商品只列一次；不同店铺的价格和佣金分别展示。">
      <div className="toolbar catalog-toolbar">
        <label className="catalog-store-filter"><span>店铺</span><select className="native-select" value={effectiveFilters.storeId} onChange={(event) => updateFilters({ storeId: event.target.value })} aria-label="按店铺筛选">
          <option value="">全部店铺</option>
          {storeOptions.map((store) => <option key={store.id} value={store.id}>{store.name} · {platformLabel(store.platform)}{!store.active ? ' · 已停用' : ''}</option>)}
        </select></label>
        <label className="search-field catalog-search"><Search size={14} /><input value={filters.query} onChange={(event) => updateFilters({ query: event.target.value })} placeholder="搜索商品、编码、规格或店铺" aria-label="搜索商品和店铺" /></label>
        <span className="toolbar-spacer" />
        <span className="table-result-count">{visible.length} 个商品 · {offerCount} 条店铺商品记录</span>
      </div>
      {visible.length ? <CatalogTable groups={visible} canManage={canManage} editProduct={setEditingProduct} editOffer={setEditingOffer} /> : <EmptyState
        title={filters.query || effectiveFilters.storeId ? '没有匹配商品' : workspace.products.length ? '当前平台暂无商品' : '还没有商品'}
        description={filters.query || effectiveFilters.storeId ? '调整平台、店铺或搜索词后再试。' : '添加商品及对应店铺，售价和佣金可以稍后补充。'}
        icon={<EmptyIllustration kind="products" />}
        action={canManage && !filters.query && !effectiveFilters.storeId && <Button size="sm" onClick={() => setCreateOpen(true)}><Plus size={14} />添加商品</Button>}
      />}
    </Panel>
    {canManage && <CatalogCreateDialog open={createOpen} onOpenChange={changeCreateOpen} initialPlatform={platformInitial} stores={workspace.manualStores} products={workspace.products} />}
    {canManage && editingProduct && <ProductInfoDialog product={editingProduct} onOpenChange={(open) => { if (!open) setEditingProduct(null); }} />}
    {canManage && editingOffer && <CatalogOfferDialog assortment={editingOffer} onOpenChange={(open) => { if (!open) setEditingOffer(null); }} />}
  </div>;
}

function CatalogTable({ groups, canManage, editProduct, editOffer }: {
  groups: ReturnType<typeof buildCatalogGroups>;
  canManage: boolean;
  editProduct: (product: Product) => void;
  editOffer: (assortment: StoreAssortment) => void;
}) {
  return <div className="table-wrap catalog-table-wrap"><table className="data-table catalog-table">
    <thead><tr><th>商品 / 编码 / 规格</th><th>店铺 / 平台</th><th>日常价 / 直播价</th><th>达人佣金</th><th>状态</th>{canManage && <th className="text-right">编辑</th>}</tr></thead>
    <tbody>{groups.map((group) => {
      const rowOffers: Array<CatalogOffer | null> = group.offers.length ? group.offers : [null];
      return rowOffers.map((offer, index) => <tr key={offer?.assortment.id ?? `${group.product.id}-unlinked`}>
        {index === 0 && <td className="catalog-product-cell" rowSpan={rowOffers.length}><span className="table-primary">{group.product.name}</span><span className="table-secondary">{group.product.brand}</span><span className="catalog-product-code">{group.product.sku ?? '未填商品编码'}{group.product.specification ? ` · ${group.product.specification}` : ''}</span></td>}
        {offer ? <CatalogOfferCell offer={offer} /> : <td className="catalog-unlinked-cell"><span className="table-primary">未关联店铺</span><span className="table-secondary">尚未添加店铺信息</span></td>}
        <td className="catalog-price-cell">{offer ? <><span>日常 {formatMoney(offer.assortment.priceCents)}</span><span className="table-secondary">直播 {formatMoney(offer.assortment.livePriceCents)}</span></> : <span className="catalog-no-offer">—</span>}</td>
        <td className="catalog-commission-cell">{offer ? offer.assortment.creatorCommissionBps === null ? '—' : `${(offer.assortment.creatorCommissionBps / 100).toFixed(2)}%` : <span className="catalog-no-offer">—</span>}</td>
        <td className="catalog-status-cell">{offer ? <CatalogOfferStatus product={group.product} offer={offer} /> : <StatusPill value={group.product.active ? 'unlinked' : 'inactive'} label={group.product.active ? '未关联店铺' : '商品已停用'} tone="neutral" />}</td>
        {canManage && <td className="catalog-action-cell"><div className="catalog-edit-stack">{index === 0 && <Button variant="outline" size="sm" className="small-button" onClick={() => editProduct(group.product)}>商品资料</Button>}{offer && <Button variant="outline" size="sm" className="small-button" onClick={() => editOffer(offer.assortment)}>售价与佣金</Button>}</div></td>}
      </tr>);
    })}</tbody>
  </table></div>;
}

function CatalogOfferCell({ offer }: { offer: CatalogOffer }) {
  return <td className="catalog-offer-cell"><span className="table-primary">{offer.store?.name ?? '店铺资料暂不可用'}</span><span className="table-secondary">{offer.store ? `${platformLabel(offer.store.platform)} · 店铺 ID ${offer.store.externalShopId}` : '平台资料暂不可用'}</span></td>;
}

function CatalogOfferStatus({ product, offer }: { product: Product; offer: CatalogOffer }) {
  const now = Date.now();
  const beforeStart = Boolean(offer.assortment.validFrom && Date.parse(offer.assortment.validFrom) > now);
  const afterEnd = Boolean(offer.assortment.validUntil && Date.parse(offer.assortment.validUntil) < now);
  if (!product.active) return <StatusPill value="inactive" label="商品已停用" tone="neutral" />;
  if (!offer.store) return <StatusPill value="inactive" label="店铺资料缺失" tone="orange" />;
  if (!offer.store.active) return <StatusPill value="inactive" label="店铺已停用" tone="neutral" />;
  if (!offer.assortment.active) return <StatusPill value="inactive" label="该店铺商品已停用" tone="neutral" />;
  if (beforeStart) return <StatusPill value="pending" label="未到有效期" tone="orange" />;
  if (afterEnd) return <StatusPill value="inactive" label="超出有效期" tone="neutral" />;
  return <StatusPill value="active" label="可用于新合作" tone="green" />;
}

function CatalogCreateDialog({ open, onOpenChange, initialPlatform, stores, products }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialPlatform: Platform;
  stores: ManualStore[];
  products: Product[];
}) {
  const { session, run, running, refresh } = useWorkbench();
  const [platform, setPlatform] = useState<Platform>(initialPlatform);
  const [storeChoice, setStoreChoice] = useState<StoreChoice>('existing');
  const [storeId, setStoreId] = useState('');
  const [productChoice, setProductChoice] = useState<ProductChoice>('existing');
  const [productId, setProductId] = useState('');
  const [error, setError] = useState('');
  const hasInitialStore = stores.some((store) => store.active && store.platform === initialPlatform);
  const existingStores = stores.filter((store) => store.active && store.platform === platform).sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
  const selectedStore = storeChoice === 'existing' ? existingStores.find((store) => store.id === storeId) : undefined;
  const productTeamId = selectedStore?.teamId ?? session.actor.teamId;
  const existingProducts = products.filter((product) => product.active && product.teamId === productTeamId).sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
  const hasProductContext = storeChoice === 'new' || Boolean(selectedStore);
  const effectiveProductChoice: ProductChoice = hasProductContext && existingProducts.length === 0 ? 'new' : productChoice;

  useEffect(() => {
    if (!open) return;
    setPlatform(initialPlatform);
    setStoreChoice(hasInitialStore ? 'existing' : 'new');
    setStoreId('');
    setProductChoice('existing');
    setProductId('');
    setError('');
  }, [hasInitialStore, initialPlatform, open]);

  function changePlatform(value: Platform) {
    setPlatform(value);
    setStoreId('');
    setStoreChoice(stores.some((store) => store.active && store.platform === value) ? 'existing' : 'new');
    setProductId('');
    setError('');
  }

  function changeStoreChoice(value: StoreChoice) {
    setStoreChoice(value);
    setError('');
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    const form = new FormData(event.currentTarget);
    try {
      const storePayload = storeChoice === 'existing'
        ? { storeId }
        : { newStore: { platform, externalShopId: requiredText(form, 'externalShopId', '请填写店铺 ID。'), name: requiredText(form, 'storeName', '请填写店铺名称。'), note: optionalText(form.get('storeNote')) } };
      if (storeChoice === 'existing' && !selectedStore) throw new Error('请选择当前平台下可用的店铺。');

      const productPayload = effectiveProductChoice === 'existing'
        ? { productId }
        : {
          newProduct: {
            brand: requiredText(form, 'brand', '请填写商品品牌。'),
            name: requiredText(form, 'productName', '请填写商品名称。'),
            sku: optionalText(form.get('sku')),
            specification: optionalText(form.get('specification')),
            sampleCostCents: optionalCents(form.get('sampleCost'), '样品成本格式无效，请填写不超过两位小数的非负金额。'),
            note: optionalText(form.get('productNote')),
          },
        };
      if (effectiveProductChoice === 'existing' && !existingProducts.some((product) => product.id === productId)) throw new Error('请选择当前店铺团队内可用的商品。');

      await run({
        type: 'catalog.saveProduct',
        ...storePayload,
        ...productPayload,
        priceCents: optionalCents(form.get('price'), '日常价格式无效，请填写不超过两位小数的非负金额。'),
        livePriceCents: optionalCents(form.get('livePrice'), '直播价格式无效，请填写不超过两位小数的非负金额。'),
        creatorCommissionBps: optionalCommissionBps(form.get('creatorCommissionPercent')),
      });
      toast.success('商品和店铺信息已保存');
      await refresh();
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败');
    }
  }

  return <Modal open={open} onOpenChange={onOpenChange} title="添加商品" description="先填写平台、店铺和商品，其他信息可以稍后补充。" className="modal-standard modal-wide catalog-create-dialog">
    <form className="modal-form catalog-create-form" onSubmit={submit} onInvalid={(event) => {
      const field = event.target;
      if (field instanceof HTMLElement) {
        const details = field.closest('details:not([open])');
        if (details instanceof HTMLDetailsElement) details.open = true;
      }
    }}>
      <div className="catalog-create-form-body">
        <section className="detail-section catalog-form-section">
          <div className="timeline-title-row"><h3>店铺</h3><span>商品归属的平台和店铺</span></div>
          <FormField label="平台" required><select className="native-select" value={platform} onChange={(event) => changePlatform(event.target.value as Platform)} required>{PLATFORMS.map((item) => <option key={item} value={item}>{platformLabel(item)}</option>)}</select></FormField>
          <div className="catalog-choice-row"><strong>店铺</strong><div className="catalog-choice-actions"><Button type="button" size="sm" variant={storeChoice === 'existing' ? 'default' : 'outline'} onClick={() => changeStoreChoice('existing')} disabled={!existingStores.length}>选择已有店铺</Button><Button type="button" size="sm" variant={storeChoice === 'new' ? 'default' : 'outline'} onClick={() => changeStoreChoice('new')}><Plus size={13} />新增店铺</Button></div></div>
          <div hidden={storeChoice !== 'existing'}><FormField className="catalog-existing-store" label="选择店铺" required><select className="native-select" value={storeId} onChange={(event) => { setStoreId(event.target.value); setProductId(''); }} required disabled={storeChoice !== 'existing' || !existingStores.length}><option value="">{existingStores.length ? '选择店铺' : '当前平台还没有可用店铺'}</option>{existingStores.map((store) => <option key={store.id} value={store.id}>{store.name} · 店铺 ID {store.externalShopId}</option>)}</select></FormField></div>
          <fieldset className="catalog-choice-fields" disabled={storeChoice !== 'new'}>
            <div className="form-grid">
              <FormField label="平台店铺 ID" required hint="用于区分同名店铺；从团队已有的平台导出资料复制完整编号，并与后续导入保持一致。"><Input name="externalShopId" required maxLength={300} placeholder="粘贴完整店铺编号" /></FormField>
              <FormField label="店铺名称" required><Input name="storeName" required placeholder="例如：品牌旗舰店" /></FormField>
              <details className="catalog-form-more">
                <summary><span>店铺备注（选填）</span><small>补充团队需要了解的信息</small></summary>
                <div className="catalog-form-more-content"><FormField label="店铺备注"><Textarea name="storeNote" rows={2} placeholder="填写补充说明" /></FormField></div>
              </details>
            </div>
          </fieldset>
        </section>
        <section className="detail-section catalog-form-section">
          <div className="timeline-title-row"><h3>商品</h3><span>同一商品可添加到不同店铺</span></div>
          <div className="catalog-choice-actions"><Button type="button" size="sm" variant={effectiveProductChoice === 'existing' ? 'default' : 'outline'} onClick={() => setProductChoice('existing')} disabled={!hasProductContext || !existingProducts.length}>选择已有商品</Button><Button type="button" size="sm" variant={effectiveProductChoice === 'new' ? 'default' : 'outline'} onClick={() => setProductChoice('new')}><Plus size={13} />新建商品</Button></div>
          {!hasProductContext && <p className="catalog-choice-hint">先选择店铺，再查看这个店铺团队已有的商品。</p>}
          {hasProductContext && existingProducts.length === 0 && <p className="catalog-choice-hint">当前店铺还没有商品，已为你切换到新建商品。</p>}
          <div hidden={effectiveProductChoice !== 'existing'}><FormField className="catalog-existing-product" label="选择商品" required><select className="native-select" value={productId} onChange={(event) => setProductId(event.target.value)} required disabled={effectiveProductChoice !== 'existing' || !hasProductContext || !existingProducts.length}><option value="">{hasProductContext ? '选择商品' : '选择店铺后再选择商品'}</option>{existingProducts.map((product) => <option key={product.id} value={product.id}>{product.brand} · {product.name}{product.sku ? ` · ${product.sku}` : ''}</option>)}</select></FormField></div>
          <fieldset className="catalog-choice-fields" disabled={effectiveProductChoice !== 'new'}>
            <div className="form-grid">
              <FormField label="品牌" required><Input name="brand" required defaultValue={session.businessWorkspace?.brandName ?? session.workbook?.brandName ?? ''} /></FormField>
              <FormField label="商品名称" required><Input name="productName" required placeholder="填写商品名称" /></FormField>
              <details className="catalog-form-more">
                <summary><span>商品补充信息（选填）</span><small>商品编码、规格、样品成本和备注</small></summary>
                <div className="form-grid catalog-form-more-content">
                  <FormField label="商品编码（SKU）"><Input name="sku" /></FormField>
                  <FormField label="规格"><Input name="specification" /></FormField>
                  <FormField label="样品成本参考（元）"><Input name="sampleCost" type="number" min={0} step="0.01" /></FormField>
                  <FormField label="商品备注"><Input name="productNote" /></FormField>
                </div>
              </details>
            </div>
          </fieldset>
        </section>
        <details className="catalog-form-more catalog-assortment-more">
          <summary><span>售价与佣金（选填）</span><small>价格和佣金按店铺分别记录</small></summary>
          <div className="form-grid catalog-form-more-content">
            <FormField label="日常价（元）"><Input name="price" type="number" min={0} step="0.01" /></FormField>
            <FormField label="直播价（元）"><Input name="livePrice" type="number" min={0} step="0.01" /></FormField>
            <FormField label="达人佣金（%）"><Input name="creatorCommissionPercent" type="number" min={0} max={100} step="0.01" /></FormField>
          </div>
        </details>
        {error && <p className="field-error" role="alert">{error}</p>}
      </div>
      <div className="modal-actions catalog-create-footer"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button><Button type="submit" disabled={running || (storeChoice === 'existing' && !storeId) || (effectiveProductChoice === 'existing' && !productId)}>{running ? '保存中…' : '保存商品'}</Button></div>
    </form>
  </Modal>;
}

function ProductInfoDialog({ product, onOpenChange }: { product: Product; onOpenChange: (open: boolean) => void }) {
  const { run, running, refresh } = useWorkbench();
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    const form = new FormData(event.currentTarget);
    try {
      await run({ type: 'product.update', productId: product.id, expectedVersion: product.version, brand: requiredText(form, 'brand', '请填写品牌。'), name: requiredText(form, 'name', '请填写商品名称。'), sku: optionalText(form.get('sku')), specification: optionalText(form.get('specification')), sampleCostCents: optionalCents(form.get('sampleCost'), '样品成本格式无效，请填写不超过两位小数的非负金额。'), note: optionalText(form.get('note')), active: form.get('active') === 'on' });
      toast.success('商品资料已更新');
      await refresh();
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败');
    }
  }
  return <Modal open onOpenChange={onOpenChange} title="编辑商品资料" description={product.name}>
    <form className="modal-form" onSubmit={submit}><div className="form-grid">
      <FormField label="品牌" required><Input name="brand" required defaultValue={product.brand} /></FormField>
      <FormField label="商品名称" required><Input name="name" required defaultValue={product.name} /></FormField>
      <FormField label="商品编码（SKU）"><Input name="sku" defaultValue={product.sku ?? ''} /></FormField>
      <FormField label="规格"><Input name="specification" defaultValue={product.specification ?? ''} /></FormField>
      <FormField label="样品成本参考（元）"><Input name="sampleCost" type="number" min={0} step="0.01" defaultValue={product.sampleCostCents === null ? '' : (product.sampleCostCents / 100).toFixed(2)} /></FormField>
      <FormField label="备注"><Input name="note" defaultValue={product.note ?? ''} /></FormField>
    </div><label className="check-row"><input name="active" type="checkbox" defaultChecked={product.active} />允许用于新业务</label>
    {error && <p className="field-error" role="alert">{error}</p>}
    <div className="modal-actions"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button><Button type="submit" disabled={running}>{running ? '保存中…' : '保存商品资料'}</Button></div></form>
  </Modal>;
}

function CatalogOfferDialog({ assortment, onOpenChange }: { assortment: StoreAssortment; onOpenChange: (open: boolean) => void }) {
  const { workspace, run, running, refresh } = useWorkbench();
  const [error, setError] = useState('');
  const store = workspace.manualStores.find((record) => record.id === assortment.storeId);
  const product = workspace.products.find((record) => record.id === assortment.productId);
  const details = [
    store ? `${platformLabel(store.platform)} · ${store.name} · 店铺 ID ${store.externalShopId}` : '店铺资料暂不可用',
    product ? `${product.name}${product.sku ? ` · SKU ${product.sku}` : ''}` : '商品资料暂不可用',
  ].join(' · ');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    const form = new FormData(event.currentTarget);
    try {
      await run({ type: 'assortment.update', assortmentId: assortment.id, expectedVersion: assortment.version, priceCents: optionalCents(form.get('price'), '日常价格式无效，请填写不超过两位小数的非负金额。'), livePriceCents: optionalCents(form.get('livePrice'), '直播价格式无效，请填写不超过两位小数的非负金额。'), creatorCommissionBps: optionalCommissionBps(form.get('creatorCommissionPercent')), active: form.get('active') === 'on' });
      toast.success('售价与佣金已更新');
      await refresh();
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败');
    }
  }
  return <Modal open onOpenChange={onOpenChange} title="修改售价与佣金" description={details}>
    <form className="modal-form" onSubmit={submit}><div className="form-grid">
      <FormField label="日常价（元）"><Input name="price" type="number" min={0} step="0.01" defaultValue={amountInput(assortment.priceCents)} /></FormField>
      <FormField label="直播价（元）"><Input name="livePrice" type="number" min={0} step="0.01" defaultValue={amountInput(assortment.livePriceCents)} /></FormField>
      <FormField label="达人佣金（%）"><Input name="creatorCommissionPercent" type="number" min={0} max={100} step="0.01" defaultValue={assortment.creatorCommissionBps === null ? '' : (assortment.creatorCommissionBps / 100).toFixed(2)} /></FormField>
    </div><label className="check-row"><input name="active" type="checkbox" defaultChecked={assortment.active} />允许用于新合作</label>
    {error && <p className="field-error" role="alert">{error}</p>}
    <div className="modal-actions"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button><Button type="submit" disabled={running}>{running ? '保存中…' : '保存修改'}</Button></div></form>
  </Modal>;
}

function optionalText(value: FormDataEntryValue | null): string | null {
  const text = String(value ?? '').trim();
  return text || null;
}

function requiredText(form: FormData, name: string, message: string): string {
  const value = String(form.get(name) ?? '').trim();
  if (!value) throw new Error(message);
  return value;
}

function optionalCents(value: FormDataEntryValue | null, errorMessage: string): number | null {
  const amount = String(value ?? '').trim();
  if (!amount) return null;
  const cents = parseNonnegativeCents(amount);
  if (cents === null) throw new Error(errorMessage);
  return cents;
}

function optionalCommissionBps(value: FormDataEntryValue | null): number | null {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const percent = Number(text);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new Error('达人佣金需填写 0–100 之间的百分比。');
  return Math.round(percent * 100);
}

function amountInput(value: number | null): string {
  return value === null ? '' : (value / 100).toFixed(2);
}
