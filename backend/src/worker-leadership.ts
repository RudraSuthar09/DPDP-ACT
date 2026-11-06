import { Client, type ClientConfig } from 'pg';

/**
 * Exactly one ACTIVE worker, whatever the deployment does.
 *
 * The deadline engine is safe with several workers (each deadline is claimed
 * in one transaction), but the Enterprise storage sweep is not coordinated
 * across processes. Deployment config is the first line (ECS desiredCount 1,
 * maximumPercent 100), but it cannot stop a rolling deploy, a manual "run
 * task", a second region, or a developer pointing a local worker at the shared
 * database. This is the line that holds regardless.
 *
 * HOW: a session-level PostgreSQL advisory lock on a fixed key, held on one
 * dedicated connection for the life of the process. A second worker cannot
 * take it, so it stands by — polling, doing nothing else — and becomes active
 * only when the first one's connection goes away (deploy, crash, scale-in).
 * Postgres releases a session lock the instant its connection closes, so a
 * dead worker never leaves a stuck lock behind.
 *
 * LOSING THE LOCK MEANS STOPPING. If the lock connection drops while active,
 * another worker may already have taken over; carrying on would be exactly
 * the duplicate this prevents. So the process exits, and the orchestrator
 * restarts it — it then stands by like any other second worker.
 *
 * Needs no privileges beyond CONNECT: advisory locks are not table rights, so
 * it uses the least-privileged runtime connection (dpdp_app).
 *
 * NOTE: requires a session-level connection. A transaction-mode pooler
 * (PgBouncer/Supavisor in transaction mode) cannot hold a session lock; RDS
 * direct connections and the session-mode pooler port are fine.
 */

/** A fixed, arbitrary 64-bit key for this one purpose. Never reuse it. */
export const WORKER_LEADER_LOCK_KEY = '7391054126608713412';

export interface LeadershipClient {
  connect(): Promise<unknown>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  on(event: 'error' | 'end', listener: (...args: unknown[]) => void): unknown;
  end(): Promise<unknown>;
}

export interface LeadershipOptions {
  client: LeadershipClient;
  log: (message: string) => void;
  /** Called when leadership is lost after being acquired. Default: exit(1). */
  onLost?: (reason: string) => void;
  retryMs?: number;
  /** Resolves when the process is asked to stop while still standing by. */
  stopSignal?: Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

export interface Leadership {
  /** Releases the lock and closes its connection (graceful shutdown). */
  release(): Promise<void>;
}

/**
 * Resolves once THIS process holds the worker lock; until then it polls.
 * Resolves `null` if `stopSignal` fires first (the process should then exit
 * without ever starting).
 */
export async function acquireWorkerLeadership(opts: LeadershipOptions): Promise<Leadership | null> {
  const retryMs = opts.retryMs ?? 15_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const onLost =
    opts.onLost ??
    ((reason: string) => {
      opts.log(
        `Worker leadership lost (${reason}); stopping so that only one worker is ever active.`,
      );
      process.exit(1);
    });

  let stopped = false;
  void opts.stopSignal?.then(() => {
    stopped = true;
  });

  await opts.client.connect();
  let announcedStandby = false;
  for (;;) {
    if (stopped) {
      await opts.client.end().catch(() => undefined);
      return null;
    }
    const { rows } = await opts.client.query(
      'SELECT pg_try_advisory_lock($1::bigint) AS acquired',
      [WORKER_LEADER_LOCK_KEY],
    );
    if (rows[0]?.acquired === true) break;
    if (!announcedStandby) {
      opts.log(
        'Another worker is already active. Standing by; this worker takes over only if that one stops.',
      );
      announcedStandby = true;
    }
    await Promise.race([sleep(retryMs), opts.stopSignal ?? new Promise<void>(() => undefined)]);
  }

  let releasing = false;
  opts.client.on('error', () => {
    if (!releasing) onLost('lock connection error');
  });
  opts.client.on('end', () => {
    if (!releasing) onLost('lock connection closed');
  });
  opts.log('Worker leadership acquired: this is the only active worker.');

  return {
    async release() {
      releasing = true;
      await opts.client
        .query('SELECT pg_advisory_unlock($1::bigint)', [WORKER_LEADER_LOCK_KEY])
        .catch(() => undefined);
      await opts.client.end().catch(() => undefined);
    },
  };
}

/** The production client: its own connection (never a pooled one, which
 *  could hand the lock's session to unrelated work), TCP keep-alive so a
 *  silently dead network path is noticed. */
export function leadershipClient(options: ClientConfig): Client {
  return new Client({ ...options, keepAlive: true, application_name: 'dpdp-worker-leader' });
}
