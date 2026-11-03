import {
  base32Decode,
  base32Encode,
  classifyCode,
  generateRecoveryCodes,
  generateTotpSecret,
  hotp,
  matchTotp,
  normalizeRecoveryCode,
  otpauthUrl,
  stepAt,
  totpAt,
} from './two-factor';

const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('TOTP', () => {
  it('matches the RFC 6238 test vectors', () => {
    const vectors: Array<[number, string]> = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130'],
    ];
    for (const [seconds, expected] of vectors) {
      expect(totpAt(RFC_SECRET, seconds * 1000, 8)).toBe(expected);
    }
  });

  it('matches the RFC 4226 counter vectors', () => {
    const key = Buffer.from('12345678901234567890');
    const expected = [
      '755224',
      '287082',
      '359152',
      '969429',
      '338314',
      '254676',
      '287922',
      '162583',
      '399871',
      '520489',
    ];
    expected.forEach((code, counter) => expect(hotp(key, counter)).toBe(code));
  });

  it('round-trips base32 and tolerates spaces, dashes and lower case', () => {
    for (const size of [1, 2, 3, 4, 5, 10, 20, 33]) {
      const bytes = Buffer.from(
        Array.from({ length: size }, (_, i) => (i * 37 + 11) & 255),
      );
      expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true);
    }
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('mzxw 6ytb-oi==').toString()).toBe('foobar');
    expect(() => base32Decode('MZXW1')).toThrow('Not a valid secret');
  });

  it('makes a 32 character secret', () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(generateTotpSecret()).not.toBe(secret);
  });

  it('accepts the current code and one step either side', () => {
    const now = 1_700_000_000_000;
    const step = stepAt(now);
    const code = (offset: number) =>
      totpAt(RFC_SECRET, (step + offset) * 30_000);
    expect(matchTotp(RFC_SECRET, code(0), now, 0)).toBe(step);
    expect(matchTotp(RFC_SECRET, code(-1), now, 0)).toBe(step - 1);
    expect(matchTotp(RFC_SECRET, code(1), now, 0)).toBe(step + 1);
    expect(matchTotp(RFC_SECRET, code(-2), now, 0)).toBeNull();
    expect(matchTotp(RFC_SECRET, code(2), now, 0)).toBeNull();
  });

  it('refuses a code that was already used', () => {
    const now = 1_700_000_000_000;
    const step = stepAt(now);
    const code = totpAt(RFC_SECRET, now);
    expect(matchTotp(RFC_SECRET, code, now, step)).toBeNull();
    expect(matchTotp(RFC_SECRET, code, now, step - 1)).toBe(step);
  });

  it('refuses malformed input', () => {
    const now = 1_700_000_000_000;
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 5x']) {
      expect(matchTotp(RFC_SECRET, bad, now, 0)).toBeNull();
    }
    const good = totpAt(RFC_SECRET, now);
    expect(
      matchTotp(RFC_SECRET, `${good.slice(0, 3)} ${good.slice(3)}`, now, 0),
    ).toBe(stepAt(now));
  });

  it('builds the link an authenticator app reads', () => {
    const url = otpauthUrl(
      'Infra Sentinel',
      'ada@example.com',
      'JBSWY3DPEHPK3PXP',
    );
    expect(
      url.startsWith('otpauth://totp/Infra%20Sentinel:ada%40example.com?'),
    ).toBe(true);
    const query = new URL(url).searchParams;
    expect(query.get('secret')).toBe('JBSWY3DPEHPK3PXP');
    expect(query.get('issuer')).toBe('Infra Sentinel');
    expect(query.get('digits')).toBe('6');
    expect(query.get('period')).toBe('30');
  });
});

describe('recovery codes', () => {
  it('makes ten different codes in a readable shape', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes)
      expect(code).toMatch(
        /^[a-hj-km-np-z2-9]{4}-[a-hj-km-np-z2-9]{4}-[a-hj-km-np-z2-9]{4}$/,
      );
  });

  it('reads codes however they were typed', () => {
    expect(normalizeRecoveryCode(' ABCD-efgh 2345 ')).toBe('abcdefgh2345');
    expect(classifyCode('123 456')).toBe('totp');
    expect(classifyCode('abcd-efgh-2345')).toBe('recovery');
    expect(classifyCode('ABCDEFGH2345')).toBe('recovery');
    expect(classifyCode('12345')).toBeNull();
    expect(classifyCode('too short')).toBeNull();
    expect(classifyCode('')).toBeNull();
  });
});
