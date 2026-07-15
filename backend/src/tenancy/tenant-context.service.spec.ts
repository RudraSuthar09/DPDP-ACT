import type { TenantContext } from '@dpdp/shared';
import { TenantContextService } from './tenant-context.service';

describe('TenantContextService', () => {
  const service = new TenantContextService();
  const ctx: TenantContext = {
    tenantId: '11111111-1111-1111-1111-111111111111',
    userId: 'user-1',
    role: 'owner',
    correlationId: 'corr-1',
  };

  it('getOrThrow() throws when there is no context (fail closed)', () => {
    expect(() => service.getOrThrow()).toThrow(/tenant context/i);
  });

  it('get() is undefined outside a run() scope', () => {
    expect(service.get()).toBeUndefined();
  });

  it('exposes the context inside run(), and clears it afterwards', () => {
    service.run(ctx, () => {
      expect(service.get()).toEqual(ctx);
      expect(service.getOrThrow()).toEqual(ctx);
    });
    // Outside the run scope again → back to fail-closed.
    expect(service.get()).toBeUndefined();
  });
});
