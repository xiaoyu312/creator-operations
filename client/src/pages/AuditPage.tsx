import { useMemo, useState } from 'react';
import '../operations-surfaces.css';
import { Search } from 'lucide-react';
import type { AuditEvent } from '@shared/types';
import { useWorkbench } from '../workbench-context';
import { Button } from '../components/ui/button';
import { EmptyState, Modal, PageHeading, Panel, formatDateTime } from '../components/workbench';
import { compareTimestamps } from '../lib/time';

const entityLabels: Record<string, string> = {
  member: '成员', creator: '达人', followup: '跟进', task: '待办', product: '商品', sample: '样品申请', sample_package: '样品包裹',
  cooperation: '合作单', schedule: '排期', delivery: '交付', order: '订单', refund: '退款', import: '导入批次',
  export: '数据导出', manual_store: '店铺资料', store_assortment: '商品货盘', creator_product_proposal: '推品提案',
  partner_resource: '团长与机构', cooperation_partner_link: '合作方关联', content_asset: '内容资产',
  content_observation: '内容指标记录', commercial_ledger_entry: '费用台账', team_monthly_target: '团队月目标',
};

const actionLabels: Record<string, string> = {
  'assortment.created': '新增商品货盘',
  'assortment.updated': '更新商品货盘',
  'content_asset.created': '新增内容资料',
  'content_asset.creator_merged': '合并内容关联达人',
  'content_asset.rights_updated': '更新内容授权',
  'content_asset.updated': '更新内容资料',
  'content_observation.appended': '登记内容指标',
  'cooperation.cancelled': '取消合作',
  'cooperation.created': '新建合作',
  'cooperation.delivered': '完成合作交付',
  'cooperation.draft_updated': '更新合作草稿',
  'cooperation.handed_off': '转交合作负责人',
  'cooperation.rejected': '驳回合作',
  'cooperation.approved': '通过合作审核',
  'cooperation.sample_linked': '关联寄样申请',
  'cooperation.sample_reapplication': '重新申请寄样',
  'cooperation.sample_replaced': '更换寄样商品',
  'cooperation.samples_received': '确认样品签收',
  'cooperation.samples_shipped': '确认样品发货',
  'cooperation.samples_waived': '取消寄样要求',
  'cooperation.submitted': '提交合作审核',
  'cooperation_partner_link.created': '关联合作资源',
  'cooperation_partner_link.updated': '更新合作资源关联',
  'creator.account_added': '添加达人平台账号',
  'creator.account_attached': '关联达人平台账号',
  'creator.account_updated': '更新达人平台账号',
  'creator.brand_linked': '关联达人到品牌',
  'creator.brand_relationship_updated': '更新达人合作关系',
  'creator.contact_updated': '更新达人联系方式',
  'creator.created': '新建达人',
  'creator.merged': '合并达人档案',
  'creator.merged_into': '将达人档案合并到其他达人',
  'creator.owner_changed': '修改达人负责人',
  'creator.owner_history_coalesced': '整理负责人记录',
  'creator.profile_created': '新建达人档案',
  'creator.profile_updated': '更新达人档案',
  'creator.stage_advanced_from_followup': '根据跟进更新达人阶段',
  'creator.stage_changed': '调整达人阶段',
  'creator.transferred': '转交达人负责人',
  'creator.updated': '更新达人资料',
  'delivery.approved': '验收通过',
  'delivery.cancelled': '取消交付',
  'delivery.cancelled_by_cooperation': '合作取消，关闭交付',
  'delivery.created': '新增交付要求',
  'delivery.handed_off': '转交交付负责人',
  'delivery.returned': '退回交付修改',
  'delivery.submitted': '提交交付',
  'export.creators': '导出达人档案',
  'export.samples': '导出寄样记录',
  'export.cooperations': '导出合作记录',
  'export.schedules': '导出排期记录',
  'export.deliveries': '导出交付记录',
  'export.orders': '导出订单',
  'export.refunds': '导出退款记录',
  'export.tasks': '导出待办',
  'followup.created': '记录达人跟进',
  'ledger_entry.recorded': '登记费用',
  'ledger_entry.voided': '作废费用记录',
  'manual_store.created': '新增店铺资料',
  'manual_store.updated': '更新店铺资料',
  'member.created': '新增成员',
  'member.handoff_completed': '完成人员交接',
  'member.updated': '更新成员信息',
  'order.owner_corrected': '修改订单负责人',
  'order.source_reconciled': '核对订单信息',
  'partner_resource.created': '新增合作资源',
  'partner_resource.updated': '更新合作资源',
  'product.created': '新增商品',
  'product.updated': '更新商品',
  'proposal.accepted': '达人接受推品',
  'proposal.cancelled': '关闭推品提案',
  'proposal.converted': '推品提案转为合作',
  'proposal.created': '新建推品提案',
  'proposal.creator_merged': '合并推品提案关联达人',
  'proposal.draft_updated': '更新推品提案',
  'proposal.proposed_recorded': '提交推品提案',
  'proposal.rejected': '达人拒绝推品',
  'refund.source_reconciled': '核对退款信息',
  'sample.approved': '通过寄样申请',
  'sample.closed': '关闭寄样申请',
  'sample.closed_by_cooperation_cancel': '合作取消，关闭寄样申请',
  'sample.closed_by_waiver': '取消寄样申请',
  'sample.created': '新建寄样申请',
  'sample.draft_updated': '更新寄样申请',
  'sample.package_received': '登记样品签收',
  'sample.package_scope_handed_off': '转交样品包裹',
  'sample.package_shipped': '登记样品发货',
  'sample.receipt_updated': '更新样品签收信息',
  'sample.rejected': '驳回寄样申请',
  'sample.shipped': '确认样品已发货',
  'sample.shipping_halted_by_cooperation_cancel': '合作取消，停止寄样发货',
  'sample.submitted': '提交寄样审核',
  'sample.superseded_for_reapplication': '重新申请寄样',
  'sample.team_handoff': '转交寄样负责人',
  'schedule.cancelled': '取消直播排期',
  'schedule.cancelled_by_cooperation': '合作取消，关闭排期',
  'schedule.completed': '登记直播完成',
  'schedule.created': '新增直播排期',
  'schedule.handed_off': '转交排期负责人',
  'schedule.rescheduled': '调整直播排期',
  'task.completed': '完成待办',
  'task.completed_by_business_action': '完成待办',
  'task.completed_by_cancellation': '取消业务后完成待办',
  'task.created': '新建待办',
  'task.handed_off': '转交待办负责人',
  'task.queued': '创建跟进待办',
  'team_target.created': '设置团队目标',
  'team_target.updated': '更新团队目标',
};

function actionLabel(action: string) {
  return actionLabels[action] ?? '更新记录';
}

export default function AuditPage() {
  const { workspace } = useWorkbench();
  const [query, setQuery] = useState('');
  const [entity, setEntity] = useState('all');
  const [selected, setSelected] = useState<AuditEvent | null>(null);
  const events = useMemo(() => workspace.auditEvents.filter((event) => {
    if (entity !== 'all' && event.entityType !== entity) return false;
    const actor = workspace.members.find((member) => member.id === event.actorId);
    const content = `${actor?.displayName ?? ''} ${event.entityId} ${actionLabel(event.action)} ${event.reason ?? ''}`.toLowerCase();
    return !query.trim() || content.includes(query.trim().toLowerCase());
  }).sort((a, b) => compareTimestamps(a.occurredAt, b.occurredAt, 'desc')), [workspace.auditEvents, workspace.members, entity, query]);

  return <div className="page-stack ops-page ops-page--audit">
    <PageHeading title="操作记录" description="查看达人、合作、订单和成员变更记录。" />
    <Panel title="操作记录" description={`${events.length} 条记录`}>
      <div className="toolbar"><label className="search-field"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索成员或操作" aria-label="搜索操作记录" /></label><select className="filter-select" value={entity} onChange={(event) => setEntity(event.target.value)} aria-label="按业务对象筛选"><option value="all">所有对象</option>{Object.entries(entityLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><span className="toolbar-spacer" /></div>
      {events.length ? <div className="table-wrap"><table className="data-table audit-table"><thead><tr><th>发生时间</th><th>操作人</th><th>业务对象</th><th>操作</th><th>原因 / 摘要</th><th className="text-right">详情</th></tr></thead><tbody>{events.map((event) => {
        const actor = workspace.members.find((member) => member.id === event.actorId);
        return <tr key={event.id}><td>{formatDateTime(event.occurredAt)}</td><td>{actor?.displayName ?? '系统 / 已停用成员'}</td><td><span className="table-primary">{entityLabels[event.entityType] ?? event.entityType}</span></td><td><span className="audit-action">{actionLabel(event.action)}</span></td><td>{event.reason ?? '—'}</td><td className="table-action-cell"><button className="link-button" onClick={() => setSelected(event)}>查看</button></td></tr>;
      })}</tbody></table></div> : <EmptyState title="没有匹配的操作记录" description={workspace.auditEvents.length ? '调整筛选条件。' : '业务操作发生后，记录会显示在这里。'} />}
    </Panel>
    {selected && <AuditDetail event={selected} open onOpenChange={(open) => { if (!open) setSelected(null); }} />}
  </div>;
}

function AuditDetail({ event, open, onOpenChange }: { event: AuditEvent; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { workspace } = useWorkbench();
  const actor = workspace.members.find((member) => member.id === event.actorId);
  const changedKeys = Array.from(new Set([...Object.keys(event.before ?? {}), ...Object.keys(event.after ?? {})]));
  const changedLabels: Record<string, string> = {
    status: '状态', teamId: '团队', ownerMemberId: '负责人', businessOwnerName: '商务名称', active: '成员状态',
    dueAt: '截止时间', nextAction: '下一步行动', nextActionDueAt: '下一步期限', note: '备注', reason: '原因',
    creatorId: '达人', productId: '商品', orderId: '订单', platform: '平台', effectiveAt: '生效时间',
  };
  return <Modal open={open} onOpenChange={onOpenChange} title={`${entityLabels[event.entityType] ?? event.entityType} · ${actionLabel(event.action)}`}>
    <dl className="audit-detail-grid"><div><dt>操作人</dt><dd>{actor?.displayName ?? '系统 / 已停用成员'}</dd></div><div><dt>发生时间</dt><dd>{formatDateTime(event.occurredAt)}</dd></div><div><dt>变更内容</dt><dd>{changedKeys.length ? [...new Set(changedKeys.map((key) => changedLabels[key] ?? '其他信息'))].join('、') : '暂无变更内容'}</dd></div></dl>
    {event.reason && <div className="audit-reason"><strong>操作原因</strong><p>{event.reason}</p></div>}
    <div className="modal-actions"><Button variant="outline" onClick={() => onOpenChange(false)}>关闭</Button></div>
  </Modal>;
}
