import { createHash, randomBytes } from 'node:crypto';
import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GATEWAY_PAIRING_NONCE_TTL_SECONDS,
  GATEWAY_SESSION_TTL_SECONDS,
} from '@dpdp/shared';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { AuditContextService } from '../audit/audit-context.service';
import { TokenService } from '../identity/token.service';
import { DataSourceService } from '../datasource/data-source.service';
import { InstallationService } from '../installation/installation.service';
import { CapabilityService } from '../capability/capability.service';
import { GatewayRepository, type GatewayDeviceRow } from './gateway.repository';
import { parseEnrollDevice } from './gateway.dto';
import { resolveGatewayProfile, type GatewayProfile } from './gateway-profile';
import {
  evaluateDeviceStatus,
  evaluateEnrollmentCode,
  evaluatePairingRedemption,
  evaluateSession,
  type PolicyResult,
} from './gateway-policy';

/**
 * The Gateway control plane (Phase 3C). Enrolment → pairing → session, plus
 * heartbeat, revocation and de-enrolment. It NEVER reads customer data and holds
 * NO raw-data capability: it moves ids, hashes and metadata only. Every accept/
 * reject decision is delegated to the pure functions in gateway-policy.ts; every
 * mutation is @Audited at the controller and annotated here with METADATA ONLY —
 * never a code, nonce, token, private key, or customer value.
 */
@Injectable()
export class GatewayService {
  private readonly enrollmentTtlSeconds: number;

  constructor(
    private readonly repo: GatewayRepository,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditContextService,
    private readonly tokens: TokenService,
    private readonly sources: DataSourceService,
    private readonly installations: InstallationService,
    private readonly capability: CapabilityService,
    config: ConfigService,
  ) {
    this.enrollmentTtlSeconds = Number(config.get('GATEWAY_ENROLLMENT_CODE_TTL_SECONDS') ?? 900);
  }

  // --- staff: issue an enrolment code --------------------------------------

  async createEnrollment(label: string | null): Promise<{ code: string; codePrefix: string; expiresAt: string }> {
    const ctx = this.tenantContext.getOrThrow();
    const code = randomToken();
    const expiresAt = new Date(Date.now() + this.enrollmentTtlSeconds * 1000);
    const row = await this.repo.createEnrollment({
      codeHash: sha256(code),
      codePrefix: code.slice(0, 8),
      label,
      createdBy: ctx.userId,
      expiresAt,
    });
    this.audit.annotate({
      targetType: 'gateway_enrollment',
      targetId: row.id,
      reason: `Gateway enrolment code issued${label ? ` ("${label}")` : ''}, expires ${expiresAt.toISOString()}.`,
      afterState: { codePrefix: row.code_prefix },
    });
    // The raw code is returned exactly once and never stored.
    return { code, codePrefix: row.code_prefix, expiresAt: expiresAt.toISOString() };
  }

  // --- device: enrol --------------------------------------------------------

  async enroll(
    enrollmentId: string,
    body: unknown,
  ): Promise<{ device: DeviceView; deviceToken: string; expiresIn: number }> {
    const ctx = this.tenantContext.getOrThrow();
    // The audit actor is the staff user who created the code — the enrolment
    // middleware put that on the context as userId.
    const actorUserId = ctx.userId;
    const input = parseEnrollDevice(body);

    const enrolment = await this.repo.findEnrollment(enrollmentId);
    assertOk(evaluateEnrollmentCode(enrolment, new Date()));

    // Product decision: ONE tenant -> ONE active Enterprise Gateway. A friendly
    // app-level check before the DB's own partial unique index (the real
    // backstop) ever gets a chance to reject it. Replacing a Gateway is an
    // EXPLICIT client action — revoke the old device first, never silent swap.
    const existingActive = await this.repo.findActiveDevice();
    if (existingActive) {
      throw new ForbiddenException(
        'An active Enterprise Gateway is already connected for this tenant. Revoke it before enrolling another.',
      );
    }

    const device = await this.repo.createDevice({
      publicKey: input.publicKey,
      deviceRef: input.deviceRef,
      platform: input.platform,
      agentVersion: input.agentVersion,
      displayName: input.displayName,
      enrolledBy: actorUserId,
    });

    // Consume the code (single-use enforced in SQL). If it lost a race, fail closed.
    const consumed = await this.repo.consumeEnrollment(enrollmentId, device.id);
    if (!consumed) throw new UnauthorizedException('Enrolment code is no longer valid.');

    const { token, expiresIn } = this.tokens.mintGatewayDeviceToken({
      deviceId: device.id,
      tenantId: ctx.tenantId,
      actorUserId,
    });

    this.audit.annotate({
      targetType: 'gateway_device',
      targetId: device.id,
      reason: `Gateway device enrolled (${device.platform}, agent ${device.agent_version}).`,
      afterState: { platform: device.platform, status: device.status },
    });
    return { device: toDeviceView(device), deviceToken: token, expiresIn };
  }

  // --- device: heartbeat ----------------------------------------------------

  async heartbeat(deviceId: string, agentVersion: string): Promise<{ deviceStatus: string; boundSourceIds: string[] }> {
    const device = await this.repo.findDevice(deviceId);
    assertOk(evaluateDeviceStatus(device));
    await this.repo.touchHeartbeat(deviceId, agentVersion);
    // Locked architecture §12: a linked Installation's heartbeat/version is
    // metadata derived from its Gateway's — never a second, divergent signal.
    // Best-effort: a missing/decommissioned installation must never fail the
    // device's own heartbeat response.
    if (device!.installation_id) {
      await this.installations.touchHeartbeat(device!.installation_id, agentVersion).catch(() => undefined);
    }
    this.audit.annotate({
      targetType: 'gateway_device',
      targetId: deviceId,
      reason: `Gateway heartbeat (agent ${agentVersion}).`,
    });
    return { deviceStatus: 'active', boundSourceIds: [] };
  }

  // --- staff: create a pairing nonce ---------------------------------------

  async createPairing(sourceId: string, deviceId: string): Promise<{ nonce: string; expiresAt: string }> {
    const ctx = this.tenantContext.getOrThrow();

    // Device must be enrolled + active (in this tenant, via RLS).
    const device = await this.repo.findDevice(deviceId);
    assertOk(evaluateDeviceStatus(device), NotFoundException);

    // Source must exist, be active, and be explicitly Gateway-connected (Mode B).
    // Reached through DataSourceService (R2 — never this module's own SQL).
    const source = await this.sources.get(sourceId); // throws NotFound if absent
    if (source.status !== 'active' || source.dataAccessMode !== 'gateway_connected') {
      throw new ForbiddenException('Source is not Gateway-connected; pairing is not allowed.');
    }

    const nonce = randomToken();
    const expiresAt = new Date(Date.now() + GATEWAY_PAIRING_NONCE_TTL_SECONDS * 1000);
    const pairing = await this.repo.createPairing({
      userId: ctx.userId,
      sourceId,
      deviceId,
      nonceHash: sha256(nonce),
      expiresAt,
    });
    this.audit.annotate({
      targetType: 'gateway_pairing',
      targetId: pairing.id,
      reason: `Pairing issued for source ${sourceId} + device ${deviceId}, expires ${expiresAt.toISOString()}.`,
      afterState: { sourceId, deviceId },
    });
    return { nonce, expiresAt: expiresAt.toISOString() };
  }

  // --- device: redeem a pairing -> session ---------------------------------

  async redeemPairing(deviceId: string, nonce: string, sourceId: string): Promise<{ sessionToken: string; expiresAt: string }> {
    const ctx = this.tenantContext.getOrThrow();

    const device = await this.repo.findDevice(deviceId);
    assertOk(evaluateDeviceStatus(device));

    const pairing = await this.repo.findPairingByHash(sha256(nonce));
    assertOk(
      evaluatePairingRedemption(pairing, { tenantId: ctx.tenantId, deviceId, sourceId, now: new Date() }),
    );

    const consumed = await this.repo.consumePairing(pairing!.id);
    if (!consumed) throw new UnauthorizedException('Pairing nonce is no longer valid.');

    const sessionToken = randomToken();
    const expiresAt = new Date(Date.now() + GATEWAY_SESSION_TTL_SECONDS * 1000);
    const session = await this.repo.createSession({
      userId: pairing!.user_id,
      sourceId,
      deviceId,
      pairingId: pairing!.id,
      tokenHash: sha256(sessionToken),
      expiresAt,
    });
    this.audit.annotate({
      targetType: 'gateway_session',
      targetId: session.id,
      reason: `Gateway session created for source ${sourceId} + device ${deviceId}.`,
      afterState: { sourceId, deviceId },
    });
    return { sessionToken, expiresAt: expiresAt.toISOString() };
  }

  // --- device: refresh a session -------------------------------------------

  async refreshSession(deviceId: string, sessionToken: string): Promise<{ sessionToken: string; expiresAt: string }> {
    const ctx = this.tenantContext.getOrThrow();
    const device = await this.repo.findDevice(deviceId);
    assertOk(evaluateDeviceStatus(device));

    const current = await this.repo.findSessionByHash(sha256(sessionToken));
    assertOk(evaluateSession(current, { tenantId: ctx.tenantId, now: new Date(), deviceId }));

    // Rotate: mint a fresh session and revoke the old one.
    const next = randomToken();
    const expiresAt = new Date(Date.now() + GATEWAY_SESSION_TTL_SECONDS * 1000);
    const session = await this.repo.createSession({
      userId: current!.user_id,
      sourceId: current!.source_id,
      deviceId,
      pairingId: current!.pairing_id,
      tokenHash: sha256(next),
      expiresAt,
    });
    await this.repo.revokeSession(current!.id);
    this.audit.annotate({
      targetType: 'gateway_session',
      targetId: session.id,
      reason: `Gateway session refreshed for device ${deviceId}.`,
      afterState: { deviceId },
    });
    return { sessionToken: next, expiresAt: expiresAt.toISOString() };
  }

  // --- device: de-enrol -----------------------------------------------------

  async deenroll(deviceId: string): Promise<{ removed: true }> {
    const device = await this.repo.findDevice(deviceId);
    assertOk(evaluateDeviceStatus(device));
    await this.repo.removeDevice(deviceId);
    await this.repo.revokeDeviceSessions(deviceId);
    this.audit.annotate({
      targetType: 'gateway_device',
      targetId: deviceId,
      reason: 'Gateway device de-enrolled (removed).',
      beforeState: { status: 'active' },
      afterState: { status: 'removed' },
    });
    return { removed: true };
  }

  // --- staff: list + revoke -------------------------------------------------

  async listDevices(): Promise<DeviceView[]> {
    return (await this.repo.listDevices()).map(toDeviceView);
  }

  /** The tenant's one active Gateway (or null) — the "reconnect on login" read. */
  async getActiveDevice(): Promise<DeviceView | null> {
    const row = await this.repo.findActiveDevice();
    if (!row) return null;
    return this.withProfile(row);
  }

  /**
   * Locked architecture §5/§11: link (or clear) this device's Installation —
   * a common Gateway Core operation, not a second implementation. Linking to
   * a `client_server`-flavoured (Enterprise) installation requires the
   * tenant currently hold the `enterpriseGateway` capability; linking to a
   * `hosted`-flavoured (SaaS) one, or clearing the link, does not — the
   * check is data-dependent on the TARGET installation, so it runs here
   * rather than as a static route decorator (CapabilityGuard is for the
   * static case only; this is CapabilityService.assertCapability's direct-
   * call path).
   */
  async setInstallation(deviceId: string, installationId: string | null): Promise<DeviceView> {
    if (installationId) {
      const installation = await this.installations.getById(installationId);
      if (installation.deploymentType === 'client_server') {
        await this.capability.assertCapability('enterpriseGateway');
      }
    }
    const row = await this.repo.setInstallation(deviceId, installationId);
    if (!row) throw new NotFoundException('Gateway device not found or not active.');
    this.audit.annotate({
      targetType: 'gateway_device',
      targetId: deviceId,
      reason: installationId ? `Gateway device linked to installation ${installationId}.` : 'Gateway device unlinked from its installation.',
      afterState: { installationId },
    });
    return this.withProfile(row);
  }

  /**
   * Phase 3G-2.5: set/clear the browser-facing endpoint for an already-enrolled,
   * active device. Config only (a URL) — never touches the device's security
   * identity (public key / device token), which is entirely unaffected.
   */
  async setEndpoint(deviceId: string, endpoint: string | null): Promise<DeviceView> {
    const row = await this.repo.setEndpoint(deviceId, endpoint);
    if (!row) throw new NotFoundException('Gateway device not found or not active.');
    this.audit.annotate({
      targetType: 'gateway_device',
      targetId: deviceId,
      reason: endpoint ? `Gateway endpoint set to "${endpoint}".` : 'Gateway endpoint cleared.',
      afterState: { endpoint },
    });
    return toDeviceView(row);
  }

  async revokeDevice(deviceId: string, reason: string | null): Promise<DeviceView> {
    const ctx = this.tenantContext.getOrThrow();
    const row = await this.repo.revokeDevice(deviceId, ctx.userId, reason);
    if (!row) throw new NotFoundException('Device not found or not active.');
    await this.repo.revokeDeviceSessions(deviceId);
    this.audit.annotate({
      targetType: 'gateway_device',
      targetId: deviceId,
      reason: reason ?? 'Gateway device revoked.',
      beforeState: { status: 'active' },
      afterState: { status: 'revoked' },
    });
    return toDeviceView(row);
  }

  /** Resolve the device's Gateway profile from its linked installation, if
   *  any (single extra lookup — used only where a caller needs one device's
   *  full view, never in the plain listDevices() read). */
  private async withProfile(row: GatewayDeviceRow): Promise<DeviceView> {
    const view = toDeviceView(row);
    if (!row.installation_id) return view;
    const installation = await this.installations.getById(row.installation_id).catch(() => null);
    if (!installation) return view;
    return { ...view, profile: resolveGatewayProfile(installation.deploymentType) };
  }
}

// --- helpers ----------------------------------------------------------------

export interface DeviceView {
  id: string;
  platform: string;
  agentVersion: string;
  displayName: string;
  status: string;
  /** Phase 3G-2.5: the browser-facing URL to reach this Gateway. Null until
   *  staff explicitly configures it. Never the security identity. */
  endpoint: string | null;
  /** Locked architecture §5/§11: the Installation this device is linked to,
   *  or null. */
  installationId: string | null;
  /** Derived from the linked installation's deploymentType — SaaS Gateway vs
   *  Enterprise Gateway PROFILE of the one Gateway Core, never a second
   *  implementation. Null until a device is linked to an installation. */
  profile: GatewayProfile | null;
  enrolledAt: string;
  lastHeartbeatAt: string | null;
}

function toDeviceView(row: GatewayDeviceRow): DeviceView {
  return {
    id: row.id,
    platform: row.platform,
    agentVersion: row.agent_version,
    displayName: row.display_name,
    status: row.status,
    endpoint: row.endpoint,
    installationId: row.installation_id,
    profile: null,
    enrolledAt: row.enrolled_at.toISOString(),
    lastHeartbeatAt: row.last_heartbeat_at ? row.last_heartbeat_at.toISOString() : null,
  };
}

/** A high-entropy opaque token/code/nonce. Base64url, ~256 bits. */
function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Turn a policy rejection into an HTTP error. The error message is the stable
 * GatewayErrorCode ONLY — never the internal reason, never a token/secret/value.
 * Default is 401 (auth failure); pass a class for a different status.
 */
function assertOk(result: PolicyResult, ErrorClass: new (msg: string) => Error = UnauthorizedException): void {
  if (!result.ok) {
    throw new ErrorClass(result.code);
  }
}
