import { Global, Inject, Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TenantDatabaseService } from '../../database/database.service';
import { UnitOfWorkService } from '../../database/unit-of-work';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { AuditModule } from './audit.module';
import { AuditContextService } from './audit-context.service';
import { AUDIT_SINK } from './postgres-audit.sink';
import { SystemAuditService } from './system-audit.service';

/**
 * The claim in AuditModule's header is that a feature module CANNOT inject the
 * audit sink — not "should not", but cannot. That claim is worth exactly as much
 * as the test that tries it.
 */

/**
 * Stand-ins for the two @Global providers AuditModule's internals depend on.
 *
 * These exist so the injection failures below are the ones we are actually
 * testing. Without them AuditModule cannot instantiate at all, every
 * `.compile()` rejects with an unresolved dependency, and the "refuses to boot"
 * test passes for entirely the wrong reason — a green that proves nothing.
 */
@Global()
@Module({
  providers: [
    { provide: TenantDatabaseService, useValue: {} },
    { provide: TenantContextService, useValue: new TenantContextService() },
    UnitOfWorkService,
  ],
  exports: [TenantDatabaseService, TenantContextService, UnitOfWorkService],
})
class FakeGlobals {}

@Injectable()
class ServiceThatTriesToWriteAudit {
  constructor(@Inject(AUDIT_SINK) readonly sink: unknown) {}
}

@Module({ imports: [AuditModule], providers: [ServiceThatTriesToWriteAudit] })
class ModuleThatTriesToWriteAudit {}

@Injectable()
class WellBehavedService {
  constructor(readonly audit: AuditContextService) {}
}

@Module({ imports: [AuditModule], providers: [WellBehavedService] })
class WellBehavedModule {}

@Injectable()
class WorkerLikeService {
  constructor(readonly systemAudit: SystemAuditService) {}
}

@Module({ imports: [AuditModule], providers: [WorkerLikeService] })
class WorkerLikeModule {}

describe('AuditModule — the export list is a security control (R3)', () => {
  it('REFUSES to boot a module that tries to inject the audit sink', async () => {
    // The enforcement: AUDIT_SINK is provided inside AuditModule but not
    // exported, so Nest cannot resolve it for anyone else. A service that tries
    // to write its own audit entries does not get a code review comment — it
    // gets a dead application, at startup, in CI.
    expect.assertions(2);
    try {
      await Test.createTestingModule({
        imports: [FakeGlobals, ModuleThatTriesToWriteAudit],
      }).compile();
    } catch (err) {
      const message = String((err as Error).message);
      // Specifically AUDIT_SINK — not merely "some dependency failed", which is
      // what a missing FakeGlobals would produce.
      expect(message).toContain('AUDIT_SINK');
      expect(message).toMatch(/can't resolve dependencies|Nest can not find/i);
    }
  });

  it('allows a module to inject AuditContextService, which can only annotate', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [FakeGlobals, WellBehavedModule],
    }).compile();
    const service = moduleRef.get(WellBehavedService);
    expect(service.audit).toBeInstanceOf(AuditContextService);

    // And what it got has no way to reach a database: annotate() merges facts
    // into AsyncLocalStorage and returns void. There is no write to escalate to.
    expect(Object.getOwnPropertyNames(AuditContextService.prototype).sort()).toEqual([
      'annotate',
      'constructor',
      'current',
      'run',
    ]);
  });

  it('allows a module to inject SystemAuditService — the one sanctioned second caller', async () => {
    // The addition this test exists to pin: a worker-side module CAN now reach
    // a typed audit-write path, and the sink itself STILL cannot be reached
    // directly — the two facts have to hold at the same time or the "second
    // sanctioned caller, not a second writer" claim is just a comment.
    const moduleRef = await Test.createTestingModule({
      imports: [FakeGlobals, WorkerLikeModule],
    }).compile();
    const service = moduleRef.get(WorkerLikeService);
    expect(service.systemAudit).toBeInstanceOf(SystemAuditService);

    // What it exposes is exactly one method, taking a client and a tenant the
    // caller must already hold — no bare `sink`, no way to omit either.
    expect(Object.getOwnPropertyNames(SystemAuditService.prototype).sort()).toEqual([
      'constructor',
      'record',
    ]);
  });

  it('SystemAuditService refuses to append when the given client is bound to a different tenant', async () => {
    // The defence-in-depth check inside PostgresAuditSink.recordOnClient,
    // exercised directly against a fake PoolClient rather than a real
    // connection — cheap, and it is exactly the property that matters: a
    // caller that got its tenantId wrong must fail LOUDLY, before any SQL that
    // could write to the wrong chain, not silently rebind and proceed.
    const moduleRef = await Test.createTestingModule({
      imports: [FakeGlobals, WorkerLikeModule],
    }).compile();
    const service = moduleRef.get(WorkerLikeService);

    const query = jest.fn().mockResolvedValue({ rows: [{ tenant: 'tenant-a' }] });
    const fakeClient = { query } as unknown as Parameters<SystemAuditService['record']>[0];

    await expect(
      service.systemAudit.record(fakeClient, 'tenant-b', {
        action: 'test.action',
        outcome: 'success',
        correlationId: '00000000-0000-4000-8000-000000000000',
      }),
    ).rejects.toThrow(/bound to tenant tenant-a.*not tenant-b/s);

    // The bound-tenant check ran, and NOTHING else did: exactly one query (the
    // `app.current_tenant()` probe), never a second call that could only be
    // the append itself.
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('annotating outside a request is a no-op, not a crash', () => {
    // A service must not have to know whether it was called from HTTP or a job.
    const audit = new AuditContextService();
    expect(() => audit.annotate({ reason: 'no request in scope' })).not.toThrow();
    expect(audit.current()).toBeUndefined();
  });

  it('annotations from different layers merge into one entry', async () => {
    const audit = new AuditContextService();
    const merged = await audit.run(async (annotation) => {
      audit.annotate({ targetType: 'user', targetId: 'u1' }); // e.g. a controller
      audit.annotate({ reason: 'left the company' }); // e.g. a service
      audit.annotate({ beforeState: { status: 'active' } }); // e.g. deeper still
      return annotation;
    });
    expect(merged).toEqual({
      targetType: 'user',
      targetId: 'u1',
      reason: 'left the company',
      beforeState: { status: 'active' },
    });
  });
});
