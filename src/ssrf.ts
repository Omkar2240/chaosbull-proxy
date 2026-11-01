import dns from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Checks if an IPv4 address falls within private, loopback, link-local, or reserved ranges.
 */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return true; // Malformed IP is treated as unsafe
  }

  const [a, b] = parts;

  // 0.0.0.0/8 (Current network)
  if (a === 0) return true;

  // 10.0.0.0/8 (Private network)
  if (a === 10) return true;

  // 127.0.0.0/8 (Loopback)
  if (a === 127) return true;

  // 169.254.0.0/16 (Link-local, AWS/GCP/Azure metadata 169.254.169.254)
  if (a === 169 && b === 254) return true;

  // 172.16.0.0/12 (Private network: 172.16.0.0 - 172.31.255.255)
  if (a === 172 && b >= 16 && b <= 31) return true;

  // 192.168.0.0/16 (Private network)
  if (a === 192 && b === 168) return true;

  // 100.64.0.0/10 (Carrier-grade NAT)
  if (a === 100 && b >= 64 && b <= 127) return true;

  // 192.0.0.0/24, 192.0.2.0/24 (TEST-NET-1)
  if (a === 192 && b === 0) return true;

  // 198.51.100.0/24 (TEST-NET-2)
  if (a === 198 && b === 51) return true;

  // 203.0.113.0/24 (TEST-NET-3)
  if (a === 203 && b === 0 && parts[2] === 113) return true;

  // 224.0.0.0/4 (Multicast) & 240.0.0.0/4 (Reserved)
  if (a >= 224) return true;

  return false;
}

/**
 * Checks if an IPv6 address falls within loopback, link-local, unique-local, or IPv4-mapped private ranges.
 */
function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();

  // Loopback ::1
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;

  // Unspecified ::
  if (normalized === '::' || normalized === '0:0:0:0:0:0:0:0') return true;

  // Unique local fc00::/7 (fc00... or fd00...)
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;

  // Link-local fe80::/10
  if (normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) {
    return true;
  }

  // IPv4-mapped IPv6 (::ffff:127.0.0.1 or ::ffff:7f00:1)
  if (normalized.includes('::ffff:')) {
    const v4Part = normalized.split('::ffff:')[1];
    if (v4Part && (isIP(v4Part) === 4 || v4Part.includes('.'))) {
      return isPrivateIPv4(v4Part);
    }
  }

  return false;
}

export class SSRFSecurityError extends Error {
  constructor(message: string) {
    super(`[SSRF Security Violation] ${message}`);
    this.name = 'SSRFSecurityError';
  }
}

/**
 * Validates a target URL against SSRF threats:
 * - Ensures scheme is http or https
 * - Rejects localhost, metadata endpoints, and internal network domains
 * - Resolves DNS and verifies all resolved IP addresses are public
 */
export async function validateTargetUrl(targetUrl: string, allowLocal: boolean = false): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    throw new SSRFSecurityError(`Invalid URL format: "${targetUrl}"`);
  }

  // 1. Protocol check
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SSRFSecurityError(`Forbidden URL protocol "${parsed.protocol}". Only http: and https: are permitted.`);
  }

  const hostname = parsed.hostname.toLowerCase();

  // 2. Allow local if explicitly permitted (e.g. during offline integration tests)
  if (allowLocal) {
    return;
  }

  // 3. Known dangerous hostnames & metadata services
  const forbiddenHosts = [
    'localhost',
    'metadata.google.internal',
    'metadata.internal',
    '169.254.169.254',
    'instance-data',
    'local',
  ];

  if (forbiddenHosts.includes(hostname) || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new SSRFSecurityError(`Access to host "${hostname}" is prohibited.`);
  }

  // 4. If hostname is directly an IP address
  const ipType = isIP(hostname);
  if (ipType === 4) {
    if (isPrivateIPv4(hostname)) {
      throw new SSRFSecurityError(`Access to private/internal IPv4 address "${hostname}" is prohibited.`);
    }
    return;
  }
  if (ipType === 6) {
    if (isPrivateIPv6(hostname)) {
      throw new SSRFSecurityError(`Access to private/internal IPv6 address "${hostname}" is prohibited.`);
    }
    return;
  }

  // 5. DNS Resolution check
  try {
    const addresses = await dns.lookup(hostname, { all: true });
    if (!addresses || addresses.length === 0) {
      throw new SSRFSecurityError(`DNS resolution returned no records for host "${hostname}".`);
    }

    for (const record of addresses) {
      if (record.family === 4 && isPrivateIPv4(record.address)) {
        throw new SSRFSecurityError(`Host "${hostname}" resolved to restricted private IP "${record.address}".`);
      }
      if (record.family === 6 && isPrivateIPv6(record.address)) {
        throw new SSRFSecurityError(`Host "${hostname}" resolved to restricted private IPv6 "${record.address}".`);
      }
    }
  } catch (err: unknown) {
    if (err instanceof SSRFSecurityError) {
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new SSRFSecurityError(`DNS lookup failed for "${hostname}": ${msg}`);
  }
}

