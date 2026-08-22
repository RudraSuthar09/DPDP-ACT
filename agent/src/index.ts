/**
 * Local Agent entrypoint. A SEPARATE process from the DPDP backend — it is not
 * a Nest module and shares no runtime with the API.
 *
 * It loads network config from the environment, enrolls with the central DPDP
 * control plane (or reuses a previously-persisted credential — see
 * enrollment.ts), starts the localhost HTTP server, and reports how it is
 * exposed. If the bind host is non-loopback it prints a prominent warning —
 * the agent is never silently exposed to a network interface.
 *
 * Run:  node dist/index.js             (normal start)
 *       node dist/index.js --deenroll  (de-enroll and clear the local credential)
 *
 * See agent/README.md and installer README for GATEWAY_ENROLLMENT_CODE.
 */
import { loadAgentConfig, AgentConfigError, type AgentConfig } from './config';
import { createAgentServer } from './server';
import { AGENT_VERSION, PROTOCOL_VERSION } from './version';
import { ConnectorRegistry, loadSourceConfig } from './connectors/registry';
import { SessionStore } from './session-store';
import { DataPlane } from './data-plane';
import { StorageRegistry, loadStorageRootConfig } from './storage/registry';
import { StorageSessionStore } from './storage/storage-session-store';
import { StoragePlane } from './storage/storage-plane';
import {
  ensureEnrolled,
  startHeartbeat,
  deenroll,
  clearPersistedCredential,
  loadPersistedCredential,
  createControlPlaneClient,
  EnrollmentRequiredError,
  type PersistedCredential,
} from './enrollment';

function log(line: string): void {
  console.log(`[agent] ${line}`);
}

async function runDeenroll(config: AgentConfig): Promise<void> {
  if (!config.controlPlaneUrl) {
    console.error('[agent] --deenroll requires GATEWAY_CONTROL_PLANE_URL to be set.');
    process.exit(1);
  }
  const existing = loadPersistedCredential(config.stateDir);
  if (!existing) {
    log('No persisted Gateway credential found — nothing to de-enroll.');
    return;
  }
  const client = createControlPlaneClient(config.controlPlaneUrl);
  const { backendNotified } = await deenroll(client, existing, config.stateDir);
  if (backendNotified) {
    log('De-enrolled: the backend has removed this device, and the local credential was cleared.');
  } else {
    log(
      'Could not reach the backend to de-enroll (the local credential was cleared anyway). ' +
        'If this device should stop being trusted, revoke it from DPDP’s Data Sources page.',
    );
  }
  log('Re-enrollment will require a brand-new enrollment code.');
}

/**
 * Enroll (or reuse a persisted credential) before wiring the data plane. Never
 * fatal on its own: a Gateway with sources configured but not yet enrolled
 * still starts as a health-only listener, exactly like one with no sources
 * configured at all — an operator can supply GATEWAY_ENROLLMENT_CODE and
 * restart once they have a code, without the process crash-looping meanwhile.
 */
async function tryEnroll(config: AgentConfig): Promise<PersistedCredential | null> {
  if (!config.controlPlaneUrl) {
    log('GATEWAY_CONTROL_PLANE_URL is not set — enrollment/heartbeat/pairing are unavailable.');
    return null;
  }
  const client = createControlPlaneClient(config.controlPlaneUrl);
  try {
    return await ensureEnrolled({
      stateDir: config.stateDir,
      client,
      enrollmentCode: config.enrollmentCode,
      platform: config.platform,
      agentVersion: AGENT_VERSION,
      displayName: config.displayName,
      log,
    });
  } catch (err) {
    if (err instanceof EnrollmentRequiredError) {
      log(err.message);
    } else {
      log(`Gateway enrollment failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return null;
  }
}

async function main(): Promise<void> {
  let config: AgentConfig;
  try {
    config = loadAgentConfig();
  } catch (err) {
    // Sanitized: print only the (secret-free) message, then exit non-zero.
    const message = err instanceof AgentConfigError ? err.message : 'Invalid agent configuration.';
    console.error(`[agent] configuration error: ${message}`);
    process.exit(1);
    return;
  }

  if (process.argv.includes('--deenroll')) {
    await runDeenroll(config);
    process.exit(0);
    return;
  }

  const credential = await tryEnroll(config);

  // Heartbeat starts as soon as we have a credential — independent of whether
  // any data sources are configured yet. A freshly-enrolled Gateway with zero
  // sources must still show as "Connected" (last_heartbeat_at advancing) in
  // DPDP; heartbeat must never be gated on GATEWAY_SOURCES being non-empty.
  let stopHeartbeat: (() => void) | undefined;
  let heartbeatClient: ReturnType<typeof createControlPlaneClient> | undefined;
  if (credential && config.controlPlaneUrl) {
    heartbeatClient = createControlPlaneClient(config.controlPlaneUrl);
    stopHeartbeat = startHeartbeat(heartbeatClient, credential, AGENT_VERSION, config.heartbeatIntervalSeconds, log, () => {
      // The backend has definitively rejected this credential (revoked or
      // expired) — clear it locally too, so the NEXT restart correctly asks
      // for a fresh enrollment code instead of retrying a dead one forever.
      clearPersistedCredential(config.stateDir);
    });
  }

  // Wire the data plane if any sources are configured AND enrollment gave us a
  // real device credential — pairing redemption needs both. With no sources,
  // or no credential yet, the agent is the health-only listener (heartbeat,
  // if enrolled, still runs regardless — see above).
  let dataPlane: DataPlane | undefined;
  try {
    const sources = loadSourceConfig();
    if (sources.length > 0 && credential && config.controlPlaneUrl) {
      const client = heartbeatClient ?? createControlPlaneClient(config.controlPlaneUrl);
      dataPlane = new DataPlane(
        new ConnectorRegistry(sources),
        new SessionStore(),
        { tenantId: credential.tenantId, deviceId: credential.deviceId },
        { redeemPairing: (input) => client.redeemPairing(credential.deviceToken, input) },
      );
    } else if (sources.length > 0 && !credential) {
      log('Data sources are configured but this Gateway is not yet enrolled — pairing will fail until it is.');
    }
  } catch (err) {
    console.error(`[agent] data-plane configuration error: ${err instanceof Error ? err.message : 'invalid'}`);
    process.exit(1);
    return;
  }

  // Wire the storage plane if any storage roots are configured AND enrollment
  // gave us a real device credential — same gating logic as the data plane,
  // applied to a separate config/registry/session-store/plane instance.
  let storagePlane: StoragePlane | undefined;
  try {
    const storageRoots = loadStorageRootConfig();
    if (storageRoots.length > 0 && credential && config.controlPlaneUrl) {
      const client = heartbeatClient ?? createControlPlaneClient(config.controlPlaneUrl);
      storagePlane = new StoragePlane(
        new StorageRegistry(storageRoots),
        new StorageSessionStore(),
        { tenantId: credential.tenantId, deviceId: credential.deviceId },
        { redeemStoragePairing: (input) => client.redeemStoragePairing(credential.deviceToken, input) },
      );
    } else if (storageRoots.length > 0 && !credential) {
      log('Storage roots are configured but this Gateway is not yet enrolled — pairing will fail until it is.');
    }
  } catch (err) {
    console.error(`[agent] storage-plane configuration error: ${err instanceof Error ? err.message : 'invalid'}`);
    process.exit(1);
    return;
  }

  const server = createAgentServer(config, { dataPlane, storagePlane, log });

  server.listen(config.bindPort, config.bindHost, () => {
    console.log(
      `[agent] DPDP Local Agent v${AGENT_VERSION} (protocol ${PROTOCOL_VERSION}) ` +
        `listening on http://${config.bindHost}:${config.bindPort}`,
    );
    console.log(`[agent] network mode: ${config.networkMode}`);
    console.log(`[agent] allowed origins configured: ${config.allowedOrigins.length}`);
    console.log(`[agent] control-plane configured: ${config.controlPlaneUrl ? 'yes' : 'no'}`);
    console.log(`[agent] Gateway enrolled: ${credential ? `yes (device ${credential.deviceId})` : 'no'}`);
    if (config.networkMode === 'non-loopback') {
      console.warn(
        '[agent] ============================================================\n' +
          '[agent]  WARNING: NON-LOOPBACK BIND. The agent is reachable over the\n' +
          '[agent]  network, not just this machine. Ensure firewall / network\n' +
          '[agent]  controls restrict access to trusted devices only. TLS is a\n' +
          '[agent]  later hardening phase; do not expose this beyond a trusted LAN.\n' +
          '[agent] ============================================================',
      );
    }
  });

  const shutdown = (): void => {
    stopHeartbeat?.();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(`[agent] fatal startup error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
