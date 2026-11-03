import {
  assignSchema,
  channelCreateSchema,
  describeChannel,
  maintenanceSchema,
  maskChannelConfig,
  parseChannelConfig,
  parseWith,
  policySchema,
  restoreChannelConfig,
  ruleSchema,
  scheduleSchema,
  silenceSchema,
} from './alert.schema';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('parseChannelConfig', () => {
  it('accepts every channel type with defaults', () => {
    expect(
      parseChannelConfig('email', { recipients: ['Ops@Example.com'] }),
    ).toEqual({ recipients: ['ops@example.com'] });
    expect(
      parseChannelConfig('slack', {
        webhookUrl: 'https://hooks.slack.com/services/a',
      }),
    ).toEqual({
      webhookUrl: 'https://hooks.slack.com/services/a',
    });
    expect(
      parseChannelConfig('telegram', { botToken: '123456:ABCDEF', chatId: 42 }),
    ).toEqual({
      botToken: '123456:ABCDEF',
      chatId: '42',
    });
    expect(parseChannelConfig('ntfy', { topic: 'alerts' })).toEqual({
      serverUrl: 'https://ntfy.sh',
      topic: 'alerts',
    });
    expect(
      parseChannelConfig('gotify', {
        serverUrl: 'https://gotify.local/',
        appToken: 'tok',
      }),
    ).toEqual({
      serverUrl: 'https://gotify.local',
      appToken: 'tok',
    });
    expect(
      parseChannelConfig('webhook', { url: 'https://example.com/hook' }),
    ).toEqual({
      url: 'https://example.com/hook',
      headers: {},
    });
  });

  it('rejects bad input with readable messages', () => {
    expect(() => parseChannelConfig('email', { recipients: [] })).toThrow(
      /at least one email/,
    );
    expect(() =>
      parseChannelConfig('slack', { webhookUrl: 'ftp://nope' }),
    ).toThrow();
    expect(() => parseChannelConfig('ntfy', { topic: 'has space' })).toThrow();
    expect(() =>
      parseChannelConfig('webhook', {
        url: 'https://a.test',
        headers: { 'Bad Name': 'x' },
      }),
    ).toThrow();
    expect(() =>
      parseChannelConfig('webhook', {
        url: 'https://a.test',
        headers: { A: 'x\ny' },
      }),
    ).toThrow();
  });
});

describe('secret masking', () => {
  const config = {
    url: 'https://a.test/hook',
    secret: 's',
    headers: { Authorization: 'Bearer x' },
  };

  it('hides secrets and header values', () => {
    expect(maskChannelConfig('webhook', config)).toEqual({
      url: '********',
      secret: '********',
      headers: { Authorization: '********' },
    });
    expect(maskChannelConfig('email', { recipients: ['a@b.co'] })).toEqual({
      recipients: ['a@b.co'],
    });
  });

  it('puts the stored values back when the mask comes in', () => {
    const restored = restoreChannelConfig(
      'webhook',
      {
        url: '********',
        secret: '********',
        headers: { Authorization: '********', Extra: 'new' },
      },
      config,
    );
    expect(restored).toEqual({
      url: 'https://a.test/hook',
      secret: 's',
      headers: { Authorization: 'Bearer x', Extra: 'new' },
    });
  });

  it('refuses to hand stored secrets to another address', () => {
    const telegram = {
      botToken: '123456:SECRET',
      chatId: '1',
      apiBaseUrl: 'https://api.telegram.org',
    };
    expect(() =>
      restoreChannelConfig(
        'telegram',
        {
          ...telegram,
          botToken: '********',
          apiBaseUrl: 'https://attacker.test',
        },
        telegram,
      ),
    ).toThrow(/Re-enter/);
    expect(() =>
      restoreChannelConfig(
        'telegram',
        { ...telegram, botToken: '********', apiBaseUrl: '' },
        telegram,
      ),
    ).toThrow(/Re-enter/);
    expect(
      restoreChannelConfig(
        'telegram',
        { ...telegram, botToken: '********' },
        telegram,
      ).botToken,
    ).toBe('123456:SECRET');
    expect(
      restoreChannelConfig(
        'telegram',
        {
          ...telegram,
          botToken: 'new-token',
          apiBaseUrl: 'https://attacker.test',
        },
        telegram,
      ).botToken,
    ).toBe('new-token');

    const gotify = { serverUrl: 'https://gotify.test', appToken: 'app-secret' };
    expect(() =>
      restoreChannelConfig(
        'gotify',
        { serverUrl: 'https://attacker.test', appToken: '********' },
        gotify,
      ),
    ).toThrow(/Re-enter/);
    expect(
      restoreChannelConfig(
        'gotify',
        { serverUrl: 'https://gotify.test', appToken: '********' },
        gotify,
      ).appToken,
    ).toBe('app-secret');

    expect(() =>
      restoreChannelConfig(
        'webhook',
        {
          url: 'https://attacker.test/hook',
          secret: 'mine',
          headers: { Authorization: '********' },
        },
        config,
      ),
    ).toThrow(/Re-enter/);
    expect(
      restoreChannelConfig(
        'webhook',
        {
          url: 'https://attacker.test/hook',
          secret: 'mine',
          headers: { Authorization: 'mine' },
        },
        config,
      ).headers,
    ).toEqual({ Authorization: 'mine' });
    expect(
      restoreChannelConfig(
        'webhook',
        {
          url: '********',
          secret: '********',
          headers: { Authorization: '********' },
        },
        config,
      ).secret,
    ).toBe('s');
  });

  it('describes a channel without leaking secrets', () => {
    expect(describeChannel('webhook', config)).toBe('Webhook to a.test');
    expect(
      describeChannel('telegram', { botToken: '123456:SECRET', chatId: '1' }),
    ).not.toContain('SECRET');
    expect(describeChannel('email', { recipients: ['a@b.co', 'c@d.co'] })).toBe(
      'a@b.co, c@d.co',
    );
  });
});

describe('channelCreateSchema', () => {
  it('defaults to enabled and rejects unknown keys', () => {
    expect(
      channelCreateSchema.parse({ name: 'x', type: 'slack', config: {} })
        .enabled,
    ).toBe(true);
    expect(() =>
      parseWith(channelCreateSchema, {
        name: 'x',
        type: 'slack',
        config: {},
        extra: 1,
      }),
    ).toThrow();
    expect(() =>
      parseWith(channelCreateSchema, { name: '  ', type: 'slack', config: {} }),
    ).toThrow();
  });
});

describe('ruleSchema', () => {
  it('applies defaults', () => {
    const rule = ruleSchema.parse({
      name: 'Down',
      scope: { tags: ['Prod'] },
      channelIds: [id(1), id(1)],
    });
    expect(rule).toMatchObject({
      enabled: true,
      trigger: 'down',
      severity: 'critical',
      forSec: 0,
      policyId: null,
      notifyRecovery: true,
      channelIds: [id(1)],
      scope: { all: false, monitorIds: [], tags: ['prod'] },
    });
  });

  it('needs a scope and a destination', () => {
    expect(() =>
      parseWith(ruleSchema, { name: 'x', scope: {}, channelIds: [id(1)] }),
    ).toThrow(/at least one monitor or tag/);
    expect(() =>
      parseWith(ruleSchema, { name: 'x', scope: { all: true } }),
    ).toThrow();
    expect(() =>
      parseWith(ruleSchema, {
        name: 'x',
        scope: { all: true },
        policyId: id(2),
      }),
    ).not.toThrow();
  });

  it('clears the other scope fields when all is set', () => {
    const rule = ruleSchema.parse({
      name: 'x',
      scope: { all: true, tags: ['a'] },
      channelIds: [id(1)],
    });
    expect(rule.scope).toEqual({ all: true, monitorIds: [], tags: [] });
  });

  it('limits the delay', () => {
    expect(() =>
      parseWith(ruleSchema, {
        name: 'x',
        scope: { all: true },
        channelIds: [id(1)],
        forSec: 90000,
      }),
    ).toThrow();
    expect(() =>
      parseWith(ruleSchema, {
        name: 'x',
        scope: { all: true },
        channelIds: [id(1)],
        severity: 'fatal',
      }),
    ).toThrow();
  });
});

describe('policySchema', () => {
  it('sorts steps and removes duplicate channels', () => {
    const policy = policySchema.parse({
      name: 'P',
      steps: [
        { afterSec: 600, scheduleId: id(3) },
        { afterSec: 0, channelIds: [id(1), id(1)] },
      ],
    });
    expect(policy.steps.map((step) => step.afterSec)).toEqual([0, 600]);
    expect(policy.steps[0].channelIds).toEqual([id(1)]);
    expect(policy.steps[1].scheduleId).toBe(id(3));
  });

  it('rejects empty steps and too many steps', () => {
    expect(() => parseWith(policySchema, { name: 'P', steps: [] })).toThrow();
    expect(() =>
      parseWith(policySchema, { name: 'P', steps: [{ afterSec: 0 }] }),
    ).toThrow();
    expect(() =>
      parseWith(policySchema, {
        name: 'P',
        steps: Array.from({ length: 7 }, () => ({
          afterSec: 0,
          channelIds: [id(1)],
        })),
      }),
    ).toThrow();
  });
});

describe('scheduleSchema', () => {
  it('defaults to weekly shifts starting now', () => {
    const schedule = scheduleSchema.parse({
      name: 'S',
      members: [id(1), id(1), id(2)],
    });
    expect(schedule.members).toEqual([id(1), id(2)]);
    expect(schedule.periodSec).toBe(604800);
    expect(schedule.anchorAt).toBeInstanceOf(Date);
  });

  it('needs people and a sensible shift length', () => {
    expect(() => parseWith(scheduleSchema, { name: 'S', members: [] })).toThrow(
      /at least one person/,
    );
    expect(() =>
      parseWith(scheduleSchema, { name: 'S', members: [id(1)], periodSec: 60 }),
    ).toThrow();
  });
});

describe('silenceSchema and maintenanceSchema', () => {
  it('checks the time range of a silence', () => {
    const start = new Date('2030-01-01T00:00:00Z');
    expect(() =>
      parseWith(silenceSchema, {
        name: 'S',
        scope: { all: true },
        startsAt: start,
        endsAt: new Date(start.getTime() - 1),
      }),
    ).toThrow();
    expect(() =>
      parseWith(silenceSchema, {
        name: 'S',
        scope: { all: true },
        startsAt: start,
        endsAt: new Date(start.getTime() + 100 * 86_400_000),
      }),
    ).toThrow();
    expect(
      parseWith(silenceSchema, {
        name: 'S',
        scope: { all: true },
        startsAt: start,
        endsAt: new Date(start.getTime() + 3600_000),
      }).endsAt.getTime(),
    ).toBe(start.getTime() + 3600_000);
  });

  it('keeps repeating windows shorter than their period', () => {
    const base = {
      name: 'W',
      scope: { all: true },
      startsAt: '2030-01-01T00:00:00Z',
    };
    expect(
      parseWith(maintenanceSchema, { ...base, durationSec: 3600 }).repeat,
    ).toBe('none');
    expect(() =>
      parseWith(maintenanceSchema, {
        ...base,
        durationSec: 90_000,
        repeat: 'daily',
      }),
    ).toThrow();
    expect(() =>
      parseWith(maintenanceSchema, { ...base, durationSec: 30 }),
    ).toThrow();
    expect(() =>
      parseWith(maintenanceSchema, {
        ...base,
        durationSec: 3600,
        repeat: 'monthly',
      }),
    ).toThrow();
  });
});

describe('assignSchema', () => {
  it('accepts an id or null', () => {
    expect(assignSchema.parse({ userId: null })).toEqual({ userId: null });
    expect(assignSchema.parse({ userId: id(1) })).toEqual({ userId: id(1) });
    expect(() => parseWith(assignSchema, { userId: 'me' })).toThrow();
  });
});
