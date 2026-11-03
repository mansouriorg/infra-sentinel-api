import {
  API_SCOPES,
  createKeySchema,
  effectiveRole,
  expandScopes,
  expiryDate,
  generateApiKey,
  isApiKeyToken,
  keyStatus,
  parseApiKey,
} from './api-keys';

describe('api keys', () => {
  it('generates unique keys that parse back to the stored hash and prefix', () => {
    const first = generateApiKey();
    const second = generateApiKey();
    expect(first.token).not.toBe(second.token);
    expect(first.token).toMatch(/^isk_[0-9a-f]{10}_[A-Za-z0-9_-]{40}$/);
    expect(first.prefix).toBe(first.token.slice(0, 14));
    expect(parseApiKey(first.token)).toEqual({
      prefix: first.prefix,
      hash: first.hash,
    });
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses text that is not a key', () => {
    expect(isApiKeyToken('isk_anything')).toBe(true);
    expect(isApiKeyToken('abc')).toBe(false);
    expect(parseApiKey('isk_short')).toBeNull();
    expect(parseApiKey(`isk_zzzzzzzzzz_${'a'.repeat(40)}`)).toBeNull();
    expect(parseApiKey(`isk_0123456789_${'a'.repeat(39)}`)).toBeNull();
    expect(parseApiKey(`isk_0123456789_${'a'.repeat(41)}`)).toBeNull();
  });

  it('adds the read scope that a write scope needs and drops unknown scopes', () => {
    expect(expandScopes(['monitors:write'])).toEqual([
      'monitors:read',
      'monitors:write',
    ]);
    expect(
      expandScopes(['status:write', 'reports:read', 'bogus', 'monitors:read']),
    ).toEqual(['monitors:read', 'status:read', 'status:write', 'reports:read']);
    expect(expandScopes([])).toEqual([]);
    expect(expandScopes(['servers:read', 'servers:read'])).toEqual([
      'servers:read',
    ]);
  });

  it('lists every scope once with a label and a description', () => {
    const ids = API_SCOPES.map((scope) => scope.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const scope of API_SCOPES) {
      expect(scope.label.length).toBeGreaterThan(3);
      expect(scope.description.endsWith('.')).toBe(true);
      expect(scope.access).toBe(scope.id.endsWith(':write') ? 'write' : 'read');
    }
  });

  it('caps the role: read keys are viewers, write keys are members, never above the creator', () => {
    expect(effectiveRole(['monitors:read'], 'owner')).toBe('viewer');
    expect(effectiveRole(['monitors:read', 'monitors:write'], 'owner')).toBe(
      'member',
    );
    expect(effectiveRole(['monitors:write'], 'admin')).toBe('member');
    expect(effectiveRole(['monitors:write'], 'viewer')).toBe('viewer');
    expect(effectiveRole(['monitors:read'], 'viewer')).toBe('viewer');
  });

  it('works out expiry and status', () => {
    const now = Date.UTC(2026, 0, 1);
    expect(expiryDate(null, now)).toBeNull();
    expect(expiryDate(undefined, now)).toBeNull();
    expect(expiryDate(90, now)?.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(keyStatus({ revoked_at: null, expires_at: null }, now)).toBe(
      'active',
    );
    expect(
      keyStatus({ revoked_at: null, expires_at: new Date(now + 1000) }, now),
    ).toBe('active');
    expect(
      keyStatus(
        { revoked_at: null, expires_at: new Date(now).toISOString() },
        now,
      ),
    ).toBe('expired');
    expect(
      keyStatus({ revoked_at: new Date(now), expires_at: null }, now),
    ).toBe('revoked');
  });

  it('validates the create form', () => {
    expect(
      createKeySchema.safeParse({ name: 'CI', scopes: ['monitors:read'] })
        .success,
    ).toBe(true);
    expect(
      createKeySchema.safeParse({
        name: 'CI',
        scopes: ['monitors:read'],
        expiresInDays: 90,
      }).success,
    ).toBe(true);
    expect(
      createKeySchema.safeParse({
        name: 'CI',
        scopes: ['monitors:read'],
        expiresInDays: null,
      }).success,
    ).toBe(true);
    expect(
      createKeySchema.safeParse({ name: '  ', scopes: ['monitors:read'] })
        .success,
    ).toBe(false);
    expect(createKeySchema.safeParse({ name: 'CI', scopes: [] }).success).toBe(
      false,
    );
    expect(
      createKeySchema.safeParse({ name: 'CI', scopes: ['nope'] }).success,
    ).toBe(false);
    expect(
      createKeySchema.safeParse({
        name: 'CI',
        scopes: ['monitors:read'],
        expiresInDays: 7,
      }).success,
    ).toBe(false);
    expect(
      createKeySchema.safeParse({
        name: 'x'.repeat(61),
        scopes: ['monitors:read'],
      }).success,
    ).toBe(false);
    expect(
      createKeySchema.parse({ name: ' CI ', scopes: ['monitors:read'] }).name,
    ).toBe('CI');
  });
});
