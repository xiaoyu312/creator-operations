import { useId, useMemo, useState, type FormEvent } from 'react';
import { format, parseISO } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { CalendarDays, ChevronDown, ExternalLink, Pencil, Plus } from 'lucide-react';
import type { CreatorAccount, CreatorCommerceType, CreatorSessionRecord } from '@shared/types';
import { useWorkbench } from '../workbench-context';
import { Button } from './ui/button';
import { Calendar } from './ui/calendar';
import { Checkbox } from './ui/checkbox';
import { Input } from './ui/input';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { Textarea } from './ui/textarea';
import { EmptyState, FormField, Modal, formatDate, formatMoney, shanghaiDateKey } from './workbench';
import { platformLabel, type CreatorPlatformFilter } from '../lib/platform-presentation';
import '../creators-reference.css';

const commerceTypeLabels: Record<CreatorCommerceType, string> = {
  short_video: '短视频带货',
  live: '直播带货',
};
const EMPTY_CREATOR_SESSIONS: CreatorSessionRecord[] = [];

interface CreatorSessionHistoryProps {
  creatorId: string;
  accounts: CreatorAccount[];
  canEdit: boolean;
  platform?: CreatorPlatformFilter;
}

export default function CreatorSessionHistory({ creatorId, accounts, canEdit, platform = 'all' }: CreatorSessionHistoryProps) {
  const { workspace } = useWorkbench();
  const [editingSession, setEditingSession] = useState<CreatorSessionRecord | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const creatorSessions = workspace.creatorSessions ?? EMPTY_CREATOR_SESSIONS;
  const sessions = useMemo(() => creatorSessions
    .filter((session) => session.creatorId === creatorId && (platform === 'all' || session.platform === platform))
    .sort((a, b) => b.occurredOn.localeCompare(a.occurredOn) || b.createdAt.localeCompare(a.createdAt)),
  [creatorSessions, creatorId, platform]);
  const activeAccounts = accounts.filter((account) => account.active && (platform === 'all' || account.platform === platform));

  return <>
    <section className="detail-section creator-session-history" aria-label="达人历史场次表现">
      <div className="timeline-title-row">
        <div>
          <h3>历史场次与表现</h3>
          <p className="creator-session-intro">仅展示手工补录记录，与平台订单数据分开。</p>
        </div>
        <div className="creator-session-heading-actions">
          <span>{sessions.length} 条</span>
          {canEdit && <Button size="sm" onClick={() => setCreateOpen(true)} disabled={activeAccounts.length === 0}>
            <Plus size={14} aria-hidden="true" />添加记录
          </Button>}
        </div>
      </div>
      {sessions.length ? <ol className="creator-session-list">
        {sessions.map((session) => {
          const account = accounts.find((item) => item.id === session.creatorAccountId);
          const products = session.productIds.map((productId) => workspace.products.find((product) => product.id === productId)?.name ?? '商品档案不可用');
          return <li className="creator-session-item" key={session.id}>
            <div className="creator-session-item-main">
              <div className="creator-session-item-title">
                <strong>{session.title}</strong>
                <span className="creator-session-manual-label">手工补录</span>
              </div>
              <div className="creator-session-meta">
                <span>{formatDate(session.occurredOn)}</span>
                <span>{platformLabel(session.platform)} · {account?.displayName ?? '账号已不可用'}</span>
                <span>{commerceTypeLabels[session.commerceType]}</span>
              </div>
              <div className="creator-session-metrics">
                <span>GMV <strong>{session.gmvCents === null ? '未填写' : formatMoney(session.gmvCents)}</strong></span>
                <span>订单数 <strong>{session.orderCount === null ? '未填写' : session.orderCount}</strong></span>
                {products.length > 0 && <span>商品 <strong>{products.join('、')}</strong></span>}
              </div>
              {session.note && <p className="creator-session-note">{session.note}</p>}
            </div>
            <div className="creator-session-item-actions">
              {session.contentUrl && <a href={session.contentUrl} target="_blank" rel="noreferrer" aria-label={`打开${session.title}的内容链接`}>
                内容链接 <ExternalLink size={12} aria-hidden="true" />
              </a>}
              {canEdit && <Button size="sm" variant="ghost" onClick={() => setEditingSession(session)} aria-label={`编辑${session.title}的手工记录`}>
                <Pencil size={13} aria-hidden="true" />编辑
              </Button>}
            </div>
          </li>;
        })}
      </ol> : <EmptyState title="暂无手工补录场次" description="可按平台账号录入历史日期、场次信息与可确认的表现数据。" action={canEdit && activeAccounts.length > 0 ? <Button size="sm" variant="outline" onClick={() => setCreateOpen(true)}>添加第一条记录</Button> : undefined} />}
      {canEdit && activeAccounts.length === 0 && <p className="creator-session-hint">请先添加有效的平台账号，再补录历史场次。</p>}
    </section>
    {createOpen && <CreatorSessionDialog creatorId={creatorId} accounts={activeAccounts} onClose={() => setCreateOpen(false)} />}
    {editingSession && <CreatorSessionDialog creatorId={creatorId} accounts={accounts} session={editingSession} onClose={() => setEditingSession(null)} />}
  </>;
}

function CreatorSessionDialog({ creatorId, accounts, session, onClose }: {
  creatorId: string;
  accounts: CreatorAccount[];
  session?: CreatorSessionRecord;
  onClose: () => void;
}) {
  const { workspace, run, running } = useWorkbench();
  const selectableAccounts = session
    ? accounts.filter((account) => account.active || account.id === session.creatorAccountId)
    : accounts.filter((account) => account.active);
  const [accountId, setAccountId] = useState(session?.creatorAccountId ?? selectableAccounts[0]?.id ?? '');
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>(session?.productIds ?? []);
  const [commerceType, setCommerceType] = useState<CreatorCommerceType>(session?.commerceType ?? 'short_video');
  const [occurredOn, setOccurredOn] = useState(session?.occurredOn ?? shanghaiDateKey(new Date()));
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [error, setError] = useState('');
  const productPickerId = useId();
  const availableProducts = workspace.products.filter((product) => product.active || session?.productIds.includes(product.id));
  const availableProductIds = new Set(availableProducts.map((product) => product.id));
  const unavailableProductIds = selectedProductIds.filter((productId) => !availableProductIds.has(productId));
  const selectedProductSummary = selectedProductIds.map((productId) => workspace.products.find((product) => product.id === productId)?.name ?? '历史商品关联（档案不可用）');
  const productTriggerLabel = selectedProductSummary.length === 0
    ? '不关联商品'
    : `${selectedProductSummary.slice(0, 2).join('、')}${selectedProductSummary.length > 2 ? ` 等 ${selectedProductSummary.length} 个` : ''}`;
  const title = session ? '编辑手工场次记录' : '补录历史场次';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    const form = new FormData(event.currentTarget);
    const titleValue = String(form.get('title') ?? '').trim();
    const gmvText = String(form.get('gmv') ?? '').trim();
    const orderText = String(form.get('orderCount') ?? '').trim();
    const gmvValue = gmvText === '' ? null : Number(gmvText);
    const orderValue = orderText === '' ? null : Number(orderText);
    if (!accountId) { setError('请选择平台账号。'); return; }
    if (!occurredOn) { setError('请选择场次日期。'); return; }
    if (gmvValue !== null && (!Number.isFinite(gmvValue) || gmvValue < 0 || Math.abs(gmvValue * 100 - Math.round(gmvValue * 100)) > 1e-7)) {
      setError('GMV 请填写大于或等于 0 的金额，最多保留两位小数。');
      return;
    }
    if (orderValue !== null && (!Number.isInteger(orderValue) || orderValue < 0)) {
      setError('订单数请填写大于或等于 0 的整数。');
      return;
    }
    const fields = {
      creatorAccountId: accountId,
      commerceType,
      occurredOn,
      title: titleValue,
      productIds: selectedProductIds,
      gmvCents: gmvValue === null ? null : Math.round(gmvValue * 100),
      orderCount: orderValue,
      contentUrl: String(form.get('contentUrl') ?? '').trim() || null,
      note: String(form.get('note') ?? '').trim() || null,
    };
    try {
      if (session) {
        await run({ type: 'creator.session.update', sessionId: session.id, expectedVersion: session.version, ...fields });
      } else {
        await run({ type: 'creator.session.create', creatorId, ...fields });
      }
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败，请重试。');
    }
  }

  function toggleProduct(productId: string, checked: boolean) {
    setSelectedProductIds((current) => checked
      ? current.includes(productId) ? current : [...current, productId]
      : current.filter((selectedId) => selectedId !== productId));
  }

  const selectedDate = occurredOn ? parseISO(occurredOn) : undefined;
  return <Modal open onOpenChange={(open) => { if (!open) onClose(); }} title={title} description="记录按所属平台账号保存为手工资料；留空的 GMV 或订单数会显示为未填写。" className="modal-standard modal-wide">
    <form className="modal-form creator-session-form" onSubmit={submit}>
      <div className="form-grid">
        <FormField label="平台账号" required>
          <select className="native-select" value={accountId} onChange={(event) => setAccountId(event.target.value)} required aria-label="选择历史场次的平台账号">
            <option value="" disabled>选择平台账号</option>
            {selectableAccounts.map((account) => <option value={account.id} key={account.id}>{platformLabel(account.platform)} · {account.displayName}{account.active ? '' : '（已停用）'}</option>)}
          </select>
        </FormField>
        <FormField label="带货类型" required>
          <select className="native-select" value={commerceType} onChange={(event) => setCommerceType(event.target.value as CreatorCommerceType)} aria-label="选择历史场次的带货类型">
            <option value="short_video">短视频带货</option>
            <option value="live">直播带货</option>
          </select>
        </FormField>
        <FormField label="场次日期" required>
          <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
            <PopoverTrigger asChild><Button type="button" variant="outline" className="creator-session-date-trigger" aria-label={`场次日期：${occurredOn || '未选择'}`}>
              <CalendarDays size={15} aria-hidden="true" />{occurredOn ? formatDate(occurredOn) : '选择日期'}
            </Button></PopoverTrigger>
            <PopoverContent align="start" className="w-auto p-0">
              <Calendar locale={zhCN} mode="single" selected={selectedDate} onSelect={(date) => { if (date) setOccurredOn(format(date, 'yyyy-MM-dd')); setCalendarOpen(false); }} initialFocus />
            </PopoverContent>
          </Popover>
          <input type="hidden" name="occurredOn" value={occurredOn} />
        </FormField>
        <FormField label="场次 / 内容名称" required><Input name="title" defaultValue={session?.title ?? ''} required maxLength={300} placeholder="例如：9 月专场直播" /></FormField>
        <FormField label="关联商品">
          <Popover>
            <PopoverTrigger asChild><Button type="button" variant="outline" className="creator-session-product-trigger" aria-label={`关联商品，已选 ${selectedProductIds.length} 个`}>
              <span>{productTriggerLabel}</span><ChevronDown size={14} aria-hidden="true" />
            </Button></PopoverTrigger>
            <PopoverContent align="start" className="creator-session-products-popover">
              <div className="creator-session-product-options" aria-label="选择关联商品">
                {availableProducts.map((product) => {
                  const optionId = `${productPickerId}-${product.id}`;
                  return <div className="creator-session-product-option" key={product.id}>
                    <Checkbox id={optionId} checked={selectedProductIds.includes(product.id)} onCheckedChange={(checked) => toggleProduct(product.id, checked === true)} />
                    <label htmlFor={optionId}>{product.brand} · {product.name}{product.sku ? ` · ${product.sku}` : ''}</label>
                  </div>;
                })}
                {unavailableProductIds.map((productId, index) => {
                  const optionId = `${productPickerId}-unavailable-${index}`;
                  return <div className="creator-session-product-option" key={productId}>
                    <Checkbox id={optionId} checked onCheckedChange={(checked) => toggleProduct(productId, checked === true)} />
                    <label htmlFor={optionId}>历史商品关联（档案不可用）</label>
                  </div>;
                })}
                {availableProducts.length === 0 && unavailableProductIds.length === 0 && <p className="creator-session-products-empty">暂无可关联商品，可留空保存。</p>}
              </div>
            </PopoverContent>
          </Popover>
        </FormField>
        <FormField label="GMV（元）" hint="只记录可确认的历史值；未知请留空。"><Input name="gmv" type="number" min={0} step="0.01" inputMode="decimal" defaultValue={session?.gmvCents === null || session?.gmvCents === undefined ? '' : (session.gmvCents / 100).toFixed(2)} placeholder="可留空" /></FormField>
        <FormField label="订单数" hint="未知请留空；0 表示已确认没有订单。"><Input name="orderCount" type="number" min={0} step={1} inputMode="numeric" defaultValue={session?.orderCount ?? ''} placeholder="可留空" /></FormField>
        <FormField label="内容链接"><Input name="contentUrl" type="url" defaultValue={session?.contentUrl ?? ''} placeholder="https://" /></FormField>
        <FormField label="补充说明" className="span-2"><Textarea name="note" rows={3} maxLength={4000} defaultValue={session?.note ?? ''} placeholder="来源口径、记录人补充说明等" /></FormField>
      </div>
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="modal-actions"><Button type="button" variant="outline" onClick={onClose}>取消</Button><Button type="submit" disabled={running}>{running ? '保存中…' : session ? '保存修改' : '保存记录'}</Button></div>
    </form>
  </Modal>;
}
