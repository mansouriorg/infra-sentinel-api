import { SecretBox } from './secret-box';

const box = new SecretBox('a-long-random-secret-for-the-unit-tests-123456');

describe('SecretBox', () => {
  it('seals and opens text, including empty and unicode text', () => {
    for (const text of [
      '',
      'JBSWY3DPEHPK3PXP',
      'clé secrète 🔐',
      'x'.repeat(5000),
    ]) {
      const sealed = box.seal(text);
      expect(sealed.startsWith('v1.')).toBe(true);
      expect(sealed).not.toContain(text || '\u0000');
      expect(box.open(sealed)).toBe(text);
    }
  });

  it('never produces the same output twice for the same text', () => {
    expect(box.seal('same')).not.toBe(box.seal('same'));
  });

  it('refuses text that was changed or sealed with another secret', () => {
    const sealed = box.seal('top secret');
    const parts = sealed.split('.');
    const flipped = `${parts[0]}.${parts[1]}.${parts[2]}.${Buffer.from('not it').toString('base64url')}`;
    expect(() => box.open(flipped)).toThrow();
    expect(() => box.open('garbage')).toThrow('Unreadable secret');
    expect(() =>
      new SecretBox('another-long-random-secret-for-the-tests-0987').open(
        sealed,
      ),
    ).toThrow();
  });

  it('signs tokens that expire and belong to one purpose', () => {
    const now = 1_700_000_000_000;
    const token = box.sign('login', { uid: 'u1' }, 60_000, now);
    expect(box.verify<{ uid: string }>('login', token, now + 59_000)?.uid).toBe(
      'u1',
    );
    expect(box.verify('login', token, now + 61_000)).toBeNull();
    expect(box.verify('sso', token, now + 1_000)).toBeNull();
    expect(box.verify('login', undefined, now)).toBeNull();
    expect(box.verify('login', 'nope', now)).toBeNull();
  });

  it('rejects a token whose body was changed', () => {
    const now = Date.now();
    const token = box.sign('login', { uid: 'u1' }, 60_000, now);
    const [body, mac] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ uid: 'u2', exp: now + 60_000 }),
    ).toString('base64url');
    expect(box.verify('login', `${forged}.${mac}`, now)).toBeNull();
    expect(box.verify('login', `${body}.${mac}`, now)?.exp).toBe(now + 60_000);
    expect(
      new SecretBox('another-long-random-secret-for-the-tests-0987').verify(
        'login',
        token,
        now,
      ),
    ).toBeNull();
  });
});
