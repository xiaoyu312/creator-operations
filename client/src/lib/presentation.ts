import type { DataMode, Role, WorkspaceSnapshot } from '../../../shared/types.ts';

export type WalkthroughStepId = 'creator' | 'sample' | 'schedule' | 'orders';

export interface WalkthroughStep {
  id: WalkthroughStepId;
  label: string;
  title: string;
  explanation: string;
  available: boolean;
  href: string | null;
  targetName?: string;
  relatedHref?: string;
  relatedLabel?: string;
}

export interface WalkthroughPlan {
  creatorId: string;
  creatorName: string;
  caseLabel: string;
  relatedCooperationId: string | null;
  steps: WalkthroughStep[];
}

export type DemoWalkthroughSelection =
  | { status: 'ready'; plan: WalkthroughPlan }
  | { status: 'not_demo'; message: string }
  | { status: 'unsupported_role'; message: string; fallbackHref: string; fallbackLabel: string }
  | { status: 'missing_creator'; message: string; fallbackHref: string; fallbackLabel: string };

export interface DailyStartingPoint {
  title: string;
  description: string;
  href: string;
  actionLabel: string;
}

interface ActorScope {
  memberId: string;
  role: Role;
}

/** Selects existing records from the current visible scope; it never creates or links records. */
export function selectDemoWalkthrough(
  workspace: WorkspaceSnapshot,
  actor: ActorScope,
  dataMode: DataMode,
): DemoWalkthroughSelection {
  if (dataMode !== 'demo') return { status: 'not_demo', message: '演示路线只在 DEMO 环境提供。' };
  if (actor.role === 'ops') {
    return {
      status: 'unsupported_role',
      message: '当前身份负责样品履约，可从样品队列开始；完整商务演示需要商务或管理视角。',
      fallbackHref: '/samples',
      fallbackLabel: '查看样品履约',
    };
  }

  const permittedCreators = workspace.creators.filter((creator) => {
    if (!workspace.scope.teamIds.includes(creator.teamId)) return false;
    if (actor.role === 'bd') return creator.ownerMemberId === actor.memberId;
    return actor.role === 'admin' || actor.role === 'manager';
  });
  const creator = permittedCreators
    .map((item) => ({ creator: item, score: creatorEvidenceScore(item, workspace) }))
    .sort((a, b) => b.score - a.score || a.creator.id.localeCompare(b.creator.id))[0]?.creator;

  if (!creator) {
    return {
      status: 'missing_creator',
      message: '当前授权范围内没有可用于演示的达人记录，演示计划尚未启动。',
      fallbackHref: actor.role === 'bd' ? '/creators?scope=mine' : '/creators?scope=team',
      fallbackLabel: actor.role === 'bd' ? '查看我的达人' : '查看团队达人',
    };
  }

  const creatorSamples = workspace.samples
    .filter((item) => item.creatorId === creator.id && item.teamId === creator.teamId)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id));
  const creatorSchedules = workspace.schedules
    .filter((item) => item.creatorId === creator.id && item.teamId === creator.teamId)
    .sort((a, b) => {
      const statusRank = (status: typeof a.status) => status === 'planned' || status === 'rescheduled' ? 2 : status === 'completed' ? 1 : 0;
      return statusRank(b.status) - statusRank(a.status)
        || Date.parse(b.plannedStartAt) - Date.parse(a.plannedStartAt)
        || a.id.localeCompare(b.id);
    });
  const paidOrders = workspace.orders
    .filter((item) => item.creatorId === creator.id && item.teamId === creator.teamId && item.status === 'paid')
    .sort((a, b) => Date.parse(b.paidAt ?? b.createdAt) - Date.parse(a.paidAt ?? a.createdAt) || a.id.localeCompare(b.id));
  const selectedSample = creatorSamples[0];
  const selectedSchedule = creatorSchedules[0];
  const relatedCooperationId = selectedSample && selectedSchedule
    && selectedSample.cooperationId !== null
    && selectedSample.cooperationId === selectedSchedule.cooperationId
    ? workspace.cooperations.find((item) => item.id === selectedSample.cooperationId && item.creatorId === creator.id && item.teamId === creator.teamId)?.id ?? null
    : null;
  const relationshipNote = getSampleScheduleRelationshipNote(selectedSample, selectedSchedule, relatedCooperationId, workspace);
  const creatorName = creator.accounts.find((item) => item.active)?.displayName ?? creator.name;
  const account = creator.accounts.find((item) => item.active) ?? creator.accounts[0];
  const creatorScope = actor.role === 'bd' ? 'mine' : 'team';
  const creatorQuery = account?.externalAccountId ?? creator.name;
  const managerDashboard = (actor.role === 'manager' || actor.role === 'admin') && workspace.scope.canSeeTeamMetrics;

  return {
    status: 'ready',
    plan: {
      creatorId: creator.id,
      creatorName,
      caseLabel: '当前可见案例',
      relatedCooperationId,
      steps: [
        {
          id: 'creator', label: '01', title: '达人',
          explanation: `从当前范围打开“${creatorName}”，查看主商务与跟进记录。`,
          available: true,
          href: `/creators?scope=${creatorScope}&q=${encodeURIComponent(creatorQuery)}`,
          targetName: creatorName,
        },
        {
          id: 'sample', label: '02', title: '寄样申请',
          explanation: selectedSample
            ? `查看该达人当前可见的寄样申请 ${selectedSample.id.slice(0, 8)}。${relationshipNote}`
            : `当前没有该达人的可见寄样申请记录。${relationshipNote}`,
          available: Boolean(selectedSample),
          href: selectedSample ? `/samples?${new URLSearchParams({ status: 'all', q: selectedSample.id }).toString()}` : null,
          targetName: selectedSample ? `寄样申请 ${selectedSample.id.slice(0, 8)}` : undefined,
        },
        {
          id: 'schedule', label: '03', title: '上播排期',
          explanation: selectedSchedule
            ? `查看该达人当前可见的上播排期“${selectedSchedule.title}”。${relationshipNote}`
            : `当前没有该达人的可见上播排期记录。${relationshipNote}`,
          available: Boolean(selectedSchedule),
          href: selectedSchedule ? `/schedule?${new URLSearchParams({ scheduleId: selectedSchedule.id }).toString()}` : null,
          targetName: selectedSchedule?.title,
        },
        {
          id: 'orders', label: '04', title: '数据复盘',
          explanation: paidOrders.length
            ? `查看该达人当前可见的 ${paidOrders.length} 笔已支付订单；订单仍按付款时负责人快照归属。`
            : '当前没有该达人的已支付订单记录，不能据此推断平台无成交。',
          available: paidOrders.length > 0,
          href: paidOrders.length ? `/orders?creatorId=${encodeURIComponent(creator.id)}` : null,
          targetName: paidOrders.length ? `${paidOrders.length} 笔已支付订单` : undefined,
          relatedHref: managerDashboard ? '/dashboard' : undefined,
          relatedLabel: managerDashboard ? '查看团队看板' : undefined,
        },
      ],
    },
  };
}

function getSampleScheduleRelationshipNote(
  sample: WorkspaceSnapshot['samples'][number] | undefined,
  schedule: WorkspaceSnapshot['schedules'][number] | undefined,
  relatedCooperationId: string | null,
  workspace: WorkspaceSnapshot,
) {
  if (sample && schedule && relatedCooperationId) {
    const cooperation = workspace.cooperations.find((item) => item.id === relatedCooperationId);
    return `当前可见合作记录“${cooperation?.title ?? relatedCooperationId}”能证明这两条记录关联到同一笔合作。`;
  }
  if (sample && schedule) return '两条记录属于同一达人，但当前可见数据没有证明它们关联到同一笔合作。';
  if (sample) return '当前没有该达人的可见上播排期；不会从寄样申请推定存在对应排期。';
  if (schedule) return '当前没有该达人的可见寄样申请；这里只展示已记录的上播排期。';
  return '当前没有该达人的可见寄样申请或上播排期记录；不会补造记录。';
}

function creatorEvidenceScore(creator: WorkspaceSnapshot['creators'][number], workspace: WorkspaceSnapshot) {
  const sampleCount = workspace.samples.filter((item) => item.creatorId === creator.id && item.teamId === creator.teamId).length;
  const scheduleCount = workspace.schedules.filter((item) => item.creatorId === creator.id && item.teamId === creator.teamId).length;
  const paidOrderCount = workspace.orders.filter((item) => item.creatorId === creator.id && item.teamId === creator.teamId && item.status === 'paid').length;
  return (sampleCount > 0 ? 8 : 0) + (scheduleCount > 0 ? 8 : 0) + (paidOrderCount > 0 ? 4 : 0);
}

export function selectDailyStartingPoint(workspace: WorkspaceSnapshot, actor: ActorScope): DailyStartingPoint {
  if (actor.role === 'ops') {
    const pendingShipments = workspace.metrics.sampleBacklog.pendingShipment;
    const awaitingReceipts = workspace.metrics.sampleBacklog.pendingReceiptPackages;
    if (pendingShipments + awaitingReceipts > 0) {
      return { title: '先处理样品履约', description: `${pendingShipments} 项待发货、${awaitingReceipts} 个包裹待签收。`, href: '/samples', actionLabel: '查看样品队列' };
    }
    return { title: '查看样品队列', description: '当前没有待发货或待签收事项，可从样品记录核对履约状态。', href: '/samples', actionLabel: '查看样品队列' };
  }

  const openTasks = workspace.tasks.filter((task) => task.status === 'open' && (
    workspace.scope.teamIds.includes(task.teamId)
      && (actor.role === 'bd' ? task.ownerMemberId === actor.memberId : actor.role === 'admin' || actor.role === 'manager')
  ));
  if (openTasks.length > 0) {
    return { title: '先处理待办', description: `${openTasks.length} 条当前范围内的开放任务，按截止时间优先处理。`, href: '/tasks', actionLabel: '查看待办' };
  }

  if (actor.role === 'bd') {
    const ownedCreators = workspace.creators.filter((creator) => creator.ownerMemberId === actor.memberId);
    if (ownedCreators.length > 0) return { title: '从我负责的达人开始', description: `${ownedCreators.length} 位当前负责达人，可继续跟进、登记寄样或核对上播排期。`, href: '/creators?scope=mine', actionLabel: '查看我的达人' };
    return { title: '先查看公海达人', description: '当前还没有分配给你的达人，可以查看所在团队公海。', href: '/public-pool', actionLabel: '查看公海' };
  }

  const teamCreators = workspace.creators.filter((creator) => creator.ownerMemberId !== null && workspace.scope.teamIds.includes(creator.teamId));
  if (teamCreators.length > 0) return { title: '从团队达人开始', description: `${teamCreators.length} 位已分配达人，可查看负责人、寄样申请与上播排期。`, href: '/creators?scope=team', actionLabel: '查看团队达人' };
  return { title: '查看团队准备情况', description: '先核对成员与可见团队，确认达人负责人分配。', href: '/team', actionLabel: '查看成员与交接' };
}
