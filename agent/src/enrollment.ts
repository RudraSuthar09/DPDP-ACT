/**
 * Gateway enrollment lifecycle (Phase 3C, agent side) — the piece identified as
 * missing during the Phase 2 investigation: the backend has always fully
 * supported POST /gateway/enroll, /gateway/heartbeat, /gateway/session/refresh,
 * and /gateway/deenroll (backend/src/modules/gateway), but nothing in this
 * package ever called them. This file is the CLIENT half of an existing,
 * already-implemented server protocol — not a second enrollment mechanism, not
 * a second device table, not a second security model.
 *
 * Flow:
 *   1. On first run, a human supplies the one-time enrollment code DPDP showed
 *      them (GATEWAY_ENROLLMENT_CODE).
 *   2. ensureEnrolled() redeems it exactly once via POST /gateway/enroll,
 *      receiving a device token (a long-lived `gateway_device` JWT — see
 *      backend/src/modules/identity/token.service.ts).
 *   3. The device token is persisted to a local JSON file under `stateDir` —
 *      NOT the central database (I1: the central platform never gains a second
 *      copy of a credential that must stay in the client environment), NOT the
 *      enrollment code itself (single-use, already spent by this point), and
 *      entirely separate from any client-database credential (those live only
 *      in GATEWAY_SOURCES, untouched by this file).
 *   4. Every subsequent start loads the persisted token and skips enrollment
 *      entirely — no code is asked for or needed again while the credential
 *      remains valid (item 5/9 of the Phase 1 spec).
 *   5. A heartbeat runs on an interval using the persisted token.
 *   6. deenroll() calls the backend to remove the device, then deletes the
 *      local file — the backend has no record of this device afterward, so
 *      re-enrollment requires a brand-new code, exactly as a first install.
 */
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import path from 'node:path';
import type { GatewayAgentPlatform } from '@dpdp/shared';

export interface PersistedCredential {
  tenantId: string;
  deviceId: string;
  deviceToken: string;
  enrolledAt: string;
}

export class EnrollmentRequiredError extends Error {
  constructor() {
    super(
      'This Gateway has no persisted device credential and no enrollment code was ' +
        'supplied (GATEWAY_ENROLLMENT_CODE). Generate a one-time enrollment code in ' +
        'DPDP (Data Sources -> Enterprise Gateway -> Connect Enterprise Gateway) and ' +
        'set GATEWAY_ENROLLMENT_CODE before starting the Gateway.',
    );
    this.name = 'EnrollmentRequiredError';
  }
}

/** Thrown by the HTTP client on any non-2xx response; carries the status so
 *  callers (the heartbeat loop) can tell "credential rejected" (401/403) apart
 *  from "transiently unreachable" without parsing message text. */
export class ControlPlaneHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`Gateway control-plane call failed (HTTP ${status})`);
    this.name = 'ControlPlaneHttpError';
  }
}

// --- local credential persistence -------------------------------------------

function credentialFilePath(stateDir: string): string {
  return path.join(stateDir, 'device-credential.json');
}

/** Never throws for "not enrolled yet" — returns null. Throws only if the file
 *  exists but is unreadable/corrupt, so a real problem is never silently
 *  swallowed into "just re-enroll". */
export function loadPersistedCredential(stateDir: string): PersistedCredential | null {
  const file = credentialFilePath(stateDir);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const parsed = JSON.parse(raw) as Partial<PersistedCredential>;
  if (
    typeof parsed.tenantId !== 'string' ||
    typeof parsed.deviceId !== 'string' ||
    typeof parsed.deviceToken !== 'string' ||
    typeof parsed.enrolledAt !== 'string'
  ) {
    throw new Error(`Corrupt Gateway credential file at ${file} — delete it and re-enroll.`);
  }
  return parsed as PersistedCredential;
}

/** Restrictive permissions (owner read/write only) where the platform supports
 *  it — this is a bearer credential, handled like an SSH private key, not an
 *  ordinary config file. */
export function savePersistedCredential(stateDir: string, cred: PersistedCredential): void {
  mkdirSync(stateDir, { recursive: true });
  const file = credentialFilePath(stateDir);
  writeFileSync(file, JSON.stringify(cred, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Best-effort: chmod semantics differ on Windows. The file is still only
    // readable by the account the agent runs as; this is defence in depth.
  }
}

export function clearPersistedCredential(stateDir: string): void {
  try {
    rmSync(credentialFilePath(stateDir), { force: true });
  } catch {
    // Best-effort — de-enrollment must not fail just because local cleanup did.
  }
}

// --- the control-plane HTTP client ------------------------------------------

export interface GatewayControlPlaneClient {
  enroll(input: {
    enrollmentCode: string;
    publicKey: string;
    platform: GatewayAgentPlatform;
    agentVersion: string;
    displayName: string;
    deviceRef: string | null;
  }): Promise<{ deviceId: string; tenantId: string; deviceToken: string }>;
  heartbeat(deviceToken: string, agentVersion: string): Promise<void>;
  refreshSession(deviceToken: string, sessionToken: string): Promise<{ sessionToken: string; expiresAt: string }>;
  deenroll(deviceToken: string): Promise<void>;
  redeemPairing(
    deviceToken: string,
    input: { nonce: string; sourceId: string },
  ): Promise<{ sessionToken: string; expiresAt: string }>;
  /** Storage data-plane integration: the storage-plane sibling of
   *  redeemPairing, scoped to a storageRootId. Posts to the SAME backend host
   *  as every other control-plane call — one client, one more method, not a
   *  second HTTP client. */
  redeemStoragePairing(
    deviceToken: string,
    input: { nonce: string; storageRootId: string },
  ): Promise<{ sessionToken: string; expiresAt: string }>;
}

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ControlPlaneHttpError(res.status, json);
  return json;
}

/** Reads claims from a JWT WITHOUT verifying its signature. Safe only because
 *  the result is used purely for local bookkeeping (which tenant this
 *  credential belongs to, for logging/display) — never for an authorization
 *  decision. Every real check happens on the BACKEND, which verifies the
 *  signature on every call this token is subsequently used for. */
function decodeJwtPayloadUnsafe(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) return {};
  try {
    return JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * The real client. Every call carries metadata only — ids, hashes, tokens,
 * non-secret device info — never a client-database credential and never a
 * customer value; the routes themselves enforce this server-side
 * (backend/src/modules/gateway/gateway.dto.ts's rejectSecretFields).
 */
export function createControlPlaneClient(controlPlaneUrl: string): GatewayControlPlaneClient {
  return {
    async enroll(input) {
      const json = (await postJson(
        `${controlPlaneUrl}/gateway/enroll`,
        { 'x-gateway-enrollment-code': input.enrollmentCode },
        {
          publicKey: input.publicKey,
          platform: input.platform,
          agentVersion: input.agentVersion,
          displayName: input.displayName,
          deviceRef: input.deviceRef,
        },
      )) as { device: { id: string }; deviceToken: string };
      const claims = decodeJwtPayloadUnsafe(json.deviceToken);
      const tenantId = typeof claims.tenant_id === 'string' ? claims.tenant_id : '';
      return { deviceId: json.device.id, tenantId, deviceToken: json.deviceToken };
    },
    async heartbeat(deviceToken, agentVersion) {
      await postJson(`${controlPlaneUrl}/gateway/heartbeat`, { 'x-gateway-device-token': deviceToken }, { agentVersion });
    },
    async refreshSession(deviceToken, sessionToken) {
      return (await postJson(
        `${controlPlaneUrl}/gateway/session/refresh`,
        { 'x-gateway-device-token': deviceToken },
        { sessionToken },
      )) as { sessionToken: string; expiresAt: string };
    },
    async deenroll(deviceToken) {
      await postJson(`${controlPlaneUrl}/gateway/deenroll`, { 'x-gateway-device-token': deviceToken }, {});
    },
    async redeemPairing(deviceToken, input) {
      return (await postJson(
        `${controlPlaneUrl}/gateway/pair/redeem`,
        { 'x-gateway-device-token': deviceToken },
        input,
      )) as { sessionToken: string; expiresAt: string };
    },
    async redeemStoragePairing(deviceToken, input) {
      return (await postJson(
        `${controlPlaneUrl}/storage/gateway/pair/redeem`,
        { 'x-gateway-device-token': deviceToken },
        input,
      )) as { sessionToken: string; expiresAt: string };
    },
  };
}

// --- orchestration -----------------------------------------------------------

export interface EnsureEnrolledOptions {
  stateDir: string;
  client: GatewayControlPlaneClient;
  enrollmentCode: string | null;
  platform: GatewayAgentPlatform;
  agentVersion: string;
  displayName: string;
  log: (line: string) => void;
}

/**
 * Loads a persisted credential if one exists; otherwise redeems the supplied
 * one-time enrollment code exactly once and persists the result. Never asks
 * for a code on a run where a credential already exists.
 */
export async function ensureEnrolled(options: EnsureEnrolledOptions): Promise<PersistedCredential> {
  const existing = loadPersistedCredential(options.stateDir);
  if (existing) {
    options.log(`Using persisted Gateway credential (device ${existing.deviceId}).`);
    return existing;
  }

  if (!options.enrollmentCode) {
    throw new EnrollmentRequiredError();
  }

  options.log('No persisted credential found — enrolling with the supplied one-time code...');

  // A real keypair is generated so the enrollment DTO receives a genuine PEM
  // public key (its validation requires one) — the private half is discarded
  // immediately. Nothing in the current protocol verifies a signature made
  // with it (see shared/src/gateway.ts §3: "the actual key generation,
  // storage and proof happen in a later phase"); persisting an unused private
  // key here would be exactly the kind of unused infrastructure this project
  // avoids building ahead of need.
  const { publicKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const result = await options.client.enroll({
    enrollmentCode: options.enrollmentCode,
    publicKey,
    platform: options.platform,
    agentVersion: options.agentVersion,
    displayName: options.displayName,
    deviceRef: randomUUID(),
  });

  const credential: PersistedCredential = {
    tenantId: result.tenantId,
    deviceId: result.deviceId,
    deviceToken: result.deviceToken,
    enrolledAt: new Date().toISOString(),
  };
  savePersistedCredential(options.stateDir, credential);
  options.log(`Enrolled and persisted Gateway credential (device ${credential.deviceId}).`);
  return credential;
}

/**
 * Runs heartbeat on an interval. Returns a stop function. A transient failure
 * is logged, never thrown out of the interval — a network blip must not crash
 * the process. `onAuthFailure` fires only for a definitive rejection (401/403
 * — the token itself is no longer accepted, e.g. revoked centrally), so the
 * caller can decide whether to clear the local credential.
 */
export function startHeartbeat(
  client: GatewayControlPlaneClient,
  credential: PersistedCredential,
  agentVersion: string,
  intervalSeconds: number,
  log: (line: string) => void,
  onAuthFailure: () => void,
): () => void {
  const timer = setInterval(() => {
    client.heartbeat(credential.deviceToken, agentVersion).catch((err: unknown) => {
      if (err instanceof ControlPlaneHttpError && (err.status === 401 || err.status === 403)) {
        log('Gateway heartbeat rejected — this device credential is no longer valid (revoked or expired).');
        onAuthFailure();
        return;
      }
      log(`Gateway heartbeat failed (will retry): ${err instanceof Error ? err.message : String(err)}`);
    });
  }, intervalSeconds * 1000);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * De-enrolls with the backend, then removes the local credential. The local
 * clear happens even if the backend call fails — a clean local uninstall must
 * not be blocked by connectivity — but the caller is told so it can advise
 * revoking the device centrally instead (item 8/9: re-enrollment afterward
 * still requires a new code either way, since this device's local credential
 * is gone regardless of which half succeeded).
 */
export async function deenroll(
  client: GatewayControlPlaneClient,
  credential: PersistedCredential,
  stateDir: string,
): Promise<{ backendNotified: boolean }> {
  let backendNotified = false;
  try {
    await client.deenroll(credential.deviceToken);
    backendNotified = true;
  } catch {
    // Swallowed deliberately: a clean local uninstall must not be blocked by
    // connectivity. clearPersistedCredential still runs below either way.
  }
  clearPersistedCredential(stateDir);
  return { backendNotified };
}
