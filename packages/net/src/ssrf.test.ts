import { describe, expect, it } from 'vitest';
import { blockedReason, isBlockedAddress } from './ip.js';
import { assertPublicUrl, UrlBlockedError, type HostResolver } from './ssrf.js';

describe('isBlockedAddress', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.1.2.3', 'loopback'],
    ['::1', 'loopback'],
    ['10.0.0.5', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    ['169.254.169.254', 'link-local (cloud metadata)'],
    ['169.254.0.1', 'link-local'],
    ['fe80::1', 'link-local v6'],
    ['fd00:ec2::254', 'unique-local v6 (AWS IPv6 metadata)'],
    ['fc00::1', 'unique-local v6'],
    ['100.100.100.200', 'carrier-grade NAT (Alibaba metadata)'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['0.0.0.0', 'unspecified'],
    ['::', 'unspecified v6'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'broadcast'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
    ['::ffff:169.254.169.254', 'IPv4-mapped metadata'],
    ['::ffff:10.0.0.1', 'IPv4-mapped private'],
    ['64:ff9b::7f00:1', 'NAT64 wrapping loopback'],
    ['2002:7f00:1::1', '6to4 wrapping loopback'],
  ])('blocks %s (%s)', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(['93.184.216.34', '8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])(
    'allows public address %s',
    (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    },
  );

  it('blocks garbage', () => {
    expect(blockedReason('not-an-ip')).toBe('not a valid IP address');
    expect(blockedReason('999.1.1.1')).toBe('not a valid IP address');
  });

  it('accepts bracketed IPv6 literals', () => {
    expect(isBlockedAddress('[::1]')).toBe(true);
    expect(isBlockedAddress('[2606:4700:4700::1111]')).toBe(false);
  });
});

function resolverFor(map: Record<string, string[]>): HostResolver {
  return async (hostname) => {
    const found = map[hostname];
    if (!found) throw new Error('ENOTFOUND');
    return found;
  };
}

describe('assertPublicUrl', () => {
  const resolver = resolverFor({
    'example.com': ['93.184.216.34'],
    'rebind.example': ['93.184.216.34', '127.0.0.1'],
    'internal.example': ['10.1.2.3'],
    'metadata.example': ['169.254.169.254'],
    'empty.example': [],
  });

  it('accepts a public https URL', async () => {
    const url = await assertPublicUrl('https://example.com/path?q=1', { resolver });
    expect(url.hostname).toBe('example.com');
  });

  it('rejects non-http schemes', async () => {
    for (const bad of ['ftp://example.com', 'file:///etc/passwd', 'gopher://example.com']) {
      await expect(assertPublicUrl(bad, { resolver })).rejects.toThrow(UrlBlockedError);
    }
  });

  it('rejects private, loopback and metadata IP literals', async () => {
    for (const bad of [
      'http://127.0.0.1/',
      'http://10.0.0.1:8080/',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/',
      'http://[::ffff:7f00:1]/',
    ]) {
      await expect(assertPublicUrl(bad, { resolver })).rejects.toThrow(UrlBlockedError);
    }
  });

  it('rejects alternative IPv4 spellings that resolve to loopback', async () => {
    for (const bad of ['http://2130706433/', 'http://0x7f.0.0.1/', 'http://0177.0.0.1/']) {
      await expect(assertPublicUrl(bad, { resolver })).rejects.toThrow(UrlBlockedError);
    }
  });

  it('rejects localhost by name', async () => {
    await expect(assertPublicUrl('http://localhost:3000/', { resolver })).rejects.toThrow(
      UrlBlockedError,
    );
    await expect(assertPublicUrl('http://app.localhost/', { resolver })).rejects.toThrow(
      UrlBlockedError,
    );
  });

  it('rejects hostnames that resolve to a private address', async () => {
    await expect(assertPublicUrl('https://internal.example/', { resolver })).rejects.toThrow(
      /non-public/,
    );
    await expect(assertPublicUrl('https://metadata.example/', { resolver })).rejects.toThrow(
      UrlBlockedError,
    );
  });

  it('rejects when any resolved address is private (DNS rebinding mix)', async () => {
    await expect(assertPublicUrl('https://rebind.example/', { resolver })).rejects.toThrow(
      UrlBlockedError,
    );
  });

  it('rejects unresolvable hosts and empty answers', async () => {
    await expect(assertPublicUrl('https://nope.example/', { resolver })).rejects.toThrow(
      /Could not resolve/,
    );
    await expect(assertPublicUrl('https://empty.example/', { resolver })).rejects.toThrow(
      /Could not resolve/,
    );
  });

  it('rejects embedded credentials and malformed URLs', async () => {
    await expect(assertPublicUrl('https://user:pw@example.com/', { resolver })).rejects.toThrow(
      UrlBlockedError,
    );
    await expect(assertPublicUrl('not a url', { resolver })).rejects.toThrow(UrlBlockedError);
  });

  it('allows local targets only when explicitly enabled, and still checks the scheme', async () => {
    const url = await assertPublicUrl('http://127.0.0.1:4010/', { allowLocal: true });
    expect(url.port).toBe('4010');
    await expect(assertPublicUrl('ftp://127.0.0.1/', { allowLocal: true })).rejects.toThrow(
      UrlBlockedError,
    );
  });
});
