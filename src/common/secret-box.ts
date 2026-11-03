import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const VERSION = 'v1';

export class SecretBox {
  private readonly key: Buffer;
  private readonly macKey: Buffer;

  constructor(secret: string) {
    this.key = Buffer.from(
      hkdfSync('sha256', secret, 'infra-sentinel', 'secret-box', 32),
    );
    this.macKey = Buffer.from(
      hkdfSync('sha256', secret, 'infra-sentinel', 'mac', 32),
    );
  }

  seal(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return [
      VERSION,
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      data.toString('base64url'),
    ].join('.');
  }

  open(sealed: string): string {
    const [version, iv, tag, data] = sealed.split('.');
    if (version !== VERSION || !iv || !tag || data === undefined) {
      throw new Error('Unreadable secret');
    }
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.key,
      Buffer.from(iv, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(data, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }

  mac(purpose: string, value: string): string {
    return createHmac('sha256', this.macKey)
      .update(`${purpose}\n${value}`)
      .digest('base64url');
  }

  sign(
    purpose: string,
    payload: Record<string, unknown>,
    ttlMs: number,
    now: number = Date.now(),
  ): string {
    const body = Buffer.from(
      JSON.stringify({ ...payload, exp: now + ttlMs }),
    ).toString('base64url');
    return `${body}.${this.mac(purpose, body)}`;
  }

  verify<T extends Record<string, unknown>>(
    purpose: string,
    token: string | undefined,
    now: number = Date.now(),
  ): (T & { exp: number }) | null {
    if (!token) return null;
    const index = token.lastIndexOf('.');
    if (index < 1) return null;
    const body = token.slice(0, index);
    const given = Buffer.from(token.slice(index + 1));
    const expected = Buffer.from(this.mac(purpose, body));
    if (given.length !== expected.length || !timingSafeEqual(given, expected))
      return null;
    try {
      const payload = JSON.parse(
        Buffer.from(body, 'base64url').toString('utf8'),
      ) as T & { exp: number };
      return typeof payload.exp === 'number' && payload.exp > now
        ? payload
        : null;
    } catch {
      return null;
    }
  }
}
