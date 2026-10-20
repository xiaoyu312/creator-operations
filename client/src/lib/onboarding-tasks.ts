import type { Capability, Role, WorkspaceSnapshot } from '../../../shared/types.ts';
import { brandScopedHref } from './home-actions.ts';

export interface OnboardingTask {
  id: string;
  title: string;
  description: string;
  done: boolean;
  href: string;
  ctaLabel: string;
}

export interface OnboardingGroup {
  id: string;
  title: string;
  tasks: OnboardingTask[];
}

export interface OnboardingPlan {
  roleTitle: string;
  intro: string;
  groups: OnboardingGroup[];
  doneCount: number;
  totalCount: number;
  nextTask: OnboardingTask | null;
}

export interface OnboardingActor {
  role: Role;
  memberId: string;
  capabilities: readonly Capability[];
}

function task(id: string, title: string, description: string, done: boolean, path: string, ctaLabel: string, brandId?: string): OnboardingTask {
  return { id, title, description, done, href: brandScopedHref(path, brandId), ctaLabel };
}

/** Completion is derived from visible business records only; browsing a page never marks a step done. */
export function buildOnboardingPlan(workspace: WorkspaceSnapshot, actor: OnboardingActor, brandId?: string): OnboardingPlan {
  const teamIds = workspace.scope.teamIds;
  const nonDraftSamples = workspace.samples.filter((sample) => sample.status !== 'draft' && teamIds.includes(sample.teamId));
  let roleTitle: string;
  let intro: string;
  let groups: OnboardingGroup[];

  if (actor.role === 'ops') {
    const handled = nonDraftSamples.filter((sample) => sample.decidedAt !== null);
    const packages = workspace.samplePackages.filter((pack) => nonDraftSamples.some((sample) => sample.id === pack.sampleId));
    roleTitle = '样品运营';
    intro = '按“审核 → 发货 → 签收”处理寄样，每一步都会同步给负责商务。';
    groups = [{
      id: 'fulfil',
      title: '寄样履约',
      tasks: [
        task('ops-queue', '收到一笔已提交寄样', '已提交的申请会出现在队列中，可继续查看审核、发货和签收进度。', nonDraftSamples.length > 0, '/samples?queue=todo', '打开队列', brandId),
        ...(actor.capabilities.includes('sample.approve') ? [task('ops-approve', '完成一笔寄样审核', '确认商品与收件信息后通过或驳回申请。', handled.length > 0, '/samples?queue=approval', '去审核', brandId)] : []),
        task('ops-ship', '登记一笔样品发货', '填写快递公司和物流单号后，商务即可查看物流进度。', packages.length > 0, '/samples?queue=shipment', '去发货', brandId),
        task('ops-receipt', '确认一笔样品签收', '记录签收后，样品状态会更新为已签收。', packages.some((pack) => pack.receivedAt !== null), '/samples?queue=receipt', '去确认', brandId),
      ],
    }];
  } else if (actor.role === 'bd') {
    const mine = workspace.creators.filter((creator) => creator.ownerMemberId === actor.memberId);
    const mineIds = new Set(mine.map((creator) => creator.id));
    const mySamples = nonDraftSamples.filter((sample) => sample.applicantId === actor.memberId || mineIds.has(sample.creatorId));
    const received = mySamples.filter((sample) => sample.status === 'received');
    roleTitle = '达人商务';
    intro = '跟着一位达人走完“建联 → 寄样 → 排期 → 出单”，就掌握了日常工作。';
    groups = [
      {
        id: 'crm',
        title: '建联达人',
        tasks: [
          task('bd-creator', '名下已有一位达人', '你负责的达人会显示在我的达人列表中，可继续记录跟进。', mine.length > 0, '/creators?create=1', '新建达人', brandId),
          task('bd-followup', '记录一次跟进', '记录本次沟通，方便安排下一步。', workspace.followups.some((item) => mineIds.has(item.creatorId) && item.createdBy === actor.memberId), '/creators?scope=mine', '去跟进', brandId),
        ],
      },
      {
        id: 'cooperate',
        title: '推进合作',
        tasks: [
          task('bd-sample', '已有一笔寄样申请已提交', '本人提交或名下达人相关的非草稿申请都会计入；之后由运营审核发货。', mySamples.length > 0, '/samples?create=1', '申请寄样', brandId),
          task('bd-received', '有一笔样品已签收', '你的寄样记录里有一笔已签收后，这项会完成；之后可继续约定档期。', received.length > 0, '/samples', '查看物流', brandId),
          task('bd-schedule', '登记一场直播排期', '保存计划时间后，冲突会自动提示。', workspace.schedules.some((schedule) => schedule.ownerMemberId === actor.memberId), '/schedule?create=1', '新建排期', brandId),
          task('bd-orders', '你负责的达人有已支付订单', '有一笔关联到你负责达人的已支付订单后，这项会完成；业绩归属按订单中的支付时负责人展示。', workspace.orders.some((order) => order.status === 'paid' && order.creatorId !== null && mineIds.has(order.creatorId)), '/team?tab=performance', '查看业绩', brandId),
        ],
      },
    ];
  } else {
    const teamCreators = workspace.creators.filter((creator) => teamIds.includes(creator.teamId));
    roleTitle = actor.role === 'admin' ? '管理员' : '团队负责人';
    intro = '先把商品、达人和分工配好，团队就能按同一套流程推进合作。';
    groups = [
      {
        id: 'setup',
        title: '基础设置',
        tasks: [
          task('mgr-products', '录入一件商品', '录入商品及对应店铺，后续申请寄样时可直接选择商品。', workspace.products.length > 0, '/products', '去录入', brandId),
          task('mgr-creators', '团队中已有一位达人', '达人可手工新建或批量导入，之后再分配给负责商务。', teamCreators.length > 0, '/creators?create=1', '新建达人', brandId),
          task('mgr-assign', '已有达人分配给商务', '每位达人可指定一位主商务，业绩按支付时负责人归属。', teamCreators.some((creator) => creator.ownerMemberId !== null), '/creators?scope=team', '去分配', brandId),
        ],
      },
      {
        id: 'operate',
        title: '业务管理',
        tasks: [
          task('mgr-sample', '团队已有一笔寄样申请已提交', '团队里有一笔申请提交后就完成此项；审核、发货与签收会继续显示在样品进度中。', nonDraftSamples.length > 0, '/samples?create=1', '申请寄样', brandId),
          task('mgr-schedule', '团队中已有一场直播排期', '排期保存后，可在排期视图查看全员档期与冲突。', workspace.schedules.some((schedule) => teamIds.includes(schedule.teamId)), '/schedule?create=1', '新建排期', brandId),
          task('mgr-orders', '已有平台订单记录', '导入平台订单后，可按达人和商务查看团队业绩。', workspace.orders.length > 0, '/orders', '导入订单', brandId),
        ],
      },
    ];
  }

  const all = groups.flatMap((group) => group.tasks);
  return {
    roleTitle,
    intro,
    groups,
    doneCount: all.filter((item) => item.done).length,
    totalCount: all.length,
    nextTask: all.find((item) => !item.done) ?? null,
  };
}
