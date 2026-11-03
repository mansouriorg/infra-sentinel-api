import { AppConfig } from '../config/app-config';
import { validateEnv } from '../config/env';
import { HealthService } from './health.service';

describe('HealthService', () => {
  it('reports an ok status with runtime details', () => {
    const config = new AppConfig(validateEnv({ NODE_ENV: 'test' }));

    const report = new HealthService(config).check();

    expect(report.status).toBe('ok');
    expect(report.service).toBe('infra-sentinel-api');
    expect(report.environment).toBe('test');
    expect(report.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(new Date(report.timestamp).toString()).not.toBe('Invalid Date');
  });
});
