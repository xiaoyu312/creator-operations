import { ArrowLeft, ArrowRight, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useWalkthrough } from '../walkthrough-context';
import '../onboarding.css';

export function WalkthroughDock() {
  const { plan, activeIndex, activeStep, isActive, previous, next, end } = useWalkthrough();
  if (!isActive || !plan || !activeStep) return null;
  const isLast = activeIndex === plan.steps.length - 1;

  return <section className="walkthrough-dock" aria-label="演示浏览" aria-live="polite">
    <div className="walkthrough-dock-main">
      <div className="walkthrough-dock-kicker"><span className="walkthrough-live-dot" aria-hidden="true" />演示浏览 {activeIndex + 1}/{plan.steps.length}<span className="walkthrough-case">{plan.caseLabel} · {plan.creatorName}</span></div>
      <div className="walkthrough-dock-content">
        <div className="walkthrough-step-mark">{activeStep.label}</div>
        <div className="walkthrough-step-copy"><strong>{activeStep.title}</strong><p>{activeStep.explanation}</p>{activeStep.available && activeStep.targetName && <small>请打开：{activeStep.targetName}</small>}{!activeStep.available && <small className="walkthrough-missing">此演示案例没有这一步的可见记录；可继续浏览其他步骤。</small>}{activeStep.relatedHref && activeStep.relatedLabel && <Link className="walkthrough-related-link" to={activeStep.relatedHref}>{activeStep.relatedLabel}<ArrowRight size={12} /></Link>}</div>
      </div>
    </div>
    <div className="walkthrough-dock-actions">
      <span className="walkthrough-browse-note">演示导航不会自动修改记录</span>
      <div className="walkthrough-button-row">
        <button className="walkthrough-control walkthrough-secondary" type="button" onClick={previous} disabled={activeIndex === 0}><ArrowLeft size={14} />上一步</button>
        <button className="walkthrough-control walkthrough-primary" type="button" onClick={isLast ? end : next}>{isLast ? '结束演示' : '下一步'}{!isLast && <ArrowRight size={14} />}</button>
        {!isLast && <button className="walkthrough-end" type="button" onClick={end} aria-label="结束演示"><X size={16} /><span>结束</span></button>}
      </div>
    </div>
  </section>;
}
