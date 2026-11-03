import {
  ONBOARDING_STEPS,
  buildSteps,
  buildView,
  onboardingSchema,
} from './onboarding.types';

const empty = {
  monitors: 0,
  rules: 0,
  members: 1,
  invites: 0,
  servers: 0,
  pages: 0,
};

describe('setup guide', () => {
  it('lists the steps in a fixed order', () => {
    expect([...ONBOARDING_STEPS]).toEqual([
      'monitor',
      'alerts',
      'team',
      'server',
      'status_page',
    ]);
  });

  it('starts with nothing done for a lone owner', () => {
    expect(buildSteps(empty).every((step) => !step.done)).toBe(true);
    expect(buildView(empty, false)).toMatchObject({
      dismissed: false,
      doneCount: 0,
      total: 5,
    });
  });

  it('ticks each step from what exists', () => {
    const done = (counts: Partial<typeof empty>, id: string) =>
      buildSteps({ ...empty, ...counts }).find((step) => step.id === id)?.done;
    expect(done({ monitors: 1 }, 'monitor')).toBe(true);
    expect(done({ rules: 1 }, 'alerts')).toBe(true);
    expect(done({ servers: 2 }, 'server')).toBe(true);
    expect(done({ pages: 1 }, 'status_page')).toBe(true);
    expect(done({ members: 2 }, 'team')).toBe(true);
    expect(done({ invites: 1 }, 'team')).toBe(true);
    expect(done({ members: 1, invites: 0 }, 'team')).toBe(false);
  });

  it('counts finished steps and carries the dismissed flag', () => {
    const view = buildView(
      { monitors: 3, rules: 1, members: 4, invites: 0, servers: 0, pages: 0 },
      true,
    );
    expect(view.doneCount).toBe(3);
    expect(view.total).toBe(5);
    expect(view.dismissed).toBe(true);
  });

  it('accepts only a true or false answer', () => {
    expect(onboardingSchema.safeParse({ dismissed: true }).success).toBe(true);
    expect(onboardingSchema.safeParse({ dismissed: false }).success).toBe(true);
    expect(onboardingSchema.safeParse({ dismissed: 'yes' }).success).toBe(
      false,
    );
    expect(onboardingSchema.safeParse({}).success).toBe(false);
    expect(
      onboardingSchema.safeParse({ dismissed: true, extra: 1 }).success,
    ).toBe(false);
  });
});
