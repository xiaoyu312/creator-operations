import { useState } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import type { Cooperation } from '@shared/types';
import { useWorkbench } from '../workbench-context';
import { Button } from './ui/button';
import { EmptyState, Panel, StatusPill, formatDateTime } from './workbench';
import { compareTimestamps } from '../lib/time';
import { accountForPlatform } from '../lib/platform-presentation';
import { CooperationActionDialog, CooperationDetail, CreateCooperationDialog, cooperationLabel } from '../pages/CooperationsPage';

type CooperationActionKind = 'decision' | 'cancel' | 'waive' | 'delivery';

export function CreatorCooperationPanel({ creatorId }: { creatorId: string }) {
  const { workspace, session, refresh } = useWorkbench();
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [actionKind, setActionKind] = useState<CooperationActionKind | null>(null);
  const creator = workspace.creators.find((item) => item.id === creatorId);
  const cooperations = workspace.cooperations
    .filter((item) => item.creatorId === creatorId && (session.actor.role !== 'bd' || item.ownerMemberId === session.actor.memberId))
    .sort((a, b) => compareTimestamps(a.updatedAt, b.updatedAt, 'desc'));
  const selected = selectedId ? workspace.cooperations.find((item) => item.id === selectedId) ?? null : null;
  const canCreate = Boolean(creator && (session.actor.role === 'admin'
    || session.actor.role === 'manager'
    || (session.actor.role === 'bd' && creator.ownerMemberId === session.actor.memberId)));

  function openDetails(item: Cooperation) {
    setSelectedId(item.id);
    setDetailOpen(true);
  }

  function closeDetails(open: boolean) {
    setDetailOpen(open);
    if (!open) setSelectedId(null);
  }

  function openAction(item: Cooperation, kind: CooperationActionKind) {
    setSelectedId(item.id);
    setDetailOpen(false);
    setActionKind(kind);
  }

  return <>
    <Panel
      title="合作约定"
      className="creator-cooperation-panel"
      action={<div className="inline-actions"><Button type="button" variant="outline" size="sm" onClick={() => void refresh()}><RefreshCw size={13} />刷新</Button>{canCreate && <Button type="button" size="sm" onClick={() => setCreateOpen(true)}><Plus size={14} />新建合作约定</Button>}</div>}
    >
      {cooperations.length === 0
        ? <EmptyState title="还没有合作约定" description={canCreate ? '先建立合作约定，提交并完成审核后即可用于排期。' : '当前达人还没有合作约定。'} action={canCreate && <Button type="button" size="sm" onClick={() => setCreateOpen(true)}><Plus size={14} />建立合作约定</Button>} />
        : <div className="creator-cooperation-list">{cooperations.map((item) => {
          const creatorAccount = accountForPlatform(creator?.accounts ?? []);
          return <article className="detail-section" key={item.id}>
            <div className="timeline-title-row"><strong>{item.title}</strong><StatusPill value={item.status} label={cooperationLabel(item.status)} /></div>
            <p className="detail-note">{creatorAccount?.displayName ?? creator?.name ?? '达人信息暂不可用'} · {item.lines.map((line) => line.productName).join('、') || '尚未添加商品'}</p>
            <p className="detail-note">{item.startAt ? formatDateTime(item.startAt) : '开始时间待定'} 至 {item.endAt ? formatDateTime(item.endAt) : '结束时间待定'}</p>
            <div className="detail-actions"><Button type="button" size="sm" variant="outline" onClick={() => openDetails(item)}>查看约定与处理</Button></div>
          </article>;
        })}</div>}
    </Panel>
    {creator && <CreateCooperationDialog open={createOpen} onOpenChange={setCreateOpen} initialCreatorId={creator.id} />}
    {selected && <CooperationDetail item={selected} open={detailOpen} onOpenChange={closeDetails} onAction={openAction} />}
    {selected && actionKind && <CooperationActionDialog item={selected} kind={actionKind} onOpenChange={(open) => { if (!open) { setActionKind(null); setDetailOpen(true); } }} />}
  </>;
}
