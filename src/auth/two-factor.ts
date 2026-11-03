import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const TOTP_PERIOD_SEC = 30;
export const TOTP_DIGITS = 6;
export const RECOVERY_CODE_COUNT = 10;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const RECOVERY_LENGTH = 12;

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error('Not a valid secret');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
      value &= (1 << bits) - 1;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(
  key: Uint8Array,
  counter: number,
  digits: number = TOTP_DIGITS,
): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hash = createHmac('sha1', key).update(message).digest();
  const offset = hash[hash.length - 1] & 15;
  const binary =
    ((hash[offset] & 127) << 24) |
    (hash[offset + 1] << 16) |
    (hash[offset + 2] << 8) |
    hash[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function stepAt(
  timeMs: number,
  period: number = TOTP_PERIOD_SEC,
): number {
  return Math.floor(timeMs / 1000 / period);
}

export function totpAt(
  secret: string,
  timeMs: number,
  digits: number = TOTP_DIGITS,
): string {
  return hotp(base32Decode(secret), stepAt(timeMs), digits);
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function cleanCode(input: string): string {
  return input.replace(/[\s-]/g, '');
}

export function matchTotp(
  secret: string,
  input: string,
  nowMs: number,
  lastStep: number,
): number | null {
  const code = cleanCode(input);
  if (!/^\d{6}$/.test(code)) return null;
  const key = base32Decode(secret);
  const current = stepAt(nowMs);
  let matched: number | null = null;
  for (const step of [current - 1, current, current + 1]) {
    const equal = sameText(hotp(key, step), code);
    if (equal && step > lastStep && matched === null) matched = step;
  }
  return matched;
}

export function otpauthUrl(
  issuer: string,
  account: string,
  secret: string,
): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const query = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SEC),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}

function randomFrom(alphabet: string, length: number): string {
  const limit = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte < limit && out.length < length)
        out += alphabet[byte % alphabet.length];
    }
  }
  return out;
}

export function generateRecoveryCodes(
  count: number = RECOVERY_CODE_COUNT,
): string[] {
  const codes = new Set<string>();
  while (codes.size < count) {
    const raw = randomFrom(RECOVERY_ALPHABET, RECOVERY_LENGTH);
    codes.add(`${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`);
  }
  return [...codes];
}

export function normalizeRecoveryCode(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export type CodeKind = 'totp' | 'recovery';

export function classifyCode(input: string): CodeKind | null {
  const compact = cleanCode(input);
  if (/^\d{6}$/.test(compact)) return 'totp';
  return normalizeRecoveryCode(input).length === RECOVERY_LENGTH
    ? 'recovery'
    : null;
}
