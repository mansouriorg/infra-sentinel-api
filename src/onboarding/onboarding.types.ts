import { z } from 'zod';

export const ONBOARDING_STEPS = [
  'monitor',
  'alerts',
  'team',
  'server',
  'status_page',
] as const;
export type OnboardingStepId = (typeof ONBOARDING_STEPS)[number];

export interface OnboardingStep {
  id: OnboardingStepId;
  done: boolean;
}

export interface OnboardingView {
  dismissed: boolean;
  steps: OnboardingStep[];
  doneCount: number;
  total: number;
}

export interface OnboardingCounts {
  monitors: number;
  rules: number;
  members: number;
  invites: number;
  servers: number;
  pages: number;
}

export function buildSteps(counts: OnboardingCounts): OnboardingStep[] {
  const done: Record<OnboardingStepId, boolean> = {
    monitor: counts.monitors > 0,
    alerts: counts.rules > 0,
    team: counts.members > 1 || counts.invites > 0,
    server: counts.servers > 0,
    status_page: counts.pages > 0,
  };
  return ONBOARDING_STEPS.map((id) => ({ id, done: done[id] }));
}

export function buildView(
  counts: OnboardingCounts,
  dismissed: boolean,
): OnboardingView {
  const steps = buildSteps(counts);
  return {
    dismissed,
    steps,
    doneCount: steps.filter((step) => step.done).length,
    total: steps.length,
  };
}

export const onboardingSchema = z.object({ dismissed: z.boolean() }).strict();
