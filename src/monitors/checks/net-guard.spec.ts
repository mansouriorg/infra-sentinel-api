import { assertHostAllowed, isPrivateAddress } from './net-guard';

describe('isPrivateAddress', () => {
  it('flags private, loopback and link-local IPv4 ranges', () => {
    for (const address of [
      '10.1.2.3',
      '127.0.0.1',
      '169.254.169.254',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.10',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
    ]) {
      expect(isPrivateAddress(address)).toBe(true);
    }
  });

  it('lets public IPv4 addresses through', () => {
    for (const address of [
      '8.8.8.8',
      '1.1.1.1',
      '172.15.0.1',
      '172.32.0.1',
      '93.184.216.34',
    ]) {
      expect(isPrivateAddress(address)).toBe(false);
    }
  });

  it('handles IPv6, including mapped IPv4', () => {
    expect(isPrivateAddress('::1')).toBe(true);
    expect(isPrivateAddress('fd00::1')).toBe(true);
    expect(isPrivateAddress('fe80::1')).toBe(true);
    expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateAddress('::ffff:7f00:1')).toBe(true);
    expect(isPrivateAddress('2606:4700:4700::1111')).toBe(false);
    expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false);
  });

  it('sees through every spelling of an IPv6 address', () => {
    for (const address of [
      '0:0:0:0:0:0:0:1',
      '0000:0000:0000:0000:0000:0000:0000:0001',
      '0:0:0:0:0:ffff:a9fe:a9fe',
      '0:0:0:0:0:ffff:169.254.169.254',
      '::ffff:169.254.169.254',
      '::ffff:a9fe:a9fe',
      '0:0:0:0:0:0:0:0',
      '::127.0.0.1',
      '::a9fe:a9fe',
      '64:ff9b::a9fe:a9fe',
      '64:ff9b::169.254.169.254',
      '64:ff9b:1::1',
      '2002:a9fe:a9fe::1',
      '2002:7f00:1::',
      'fec0::1',
      'FD00:0:0:0:0:0:0:1',
      '[::1]',
      'fe80::1%eth0',
      'ff02::1',
    ]) {
      expect(isPrivateAddress(address)).toBe(true);
    }
  });

  it('keeps public IPv6 addresses reachable', () => {
    for (const address of [
      '2606:4700:4700::1111',
      '2001:4860:4860::8888',
      '64:ff9b::808:808',
      '2002:808:808::1',
      '::ffff:8.8.8.8',
      '0:0:0:0:0:ffff:808:808',
    ]) {
      expect(isPrivateAddress(address)).toBe(false);
    }
  });

  it('flags the Azure wire server', () => {
    expect(isPrivateAddress('168.63.129.16')).toBe(true);
    expect(isPrivateAddress('168.63.129.17')).toBe(false);
  });

  it('ignores things that are not IP addresses', () => {
    expect(isPrivateAddress('example.com')).toBe(false);
  });
});

describe('assertHostAllowed', () => {
  it('allows everything when blocking is off', () => {
    expect(() => assertHostAllowed('127.0.0.1', false)).not.toThrow();
    expect(() => assertHostAllowed('localhost', false)).not.toThrow();
  });

  it('rejects local targets when blocking is on', () => {
    expect(() => assertHostAllowed('127.0.0.1', true)).toThrow(
      /private or local/,
    );
    expect(() => assertHostAllowed('[::1]', true)).toThrow(/private or local/);
    expect(() => assertHostAllowed('0:0:0:0:0:ffff:a9fe:a9fe', true)).toThrow(
      /private or local/,
    );
    expect(() => assertHostAllowed('[0:0:0:0:0:0:0:1]', true)).toThrow(
      /private or local/,
    );
    expect(() => assertHostAllowed('localhost', true)).toThrow(
      /private or local/,
    );
    expect(() => assertHostAllowed('api.localhost', true)).toThrow(
      /private or local/,
    );
    expect(() => assertHostAllowed('example.com', true)).not.toThrow();
    expect(() => assertHostAllowed('8.8.8.8', true)).not.toThrow();
  });
});
