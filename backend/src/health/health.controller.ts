import { Controller, Get, Logger, ServiceUnavailableException } from '@nestjs/common';
import { MODULES } from '@dpdp/shared';
import { TenantDatabaseService } from '../database/database.service';

/**
 * How long the database may take to answer before the check fails. Kept well
 * under a load balancer's health-check timeout (5 s by default on an AWS ALB),
 * so a hung connection reports 503 instead of the probe itself timing out.
 */
export const DB_CHECK_TIMEOUT_MS = 2000;

export interface HealthReport {
  status: 'ok';
  stage: number;
  modules: readonly string[];
  database: 'ok';
}

/**
 * GET /health — used by the image's Docker HEALTHCHECK, the desktop shell,
 * installer/scripts/health-check.ps1 and (on AWS) the ALB target group.
 *
 * 200 only when the database answers a trivial query; otherwise 503, so a load
 * balancer stops sending traffic to a task that cannot reach PostgreSQL. The
 * response never includes the error text (it can name the database host).
 */
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(private readonly db: TenantDatabaseService) {}

  @Get()
  async check(): Promise<HealthReport> {
    try {
      await withTimeout(this.db.ping(), DB_CHECK_TIMEOUT_MS);
    } catch (err) {
      this.logger.warn(`Health check failed: database unreachable (${describe(err)}).`);
      throw new ServiceUnavailableException({ status: 'error', stage: 1, database: 'unreachable' });
    }
    return { status: 'ok', stage: 1, modules: MODULES, database: 'ok' };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** The error code or class only — never the message. */
function describe(err: unknown): string {
  const e = err as { code?: unknown; name?: unknown };
  return String(e?.code ?? e?.name ?? 'unknown error');
}
