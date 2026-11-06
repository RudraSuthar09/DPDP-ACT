import { Module } from '@nestjs/common';
import { GatewayModule } from '../gateway/gateway.module';
import { StorageModule } from '../storage/storage.module';
import { DataSourceModule } from '../datasource/data-source.module';
import { CapabilityModule } from '../capability/capability.module';
import { GatewayFolderController } from './gateway-folder.controller';
import { GatewayFolderService } from './gateway-folder.service';

/**
 * Automatic folder registration for an enrolled Gateway. Deliberately a thin
 * module that OWNS no table and NO repository: it composes the existing
 * DataSourceService and StorageService (R2 — never their repositories or
 * their tables directly), so there is no second registry and no duplicated
 * validation.
 *
 * Import direction is safe: StorageModule already imports GatewayModule, and
 * DataSourceModule imports only CapabilityModule — nothing imports this
 * module, so no cycle is possible.
 */
@Module({
  imports: [GatewayModule, StorageModule, DataSourceModule, CapabilityModule],
  controllers: [GatewayFolderController],
  providers: [GatewayFolderService],
})
export class GatewayFolderModule {}
