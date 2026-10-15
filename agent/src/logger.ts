/**
 * Structured, leveled logging with secret redaction (Phase 1 of the
 * production build-out).
 *
 * Every existing call site in this package takes a plain `(line: string) =>
 * void` callback (enrollment.ts, poller.ts, server.ts, data-plane.ts) — that
 * signature is NOT changed here, so none of those files need to change
 * their own code to benefit from this. A `Logger` below exposes
 * `.info(line)` etc., each of which already satisfies `(line: string) =>
 * void` and can be passed directly wherever the old plain `log` function
 * used to go.
 *
 * Redaction is a safety net, not the only line of defense: every call site
 * that could embed something sensitive already sanitizes BEFORE logging
 * (e.g. database-connector.ts never lets a raw driver error reach a log
 * line — see its own `runOn`). `redactSecrets` exists for the NEW
 * surfaces this phase adds (retry/backoff messages, config-resolution
 * errors) where a URL or stack trace could otherwise carry a query string
 * secret or a device token pasted into an error by a future caller.
 */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface Logger {
  debug(line: string): void;
  info(line: string): void;
  warn(line: string): void;
  error(line: string): void;
  /** A derived logger whose every line is prefixed — e.g. `logger.child('heartbeat')`
   *  so a reader can filter by subsystem without re-threading a prefix string
   *  through every call site. */
  child(scope: string): Logger;
}

/** Known sensitive query-string/header-shaped key names a stray log line
 *  could otherwise leak through — device tokens, enrollment codes, DB
 *  passwords. Matches case-insensitively, `key=value` or a JSON-shaped
 *  `"key":"value"` (the optional `["']?` right after the key consumes the
 *  key's own closing quote before the colon), which is the only shape a URL
 *  or a JSON.stringify'd object turned into a string could produce. The
 *  value stops at a quote, whitespace, `&`, `,`, or `}` — whichever JSON/
 *  query-string delimiter ends it first. */
const SECRET_KEY_PATTERN = /(device[-_]?token|enrollment[-_]?code|password|x-gateway-[a-z-]*token)["']?\s*[:=]\s*["']?([^"'\s&,}]+)/gi;

export function redactSecrets(text: string): string {
  return text.replace(SECRET_KEY_PATTERN, (_match, key: string) => `${key}=[REDACTED]`);
}

function write(level: LogLevel, scope: string | null, line: string): void {
  const ts = new Date().toISOString();
  const scopePart = scope ? `[${scope}] ` : '';
  const safeLine = redactSecrets(line);
  const out = `${ts} ${level.toUpperCase().padEnd(5)} [agent] ${scopePart}${safeLine}`;
  // stderr for warn/error (so a service manager's error stream carries them),
  // stdout otherwise — standard Unix convention, matches what a systemd
  // journal / Windows Event Log forwarder expects to split on.
  if (level === 'warn' || level === 'error') {
    console.error(out);
  } else {
    console.log(out);
  }
}

/**
 * Creates a Logger that filters below `minLevel`. `error` and `warn` are
 * never suppressed in practice (minLevel is validated to one of the four
 * named levels, so the quietest legal setting is 'error' itself) — there is
 * no "silent" mode, matching "do not silently swallow errors".
 */
export function createLogger(minLevel: LogLevel = 'info', scope: string | null = null): Logger {
  const minRank = LEVEL_RANK[minLevel];
  const log = (level: LogLevel, line: string): void => {
    if (LEVEL_RANK[level] >= minRank) write(level, scope, line);
  };
  return {
    debug: (line) => log('debug', line),
    info: (line) => log('info', line),
    warn: (line) => log('warn', line),
    error: (line) => log('error', line),
    child: (childScope) => createLogger(minLevel, scope ? `${scope}:${childScope}` : childScope),
  };
}
