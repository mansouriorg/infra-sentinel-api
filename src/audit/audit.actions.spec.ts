import type { AuthContext } from '../auth/auth.types';
import {
  CSV_LIMIT,
  actorOf,
  auditQuerySchema,
  bodyFields,
  buildAuditQuery,
  clip,
  controllerSegment,
  deriveAction,
  isAuditable,
  pickSummary,
  pickTarget,
  snakeCase,
  takesOrgFromResult,
} from './audit.actions';

const id = '8d1a5f0e-2f4c-4b8e-9f2a-3b6c1d7e9a10';
const org = '3f2b8c3a-6d4e-4a1b-8c5d-7e9f0a1b2c3d';

describe('audit actions', () => {
  it('names an action after the controller and the handler', () => {
    expect(controllerSegment('monitors')).toBe('monitors');
    expect(controllerSegment('/status-pages/:id')).toBe('status-pages');
    expect(controllerSegment(['alert-rules'])).toBe('alert-rules');
    expect(controllerSegment('/')).toBe('api');
    expect(controllerSegment(undefined)).toBe('api');
    expect(snakeCase('changeRole')).toBe('change_role');
    expect(snakeCase('setComponents')).toBe('set_components');
    expect(snakeCase('create')).toBe('create');
    expect(deriveAction('orgs', 'changeRole')).toBe('orgs.change_role');
    expect(deriveAction('', 'pause')).toBe('api.pause');
  });

  it('only records changes, and skips noisy actions', () => {
    expect(isAuditable('POST', 'monitors.create')).toBe(true);
    expect(isAuditable('PATCH', 'orgs.change_role')).toBe(true);
    expect(isAuditable('DELETE', 'monitors.remove')).toBe(true);
    expect(isAuditable('GET', 'monitors.list')).toBe(false);
    expect(isAuditable('HEAD', 'monitors.list')).toBe(false);
    expect(isAuditable('OPTIONS', 'monitors.list')).toBe(false);
    expect(isAuditable('POST', 'monitors.test')).toBe(false);
    expect(isAuditable('POST', 'orgs.activate')).toBe(false);
    expect(isAuditable('POST', 'notifications.read')).toBe(false);
    expect(isAuditable('PUT', 'preferences.update')).toBe(false);
    expect(isAuditable('PUT', 'onboarding.set_dismissed')).toBe(true);
    expect(takesOrgFromResult('orgs.create')).toBe(true);
    expect(takesOrgFromResult('invites.accept')).toBe(true);
    expect(takesOrgFromResult('monitors.create')).toBe(false);
  });

  it('keeps the names of changed fields but never their values', () => {
    expect(
      bodyFields({
        name: 'x',
        password: 'hunter2',
        config: { url: 'https://secret' },
      }),
    ).toEqual(['config', 'name', 'password']);
    expect(bodyFields(undefined)).toEqual([]);
    expect(bodyFields('text')).toEqual([]);
    expect(bodyFields(['a'])).toEqual([]);
    expect(
      bodyFields(
        Object.fromEntries(
          Array.from({ length: 40 }, (_, index) => [`f${index}`, 1]),
        ),
      ).length,
    ).toBe(30);
  });

  it('finds the target and a readable summary', () => {
    expect(pickTarget({ id }, undefined)).toBe(id);
    expect(pickTarget({ name: 'x' }, { id })).toBe(id);
    expect(pickTarget({ id: 'not-a-uuid' }, { id: 'nope' })).toBe('');
    expect(pickTarget(undefined, undefined)).toBe('');
    expect(pickSummary({ name: 'API', token: 'secret-token' }, {})).toBe('API');
    expect(
      pickSummary({ key: { name: 'CI key' }, token: 'secret-token' }, {}),
    ).toBe('CI key');
    expect(pickSummary({ invite: { email: 'a@b.test' } }, {})).toBe('a@b.test');
    expect(pickSummary(undefined, { name: 'From body' })).toBe('From body');
    expect(pickSummary(undefined, undefined)).toBe('');
    expect(pickSummary({ title: 'x'.repeat(300) }, {}).length).toBe(120);
    expect(clip('  a \n b  ', 10)).toBe('a b');
  });

  it('says who did it', () => {
    const user = {
      id,
      email: 'ada@example.test',
      name: 'Ada',
      emailVerified: true,
    };
    const session: AuthContext = {
      sessionId: 's',
      user,
      orgId: org,
      role: 'admin',
    };
    expect(actorOf(session)).toEqual({
      actorType: 'user',
      actorId: id,
      actorLabel: 'ada@example.test',
    });
    const key: AuthContext = {
      ...session,
      apiKey: { id: org, name: 'CI', scopes: ['monitors:read'] },
    };
    expect(actorOf(key)).toEqual({
      actorType: 'api_key',
      actorId: org,
      actorLabel: 'CI',
    });
  });

  it('validates the filters', () => {
    expect(auditQuerySchema.parse({}).limit).toBe(50);
    expect(auditQuerySchema.parse({ limit: '200' }).limit).toBe(200);
    expect(
      auditQuerySchema.parse({ action: '', actor: '  ', from: '', before: '' }),
    ).toMatchObject({
      action: undefined,
      actor: undefined,
      from: undefined,
      before: undefined,
    });
    expect(auditQuerySchema.parse({ action: ' monitors ' }).action).toBe(
      'monitors',
    );
    expect(auditQuerySchema.safeParse({ limit: '201' }).success).toBe(false);
    expect(auditQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(auditQuerySchema.safeParse({ from: '2026-13-45' }).success).toBe(
      false,
    );
    expect(auditQuerySchema.safeParse({ from: 'yesterday' }).success).toBe(
      false,
    );
    expect(auditQuerySchema.safeParse({ before: '12; DROP' }).success).toBe(
      false,
    );
    expect(auditQuerySchema.safeParse({ format: 'xml' }).success).toBe(false);
  });

  it('builds a parameterized query', () => {
    const plain = buildAuditQuery(org, auditQuerySchema.parse({}));
    expect(plain.values).toEqual([org, 51]);
    expect(plain.text).toContain('org_id = $1');
    expect(plain.text).toContain('ORDER BY id DESC');

    const filtered = buildAuditQuery(
      org,
      auditQuerySchema.parse({
        action: '50%_off',
        actor: 'qzx',
        target: id,
        from: '2026-09-01',
        to: '2026-09-30',
        before: '900',
        limit: '10',
      }),
    );
    expect(filtered.values).toEqual([
      org,
      '50\\%\\_off%',
      '%qzx%',
      id,
      '2026-09-01T00:00:00Z',
      '2026-09-30T00:00:00Z',
      '900',
      11,
    ]);
    expect(filtered.text).toContain("action LIKE $2 ESCAPE '\\'");
    expect(filtered.text).toContain("actor_label ILIKE $3 ESCAPE '\\'");
    expect(filtered.text).toContain('target_id = $4');
    expect(filtered.text).toContain(
      "created_at < $6::timestamptz + interval '1 day'",
    );
    expect(filtered.text).toContain('id < $7::bigint');
    expect(filtered.text).not.toContain('qzx');

    const byId = buildAuditQuery(org, auditQuerySchema.parse({ actor: id }));
    expect(byId.text).toContain('actor_id = $2::uuid');

    const csv = buildAuditQuery(
      org,
      auditQuerySchema.parse({ format: 'csv', limit: '5' }),
    );
    expect(csv.values[csv.values.length - 1]).toBe(CSV_LIMIT + 1);
  });
});
