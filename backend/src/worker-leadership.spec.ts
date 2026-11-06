import {
  WORKER_LEADER_LOCK_KEY,
  acquireWorkerLeadership,
  type LeadershipClient,
} from './worker-leadership';

/**
 * Worker leadership: one active worker, others stand by, and losing the lock
 * stops the process. A fake client stands in for Postgres; the real-database
 * behaviour (two processes, one lock) is exercised separately against a local
 * PostgreSQL — see the deployment-readiness report.
 */

function fakeClient(results: boolean[]) {
  const listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  let i = 0;
  const client: LeadershipClient & { emit(e: string): void } = {
    connect: async () => undefined,
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql.includes('pg_try_advisory_lock'))
        return { rows: [{ acquired: results[Math.min(i++, results.length - 1)] }] };
      return { rows: [] };
    },
    on: (e, l) => {
      (listeners[e] ||= []).push(l);
      return client;
    },
    end: async () => undefined,
    emit: (e) => (listeners[e] || []).forEach((l) => l()),
  };
  return { client, queries };
}

const noSleep = async () => undefined;

describe('acquireWorkerLeadership', () => {
  it('becomes active at once when no other worker holds the lock', async () => {
    const { client, queries } = fakeClient([true]);
    const logs: string[] = [];
    const lead = await acquireWorkerLeadership({
      client,
      log: (m) => logs.push(m),
      sleep: noSleep,
    });
    expect(lead).not.toBeNull();
    expect(queries[0]).toEqual({
      sql: 'SELECT pg_try_advisory_lock($1::bigint) AS acquired',
      params: [WORKER_LEADER_LOCK_KEY],
    });
    expect(logs).toEqual(['Worker leadership acquired: this is the only active worker.']);
  });

  it('a second worker STANDS BY, announcing it once, and takes over only when the lock frees', async () => {
    const { client, queries } = fakeClient([false, false, false, true]);
    const logs: string[] = [];
    const lead = await acquireWorkerLeadership({
      client,
      log: (m) => logs.push(m),
      sleep: noSleep,
    });
    expect(lead).not.toBeNull();
    expect(queries.filter((q) => q.sql.includes('pg_try_advisory_lock'))).toHaveLength(4);
    expect(logs.filter((l) => l.includes('Standing by'))).toHaveLength(1);
  });

  it('a worker stopped while standing by never becomes active', async () => {
    const { client } = fakeClient([false]);
    let stop!: () => void;
    const stopSignal = new Promise<void>((r) => (stop = r));
    const pending = acquireWorkerLeadership({
      client,
      log: () => undefined,
      stopSignal,
      sleep: () => new Promise(() => undefined),
    });
    stop();
    await expect(pending).resolves.toBeNull();
  });

  it('LOSING the lock connection after becoming active stops the worker', async () => {
    const { client } = fakeClient([true]);
    const lost: string[] = [];
    await acquireWorkerLeadership({
      client,
      log: () => undefined,
      onLost: (r) => lost.push(r),
      sleep: noSleep,
    });
    client.emit('end');
    client.emit('error');
    expect(lost).toEqual(['lock connection closed', 'lock connection error']);
  });

  it('a graceful release is NOT treated as losing leadership', async () => {
    const { client, queries } = fakeClient([true]);
    const lost: string[] = [];
    const lead = await acquireWorkerLeadership({
      client,
      log: () => undefined,
      onLost: (r) => lost.push(r),
      sleep: noSleep,
    });
    await lead!.release();
    client.emit('end');
    expect(lost).toEqual([]);
    expect(queries.at(-1)).toEqual({
      sql: 'SELECT pg_advisory_unlock($1::bigint)',
      params: [WORKER_LEADER_LOCK_KEY],
    });
  });

  it('the lock key is a fixed 64-bit integer, passed as a parameter (never interpolated)', () => {
    expect(BigInt(WORKER_LEADER_LOCK_KEY) < 2n ** 63n).toBe(true);
  });
});
