import { HttpStatus, ServiceUnavailableException } from '@nestjs/common';
import { DB_CHECK_TIMEOUT_MS, HealthController } from './health.controller';
import type { TenantDatabaseService } from '../database/database.service';

/** GET /health reports 200 only when the database answers. */
function controller(ping: () => Promise<void>): HealthController {
  return new HealthController({ ping } as unknown as TenantDatabaseService);
}

describe('HealthController', () => {
  afterEach(() => jest.useRealTimers());

  it('returns ok when the database answers', async () => {
    await expect(controller(async () => undefined).check()).resolves.toMatchObject({
      status: 'ok',
      database: 'ok',
    });
  });

  it('returns 503 when the database query fails, without leaking the error text', async () => {
    const err = Object.assign(new Error('connect ECONNREFUSED db.internal.example:5432'), {
      code: 'ECONNREFUSED',
    });
    const thrown = await controller(async () => Promise.reject(err))
      .check()
      .catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(ServiceUnavailableException);
    const ex = thrown as ServiceUnavailableException;
    expect(ex.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(ex.getResponse()).toEqual({ status: 'error', stage: 1, database: 'unreachable' });
    expect(JSON.stringify(ex.getResponse())).not.toContain('db.internal.example');
  });

  it('returns 503 when the database does not answer in time', async () => {
    jest.useFakeTimers();
    const pending = controller(() => new Promise<void>(() => undefined)).check();
    const assertion = expect(pending).rejects.toBeInstanceOf(ServiceUnavailableException);
    jest.advanceTimersByTime(DB_CHECK_TIMEOUT_MS);
    await assertion;
  });
});
