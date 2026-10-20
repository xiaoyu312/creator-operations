import { createContext, useContext, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowRight, BookOpen, Check, Compass, Scale } from 'lucide-react';
import { useWorkbench } from '../workbench-context';
import { buildOnboardingPlan, type OnboardingPlan } from '../lib/onboarding-tasks';
import { brandScopedHref } from '../lib/home-actions';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from './ui/sheet';
import '../onboarding-guide.css';

interface OnboardingGuideContextValue {
  plan: OnboardingPlan;
  open: () => void;
}

const OnboardingGuideContext = createContext<OnboardingGuideContextValue | null>(null);

export function useOnboardingGuide() {
  return useContext(OnboardingGuideContext);
}

export function GuideLauncherButton() {
  const guide = useOnboardingGuide();
  if (!guide) return null;
  const percent = guide.plan.totalCount ? Math.round(guide.plan.doneCount / guide.plan.totalCount * 100) : 100;
  const allDone = guide.plan.doneCount === guide.plan.totalCount;
  return <button type="button" className={`guide-launcher${allDone ? ' is-complete' : ''}`} onClick={guide.open} aria-label={`新手指引，已完成 ${guide.plan.doneCount}/${guide.plan.totalCount}`}>
    <span className="guide-launcher-ring" style={{ '--guide-progress': `${percent}%` } as CSSProperties}><Compass size={16} aria-hidden="true" /></span>
    <span className="guide-launcher-copy"><strong>新手指引</strong><small>{allDone ? '已完成' : `${guide.plan.doneCount}/${guide.plan.totalCount}`}</small></span>
  </button>;
}

export function useBrandIdForLinks() {
  const { session } = useWorkbench();
  const [searchParams] = useSearchParams();
  return session.businessWorkspace?.brandId ?? session.workbook?.brandId ?? searchParams.get('brandId') ?? undefined;
}

export function OnboardingGuideProvider({ children }: { children: ReactNode }) {
  const { workspace, session } = useWorkbench();
  const brandId = useBrandIdForLinks();
  const [isOpen, setOpen] = useState(false);
  const plan = useMemo(() => buildOnboardingPlan(workspace, {
    role: session.actor.role,
    memberId: session.actor.memberId,
    capabilities: session.actor.capabilities,
  }, brandId), [workspace, session.actor.role, session.actor.memberId, session.actor.capabilities, brandId]);
  const value = useMemo(() => ({ plan, open: () => setOpen(true) }), [plan]);
  const isManager = session.actor.role === 'admin' || session.actor.role === 'manager';
  const percent = plan.totalCount ? Math.round(plan.doneCount / plan.totalCount * 100) : 100;

  return <OnboardingGuideContext.Provider value={value}>
    {children}
    <Sheet open={isOpen} onOpenChange={setOpen}>
      <SheetContent side="right" className="guide-sheet">
        <header className="guide-sheet-header">
          <span className="guide-sheet-kicker"><Compass size={14} aria-hidden="true" />{plan.roleTitle}上手任务</span>
          <SheetTitle>新手指引</SheetTitle>
          <SheetDescription>{plan.intro}</SheetDescription>
          <div className="guide-progress" aria-label={`完成进度 ${percent}%`}>
            <div className="guide-progress-track"><span style={{ width: `${percent}%` }} /></div>
            <span className="guide-progress-label"><strong>{plan.doneCount}</strong>/{plan.totalCount}</span>
          </div>
        </header>
        <div className="guide-sheet-body">
          {plan.groups.map((group, groupIndex) => <section className="guide-group" key={group.id} aria-labelledby={`guide-group-${group.id}`}>
            <h3 id={`guide-group-${group.id}`}><span>{String(groupIndex + 1).padStart(2, '0')}</span>{group.title}</h3>
            <ol className="guide-task-list">
              {group.tasks.map((task) => {
                const isNext = plan.nextTask?.id === task.id;
                return <li key={task.id} className={`guide-task${task.done ? ' is-done' : ''}${isNext ? ' is-next' : ''}`}>
                  <span className="guide-task-check" aria-hidden="true">{task.done ? <Check size={12} strokeWidth={3} /> : null}</span>
                  <div className="guide-task-copy">
                    <strong>{task.title}</strong>
                    <p>{task.description}</p>
                  </div>
                  {task.done
                    ? <span className="guide-task-state">已完成</span>
                    : <Link className="guide-task-cta" to={task.href} onClick={() => setOpen(false)}>{task.ctaLabel}<ArrowRight size={13} aria-hidden="true" /></Link>}
                </li>;
              })}
            </ol>
          </section>)}
          <p className="guide-note">完成状态来自真实业务记录：创建了对应记录才会打勾，仅浏览页面不会。</p>
        </div>
        <footer className="guide-sheet-footer">
          <Link to={brandScopedHref('/guide', brandId)} onClick={() => setOpen(false)}><BookOpen size={14} aria-hidden="true" />业务流程说明</Link>
          {isManager && <Link to={brandScopedHref('/rules', brandId)} onClick={() => setOpen(false)}><Scale size={14} aria-hidden="true" />业务规则与口径</Link>}
        </footer>
      </SheetContent>
    </Sheet>
  </OnboardingGuideContext.Provider>;
}
