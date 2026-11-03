import {
  hashPassword,
  normalizeEmail,
  randomToken,
  sha256,
  slugify,
  verifyPassword,
} from './crypto';

describe('crypto helpers', () => {
  it('hashes passwords with a unique salt and verifies them', async () => {
    const first = await hashPassword('correct horse battery');
    const second = await hashPassword('correct horse battery');

    expect(first).toMatch(/^scrypt\$\d+\$\d+\$\d+\$/);
    expect(first).not.toEqual(second);
    expect(await verifyPassword('correct horse battery', first)).toBe(true);
    expect(await verifyPassword('wrong password', first)).toBe(false);
  });

  it('rejects malformed hashes instead of throwing', async () => {
    expect(await verifyPassword('x', '')).toBe(false);
    expect(await verifyPassword('x', 'plain-text')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$a$b$c$d$e')).toBe(false);
  });

  it('creates url-safe random tokens', () => {
    const a = randomToken();
    const b = randomToken();
    expect(a).not.toEqual(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  });

  it('hashes tokens deterministically', () => {
    expect(sha256('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('normalizes emails and slugs', () => {
    expect(normalizeEmail('  Ada@Example.COM ')).toBe('ada@example.com');
    expect(slugify('Acme Inc.')).toMatch(/^acme-inc-[0-9a-f]{8}$/);
    expect(slugify('!!!')).toMatch(/^workspace-[0-9a-f]{8}$/);
    expect(slugify('Café Équipe')).toMatch(/^cafe-equipe-[0-9a-f]{8}$/);
  });
});
