/**
 * Agent + protocol version, as constants (NOT read from the filesystem — the
 * Phase-3B agent reads no files at all, so its version cannot come from a file).
 *
 * - AGENT_VERSION    : this binary's version.
 * - PROTOCOL_VERSION : the Gateway wire-contract generation the agent speaks
 *                      (Phase 3A contract in shared/src/gateway.ts). The browser
 *                      can compare this to refuse a mismatched agent later.
 */
export const AGENT_VERSION = '0.1.0' as const;
export const PROTOCOL_VERSION = 'gateway-3a.1' as const;
