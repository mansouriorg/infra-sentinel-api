import { Injectable } from '@nestjs/common';
import { AppConfig } from '../config/app-config';

export interface HealthReport {
  status: 'ok';
  service: string;
  version: string;
  environment: string;
  uptimeSeconds: number;
  timestamp: string;
  memory: { rssMb: number; heapUsedMb: number };
}

@Injectable()
export class HealthService {
  constructor(private readonly config: AppConfig) {}

  check(): HealthReport {
    const toMb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;
    const memory = process.memoryUsage();

    return {
      status: 'ok',
      service: 'infra-sentinel-api',
      version: process.env.npm_package_version ?? '0.1.0',
      environment: this.config.get('NODE_ENV'),
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
      memory: { rssMb: toMb(memory.rss), heapUsedMb: toMb(memory.heapUsed) },
    };
  }
}
