import { execFile } from 'node:child_process';
import * as dns from 'node:dns';
import { isIP } from 'node:net';
import type { PingConfig } from '../monitor.schema';
import type { CheckOutcome } from '../monitor.types';
import { describeNetworkError } from './assertions';
import {
  assertHostAllowed,
  BlockedTargetError,
  isPrivateAddress,
} from './net-guard';
import { down, up, type RunContext } from './outcome';

export function pingArguments(
  platform: string,
  host: string,
  timeoutMs: number,
): string[] {
  if (platform === 'win32') return ['-n', '1', '-w', String(timeoutMs), host];
  if (platform === 'darwin' || platform.endsWith('bsd')) {
    return ['-n', '-c', '1', '-W', String(timeoutMs), host];
  }
  return [
    '-n',
    '-c',
    '1',
    '-W',
    String(Math.max(1, Math.ceil(timeoutMs / 1000))),
    host,
  ];
}

export function parsePingTime(output: string): number | null {
  const match = /time[=<]\s*([\d.]+)\s*ms/i.exec(output);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

export async function resolvePingTarget(
  host: string,
  blockPrivate: boolean,
  lookup: typeof dns.promises.lookup = dns.promises.lookup,
): Promise<string> {
  if (!blockPrivate) return host;
  assertHostAllowed(host, true);
  const bare = host.replace(/^\[|\]$/g, '');
  if (isIP(bare)) return bare;
  const found = await lookup(bare, { all: true });
  if (
    found.length === 0 ||
    found.some((entry) => isPrivateAddress(entry.address))
  ) {
    throw new BlockedTargetError(host);
  }
  return found[0].address;
}

export function checkPing(
  config: PingConfig,
  context: RunContext,
): Promise<CheckOutcome> {
  return resolvePingTarget(config.host, context.blockPrivate).then(
    (target) => runPing(target, context),
    (error: unknown) => down(describeNetworkError(error, context.timeoutMs)),
  );
}

function runPing(target: string, context: RunContext): Promise<CheckOutcome> {
  return new Promise<CheckOutcome>((resolve) => {
    const started = performance.now();
    execFile(
      'ping',
      pingArguments(process.platform, target, context.timeoutMs),
      { timeout: context.timeoutMs + 2000, windowsHide: true },
      (error, stdout) => {
        const output = String(stdout ?? '');
        if (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') {
            resolve(down('The ping command is not installed on this server'));
          } else if (
            /unknown host|cannot resolve|could not find host|name or service not known/i.test(
              output + error.message,
            )
          ) {
            resolve(down('Host name could not be resolved'));
          } else {
            resolve(down(`No reply within ${context.timeoutMs} ms`));
          }
          return;
        }
        const measured = parsePingTime(output) ?? performance.now() - started;
        resolve(up('Echo reply received', measured));
      },
    );
  });
}
