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
  ],
})
export class AppModule {}
