import { createHash, randomBytes } from 'node:crypto';
import { ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { GATEWAY_PAIRING_NONCE_TTL_SECONDS, GATEWAY_SESSION_TTL_SECONDS } from '@dpdp/shared';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { AuditContextService } from '../audit/audit-context.service';
import { GatewayService } from '../gateway/gateway.service';
import { StorageRepository } from './storage.repository';
import { StorageGatewayRepository } from './storage-gateway.repository';
import { evaluateStoragePairingRedemption, evaluateStorageSession, type PolicyResult } from './storage-gateway-policy';

/**
 * The storage data-plane's CONTROL-PLANE half: staff mint a pairing nonce for
 * an Enterprise storage root, the Gateway device redeems it for a session. A
 * SEPARATE mechanism from the Gateway control plane's source pairing/session
 * (see the migration header) that reuses the SAME device/enrollment
 * infrastructure through GatewayService (R2 — never this module's own SQL
 * against gateway_devices).
 *
 * It never reads or writes a filesystem path, a folder name, or any customer
 * value — it moves ids, hashes and metadata only, exactly like the Gateway
 * control plane it mirrors.
 */
@Injectable()
export class StorageGatewayService {
  constructor(
    private readonly repo: StorageGatewayRepository,
    private readonly roots: StorageRepository,
    private readonly gateway: GatewayService,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditContextService,
  ) {}

  /**
   * Staff-issued pairing nonce for a Gateway-provider storage root. The
   * device is NOT a caller-supplied parameter — it is derived from the root's
   * own `gatewayDeviceId` binding (set explicitly at root-creation time, see
   * storage.service.ts), so there is no way to request a pairing for a device
   * other than the one the root was actually bound to.
   */
  async createPairing(storageRootId: string): Promise<{ nonce: string; expiresAt: string }> {
    const ctx = this.tenantContext.getOrThrow();
    const root = await this.roots.findRoot(storageRootId);
    if (!root || root.status !== 'active') throw new NotFoundException('Storage root not found or has been removed.');
    if (root.provider !== 'gateway' || !root.gateway_device_id) {
      throw new ForbiddenException('This storage root is not Gateway-provider; pairing is not allowed.');
    }
    const devices = await this.gateway.listDevices();
    const device = devices.find((d) => d.id === root.gateway_device_id);
    if (!device || device.status !== 'active') {
      throw new ForbiddenException('The Gateway device bound to this storage root is not active.');
    }

    const nonce = randomToken();
    const expiresAt = new Date(Date.now() + GATEWAY_PAIRING_NONCE_TTL_SECONDS * 1000);
    const pairing = await this.repo.createPairing({
      userId: ctx.userId,
      storageRootId,
      deviceId: device.id,
      nonceHash: sha256(nonce),
      expiresAt,
    });
    this.audit.annotate({
      targetType: 'gateway_storage_pairing',
      targetId: pairing.id,
      reason: `Storage pairing issued for root ${storageRootId} + device ${device.id}, expires ${expiresAt.toISOString()}.`,
      afterState: { storageRootId, deviceId: device.id },
    });
    return { nonce, expiresAt: expiresAt.toISOString() };
  }

  /** Device redeems the nonce presented by the browser -> a storage session. */
  async redeemPairing(deviceId: string, nonce: string, storageRootId: string): Promise<{ sessionToken: string; expiresAt: string }> {
    const ctx = this.tenantContext.getOrThrow();

    const devices = await this.gateway.listDevices();
    const device = devices.find((d) => d.id === deviceId);
    if (!device || device.status !== 'active') throw new UnauthorizedException('AGENT_REVOKED');

    const pairing = await this.repo.findPairingByHash(sha256(nonce));
    assertOk(evaluateStoragePairingRedemption(pairing, { tenantId: ctx.tenantId, deviceId, storageRootId, now: new Date() }));

    const consumed = await this.repo.consumePairing(pairing!.id);
    if (!consumed) throw new UnauthorizedException('INVALID_NONCE');

    const sessionToken = randomToken();
    const expiresAt = new Date(Date.now() + GATEWAY_SESSION_TTL_SECONDS * 1000);
    const session = await this.repo.createSession({
      userId: pairing!.user_id,
      storageRootId,
      deviceId,
      pairingId: pairing!.id,
      tokenHash: sha256(sessionToken),
      expiresAt,
    });
    this.audit.annotate({
      targetType: 'gateway_storage_session',
      targetId: session.id,
      reason: `Storage session created for root ${storageRootId} + device ${deviceId}.`,
      afterState: { storageRootId, deviceId },
    });
    return { sessionToken, expiresAt: expiresAt.toISOString() };
  }
}

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertOk(result: PolicyResult): void {
  if (!result.ok) throw new UnauthorizedException(result.code);
}
