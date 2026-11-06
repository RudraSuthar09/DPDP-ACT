import { ConflictException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import type {
  GatewayAuthorizeFolderRequest,
  GatewayAuthorizeFolderResponse,
  GatewayFolderRevocations,
  GatewayPendingFolderRemoval,
  GatewayRevokeFolderRequest,
  GatewayRevokeFolderResponse,
} from '@dpdp/shared';
import { AuditContextService } from '../audit/audit-context.service';
import { CapabilityService } from '../capability/capability.service';
import { GatewayService } from '../gateway/gateway.service';
import { DataSourceService } from '../datasource/data-source.service';
import { StorageService } from '../storage/storage.service';

/**
 * "An administrator authorized this folder on the Gateway computer" ->
 * the DPDP records that make it usable, created automatically so nobody ever
 * copies an id by hand.
 *
 * This is an ORCHESTRATOR, not a new registry: it does nothing a staff member
 * could not already do through the existing routes, and it does it through
 * the EXISTING services (DataSourceService, StorageService), so their
 * validation, capability checks and S5 audit annotations all still apply.
 *
 * THE SECURITY BOUNDARY (why a device may call this at all):
 *   - the tenant and device come from the VERIFIED device JWT, never the body
 *     (see GatewayDeviceMiddleware + gateway-folder.dto.ts);
 *   - the device must still be enrolled and active RIGHT NOW — a revoked
 *     device can do nothing, even with a token that still parses;
 *   - the tenant must hold the enterpriseGateway capability;
 *   - every record it can create is scoped to that tenant by RLS and, for a
 *     storage root, bound to THAT device — a device cannot create, reach or
 *     modify another tenant's or another device's locations;
 *   - it creates exactly two kinds of record and nothing else: a filesystem
 *     data source (read) and a Gateway-provider storage root (write);
 *   - no filesystem path is accepted or stored (I1) — only a display label;
 *   - the number of folders one device can register is capped, so a
 *     compromised or looping agent cannot fill a tenant's workspace;
 *   - it is idempotent by label, so a retry reuses records instead of
 *     multiplying them;
 *   - the route is @Audited, and each underlying service annotates its own
 *     entry, so the chain records who/what/when as usual.
 *
 * READ AND WRITE STAY INDEPENDENT. 'both' performs two separate grants on one
 * folder; neither is ever inferred from the other, and each is enforced by its
 * own plane in the Gateway (data plane vs storage plane, separate sessions).
 */
@Injectable()
export class GatewayFolderService {
  private readonly logger = new Logger(GatewayFolderService.name);

  /** One Gateway should not be able to create unbounded records. Well above
   *  any real deployment; a runaway agent hits this instead of the database. */
  private static readonly MAX_FOLDERS_PER_DEVICE = 50;

  constructor(
    private readonly gateway: GatewayService,
    private readonly dataSources: DataSourceService,
    private readonly storage: StorageService,
    private readonly capability: CapabilityService,
    private readonly audit: AuditContextService,
  ) {}

  async authorize(deviceId: string, input: GatewayAuthorizeFolderRequest): Promise<GatewayAuthorizeFolderResponse> {
    // 1. The device must be one of THIS tenant's, and still active. listDevices
    //    runs under the token's tenant (RLS), so another tenant's device id is
    //    indistinguishable from a nonexistent one.
    const devices = await this.gateway.listDevices();
    const device = devices.find((d) => d.id === deviceId);
    if (!device || device.status !== 'active') {
      throw new ForbiddenException('This Gateway is not active for this workspace.');
    }
    // 2. The tenant must actually be entitled to a Gateway.
    await this.capability.assertCapability('enterpriseGateway');

    const wantsRead = input.access === 'read' || input.access === 'both';
    const wantsWrite = input.access === 'write' || input.access === 'both';

    const sourceId = wantsRead ? await this.resolveReadSource(input.label) : null;
    const storageRootId = wantsWrite ? await this.resolveWriteRoot(input.label, deviceId) : null;

    this.audit.annotate({
      targetType: 'gateway_device',
      targetId: deviceId,
      reason: `Gateway folder "${input.label}" authorized for ${input.access} by its administrator; DPDP records resolved automatically.`,
      afterState: { access: input.access, ...(sourceId ? { sourceId } : {}), ...(storageRootId ? { storageRootId } : {}) },
    });
    this.logger.log(`Gateway folder authorized (device=${deviceId}, access=${input.access}).`);
    return { sourceId, storageRootId, label: input.label };
  }

  /** Reuse this tenant's active filesystem source of the same name, else
   *  create one and put it in gateway_connected mode (the same two steps a
   *  staff member performs by hand today). */
  private async resolveReadSource(label: string): Promise<string> {
    const existing = (await this.dataSources.list()).find((s) => s.status === 'active' && s.sourceKind === 'filesystem' && s.name === label);
    if (existing) {
      if (existing.dataAccessMode !== 'gateway_connected') await this.dataSources.setMode(existing.id, true);
      return existing.id;
    }
    await this.assertUnderFolderCap();
    const created = await this.dataSources.create({ name: label, sourceKind: 'filesystem', connectionHint: null });
    await this.dataSources.setMode(created.id, true);
    return created.id;
  }

  /** Reuse this device's active Gateway storage root of the same name, else
   *  create one bound to this device. A root of that name bound to a
   *  DIFFERENT device is a conflict, reported as such rather than silently
   *  rebound (that would hand this device another device's destination). */
  private async resolveWriteRoot(label: string, deviceId: string): Promise<string> {
    const roots = await this.storage.listRoots();
    const sameName = roots.find((r) => r.status === 'active' && r.name === label);
    if (sameName) {
      if (sameName.provider !== 'gateway' || sameName.gatewayDeviceId !== deviceId) {
        throw new ConflictException(
          `A storage location named "${label}" already exists for a different Gateway or provider. Rename the folder on this computer, or remove that location in DPDP first.`,
        );
      }
      return sameName.id;
    }
    await this.assertUnderFolderCap();
    const created = await this.storage.createRoot({ name: label, provider: 'gateway', gatewayDeviceId: deviceId, rootPath: null });
    return created.id;
  }

  /**
   * "Remove folder" — the reverse of authorize(), and the only way a customer
   * withdraws a folder grant. Staff-authenticated (a device must never be
   * able to revoke its own grants, nor another folder's).
   *
   * What it does, and what it deliberately does not:
   *   - BOTH grants go, together. A folder authorized for 'both' is two
   *     records; one Remove tombstones both, because the customer gave one
   *     permission and is taking one permission back. Either half may already
   *     be gone — the other is still revoked.
   *   - it is IDEMPOTENT. A second Remove of the same label finds nothing
   *     active and reports the same shape, with nothing left to revoke.
   *   - the backend FAILS CLOSED immediately, whatever the Gateway is doing:
   *     no new read pairing can be issued for a tombstoned source
   *     (GatewayService.createPairing), no new write pairing for a tombstoned
   *     root (StorageGatewayService.createPairing), no Enterprise copy can be
   *     staged into it (SubmissionDeliveryService.stageEnterpriseCopies), and
   *     an already-queued copy is refused at claim time with
   *     DESTINATION_NOT_AVAILABLE. A Gateway that has not heard yet cannot be
   *     handed anything to write.
   *   - nothing is deleted: not the customer's folders or files (this
   *     platform never held them), not a consent record, not a submission,
   *     not the evidence of any past delivery. Tombstones only.
   *   - no mapping is repointed. A form field that pointed into this folder
   *     keeps naming it and now has no usable destination; that count is
   *     returned so the UI can tell the administrator to choose a
   *     replacement. Silently sending that data somewhere else would be worse
   *     than failing.
   *   - the device's pairing credential and every OTHER folder are untouched.
   */
  async revoke(input: GatewayRevokeFolderRequest): Promise<GatewayRevokeFolderResponse> {
    const label = input.label;
    const device = (await this.gateway.listDevices()).find((d) => d.status === 'active') ?? null;

    const root = (await this.storage.listRoots()).find(
      (r) => r.status === 'active' && r.provider === 'gateway' && r.name === label,
    );
    const source = (await this.dataSources.list()).find(
      (s) => s.status === 'active' && s.sourceKind === 'filesystem' && s.name === label,
    );
    if (!root && !source) {
      // Idempotent: already removed, or never existed under this name. Not an
      // error — the customer asked for a state that already holds.
      return { label, revokedSourceId: null, revokedStorageRootId: null, gatewayPending: false, affectedFormFields: 0 };
    }

    // Count what loses its destination BEFORE the root goes, so the number is
    // the truth about what the administrator now has to repoint.
    const affectedFormFields = root ? await this.countFieldsMappedInto(root.id) : 0;

    if (source) {
      // Belt and braces: close Mode B first, then tombstone. Either alone
      // already blocks raw access; both together mean no ordering of
      // concurrent requests leaves a window open.
      await this.dataSources.setMode(source.id, false);
      await this.dataSources.remove(source.id, `Gateway folder "${label}" removed by this organisation.`);
    }
    if (root) {
      await this.storage.revokeGatewayRoot(root.id, `Gateway folder "${label}" removed by this organisation.`);
    }

    // Is the Gateway even reachable to hear about it? It picks revocations up
    // on its next check-in (GET /gateway/folders/revocations). An offline or
    // absent Gateway means the removal is recorded and waiting — said plainly
    // rather than reported as finished.
    const gatewayPending = !device || !this.isCheckedInRecently(device.lastHeartbeatAt);

    this.audit.annotate({
      targetType: 'gateway_device',
      targetId: device?.id ?? null,
      reason: `Gateway folder "${label}" removed by this organisation; read and write access revoked centrally.${
        gatewayPending ? ' The Gateway has not checked in since, so it will apply the removal on reconnect.' : ''
      }`,
      beforeState: { sourceId: source?.id ?? null, storageRootId: root?.id ?? null },
      afterState: { revoked: true, gatewayPending, affectedFormFields },
    });
    this.logger.log(`Gateway folder revoked (read=${!!source}, write=${!!root}, pending=${gatewayPending}).`);
    return {
      label,
      revokedSourceId: source?.id ?? null,
      revokedStorageRootId: root?.id ?? null,
      gatewayPending,
      affectedFormFields,
    };
  }

  /**
   * What the Gateway asks for on each check-in: the ids it must stop serving.
   * An explicit revocation list, never "everything not in the active set" —
   * the Gateway also holds entries an operator configured by hand, and those
   * must survive untouched.
   *
   * Read-only, scoped by RLS to the calling device's tenant, and restricted to
   * the two record kinds this module creates. Labels are not sent: the agent
   * matches on the ids DPDP itself issued.
   */
  async revocationsFor(deviceId: string): Promise<GatewayFolderRevocations> {
    const devices = await this.gateway.listDevices();
    const device = devices.find((d) => d.id === deviceId);
    if (!device || device.status !== 'active') {
      throw new ForbiddenException('This Gateway is not active for this workspace.');
    }
    const [roots, sources] = await Promise.all([this.storage.listRoots(true), this.dataSources.list(true)]);
    return {
      revokedSourceIds: sources.filter((s) => s.status !== 'active' && s.sourceKind === 'filesystem').map((s) => s.id),
      revokedStorageRootIds: roots
        .filter((r) => r.status !== 'active' && r.provider === 'gateway' && r.gatewayDeviceId === deviceId)
        .map((r) => r.id),
    };
  }

  /**
   * Folders whose removal is recorded but which the Gateway has not picked up
   * yet, so the UI can say "Removal pending" instead of pretending it is
   * done. Labels only — no ids, no paths.
   */
  async pendingRemovals(): Promise<GatewayPendingFolderRemoval[]> {
    const device = (await this.gateway.listDevices()).find((d) => d.status === 'active') ?? null;
    const [roots, sources] = await Promise.all([this.storage.listRoots(true), this.dataSources.list(true)]);
    // The watermark is the device's last check-in: anything revoked after it
    // cannot have reached the Gateway yet. Once the Gateway checks in again
    // (which is when it fetches revocations), these clear by themselves —
    // there is no second place recording "applied", and so none to go stale.
    const since = device?.lastHeartbeatAt ? Date.parse(device.lastHeartbeatAt) : null;
    const removedAfterLastCheckIn = (updatedAt: string): boolean =>
      since === null || Date.parse(updatedAt) > since;
    const labels = new Set<string>();
    for (const r of roots) {
      if (r.status !== 'active' && r.provider === 'gateway' && removedAfterLastCheckIn(r.updatedAt)) labels.add(r.name);
    }
    for (const s of sources) {
      if (s.status !== 'active' && s.sourceKind === 'filesystem' && removedAfterLastCheckIn(s.updatedAt)) labels.add(s.name);
    }
    return [...labels].sort().map((label) => ({ label }));
  }

  /** How many consent-form fields name a folder under this root as their
   *  destination. Composed from the existing storage surface (R2). */
  private async countFieldsMappedInto(rootId: string): Promise<number> {
    const [folders, mappings] = await Promise.all([
      this.storage.listFolders(rootId),
      this.storage.listMappings('consent_form_field'),
    ]);
    const ours = new Set(folders.map((f) => f.id));
    return mappings.filter((m) => m.status === 'active' && ours.has(m.folderId)).length;
  }

  /** A Gateway that has sent no heartbeat inside this window is treated as
   *  not having heard anything yet. Generous next to the agent's 60 s
   *  cadence: being told "pending" when it has in fact already applied the
   *  removal is harmless, the reverse is a lie. */
  private static readonly CHECK_IN_WINDOW_MS = 3 * 60_000;

  private isCheckedInRecently(lastHeartbeatAt: string | null): boolean {
    if (!lastHeartbeatAt) return false;
    const at = Date.parse(lastHeartbeatAt);
    return Number.isFinite(at) && Date.now() - at <= GatewayFolderService.CHECK_IN_WINDOW_MS;
  }

  private async assertUnderFolderCap(): Promise<void> {
    const [sources, roots] = await Promise.all([this.dataSources.list(), this.storage.listRoots()]);
    const sourceCount = sources.filter((s) => s.status === 'active' && s.sourceKind === 'filesystem').length;
    const rootCount = roots.filter((r) => r.status === 'active' && r.provider === 'gateway').length;
    if (Math.max(sourceCount, rootCount) >= GatewayFolderService.MAX_FOLDERS_PER_DEVICE) {
      throw new ConflictException(
        `This workspace already has ${GatewayFolderService.MAX_FOLDERS_PER_DEVICE} Gateway folders. Remove one in DPDP before authorizing another.`,
      );
    }
  }
}
