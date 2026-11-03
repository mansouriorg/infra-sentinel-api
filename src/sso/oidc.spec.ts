import {
  constants,
  createHmac,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto';
import {
  authorizationUrl,
  checkIssuerUrl,
  decodeJwt,
  domainAllowed,
  emailDomain,
  endpointAllowed,
  generatePkce,
  isLoopbackHost,
  pkceChallenge,
  readClaims,
  selectKey,
  ssoSchema,
  verifyJwt,
  type Jwk,
} from './oidc';

const b64 = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

function make(
  alg: string,
  payload: Record<string, unknown>,
  privateKey: KeyObject,
  header: Record<string, unknown> = {},
): string {
  const input = `${b64({ alg, typ: 'JWT', ...header })}.${b64(payload)}`;
  const data = Buffer.from(input);
  let signature: Buffer;
  if (alg.startsWith('RS'))
    signature = sign(`sha${alg.slice(2)}`, data, privateKey);
  else if (alg.startsWith('PS')) {
    signature = sign(`sha${alg.slice(2)}`, data, {
      key: privateKey,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
    });
  } else if (alg.startsWith('ES')) {
    signature = sign(`sha${alg === 'ES512' ? '512' : alg.slice(2)}`, data, {
      key: privateKey,
      dsaEncoding: 'ieee-p1363',
    });
  } else signature = sign(null, data, privateKey);
  return `${input}.${signature.toString('base64url')}`;
}

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const rsaJwk = (kid: string): Jwk => ({
  ...(rsa.publicKey.export({ format: 'jwk' }) as Jwk),
  kid,
  use: 'sig',
});
const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const ecJwk = (kid: string): Jwk => ({
  ...(ec.publicKey.export({ format: 'jwk' }) as Jwk),
  kid,
});
const ed = generateKeyPairSync('ed25519');
const edJwk = (kid: string): Jwk => ({
  ...(ed.publicKey.export({ format: 'jwk' }) as Jwk),
  kid,
});
const weak = generateKeyPairSync('rsa', { modulusLength: 1024 });

const now = 1_800_000_000_000;
const good = {
  iss: 'https://idp.example.com',
  aud: 'client-1',
  sub: 'user-1',
  exp: now / 1000 + 300,
  iat: now / 1000 - 5,
  nonce: 'n-1',
  email: 'Ada@Example.com',
  email_verified: true,
  name: 'Ada Lovelace',
};
const expected = {
  issuer: 'https://idp.example.com',
  clientId: 'client-1',
  nonce: 'n-1',
};

describe('PKCE', () => {
  it('matches the example in RFC 7636', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('makes a fresh pair each time', () => {
    const a = generatePkce();
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pkceChallenge(a.verifier)).toBe(a.challenge);
    expect(generatePkce().verifier).not.toBe(a.verifier);
  });

  it('builds the sign-in address', () => {
    const url = new URL(
      authorizationUrl('https://idp.example.com/authorize?tenant=1', {
        clientId: 'c',
        redirectUri: 'https://app.test/cb',
        state: 's',
        nonce: 'n',
        challenge: 'ch',
      }),
    );
    expect(url.searchParams.get('tenant')).toBe('1');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'c',
      redirect_uri: 'https://app.test/cb',
      scope: 'openid email profile',
      state: 's',
      nonce: 'n',
      code_challenge: 'ch',
      code_challenge_method: 'S256',
    });
  });
});

describe('tokens', () => {
  it('reads a token and refuses things that are not tokens', () => {
    const token = make('RS256', good, rsa.privateKey);
    const jwt = decodeJwt(token);
    expect(jwt.payload.sub).toBe('user-1');
    expect(jwt.header.alg).toBe('RS256');
    for (const bad of [
      '',
      'a.b',
      'a.b.c.d',
      'not a token',
      `${b64({})}.${b64([])}.x`,
      `${b64('x')}.${b64({})}.x`,
      'x'.repeat(20_000),
    ]) {
      expect(() => decodeJwt(bad)).toThrow();
    }
  });

  it('checks signatures for each supported family', () => {
    const cases: Array<[string, KeyObject, Jwk]> = [
      ['RS256', rsa.privateKey, rsaJwk('r')],
      ['RS384', rsa.privateKey, rsaJwk('r')],
      ['RS512', rsa.privateKey, rsaJwk('r')],
      ['PS256', rsa.privateKey, rsaJwk('r')],
      ['ES256', ec.privateKey, ecJwk('e')],
      ['EdDSA', ed.privateKey, edJwk('d')],
    ];
    for (const [alg, privateKey, jwk] of cases) {
      const jwt = decodeJwt(make(alg, good, privateKey, { kid: jwk.kid }));
      const key = selectKey(jwt, [jwk]);
      expect(key).not.toBeNull();
      expect(verifyJwt(jwt, key as Jwk)).toBe(true);
    }
  });

  it('rejects a changed body, another key, and a weak key', () => {
    const token = make('RS256', good, rsa.privateKey, { kid: 'r' });
    const [head, , sig] = token.split('.');
    const forged = decodeJwt(
      `${head}.${b64({ ...good, sub: 'admin' })}.${sig}`,
    );
    expect(verifyJwt(forged, rsaJwk('r'))).toBe(false);
    const other = {
      ...(generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({
        format: 'jwk',
      }) as Jwk),
      kid: 'r',
    };
    expect(verifyJwt(decodeJwt(token), other)).toBe(false);
    const small = {
      ...(weak.publicKey.export({ format: 'jwk' }) as Jwk),
      kid: 'w',
    };
    expect(
      verifyJwt(
        decodeJwt(make('RS256', good, weak.privateKey, { kid: 'w' })),
        small,
      ),
    ).toBe(false);
    expect(
      verifyJwt(decodeJwt(token), { kty: 'RSA', n: 'AQAB', e: 'AQAB' }),
    ).toBe(false);
    expect(verifyJwt(decodeJwt(token), { kty: 'oct', k: 'AAAA' })).toBe(false);
  });

  it('never accepts "none" or a shared-secret algorithm', () => {
    const none = decodeJwt(`${b64({ alg: 'none' })}.${b64(good)}.`);
    expect(selectKey(none, [rsaJwk('r')])).toBeNull();
    const input = `${b64({ alg: 'HS256', kid: 'r' })}.${b64(good)}`;
    const secret = JSON.stringify(rsaJwk('r'));
    const hs = decodeJwt(
      `${input}.${createHmac('sha256', secret).update(input).digest('base64url')}`,
    );
    expect(selectKey(hs, [rsaJwk('r')])).toBeNull();
    expect(verifyJwt(hs, rsaJwk('r'))).toBe(false);
    const wrongFamily = decodeJwt(
      make('ES256', good, ec.privateKey, { kid: 'r' }),
    );
    expect(selectKey(wrongFamily, [rsaJwk('r')])).toBeNull();
    expect(
      selectKey(decodeJwt(`${b64({ alg: '__proto__' })}.${b64(good)}.x`), [
        rsaJwk('r'),
      ]),
    ).toBeNull();
    expect(
      selectKey(decodeJwt(`${b64({ alg: 'constructor' })}.${b64(good)}.x`), [
        rsaJwk('r'),
      ]),
    ).toBeNull();
  });

  it('picks the key by id, and only guesses when there is exactly one fit', () => {
    const jwt = decodeJwt(make('RS256', good, rsa.privateKey, { kid: 'two' }));
    expect(selectKey(jwt, [rsaJwk('one'), rsaJwk('two')])?.kid).toBe('two');
    expect(selectKey(jwt, [rsaJwk('one')])).toBeNull();
    const noKid = decodeJwt(make('RS256', good, rsa.privateKey));
    expect(selectKey(noKid, [rsaJwk('one')])?.kid).toBe('one');
    expect(selectKey(noKid, [rsaJwk('one'), rsaJwk('two')])).toBeNull();
    expect(selectKey(noKid, [{ ...rsaJwk('enc'), use: 'enc' }])).toBeNull();
    expect(selectKey(noKid, [{ ...rsaJwk('x'), alg: 'RS512' }])).toBeNull();
  });
});

describe('claims', () => {
  it('accepts a good token and tidies the identity', () => {
    const result = readClaims(good, expected, now);
    expect(result).toEqual({
      ok: true,
      identity: {
        subject: 'user-1',
        email: 'ada@example.com',
        emailVerified: true,
        name: 'Ada Lovelace',
      },
    });
  });

  it('refuses each way a token can be wrong', () => {
    const reason = (change: Record<string, unknown>, ex = expected) => {
      const result = readClaims({ ...good, ...change }, ex, now);
      return result.ok ? 'ok' : result.reason;
    };
    expect(reason({ iss: 'https://evil.example.com' })).toBe('issuer');
    expect(reason({ aud: 'someone-else' })).toBe('audience');
    expect(reason({ aud: undefined })).toBe('audience');
    expect(reason({ aud: ['client-1', 'other'] })).toBe('authorized party');
    expect(reason({ aud: ['client-1', 'other'], azp: 'client-1' })).toBe('ok');
    expect(reason({ azp: 'other' })).toBe('authorized party');
    expect(reason({ exp: now / 1000 - 120 })).toBe('expired');
    expect(reason({ exp: now / 1000 - 30 })).toBe('ok');
    expect(reason({ exp: 'soon' })).toBe('expired');
    expect(reason({ exp: undefined })).toBe('expired');
    expect(reason({ iat: now / 1000 + 600 })).toBe('issued in the future');
    expect(reason({ nbf: now / 1000 + 600 })).toBe('not yet valid');
    expect(reason({ nonce: 'other' })).toBe('nonce');
    expect(reason({ nonce: undefined })).toBe('nonce');
    expect(reason({ sub: '' })).toBe('subject');
    expect(reason({ sub: 42 })).toBe('subject');
    expect(reason({ sub: 'x'.repeat(256) })).toBe('subject');
    expect(reason({ email: undefined })).toBe('email');
    expect(reason({ email: 'not-an-email' })).toBe('email');
    expect(reason({ email: 'a b@example.com' })).toBe('email');
  });

  it('reads the verified flag in the shapes providers use', () => {
    const verified = (value: unknown) => {
      const result = readClaims(
        { ...good, email_verified: value },
        expected,
        now,
      );
      return result.ok ? result.identity.emailVerified : 'fail';
    };
    expect(verified(true)).toBe(true);
    expect(verified('true')).toBe(true);
    expect(verified(false)).toBe(false);
    expect(verified('false')).toBe(false);
    expect(verified(undefined)).toBeUndefined();
    expect(verified('yes')).toBeUndefined();
  });

  it('falls back to a sensible name', () => {
    const name = (change: Record<string, unknown>) => {
      const result = readClaims({ ...good, ...change }, expected, now);
      return result.ok ? result.identity.name : 'fail';
    };
    expect(name({ name: undefined, preferred_username: 'ada.l' })).toBe(
      'ada.l',
    );
    expect(name({ name: undefined })).toBe('ada');
    expect(name({ name: '  Ada   Lovelace  ' })).toBe('Ada Lovelace');
    expect(name({ name: 'x'.repeat(200) })).toHaveLength(80);
  });
});

describe('domains and addresses', () => {
  it('matches the whole domain only', () => {
    expect(emailDomain('Ada@Example.com')).toBe('example.com');
    expect(domainAllowed('ada@example.com', ['example.com'])).toBe(true);
    expect(domainAllowed('ada@sub.example.com', ['example.com'])).toBe(false);
    expect(domainAllowed('ada@example.com.evil.test', ['example.com'])).toBe(
      false,
    );
    expect(domainAllowed('ada@notexample.com', ['example.com'])).toBe(false);
    expect(domainAllowed('a@b@example.com', ['example.com'])).toBe(true);
  });

  it('wants https except for this computer', () => {
    expect(checkIssuerUrl('https://accounts.example.com', false)).toBeNull();
    expect(
      checkIssuerUrl('https://accounts.example.com/realms/main', false),
    ).toBeNull();
    expect(checkIssuerUrl('http://accounts.example.com', false)).toMatch(
      /https/,
    );
    expect(checkIssuerUrl('http://accounts.example.com', true)).toBeNull();
    expect(checkIssuerUrl('http://localhost:8080/realms/x', false)).toBeNull();
    expect(checkIssuerUrl('http://127.0.0.1:9000', false)).toBeNull();
    expect(checkIssuerUrl('https://u:p@example.com', false)).toMatch(
      /user name/,
    );
    expect(checkIssuerUrl('https://example.com/?a=1', false)).toMatch(/\?/);
    expect(checkIssuerUrl('ftp://example.com', false)).toMatch(/https/);
    expect(checkIssuerUrl('nonsense', false)).toMatch(/issuer address/);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('127.1.2.3')).toBe(true);
    expect(isLoopbackHost('localhost.evil.test')).toBe(false);
  });

  it('applies the same rule to addresses the provider hands us', () => {
    expect(endpointAllowed('https://idp.example.com/token', false)).toBe(true);
    expect(endpointAllowed('http://idp.example.com/token', false)).toBe(false);
    expect(endpointAllowed('http://idp.example.com/token', true)).toBe(true);
    expect(endpointAllowed('http://localhost:8080/token', false)).toBe(true);
    expect(endpointAllowed('https://u:p@idp.example.com/token', false)).toBe(
      false,
    );
    expect(endpointAllowed('javascript:alert(1)', true)).toBe(false);
    expect(endpointAllowed(42, true)).toBe(false);
    expect(endpointAllowed(undefined, true)).toBe(false);
  });
});

describe('settings', () => {
  const base = {
    issuer: 'https://idp.example.com',
    clientId: 'abc',
    allowedDomains: ['Example.com', 'example.com', ' corp.example.org '],
  };

  it('tidies and defaults what an admin enters', () => {
    const parsed = ssoSchema.parse(base);
    expect(parsed.allowedDomains).toEqual(['example.com', 'corp.example.org']);
    expect(parsed).toMatchObject({
      defaultRole: 'member',
      autoProvision: true,
      enabled: false,
    });
  });

  it('refuses owners, wildcards and empty lists', () => {
    expect(ssoSchema.safeParse({ ...base, defaultRole: 'owner' }).success).toBe(
      false,
    );
    expect(
      ssoSchema.safeParse({ ...base, allowedDomains: ['*.example.com'] })
        .success,
    ).toBe(false);
    expect(
      ssoSchema.safeParse({ ...base, allowedDomains: ['localhost'] }).success,
    ).toBe(false);
    expect(
      ssoSchema.safeParse({ ...base, allowedDomains: ['-bad.com'] }).success,
    ).toBe(false);
    expect(ssoSchema.safeParse({ ...base, allowedDomains: [] }).success).toBe(
      false,
    );
    expect(ssoSchema.safeParse({ ...base, clientId: ' ' }).success).toBe(false);
    expect(ssoSchema.safeParse({ ...base, defaultRole: 'admin' }).success).toBe(
      true,
    );
  });
});
