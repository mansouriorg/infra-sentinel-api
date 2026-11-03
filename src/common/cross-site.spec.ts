import { createCrossSiteGuard } from './cross-site';

function run(
  method: string,
  url: string,
  headers: Record<string, string> = {},
) {
  const guard = createCrossSiteGuard('api/v1');
  let status = 0;
  let nexted = false;
  const response = {
    status(code: number) {
      status = code;
      return response;
    },
    json() {
      return undefined;
    },
  };
  guard({ method, url, headers }, response, () => {
    nexted = true;
  });
  return { status, nexted };
}

describe('cross-site guard for sign-in and account endpoints', () => {
  it('lets JSON requests through', () => {
    expect(
      run('POST', '/api/v1/auth/login', {
        'content-type': 'application/json',
        'content-length': '40',
      }).nexted,
    ).toBe(true);
    expect(
      run('POST', '/api/v1/auth/login', {
        'content-type': 'application/json; charset=utf-8',
        'content-length': '40',
        'sec-fetch-site': 'same-origin',
      }).nexted,
    ).toBe(true);
    expect(
      run('POST', '/api/v1/auth/register', {
        'content-type': 'application/vnd.api+json',
        'content-length': '9',
      }).nexted,
    ).toBe(true);
    expect(
      run('POST', '/api/v1/auth/login', {
        'content-type': 'application/json',
        'content-length': '9',
        'sec-fetch-site': 'same-site',
      }).nexted,
    ).toBe(true);
  });

  it('lets requests without a body and without browser headers through', () => {
    expect(run('POST', '/api/v1/auth/logout').nexted).toBe(true);
    expect(
      run('POST', '/api/v1/auth/login?x=1', {
        'content-type': 'application/json',
        'content-length': '2',
      }).nexted,
    ).toBe(true);
  });

  it('refuses form posts, which is how a page on another site would sign you in as someone else', () => {
    const form = run('POST', '/api/v1/auth/login', {
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': '30',
    });
    expect(form).toEqual({ status: 415, nexted: false });
    expect(
      run('POST', '/api/v1/auth/login', {
        'content-type': 'text/plain',
        'content-length': '30',
      }).status,
    ).toBe(415);
    expect(
      run('POST', '/api/v1/auth/login', {
        'content-type': 'multipart/form-data; boundary=x',
        'content-length': '30',
      }).status,
    ).toBe(415);
    expect(
      run('POST', '/api/v1/auth/register', { 'content-length': '30' }).status,
    ).toBe(415);
    expect(
      run('PATCH', '/api/v1/auth/me', {
        'content-type': 'text/plain',
        'transfer-encoding': 'chunked',
      }).status,
    ).toBe(415);
  });

  it('refuses requests the browser marks as coming from another site', () => {
    expect(
      run('POST', '/api/v1/auth/login', {
        'content-type': 'application/json',
        'content-length': '9',
        'sec-fetch-site': 'cross-site',
      }),
    ).toEqual({ status: 403, nexted: false });
    expect(
      run('POST', '/api/v1/auth/logout', { 'sec-fetch-site': 'cross-site' })
        .status,
    ).toBe(403);
  });

  it('leaves everything else alone', () => {
    expect(
      run('GET', '/api/v1/auth/me', { 'sec-fetch-site': 'cross-site' }).nexted,
    ).toBe(true);
    expect(
      run('POST', '/api/v1/status/acme/subscribe', {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': '20',
        'sec-fetch-site': 'cross-site',
      }).nexted,
    ).toBe(true);
    expect(
      run('POST', '/status/acme/subscribe', {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': '20',
      }).nexted,
    ).toBe(true);
    expect(
      run('POST', '/api/v1/monitors', {
        'content-type': 'text/plain',
        'content-length': '20',
      }).nexted,
    ).toBe(true);
  });
});
