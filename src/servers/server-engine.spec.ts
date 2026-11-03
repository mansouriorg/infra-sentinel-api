import { incidentTrigger, toBaselines } from './server-engine.service';

describe('incidentTrigger', () => {
  it('marks availability problems as down', () => {
    expect(incidentTrigger('offline', 'threshold')).toBe('down');
    expect(incidentTrigger('container', 'threshold')).toBe('down');
    expect(incidentTrigger('service', 'threshold')).toBe('down');
    expect(incidentTrigger('process', 'threshold')).toBe('down');
  });

  it('marks resource pressure and anomalies as degraded', () => {
    expect(incidentTrigger('cpu', 'threshold')).toBe('degraded');
    expect(incidentTrigger('disk', 'threshold')).toBe('degraded');
    expect(incidentTrigger('cpu', 'anomaly')).toBe('degraded');
    expect(incidentTrigger('net_in', 'anomaly')).toBe('degraded');
  });
});

describe('toBaselines', () => {
  it('reads numbers that the driver returns as strings or nulls', () => {
    const baselines = toBaselines({
      samples: '300',
      recent_samples: 6,
      cpu_recent: '55.5',
      cpu_mean: 20,
      cpu_std: null,
      mem_recent: null,
      load_recent: 1,
      load_mean: 0.5,
      load_std: 0.1,
      net_in_recent: 10,
      net_in_mean: 5,
      net_in_std: 1,
      net_out_recent: 0,
      net_out_mean: 0,
      net_out_std: 0,
    });
    expect(baselines.cpu).toMatchObject({
      recent: 55.5,
      mean: 20,
      std: null,
      samples: 300,
      recentSamples: 6,
    });
    expect(baselines.memory).toMatchObject({ recent: null, mean: null });
    expect(baselines.load).toMatchObject({ recent: 1, mean: 0.5, std: 0.1 });
    expect(baselines.net_in?.samples).toBe(300);
  });
});
