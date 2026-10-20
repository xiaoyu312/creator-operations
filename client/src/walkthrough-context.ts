import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import type { WalkthroughPlan, WalkthroughStep } from './lib/presentation.ts';

interface WalkthroughContextValue {
  plan: WalkthroughPlan | null;
  activeIndex: number;
  activeStep: WalkthroughStep | null;
  isActive: boolean;
  start: (plan: WalkthroughPlan) => void;
  previous: () => void;
  next: () => void;
  end: () => void;
}

interface WalkthroughState {
  identity: string;
  plan: WalkthroughPlan | null;
  activeIndex: number;
}

const WalkthroughContext = createContext<WalkthroughContextValue | null>(null);

export function WalkthroughProvider({ actorKey, dataMode, children }: { actorKey: string; dataMode: 'demo' | 'production'; children: ReactNode }) {
  const navigate = useNavigate();
  const identity = `${actorKey}:${dataMode}`;
  const [state, setState] = useState<WalkthroughState>({ identity, plan: null, activeIndex: 0 });
  useEffect(() => {
    setState((current) => current.identity === identity ? current : { identity, plan: null, activeIndex: 0 });
  }, [identity]);
  const currentState = state.identity === identity ? state : { identity, plan: null, activeIndex: 0 };
  const plan = currentState.plan;
  const activeIndex = currentState.activeIndex;
  const activeStep = plan?.steps[activeIndex] ?? null;

  const start = useCallback((nextPlan: WalkthroughPlan) => {
    if (dataMode !== 'demo' || nextPlan.steps.length === 0) return;
    setState({ identity, plan: nextPlan, activeIndex: 0 });
    if (nextPlan.steps[0].href) navigate(nextPlan.steps[0].href);
  }, [dataMode, identity, navigate]);

  const end = useCallback(() => {
    setState({ identity, plan: null, activeIndex: 0 });
  }, [identity]);

  const previous = useCallback(() => {
    if (!plan || activeIndex <= 0) return;
    const nextIndex = activeIndex - 1;
    setState({ identity, plan, activeIndex: nextIndex });
    const href = plan.steps[nextIndex]?.href;
    if (href) navigate(href);
  }, [activeIndex, identity, navigate, plan]);

  const next = useCallback(() => {
    if (!plan || activeIndex >= plan.steps.length - 1) {
      end();
      return;
    }
    const nextIndex = activeIndex + 1;
    setState({ identity, plan, activeIndex: nextIndex });
    const href = plan.steps[nextIndex]?.href;
    if (href) navigate(href);
  }, [activeIndex, end, identity, navigate, plan]);

  const value = useMemo<WalkthroughContextValue>(() => ({
    plan, activeIndex, activeStep, isActive: plan !== null, start, previous, next, end,
  }), [plan, activeIndex, activeStep, start, previous, next, end]);

  return createElement(WalkthroughContext.Provider, { value }, children);
}

export function useWalkthrough() {
  const value = useContext(WalkthroughContext);
  if (!value) throw new Error('useWalkthrough must be used inside WalkthroughProvider');
  return value;
}
