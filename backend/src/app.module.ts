import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { TenancyModule } from './tenancy/tenancy.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';

// Feature modules — the five product modules plus cross-cutting concerns.
// Modules communicate through service interfaces only; never reach into another
// module's tables (R2). They are empty skeletons in this bootstrap.
import { IdentityModule } from './modules/identity/identity.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { ConsentModule } from './modules/consent/consent.module';
import { BreachModule } from './modules/breach/breach.module';
import { GrievanceModule } from './modules/grievance/grievance.module';
import { DPRequestModule } from './modules/dprequest/dprequest.module';
import { RequestModule } from './modules/request/request.module';
import { WorkflowModule } from './modules/workflow/workflow.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuditExportModule } from './modules/audit/audit-export.module';
import { NotifyModule } from './modules/notify/notify.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { DataSourceModule } from './modules/datasource/data-source.module';
import { GatewayModule } from './modules/gateway/gateway.module';
import { StorageModule } from './modules/storage/storage.module';
import { LicensingModule } from './modules/licensing/licensing.module';
import { CapabilityModule } from './modules/capability/capability.module';
import { InstallationModule } from './modules/installation/installation.module';

@Module({
  imports: [
    // Reads process.env (Docker/CI) and, in local dev, the repo-root .env
    // (the app's cwd is backend/, so the root file is one level up).
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../.env'] }),
    // Seam S1 foundations — must load before any feature module that queries.
    TenancyModule,
    DatabaseModule,
    HealthModule,
    // Product modules
    IdentityModule,
    InventoryModule,
    ConsentModule,
    BreachModule,
    GrievanceModule,
    DPRequestModule,
    // The substrate the two above share: public portal, OTP, the identity
    // handoff, ticketing, SLA timers and escalation (FR-GRV-01/03/04/05).
    RequestModule,
    // Cross-cutting modules
    WorkflowModule, // S3 — the deadline substrate Breach/Grievance/DPRequest share
    AuditModule,
    // API-only (FR-AUD-05): needs IdentityModule for the org name, which
    // AuditModule itself must never depend on — see AuditExportController.
    AuditExportModule,
    NotifyModule,
    DashboardModule,
    // Phase 1 of the Gateway line of work: metadata + per-source access mode
    // only (I1/§2.1). No Gateway, no connector, no raw-data path.
    DataSourceModule,
    // Locked-architecture foundation phase: licensing -> capability model ->
    // installation registration, in dependency order (each imports only the
    // one before it, through its service export — R2). GatewayModule (below)
    // additively depends on both Installation and Capability.
    LicensingModule,
    CapabilityModule,
    InstallationModule,
    // Phase 3C: the Gateway CONTROL PLANE (enrolment/pairing/session/heartbeat/
    // revocation). Ids, hashes and metadata only — still no connector, no raw
    // read, no customer data (I1). Data plane is a separate, later capability.
    GatewayModule,
    // Locked-architecture foundation phase: Storage & Folder Mapping — a
    // generic, persistent Storage Root -> Folder -> Module Mapping hierarchy
    // (I1: configuration only, never a file or a customer value).
    StorageModule,
  ],
})
export class AppModule {}
