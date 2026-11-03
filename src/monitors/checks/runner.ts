import { Injectable } from '@nestjs/common';
import { AppConfig } from '../../config/app-config';
import type { CheckOutcome, MonitorType } from '../monitor.types';
import { describeNetworkError } from './assertions';
import { checkDns } from './dns.checker';
import { checkHttp } from './http.checker';
import { applyDegraded, down, type RunContext } from './outcome';
import { checkPing } from './ping.checker';
import { checkSsl } from './ssl.checker';
import { checkTcp } from './tcp.checker';

@Injectable()
export class CheckRunner {
  constructor(private readonly config: AppConfig) {}

  async run(
    type: MonitorType,
    config: Record<string, any>,
    timeoutMs: number,
  ): Promise<CheckOutcome> {
    const context: RunContext = {
      timeoutMs,
      blockPrivate: this.config.get('BLOCK_PRIVATE_TARGETS'),
    };
    try {
      const result = await this.dispatch(type, config, context);
      return applyDegraded(result, config.degradedMs);
    } catch (error) {
      return down(describeNetworkError(error, timeoutMs));
    }
  }

  private dispatch(
    type: MonitorType,
    config: Record<string, any>,
    context: RunContext,
  ): Promise<CheckOutcome> {
    switch (type) {
      case 'http':
      case 'keyword':
        return checkHttp(config as Parameters<typeof checkHttp>[0], context);
      case 'tcp':
        return checkTcp(config as Parameters<typeof checkTcp>[0], context);
      case 'ping':
        return checkPing(config as Parameters<typeof checkPing>[0], context);
      case 'dns':
        return checkDns(config as Parameters<typeof checkDns>[0], context);
      case 'ssl':
        return checkSsl(config as Parameters<typeof checkSsl>[0], context);
      case 'heartbeat':
        return Promise.resolve(down('No heartbeat received in time'));
    }
  }
}
