import { Resolver } from 'node:dns/promises';
import type { DnsConfig } from '../monitor.schema';
import type { CheckOutcome } from '../monitor.types';
import { describeNetworkError } from './assertions';
import { assertHostAllowed } from './net-guard';
import { down, up, type RunContext } from './outcome';

export interface DnsClient {
  resolve(
    host: string,
    type: DnsConfig['recordType'],
    server: string | undefined,
    timeoutMs: number,
  ): Promise<string[]>;
}

export const systemDns: DnsClient = {
  async resolve(host, type, server, timeoutMs) {
    const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
    if (server) resolver.setServers([server]);
    switch (type) {
      case 'A':
        return resolver.resolve4(host);
      case 'AAAA':
        return resolver.resolve6(host);
      case 'CNAME':
        return resolver.resolveCname(host);
      case 'NS':
        return resolver.resolveNs(host);
      case 'MX':
        return (await resolver.resolveMx(host)).map(
          (record) => `${record.priority} ${record.exchange}`,
        );
      case 'TXT':
        return (await resolver.resolveTxt(host)).map((chunks) =>
          chunks.join(''),
        );
    }
  },
};

function describeDnsError(
  error: unknown,
  type: string,
  timeoutMs: number,
): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  switch (code) {
    case 'ENODATA':
    case 'ENOTFOUND':
      return `No ${type} records found`;
    case 'ETIMEOUT':
    case 'ETIMEDOUT':
      return `The DNS server did not answer within ${timeoutMs} ms`;
    case 'ECONNREFUSED':
      return 'The DNS server refused the query';
    case 'ESERVFAIL':
      return 'The DNS server failed to answer (SERVFAIL)';
  }
  return error instanceof Error ? error.message : String(error);
}

export async function checkDns(
  config: DnsConfig,
  context: RunContext,
  client: DnsClient = systemDns,
): Promise<CheckOutcome> {
  const started = performance.now();
  const type = config.recordType ?? 'A';
  if (config.resolver) {
    try {
      assertHostAllowed(config.resolver, context.blockPrivate);
    } catch (error) {
      return down(describeNetworkError(error, context.timeoutMs));
    }
  }
  try {
    const answers = await client.resolve(
      config.host,
      type,
      config.resolver,
      context.timeoutMs,
    );
    const ms = performance.now() - started;
    if (answers.length === 0) return down(`No ${type} records found`, ms);

    if (config.expected) {
      const wanted = config.expected.toLowerCase();
      if (!answers.some((answer) => answer.toLowerCase().includes(wanted))) {
        return down(
          `${type} answer does not contain "${config.expected}" (got ${answers.slice(0, 3).join(', ')})`,
          ms,
        );
      }
    }
    const shown = answers.slice(0, 3).join(', ');
    return up(
      `${type} ${shown}${answers.length > 3 ? ` and ${answers.length - 3} more` : ''}`,
      ms,
    );
  } catch (error) {
    return down(describeDnsError(error, type, context.timeoutMs));
  }
}
