/**
 * Phase 6: what the Gateway tells DPDP about its local listener, and what it
 * accepts back, over the EXISTING authenticated heartbeat -- so a paired
 * Gateway works with the dashboard without a hand-entered endpoint or a
 * hand-edited allowedOrigins list.
 *
 *   localListenerEndpoint: reported only when the listener is on the shared
 *     loopback host (the installed Gateway's default). The backend accepts
 *     exactly that form; network binds stay staff-configured.
 *   sanitizeDashboardOrigins: the dashboard origins from the heartbeat reply,
 *     kept only if each is an exact scheme://host[:port] (no '*', no path),
 *     at most MAX_DASHBOARD_ORIGINS of them. They are used as EXACT matches,
 *     exactly like config.allowedOrigins (origin.ts).
 */
import { GATEWAY_LOOPBACK_HOST } from '@dpdp/shared';
import { isExactOrigin, type AgentConfig } from './config';

export const MAX_DASHBOARD_ORIGINS = 10;

export function localListenerEndpoint(config: Pick<AgentConfig, 'bindHost' | 'bindPort'>): string | null {
  if (config.bindHost !== GATEWAY_LOOPBACK_HOST) return null;
  return `http://${GATEWAY_LOOPBACK_HOST}:${config.bindPort}`;
}

export function sanitizeDashboardOrigins(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const o of raw) {
    if (typeof o !== 'string' || o.includes('*') || !isExactOrigin(o) || out.includes(o)) continue;
    out.push(o);
    if (out.length >= MAX_DASHBOARD_ORIGINS) break;
  }
  return out;
}
