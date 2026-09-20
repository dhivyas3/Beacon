import ipaddr from 'ipaddr.js';

/**
 * Returns why an address must not be fetched, or null when it is a normal public unicast address.
 *
 * Only `unicast` is allowed. Everything else is refused: loopback, private (RFC 1918), link-local
 * (which includes the 169.254.169.254 cloud metadata address), carrier-grade NAT (which includes
 * Alibaba's 100.100.100.200 metadata address), unique-local IPv6 (fd00:ec2::254), multicast,
 * unspecified, reserved, and the IPv6 transition ranges that can embed an IPv4 address.
 * IPv4-mapped IPv6 addresses are unwrapped first so `::ffff:127.0.0.1` cannot slip through.
 */
export function blockedReason(address: string): string | null {
  const literal = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
  if (!ipaddr.isValid(literal)) return 'not a valid IP address';

  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.process(literal);
  } catch {
    return 'not a valid IP address';
  }
  const range = parsed.range();
  return range === 'unicast' ? null : `${range} address`;
}

export function isBlockedAddress(address: string): boolean {
  return blockedReason(address) !== null;
}
