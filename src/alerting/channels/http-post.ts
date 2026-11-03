import * as http from 'node:http';
import * as https from 'node:https';
import { describeNetworkError } from '../../monitors/checks/assertions';
import {
  assertHostAllowed,
  createLookup,
} from '../../monitors/checks/net-guard';

export interface PostOptions {
  method?: 'POST' | 'PUT' | 'GET';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
  blockPrivate: boolean;
}

export interface PostResult {
  status: number;
  body: string;
}

const MAX_RESPONSE_BYTES = 64 * 1024;

export function postRequest(
  url: string,
  options: PostOptions,
): Promise<PostResult> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const method = options.method ?? 'POST';
  const body = options.body ?? '';
  const maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES;
  return new Promise<PostResult>((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(url);
      assertHostAllowed(target.hostname, options.blockPrivate);
    } catch (error) {
      reject(new Error(describeNetworkError(error, timeoutMs)));
      return;
    }

    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      action();
    };

    const client = target.protocol === 'https:' ? https : http;
    const request = client.request(
      target,
      {
        method,
        headers: {
          ...(method === 'GET'
            ? {}
            : {
                'content-type': 'application/json',
                'content-length': String(Buffer.byteLength(body)),
              }),
          'user-agent': 'InfraSentinel/1.0',
          ...options.headers,
        },
        agent: false,
        lookup: createLookup(options.blockPrivate),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const complete = () =>
          finish(() =>
            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size <= maxBytes) {
            chunks.push(chunk);
          } else {
            response.destroy();
            complete();
          }
        });
        response.on('end', complete);
        response.on('close', complete);
        response.on('error', (error) =>
          finish(() =>
            reject(new Error(describeNetworkError(error, timeoutMs))),
          ),
        );
      },
    );

    timer = setTimeout(() => {
      const timeout = Object.assign(new Error('Request timed out'), {
        code: 'ETIMEDOUT',
      });
      request.destroy(timeout);
      finish(() => reject(new Error(describeNetworkError(timeout, timeoutMs))));
    }, timeoutMs);
    timer.unref();

    request.on('error', (error) =>
      finish(() => reject(new Error(describeNetworkError(error, timeoutMs)))),
    );
    if (method !== 'GET') request.write(body);
    request.end();
  });
}

export function snippet(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}
