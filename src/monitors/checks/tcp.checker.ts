import * as net from 'node:net';
import type { TcpConfig } from '../monitor.schema';
import type { CheckOutcome } from '../monitor.types';
import { describeNetworkError } from './assertions';
import { assertHostAllowed, createLookup } from './net-guard';
import { down, up, type RunContext } from './outcome';

export function checkTcp(
  config: TcpConfig,
  context: RunContext,
): Promise<CheckOutcome> {
  return new Promise<CheckOutcome>((resolve) => {
    try {
      assertHostAllowed(config.host, context.blockPrivate);
    } catch (error) {
      resolve(down(describeNetworkError(error, context.timeoutMs)));
      return;
    }

    const started = performance.now();
    const socket = net.connect({
      host: config.host.replace(/^\[|\]$/g, ''),
      port: config.port,
      lookup: createLookup(context.blockPrivate),
    });
    let finished = false;
    const finish = (result: CheckOutcome) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(
      () => finish(down(`Timed out after ${context.timeoutMs} ms`)),
      context.timeoutMs,
    );

    socket.once('connect', () =>
      finish(up(`Port ${config.port} is open`, performance.now() - started)),
    );
    socket.once('error', (error) =>
      finish(down(describeNetworkError(error, context.timeoutMs))),
    );
  });
}
