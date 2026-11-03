import { isIP } from 'node:net';
import * as tls from 'node:tls';
import type { SslConfig } from '../monitor.schema';
import type { CheckOutcome } from '../monitor.types';
import { describeNetworkError, evaluateCertificate } from './assertions';
import { assertHostAllowed, createLookup } from './net-guard';
import { down, outcome, type RunContext } from './outcome';

export function checkSsl(
  config: SslConfig,
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
    const host = config.host.replace(/^\[|\]$/g, '');
    const socket = tls.connect({
      host,
      port: config.port ?? 443,
      servername: isIP(host) ? undefined : host,
      rejectUnauthorized: false,
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

    socket.once('secureConnect', () => {
      const certificate = socket.getPeerCertificate();
      const validTo = certificate?.valid_to
        ? new Date(certificate.valid_to)
        : null;
      const verdict = evaluateCertificate(
        {
          validTo,
          authorized: socket.authorized,
          authorizationError: socket.authorizationError
            ? String(socket.authorizationError)
            : null,
        },
        {
          warnDays: config.warnDays ?? 14,
          allowUntrusted: config.allowUntrusted ?? false,
        },
      );
      finish(
        outcome(verdict.status, verdict.message, performance.now() - started, {
          sslExpiresAt:
            validTo && !Number.isNaN(validTo.getTime()) ? validTo : null,
        }),
      );
    });
    socket.once('error', (error) =>
      finish(down(describeNetworkError(error, context.timeoutMs))),
    );
  });
}
