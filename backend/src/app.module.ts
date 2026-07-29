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
import { WorkflowModule } from './modules/workflow/workflow.module';
import { AuditModule } from './modules/audit/audit.module';
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
    // Cross-cutting modules
    WorkflowModule, // S3 — the deadline substrate Breach/Grievance/DPRequest share
    AuditModule,
    NotifyModule,
    DashboardModule,
  ],
})
export class AppModule {}
