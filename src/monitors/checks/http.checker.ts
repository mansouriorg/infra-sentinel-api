import * as http from 'node:http';
import * as https from 'node:https';
import type { TLSSocket } from 'node:tls';
import type { HttpConfig } from '../monitor.schema';
import type { CheckOutcome } from '../monitor.types';
import {
  describeNetworkError,
  parseStatusExpectation,
  readJsonPath,
} from './assertions';
import {
  assertHostAllowed,
  createLookup,
  type LookupFunction,
} from './net-guard';
import { down, up, type RunContext } from './outcome';

const MAX_BODY_BYTES = 1_048_576;
const MAX_REDIRECTS = 5;
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

interface Hop {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  certificateExpiry: Date | null;
}

function lowerCaseKeys(input: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(input))
    result[key.toLowerCase()] = value;
  return result;
}

function requestOnce(
  url: URL,
  config: HttpConfig,
  method: string,
  body: string | undefined,
  remainingMs: number,
  collectBody: boolean,
  lookup: LookupFunction | undefined,
  forwardHeaders: boolean,
): Promise<Hop> {
  return new Promise<Hop>((resolve, reject) => {
    const secure = url.protocol === 'https:';
    const transport = secure ? https : http;
    const headers: Record<string, string | number> = {
      'user-agent': 'InfraSentinel/1.0',
      accept: '*/*',
      ...(forwardHeaders ? lowerCaseKeys(config.headers ?? {}) : {}),
    };
    if (body !== undefined) {
      headers['content-type'] ??= 'text/plain; charset=utf-8';
      headers['content-length'] = Buffer.byteLength(body);
    }

    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      action();
    };

    const request = transport.request(
      url,
      {
        method,
        headers,
        agent: false,
        lookup,
        ...(secure ? { rejectUnauthorized: !config.ignoreTls } : {}),
      },
      (response) => {
        let certificateExpiry: Date | null = null;
        if (secure) {
          try {
            const certificate = (
              response.socket as TLSSocket
            ).getPeerCertificate();
            if (certificate?.valid_to)
              certificateExpiry = new Date(certificate.valid_to);
          } catch {
            certificateExpiry = null;
          }
        }

        const chunks: Buffer[] = [];
        let size = 0;
        const complete = () =>
          finish(() =>
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: Buffer.concat(chunks).toString('utf8'),
              certificateExpiry,
            }),
          );

        response.on('data', (chunk: Buffer) => {
          if (!collectBody) return;
          size += chunk.length;
          if (size <= MAX_BODY_BYTES) {
            chunks.push(chunk);
          } else {
            response.destroy();
            complete();
          }
        });
        response.on('end', complete);
        response.on('close', complete);
        response.on('error', (error) => finish(() => reject(error)));
      },
    );

    timer = setTimeout(
      () => {
        const timeout = Object.assign(new Error('Request timed out'), {
          code: 'ETIMEDOUT',
        });
        request.destroy(timeout);
        finish(() => reject(timeout));
      },
      Math.max(1, remainingMs),
    );

    request.on('error', (error) => finish(() => reject(error)));
    if (body !== undefined) request.write(body);
    request.end();
  });
}

function evaluateBody(
  config: HttpConfig,
  status: number,
  body: string,
): { ok: boolean; message: string } {
  const notes: string[] = [];

  if (config.keyword) {
    const haystack = config.caseSensitive ? body : body.toLowerCase();
    const needle = config.caseSensitive
      ? config.keyword
      : config.keyword.toLowerCase();
    const found = haystack.includes(needle);
    const wantPresent = (config.keywordMode ?? 'present') === 'present';
    if (found !== wantPresent) {
      return {
        ok: false,
        message: wantPresent
          ? `HTTP ${status}, keyword "${config.keyword}" not found`
          : `HTTP ${status}, keyword "${config.keyword}" is present but should not be`,
      };
    }
    notes.push(wantPresent ? 'keyword found' : 'keyword absent');
  }

  if (config.jsonPath) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return {
        ok: false,
        message: `HTTP ${status}, the response is not valid JSON`,
      };
    }
    const value = readJsonPath(parsed, config.jsonPath);
    if (value === undefined || value === null) {
      return {
        ok: false,
        message: `HTTP ${status}, "${config.jsonPath}" was not found in the response`,
      };
    }
    if (
      config.jsonEquals !== undefined &&
      config.jsonEquals !== '' &&
      String(value) !== config.jsonEquals
    ) {
      return {
        ok: false,
        message: `HTTP ${status}, "${config.jsonPath}" is "${String(value).slice(0, 80)}", expected "${config.jsonEquals}"`,
      };
    }
    notes.push(`${config.jsonPath} matches`);
  }

  return { ok: true, message: [`HTTP ${status}`, ...notes].join(', ') };
}

export async function checkHttp(
  config: HttpConfig,
  context: RunContext,
): Promise<CheckOutcome> {
  const started = performance.now();
  const elapsed = () => performance.now() - started;
  const lookup = createLookup(context.blockPrivate);
  const collectBody = Boolean(config.keyword || config.jsonPath);
  const matchesExpected = parseStatusExpectation(config.expectedStatus);

  let url = new URL(config.url);
  const origin = url.origin;
  let method: string = config.method;
  let body: string | undefined =
    config.method === 'POST' ? config.body : undefined;
  let certificateExpiry: Date | null = null;

  try {
    for (let hop = 0; ; hop += 1) {
      assertHostAllowed(url.hostname, context.blockPrivate);
      const remaining = context.timeoutMs - elapsed();
      if (remaining <= 0)
        throw Object.assign(new Error('Request timed out'), {
          code: 'ETIMEDOUT',
        });

      const response = await requestOnce(
        url,
        config,
        method,
        body,
        remaining,
        collectBody,
        lookup,
        url.origin === origin,
      );
      if (response.certificateExpiry)
        certificateExpiry = response.certificateExpiry;

      const location = response.headers.location;
      if (
        config.followRedirects &&
        REDIRECT_CODES.has(response.status) &&
        location
      ) {
        if (hop >= MAX_REDIRECTS) {
          return down(
            `Too many redirects (more than ${MAX_REDIRECTS})`,
            elapsed(),
            {
              statusCode: response.status,
              sslExpiresAt: certificateExpiry,
            },
          );
        }
        url = new URL(location, url);
        if (
          response.status === 303 ||
          ((response.status === 301 || response.status === 302) &&
            method === 'POST')
        ) {
          method = 'GET';
          body = undefined;
        }
        continue;
      }

      const ms = elapsed();
      const extra = {
        statusCode: response.status,
        sslExpiresAt: certificateExpiry,
      };
      if (!matchesExpected(response.status)) {
        return down(
          `HTTP ${response.status}, expected ${config.expectedStatus}`,
          ms,
          extra,
        );
      }
      const verdict = evaluateBody(config, response.status, response.body);
      return verdict.ok
        ? up(verdict.message, ms, extra)
        : down(verdict.message, ms, extra);
    }
  } catch (error) {
    return down(describeNetworkError(error, context.timeoutMs), null, {
      sslExpiresAt: certificateExpiry,
    });
  }
}
