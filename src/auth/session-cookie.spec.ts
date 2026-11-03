import { clientMeta, readSessionToken, SESSION_COOKIE } from './session-cookie';

describe('session cookie helpers', () => {
  it('reads the token from the cookie header', () => {
    const headers = { cookie: `a=1; ${SESSION_COOKIE}=tok%2Den; b=2` };
    expect(readSessionToken({ headers })).toBe('tok-en');
  });

  it('prefers a bearer token', () => {
    const headers = {
      authorization: 'Bearer abc',
      cookie: `${SESSION_COOKIE}=other`,
    };
    expect(readSessionToken({ headers })).toBe('abc');
  });

  it('returns nothing when there is no session', () => {
    expect(readSessionToken({ headers: {} })).toBeUndefined();
    expect(readSessionToken({ headers: { cookie: 'a=1' } })).toBeUndefined();
    expect(
      readSessionToken({ headers: { authorization: 'Bearer ' } }),
    ).toBeUndefined();
  });

  it('describes the client', () => {
    const meta = clientMeta({
      ip: '1.2.3.4',
      headers: { 'user-agent': 'jest' },
    });
    expect(meta).toEqual({ ip: '1.2.3.4', userAgent: 'jest' });
    expect(clientMeta({ ip: undefined, headers: {} }).ip).toBe('unknown');
  });
});
