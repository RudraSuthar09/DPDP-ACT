// Pure validation, no Electron dependency (same convention as desktop's
// storage-path-safety.js) -- this is a FAST, FRIENDLY pre-check for the
// wizard's UI only. The real, authoritative enforcement happens server-side
// in agent/src/config-file.ts's writeConfigFile (called, via cli-pair.js,
// by the elevated helper this app invokes) -- that check runs regardless of
// what this file decides, so a gap here is a UX annoyance, never a security
// bypass. Kept here anyway so the wizard can reject an obviously-wrong URL
// immediately, before asking the user for a UAC elevation over something
// that was always going to fail.
'use strict';

// `new URL(...).hostname` keeps the brackets for an IPv6 literal (e.g.
// '[::1]'), so both forms are listed here rather than stripping brackets
// and risking a mismatch for some other bracketed-but-not-loopback value.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * `raw` -> { ok:true, url:string } | { ok:false, reason:string }.
 * Requires http(s), requires HTTPS for anything that isn't a loopback host
 * (a plain developer convenience -- "Do not allow arbitrary URLs to be used
 * as a mechanism to send credentials to untrusted servers" is enforced by
 * this being the ONLY field ever sent anywhere, and by requiring a real,
 * encrypted transport for every non-local target).
 */
function validateWorkspaceUrl(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed) return { ok: false, reason: 'Enter your DPDP workspace URL.' };

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'That does not look like a valid URL. Example: https://your-company.dpdp.example.com' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'The workspace URL must start with https:// (or http:// for a local test workspace).' };
  }

  const isLoopback = LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
  if (parsed.protocol === 'http:' && !isLoopback) {
    return { ok: false, reason: 'HTTPS is required for a production DPDP workspace. Only http:// to localhost is allowed for local testing.' };
  }

  // Normalize to the origin only -- a path/query/fragment on a workspace
  // URL is never meaningful and would otherwise silently travel into
  // config.json's controlPlaneUrl.
  return { ok: true, url: `${parsed.protocol}//${parsed.host}` };
}

module.exports = { validateWorkspaceUrl };
