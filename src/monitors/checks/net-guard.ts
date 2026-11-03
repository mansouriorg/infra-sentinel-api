import * as dns from 'node:dns';
import { isIP } from 'node:net';

function ipv4ToNumber(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

const V4_RANGES: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['168.63.129.16', 32],
  ['224.0.0.0', 3],
];

function isPrivateV4(address: string): boolean {
  const value = ipv4ToNumber(address);
  if (value === null) return false;
  return V4_RANGES.some(([base, bits]) => {
    const start = ipv4ToNumber(base) as number;
    const size = 2 ** (32 - bits);
    return value >= start && value < start + size;
  });
}

function expandV6(address: string): number[] | null {
  let text = address;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const value = ipv4ToNumber(dotted[1]);
    if (value === null) return null;
    text = `${text.slice(0, dotted.index)}${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const read = (part: string): number[] | null => {
    if (part === '') return [];
    const groups = part.split(':');
    const out: number[] = [];
    for (const group of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      out.push(parseInt(group, 16));
    }
    return out;
  };
  const head = read(halves[0]);
  const tail = halves.length === 2 ? read(halves[1]) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

function v4FromGroups(high: number, low: number): string {
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

function isPrivateV6(address: string): boolean {
  const groups = expandV6(address);
  if (!groups) return true;
  const [a, b, c, d, e, f, g, h] = groups;
  const leadingZeros = a === 0 && b === 0 && c === 0 && d === 0 && e === 0;
  if (leadingZeros && f === 0 && g === 0 && (h === 0 || h === 1)) return true;
  if (leadingZeros && f === 0xffff) return isPrivateV4(v4FromGroups(g, h));
  if (leadingZeros && f === 0) return true;
  if (a === 0x64 && b === 0xff9b) {
    if (c === 0 && d === 0 && e === 0 && f === 0)
      return isPrivateV4(v4FromGroups(g, h));
    if (c === 1) return true;
  }
  if (a === 0x2002) return isPrivateV4(v4FromGroups(b, c));
  if ((a & 0xfe00) === 0xfc00) return true;
  if ((a & 0xffc0) === 0xfe80) return true;
  if ((a & 0xffc0) === 0xfec0) return true;
  if ((a & 0xff00) === 0xff00) return true;
  return false;
}

export function isPrivateAddress(input: string): boolean {
  const address = input
    .replace(/^\[|\]$/g, '')
    .split('%')[0]
    .toLowerCase();
  const family = isIP(address);
  if (family === 4) return isPrivateV4(address);
  if (family !== 6) return false;
  return isPrivateV6(address);
}

export class BlockedTargetError extends Error {
  readonly code = 'EBLOCKED';

  constructor(host: string) {
    super(
      `${host} points to a private or local address, which this server does not allow`,
    );
    this.name = 'BlockedTargetError';
  }
}

export function assertHostAllowed(host: string, blockPrivate: boolean): void {
  if (!blockPrivate) return;
  const bare = host.replace(/^\[|\]$/g, '');
  if (isIP(bare) && isPrivateAddress(bare)) throw new BlockedTargetError(host);
  if (
    bare.toLowerCase() === 'localhost' ||
    bare.toLowerCase().endsWith('.localhost')
  ) {
    throw new BlockedTargetError(host);
  }
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address?: any,
  family?: number,
) => void;
export type LookupFunction = (
  hostname: string,
  options: any,
  callback: LookupCallback,
) => void;

export function createLookup(
  blockPrivate: boolean,
): LookupFunction | undefined {
  if (!blockPrivate) return undefined;
  return (hostname, options, callback) => {
    const wantAll = options?.all === true;
    dns.lookup(
      hostname,
      { ...(options ?? {}), all: true },
      (error, addresses) => {
        if (error) return callback(error);
        const list = (addresses as unknown as dns.LookupAddress[]) ?? [];
        if (list.some((entry) => isPrivateAddress(entry.address))) {
          return callback(new BlockedTargetError(hostname));
        }
        if (wantAll) return callback(null, list);
        const first = list[0];
        if (!first) {
          const missing: NodeJS.ErrnoException = new Error(
            `getaddrinfo ENOTFOUND ${hostname}`,
          );
          missing.code = 'ENOTFOUND';
          return callback(missing);
        }
        return callback(null, first.address, first.family);
      },
    );
  };
}
