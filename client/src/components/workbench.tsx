import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, ArrowUpRight, CircleHelp, Inbox, LoaderCircle, RefreshCw } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { MetricAmount } from '@shared/types';
import { ApiError } from '../api';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

export function FullPageLoading({ label = '加载中' }: { label?: string }) {
  return <main className="full-page-state"><LoaderCircle size={22} className="spin" aria-hidden="true" /><strong>{label}…</strong></main>;
}

export function FullPageError({ error, retry }: { error: unknown; retry?: () => void }) {
  const message = error instanceof Error ? error.message : '工作台暂时无法打开。';
  const loginUrl = error instanceof ApiError ? error.loginUrl : undefined;
  return (
    <main className="full-page-state error-state" role="alert">
      <span className="error-mark"><AlertCircle size={21} /></span>
      <strong>连接工作台失败</strong>
      <span>{message}</span>
      {loginUrl && <a className="button button-outline" href={loginUrl}>重新登录</a>}
      {retry && <Button variant="outline" onClick={retry}><RefreshCw size={15} />重试</Button>}
    </main>
  );
}

export function PageHeading({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="page-heading">
      <div className="page-heading-copy"><h1>{title}</h1>{description && <p>{description}</p>}</div>
      {actions && <div className="page-heading-actions">{actions}</div>}
    </div>
  );
}

export function Panel({ title, description, action, children, className = '' }: { title: string; description?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`panel ${className}`}>
      <div className="panel-heading"><div><h2>{title}</h2>{description && <p>{description}</p>}</div>{action && <div className="panel-action">{action}</div>}</div>
      {children}
    </section>
  );
}

export function MetricTile({ label, value, sub, icon, href, tone = 'blue' }: { label: string; value: string | number; sub?: string; icon?: ReactNode; href?: string; tone?: 'blue' | 'orange' | 'green' | 'neutral' }) {
  const body = <>
    <div className="metric-top"><span>{label}</span>{icon && <span className={`metric-icon tone-${tone}`}>{icon}</span>}</div>
    <div className="metric-value">{value}</div>
    {sub && <div className="metric-sub">{sub}</div>}
    {href && <ArrowUpRight className="metric-arrow" size={15} aria-hidden="true" />}
  </>;
  return href ? <Link to={href} className={`metric-tile metric-link tone-${tone}`}>{body}</Link> : <div className={`metric-tile tone-${tone}`}>{body}</div>;
}

const statusLabels: Record<string, string> = {
  uncontacted: '未建联', contacted: '已触达', responded: '有回应', negotiating: '洽谈中', cooperating: '合作中', paused: '暂停', declined: '不合作',
  draft: '草稿', pending_approval: '待审核', pending_shipment: '待发货', shipped: '已发货', received: '已签收', rejected: '已驳回', closed: '已关闭',
  pending_samples_shipment: '待寄样', pending_samples_receipt: '待签收', pending_delivery: '待交付', delivered: '已交付', cancelled: '已取消',
  planned: '计划中', rescheduled: '已改期', completed: '已完成', pending_submission: '待提交', pending_review: '待验收', returned: '待修改', approved: '已验收',
  paid: '已支付', pending: '处理中', unknown: '待核对', succeeded: '已成功', reversed: '已冲正', open: '待处理',
};

export function statusLabel(value: string) {
  return statusLabels[value] ?? value;
}

export function StatusPill({ value, label, tone }: { value: string; label?: string; tone?: 'neutral' | 'blue' | 'green' | 'orange' | 'red' }) {
  const derived = tone ?? statusTone(value);
  return <span className={`status-pill status-${derived}`}><span className="status-indicator" aria-hidden="true" />{label ?? statusLabel(value)}</span>;
}

function statusTone(value: string): 'neutral' | 'blue' | 'green' | 'orange' | 'red' {
  if (['cooperating', 'received', 'delivered', 'completed', 'approved', 'paid', 'succeeded'].includes(value)) return 'green';
  if (['pending_approval', 'pending_shipment', 'pending_samples_shipment', 'pending_samples_receipt', 'pending_delivery', 'pending_review', 'open', 'planned'].includes(value)) return 'orange';
  if (['rejected', 'declined', 'cancelled', 'closed', 'returned', 'unknown'].includes(value)) return value === 'unknown' ? 'neutral' : 'red';
  if (['contacted', 'responded', 'negotiating', 'shipped', 'pending'].includes(value)) return 'blue';
  return 'neutral';
}

export function HelpTip({ text, label = '说明' }: { text: string; label?: string }) {
  return <Tooltip>
    <TooltipTrigger asChild><button type="button" className="help-tip" aria-label={`${label}：${text}`}><CircleHelp size={13} aria-hidden="true" /></button></TooltipTrigger>
    <TooltipContent className="help-tip-content">{text}</TooltipContent>
  </Tooltip>;
}

export function EmptyState({ title, description, action, icon }: { title: string; description?: string; action?: ReactNode; icon?: ReactNode }) {
  return <div className="empty-state"><span className="empty-icon">{icon ?? <Inbox size={21} />}</span><strong>{title}</strong>{description && <p>{description}</p>}{action && <div className="empty-state-actions">{action}</div>}</div>;
}

const ModalActivityContext = createContext<((id: string, open: boolean) => void) | null>(null);

export function ModalActivityBoundary({ children, onActiveChange }: { children: ReactNode; onActiveChange: (active: boolean) => void }) {
  const openModals = useRef(new Set<string>());
  const [openCount, setOpenCount] = useState(0);
  const register = useCallback((id: string, open: boolean) => {
    if (open) openModals.current.add(id);
    else openModals.current.delete(id);
    setOpenCount(openModals.current.size);
  }, []);
  useEffect(() => { onActiveChange(openCount > 0); }, [openCount, onActiveChange]);
  return <ModalActivityContext.Provider value={register}>{children}</ModalActivityContext.Provider>;
}

export function Modal({ open, onOpenChange, title, description, children, className = 'modal-standard', onCloseAutoFocus }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; description?: string; children: ReactNode; className?: string; onCloseAutoFocus?: (event: Event) => void }) {
  const register = useContext(ModalActivityContext);
  const modalId = useId();
  useEffect(() => {
    if (!register || !open) return;
    register(modalId, true);
    return () => register(modalId, false);
  }, [register, modalId, open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={`workbench-modal ${className}`} onCloseAutoFocus={onCloseAutoFocus} onSubmit={(event) => event.stopPropagation()}>
        <DialogHeader className="modal-header"><DialogTitle>{title}</DialogTitle>{description && <DialogDescription>{description}</DialogDescription>}</DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

export function FormField({ label, hint, required, children, className = '' }: { label: string; hint?: string; required?: boolean; children: ReactNode; className?: string }) {
  return <label className={`form-field ${className}`}><span className="field-label">{label}{required && <b aria-hidden="true"> *</b>}</span>{children}{hint && <small>{hint}</small>}</label>;
}

export function formatMoney(cents: number | null | undefined, currency = '¥') {
  if (cents === null || cents === undefined) return '—';
  return `${currency}${new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100)}`;
}

export function formatCompactMoney(cents: number | null | undefined) {
  if (cents === null || cents === undefined) return '—';
  const yuan = cents / 100;
  if (Math.abs(yuan) >= 10_000) return `¥${(yuan / 10_000).toFixed(1)} 万`;
  return formatMoney(cents);
}

export function formatDateTime(value: string | null | undefined) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

export function formatDate(value: string | null | undefined) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export function shanghaiDateKey(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export function shanghaiDateTimeInput(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
}

export function shanghaiInputToIso(value: string) {
  if (!value) return new Date().toISOString();
  const withSeconds = value.length === 16 ? `${value}:00` : value;
  return new Date(`${withSeconds}+08:00`).toISOString();
}

export function knownAmount(amount: MetricAmount) {
  return `${formatMoney(amount.knownCents)}${amount.complete ? '' : ' · 部分数据'}`;
}
