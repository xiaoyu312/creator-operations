import { DOCUMENTATION_URL } from '../lib/public-config';
import { ArrowRight, CircleHelp, ClipboardList, ExternalLink, PackageCheck, Users } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { PageHeading } from '../components/workbench';
import { selectDailyStartingPoint, selectDemoWalkthrough } from '../lib/presentation';
import { useWorkbench } from '../workbench-context';
import { useWalkthrough } from '../walkthrough-context';
import '../onboarding.css';

const journeySteps = [
  { title: '达人', description: '确认主商务与下一步跟进。' },
  { title: '寄样申请', description: '查看已记录的申请、审批、发货与签收。' },
  { title: '上播排期', description: '核对达人计划时间和开播结果。' },
  { title: '数据复盘', description: '查看订单、退款和达人表现。' },
];

function roleName(role: string) {
  return ({ admin: '管理员', manager: '团队主管', bd: '达人商务', ops: '样品运营' } as Record<string, string>)[role] ?? '工作台成员';
}

export default function GuidePage() {
  const { session, workspace } = useWorkbench();
  const { start } = useWalkthrough();
  const actor = { memberId: session.actor.memberId, role: session.actor.role };
  const dailyStart = selectDailyStartingPoint(workspace, actor);
  const demo = selectDemoWalkthrough(workspace, actor, session.dataMode);
  const demoMode = session.dataMode === 'demo';
  const missingDemoSteps = demo.status === 'ready' ? demo.plan.steps.filter((step) => !step.available).map((step) => step.title) : [];
  const shortcuts = session.actor.role === 'ops'
    ? [{ label: '样品履约', href: '/samples' }, { label: '运营任务', href: '/tasks' }]
    : session.actor.role === 'bd'
      ? [{ label: '我的达人', href: '/creators?scope=mine' }, { label: '寄样申请', href: '/samples' }, { label: '上播排期', href: '/schedule' }]
      : [{ label: '团队达人', href: '/creators?scope=team' }, { label: '寄样申请', href: '/samples' }, { label: '上播排期', href: '/schedule' }];

  return <div className="page-stack onboarding-page">
    <PageHeading title="入门指南" description={`从${roleName(session.actor.role)}的日常工作开始。`} actions={<>
      <>{DOCUMENTATION_URL && <Button asChild><a href={DOCUMENTATION_URL} target="_blank" rel="noopener noreferrer">打开部署者提供的使用说明<ExternalLink size={15} aria-hidden="true" /></a></Button>}</>
      <Link className="button button-outline" to="/">返回今日工作台</Link>
    </>} />
    <section className="onboarding-welcome" aria-labelledby="onboarding-start-title">
      <div className="onboarding-welcome-top">
        <div className="onboarding-welcome-copy">
          <p className="onboarding-eyebrow"><CircleHelp size={13} />起步路径</p>
          <h2 id="onboarding-start-title">{session.actor.role === 'ops' ? '从哪里开始？先处理样品履约' : '从哪里开始？沿着一位达人查看寄样、上播和数据'}</h2>
          <p>{session.actor.role === 'ops' ? '先处理待发货和待签收的样品。' : '依次查看达人、寄样申请、上播排期和数据复盘。'}</p>
        </div>
        {demoMode && demo.status === 'ready' && missingDemoSteps.length > 0 && <div className="onboarding-case-status">
          <strong>案例数据</strong>
          {`暂无${missingDemoSteps.join('、')}记录。`}
        </div>}
        {demoMode && demo.status !== 'ready' && demo.status !== 'not_demo' && <div className={`onboarding-case-status${demo.status === 'missing_creator' ? ' is-warning' : ''}`}>
          <strong>{demo.status === 'unsupported_role' ? '当前身份的演示入口' : '暂无完整演示案例'}</strong>{demo.message}
        </div>}
      </div>
      <ol className="onboarding-flow" aria-label="达人寄样与上播业务流程">
        {journeySteps.map((step, index) => <li className="onboarding-flow-step" key={step.title}>
          <span className="onboarding-flow-index">{String(index + 1).padStart(2, '0')}</span>
          <strong>{step.title}</strong>
          <p>{step.description}</p>
        </li>)}
      </ol>
      <div className="onboarding-main-action">
        {demoMode && demo.status === 'ready' ? <Button onClick={() => start(demo.plan)}><PackageCheck size={15} />开始演示 · 只浏览<ArrowRight size={14} /></Button>
          : demoMode && demo.status === 'unsupported_role' ? <Link className="button" to={demo.fallbackHref}><PackageCheck size={15} />{demo.fallbackLabel}<ArrowRight size={14} /></Link>
            : <Link className="button" to={dailyStart.href}><Users size={15} />{dailyStart.actionLabel}<ArrowRight size={14} /></Link>}
        {!demoMode || demo.status !== 'ready' ? <span className="onboarding-action-note">{dailyStart.description}</span> : null}
      </div>
      <nav className="onboarding-shortcuts" aria-label="常用入口">
        <span className="onboarding-shortcuts-label">常用入口</span>
        {shortcuts.slice(0, 3).map((shortcut) => <Link className="onboarding-shortcut" to={shortcut.href} key={shortcut.href}>{shortcut.label}<ArrowRight size={12} /></Link>)}
      </nav>
    </section>

    {session.actor.role === 'ops' && <p className="onboarding-role-note"><ClipboardList size={14} />可在样品申请中处理发货与签收。</p>}
  </div>;
}
