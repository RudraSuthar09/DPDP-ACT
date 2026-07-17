import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller';
import { UsersController } from './users.controller';
import { IdentityService } from './identity.service';
import { TokenService } from './token.service';
import { UsersRepository } from './users.repository';
import { RolesGuard } from './rbac/roles.guard';
import { IDENTITY_PROVIDER } from './provider/identity-provider';
import { LocalIdentityProvider } from './provider/local-identity.provider';
import { PASSWORD_HASHER, ScryptPasswordHasher } from './crypto/password-hasher';
import { AesGcmSecretCipher, SECRET_CIPHER } from './crypto/secret-cipher';

/**
 * Identity & Tenancy. Owns tenant provisioning (FR-IDN-01), authentication
 * (FR-IDN-02: email + password + TOTP), and RBAC (FR-IDN-03) — and, through the
 * tokens minted here, the `tenant_id` claim that Seam S1 turns into the Postgres
 * session GUC every RLS policy filters on. Every other module depends on that
 * claim being right.
 *
 * Requirements: FR-IDN-01/02/03 (04/05 partially: lifecycle).  Seams: S1.
 * Invariants: I3, I4.
 *
 * The three interface bindings below are the swap points, and they are bound by
 * token rather than by class so a replacement is a one-line change here:
 *   IDENTITY_PROVIDER → LocalIdentityProvider  (Stage 2: Keycloak/WorkOS, FR-IDN-06)
 *   PASSWORD_HASHER   → ScryptPasswordHasher   (later: Argon2id)
 *   SECRET_CIPHER     → AesGcmSecretCipher     (later: KMS-wrapped per-tenant keys, NFR-SEC-02)
 */
// TenancyModule and DatabaseModule are @Global — TenantContextService and
// TenantDatabaseService inject without an explicit import.
@Module({
  controllers: [AuthController, UsersController],
  providers: [
    IdentityService,
    TokenService,
    UsersRepository,
    { provide: PASSWORD_HASHER, useClass: ScryptPasswordHasher },
    { provide: SECRET_CIPHER, useClass: AesGcmSecretCipher },
    { provide: IDENTITY_PROVIDER, useClass: LocalIdentityProvider },
    // Global (FR-IDN-03). Registered here rather than in AppModule because the
    // rule belongs to the module that owns roles. Being global is the point: the
    // Auditor read-only floor must apply to routes nobody has annotated —
    // including routes not yet written by people who have not read this file.
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  // Other modules gate on roles and read the current user through these; they
  // must never touch the identity tables directly (R2).
  exports: [IdentityService, TokenService],
})
export class IdentityModule {}
