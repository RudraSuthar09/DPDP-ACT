/**
 * Host-header validation — the DNS-rebinding defense for the local listener.
 *
 * A hostile web page can make its own hostname resolve to 127.0.0.1. Its
 * requests then reach this agent as SAME-ORIGIN requests, which carry no
 * Origin header (so the Origin allowlist in origin.ts never sees them). What
 * they cannot change is the Host header: it is still the attacker's
 * hostname. Accepting only loopback names, the configured bind host and an
 * explicit admin allowlist (GATEWAY_ALLOWED_HOSTS) closes that hole for
 * every route, not just /health.
 *
 * Pure — no I/O, no config loading.
 */
import { isLoopbackHost } from './config';

export interface HostDecision {
  allowed: boolean;
  /** The Host names a loopback address (localhost, 127.0.0.0/8, [::1]). */
  loopback: boolean;
}

/** Extracts the lowercase hostname from a Host header (brackets stripped
 *  for IPv6). Returns null for anything malformed. */
export function hostnameFromHostHeader(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null;
  const h = header.trim().toLowerCase();
  if (!h || /[\s/@\\?#]/.test(h)) return null;

  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    if (end < 0) return null;
    const rest = h.slice(end + 1);
    if (rest && !/^:\d{1,5}$/.test(rest)) return null;
    const inner = h.slice(1, end);
    return inner.includes(':') ? inner : null;
  }

  const parts = h.split(':');
  if (parts.length > 2) return null; // an unbracketed IPv6 literal is not a valid Host
  if (parts.length === 2 && !/^\d{1,5}$/.test(parts[1]!)) return null;
  return parts[0] || null;
}

export function evaluateHost(
  header: string | string[] | undefined,
  config: { bindHost: string; allowedHosts: readonly string[] },
): HostDecision {
  const hostname = hostnameFromHostHeader(header);
  if (!hostname) return { allowed: false, loopback: false };
  const loopback = isLoopbackHost(hostname);
  const bind = config.bindHost.trim().toLowerCase().replace(/^\[|\]$/g, '');
  const allowed = loopback || hostname === bind || config.allowedHosts.includes(hostname);
  return { allowed, loopback };
}
