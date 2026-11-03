import {
  describeNetworkError,
  evaluateCertificate,
  parseStatusExpectation,
  readJsonPath,
} from './assertions';

describe('parseStatusExpectation', () => {
  it('matches ranges and single codes', () => {
    const matches = parseStatusExpectation('200-299, 301,404');
    expect(matches(200)).toBe(true);
    expect(matches(299)).toBe(true);
    expect(matches(301)).toBe(true);
    expect(matches(404)).toBe(true);
    expect(matches(300)).toBe(false);
    expect(matches(500)).toBe(false);
  });
});

describe('readJsonPath', () => {
  const body = {
    data: { status: 'ok', items: [{ id: 7 }, { id: 8 }] },
    ready: true,
  };

  it('reads nested values and array items', () => {
    expect(readJsonPath(body, 'data.status')).toBe('ok');
    expect(readJsonPath(body, 'data.items[1].id')).toBe(8);
    expect(readJsonPath(body, 'ready')).toBe(true);
  });

  it('returns undefined for missing paths', () => {
    expect(readJsonPath(body, 'data.nope.deeper')).toBeUndefined();
    expect(readJsonPath(null, 'a')).toBeUndefined();
  });
});

describe('evaluateCertificate', () => {
  const now = new Date('2026-06-01T00:00:00Z');
  const days = (n: number) => new Date(now.getTime() + n * 86_400_000);
  const options = { warnDays: 14, allowUntrusted: false };

  it('accepts a certificate with plenty of time left', () => {
    const verdict = evaluateCertificate(
      { validTo: days(60), authorized: true, authorizationError: null },
      options,
      now,
    );
    expect(verdict.status).toBe('up');
    expect(verdict.daysLeft).toBe(60);
  });

  it('warns when expiry is close', () => {
    const verdict = evaluateCertificate(
      { validTo: days(10), authorized: true, authorizationError: null },
      options,
      now,
    );
    expect(verdict.status).toBe('degraded');
    expect(verdict.message).toContain('10 days');
  });

  it('fails when expired', () => {
    const verdict = evaluateCertificate(
      {
        validTo: days(-3),
        authorized: false,
        authorizationError: 'CERT_HAS_EXPIRED',
      },
      options,
      now,
    );
    expect(verdict.status).toBe('down');
    expect(verdict.message).toContain('expired');
  });

  it('fails on untrusted chains unless allowed', () => {
    const facts = {
      validTo: days(90),
      authorized: false,
      authorizationError: 'DEPTH_ZERO_SELF_SIGNED_CERT',
    };
    expect(evaluateCertificate(facts, options, now).status).toBe('down');
    expect(
      evaluateCertificate(facts, { ...options, allowUntrusted: true }, now)
        .status,
    ).toBe('up');
  });

  it('fails when there is no certificate', () => {
    expect(
      evaluateCertificate(
        { validTo: null, authorized: false, authorizationError: null },
        options,
        now,
      ).status,
    ).toBe('down');
  });
});

describe('describeNetworkError', () => {
  it('turns system errors into plain sentences', () => {
    expect(
      describeNetworkError(
        Object.assign(new Error('x'), { code: 'ECONNREFUSED' }),
        5000,
      ),
    ).toBe('Connection refused');
    expect(
      describeNetworkError(
        Object.assign(new Error('x'), { code: 'ENOTFOUND' }),
        5000,
      ),
    ).toContain('resolved');
    expect(describeNetworkError(new Error('socket timed out'), 3000)).toBe(
      'Timed out after 3000 ms',
    );
  });
});
