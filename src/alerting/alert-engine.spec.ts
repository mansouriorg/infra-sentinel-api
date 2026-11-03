import { severityFor, titleFor } from './alert-engine.service';

describe('severityFor', () => {
  it('falls back to critical for down and warning for degraded', () => {
    expect(severityFor('down', [])).toBe('critical');
    expect(severityFor('degraded', [])).toBe('warning');
  });

  it('uses the most severe matching rule', () => {
    expect(
      severityFor('down', [{ severity: 'info' }, { severity: 'warning' }]),
    ).toBe('warning');
    expect(
      severityFor('down', [
        { severity: 'warning' },
        { severity: 'critical' },
        { severity: 'info' },
      ]),
    ).toBe('critical');
    expect(severityFor('degraded', [{ severity: 'info' }])).toBe('info');
  });
});

describe('titleFor', () => {
  it('names the monitor and its state', () => {
    expect(titleFor('Shop', 'down')).toBe('Shop is down');
    expect(titleFor('Shop', 'degraded')).toBe('Shop is degraded');
  });
});
