import { loadEnv, parseDotenv, validateEnv } from './env';

describe('environment', () => {
  it('fills in defaults', () => {
    const env = validateEnv({});

    expect(env.PORT).toBe(4000);
    expect(env.NODE_ENV).toBe('development');
    expect(env.MIGRATE_ON_BOOT).toBe(true);
    expect(env.COOKIE_SECURE).toBe(false);
    expect(env.SMTP_PORT).toBe(1025);
    expect(env.SMTP_USER).toBeUndefined();
    expect(env.DATABASE_URL).toContain('postgres://');
  });

  it('has monitoring defaults', () => {
    const env = validateEnv({});

    expect(env.SCHEDULER_ENABLED).toBe(true);
    expect(env.SCHEDULER_CONCURRENCY).toBe(20);
    expect(env.RESULT_RETENTION_DAYS).toBe(30);
    expect(env.BLOCK_PRIVATE_TARGETS).toBe(false);
  });

  it('rejects out-of-range monitoring settings', () => {
    expect(() => validateEnv({ SCHEDULER_CONCURRENCY: '0' })).toThrow(
      /SCHEDULER_CONCURRENCY/,
    );
    expect(() => validateEnv({ RESULT_RETENTION_DAYS: '1000' })).toThrow(
      /RESULT_RETENTION_DAYS/,
    );
  });

  it('has security defaults and protects the secret in production', () => {
    const env = validateEnv({});

    expect(env.APP_SECRET.length).toBeGreaterThanOrEqual(32);
    expect(env.AUDIT_RETENTION_DAYS).toBe(365);
    expect(env.NOTIFICATION_RETENTION_DAYS).toBe(30);
    expect(env.WEBHOOK_RETENTION_DAYS).toBe(14);
    expect(env.API_RATE_LIMIT_PER_MINUTE).toBe(600);
    expect(env.SSO_ALLOW_HTTP).toBe(false);
    expect(() => validateEnv({ NODE_ENV: 'production' })).toThrow(/APP_SECRET/);
    expect(() => validateEnv({ APP_SECRET: 'short' })).toThrow(/APP_SECRET/);
    expect(
      validateEnv({ NODE_ENV: 'production', APP_SECRET: 'x'.repeat(40) })
        .APP_SECRET,
    ).toBe('x'.repeat(40));
    expect(() => validateEnv({ AUDIT_RETENTION_DAYS: '5' })).toThrow(
      /AUDIT_RETENTION_DAYS/,
    );
    expect(() => validateEnv({ NOTIFICATION_RETENTION_DAYS: '0' })).toThrow(
      /NOTIFICATION_RETENTION_DAYS/,
    );
  });

  it('keeps metrics off until a long enough token is set', () => {
    expect(validateEnv({}).METRICS_TOKEN).toBeUndefined();
    expect(validateEnv({ METRICS_TOKEN: '' }).METRICS_TOKEN).toBeUndefined();
    expect(validateEnv({ METRICS_TOKEN: 'x'.repeat(16) }).METRICS_TOKEN).toBe(
      'x'.repeat(16),
    );
    expect(() => validateEnv({ METRICS_TOKEN: 'short' })).toThrow(
      /METRICS_TOKEN/,
    );
  });

  it('chooses the log format', () => {
    expect(validateEnv({}).LOG_FORMAT).toBe('text');
    expect(validateEnv({ LOG_FORMAT: 'json' }).LOG_FORMAT).toBe('json');
    expect(() => validateEnv({ LOG_FORMAT: 'xml' })).toThrow(/LOG_FORMAT/);
  });

  it('chooses who may create an account', () => {
    expect(validateEnv({}).SIGNUPS).toBe('open');
    expect(validateEnv({ SIGNUPS: 'invite' }).SIGNUPS).toBe('invite');
    expect(validateEnv({ SIGNUPS: 'closed' }).SIGNUPS).toBe('closed');
    expect(() => validateEnv({ SIGNUPS: 'maybe' })).toThrow(/SIGNUPS/);
  });

  it('coerces and normalizes values', () => {
    const env = validateEnv({
      PORT: '5000',
      COOKIE_SECURE: 'true',
      SMTP_USER: '',
      SESSION_TTL_DAYS: '7',
    });

    expect(env.PORT).toBe(5000);
    expect(env.COOKIE_SECURE).toBe(true);
    expect(env.SMTP_USER).toBeUndefined();
    expect(env.SESSION_TTL_DAYS).toBe(7);
  });

  it('reports every invalid value', () => {
    expect(() => validateEnv({ PORT: 'abc', WEB_URL: 'nope' })).toThrow(/PORT/);
    expect(() => validateEnv({ COOKIE_SECURE: 'maybe' })).toThrow(
      /COOKIE_SECURE/,
    );
  });

  it('parses dotenv text', () => {
    const values = parseDotenv(
      [
        '# comment',
        'A=1',
        'B="two words"',
        "C='x'",
        'export D=4 # note',
        '',
        'bad line',
      ].join('\n'),
    );

    expect(values).toEqual({ A: '1', B: 'two words', C: 'x', D: '4' });
  });

  it('lets real environment variables beat the file', () => {
    const env = loadEnv({ PORT: '4100' }, '/definitely/not/here/.env');
    expect(env.PORT).toBe(4100);
  });
});
