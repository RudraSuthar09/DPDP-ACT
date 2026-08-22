import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { STORAGE_MODULE_KEYS, type StorageModuleKey } from '@dpdp/shared';
import { TenantGuard } from '../../tenancy/tenant.guard';
import { Roles, AllowGatewayDevice } from '../identity/rbac/roles.decorator';
import { Audited } from '../audit/audited.decorator';
import type { RequestWithGatewayDevice } from '../../tenancy/gateway-device.middleware';
import { StorageService } from './storage.service';
import { StorageGatewayService } from './storage-gateway.service';
import {
  parseCreateStorageFolder,
  parseCreateStorageRoot,
  parseEntityIdQueryParam,
  parseStorageRedeemPairing,
  parseTombstoneReason,
  parseUpdateStorageRoot,
  parseUpsertStorageMapping,
} from './storage.dto';

const MANAGE = ['owner', 'dpo', 'compliance_officer'] as const;

/**
 * Staff management of the persistent Storage & Folder Mapping foundation —
 * CONFIGURATION ONLY (Storage Root -> Folder -> Module Mapping). Every route
 * here reads or writes structural metadata: a root's provider/reference, a
 * folder's name/parent, or a pointer from a module entity to a folder id.
 *
 * ===========================================================================
 * THERE IS NO FILE/DOCUMENT ROUTE HERE, AND THERE MUST NEVER BE ONE.
 *
 * No GET/POST for file bytes, no upload, no download, no "browse the real
 * disk" — this controller manages the virtual folder tree the client
 * explicitly configured. Real filesystem/object-storage I/O is a separate,
 * later capability layered on the Gateway data plane.
 * ===========================================================================
 */
@Controller('storage')
@UseGuards(TenantGuard)
export class StorageController {
  constructor(
    private readonly storage: StorageService,
    private readonly storageGateway: StorageGatewayService,
  ) {}

  // --- roots ------------------------------------------------------------

  @Get('roots')
  async listRoots(@Query('includeTombstoned') includeTombstoned?: string) {
    return { roots: await this.storage.listRoots(includeTombstoned === 'true') };
  }

  @Get('roots/:id')
  async getRoot(@Param('id') id: string) {
    return this.storage.getRoot(id);
  }

  @Post('roots')
  @Roles(...MANAGE)
  @Audited('storage.root.created')
  @HttpCode(HttpStatus.CREATED)
  async createRoot(@Body() body: unknown) {
    return this.storage.createRoot(parseCreateStorageRoot(body));
  }

  @Patch('roots/:id')
  @Roles(...MANAGE)
  @Audited('storage.root.updated')
  async updateRoot(@Param('id') id: string, @Body() body: unknown) {
    return this.storage.updateRoot(id, parseUpdateStorageRoot(body));
  }

  @Delete('roots/:id')
  @Roles(...MANAGE)
  @Audited('storage.root.removed')
  async removeRoot(@Param('id') id: string, @Body() body: unknown) {
    const { reason } = parseTombstoneReason(body);
    return this.storage.removeRoot(id, reason);
  }

  /**
   * Staff mint a one-time pairing nonce for a Gateway-provider storage root
   * (the browser then presents it directly to the Gateway agent to establish
   * a storage session — see agent/src/storage/storage-plane.ts). The device
   * is derived from the root's own binding, never a caller-supplied id.
   */
  @Post('roots/:id/gateway-pairings')
  @Roles(...MANAGE)
  @Audited('storage.gateway_pairing.created')
  @HttpCode(HttpStatus.OK)
  async createGatewayPairing(@Param('id') id: string) {
    return this.storageGateway.createPairing(id);
  }

  /**
   * Device-facing: the enrolled Gateway redeems a storage-pairing nonce
   * (presented to it by the browser) for a storage session token. Auth: the
   * `x-gateway-device-token` header, verified by GatewayDeviceMiddleware —
   * this route must be present in GATEWAY_DEVICE_PATHS for that middleware to
   * establish tenant context here (see gateway-device.middleware.ts).
   */
  @Post('gateway/pair/redeem')
  @AllowGatewayDevice()
  @Audited('storage.gateway_session.created')
  @HttpCode(HttpStatus.OK)
  async redeemGatewayPairing(@Req() req: RequestWithGatewayDevice, @Body() body: unknown) {
    if (!req.gatewayDeviceId) throw new UnauthorizedException('A valid device token is required.');
    const { nonce, storageRootId } = parseStorageRedeemPairing(body);
    return this.storageGateway.redeemPairing(req.gatewayDeviceId, nonce, storageRootId);
  }

  // --- folders ------------------------------------------------------------

  /** The full active folder set for one root — the "browse storage" view.
   *  The client assembles the tree from parentFolderId; no folder is ever
   *  suggested or guessed server-side. */
  @Get('roots/:rootId/folders')
  async listFolders(@Param('rootId') rootId: string) {
    return { folders: await this.storage.listFolders(rootId) };
  }

  @Post('folders')
  @Roles(...MANAGE)
  @Audited('storage.folder.created')
  @HttpCode(HttpStatus.CREATED)
  async createFolder(@Body() body: unknown) {
    return this.storage.createFolder(parseCreateStorageFolder(body));
  }

  @Delete('folders/:id')
  @Roles(...MANAGE)
  @Audited('storage.folder.removed')
  async removeFolder(@Param('id') id: string, @Body() body: unknown) {
    const { reason } = parseTombstoneReason(body);
    return this.storage.removeFolder(id, reason);
  }

  // --- mappings ------------------------------------------------------------

  /** Resolve the folder mapping for one module entity (e.g. a Consent
   *  Template), or `{ mapping: null }` if none is configured yet. */
  @Get('mappings')
  async getMapping(@Query('moduleKey') moduleKey?: string, @Query('entityId') entityId?: string) {
    const key = requireModuleKey(moduleKey);
    return { mapping: await this.storage.getMapping(key, parseEntityIdQueryParam(entityId)) };
  }

  @Get('mappings/list')
  async listMappings(@Query('moduleKey') moduleKey?: string) {
    return { mappings: await this.storage.listMappings(requireModuleKey(moduleKey)) };
  }

  /**
   * The explicit mapping surface — point one module entity at one folder.
   * Idempotent per (moduleKey, entityId): calling this again with a
   * different folderId is how a client CHANGES an existing mapping.
   */
  @Put('mappings')
  @Roles(...MANAGE)
  @Audited('storage.mapping.set')
  @HttpCode(HttpStatus.OK)
  async setMapping(@Body() body: unknown) {
    return this.storage.setMapping(parseUpsertStorageMapping(body));
  }

  @Delete('mappings/:id')
  @Roles(...MANAGE)
  @Audited('storage.mapping.deactivated')
  async deactivateMapping(@Param('id') id: string) {
    return this.storage.deactivateMapping(id);
  }
}

function requireModuleKey(value: string | undefined): StorageModuleKey {
  if (!value || !(STORAGE_MODULE_KEYS as readonly string[]).includes(value)) {
    throw new BadRequestException(`moduleKey must be one of: ${STORAGE_MODULE_KEYS.join(', ')}.`);
  }
  return value as StorageModuleKey;
}
