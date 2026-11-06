/**
 * Local Agent entrypoint. A SEPARATE process from the DPDP backend — it is not
 * a Nest module and shares no runtime with the API.
 *
 * Startup order (each step under the service's own Windows identity):
 *   1. resolve config, take the single-instance lock;
 *   2. honour a pending "Remove Gateway" request (startup-tasks.ts);
 *   3. enrol, or reuse the persisted credential;
 *   4. apply queued sources, migrate legacy plaintext sources, load sources;
 *   5. start heartbeat, delivery poller, data/storage planes, HTTP listener.
 *
 * Run:  node dist/index.js             (normal start)
 *       node dist/index.js --deenroll  (de-enrol and clear the local credential;
 *                                        dev/Docker only — the installed Windows
 *                                        service is de-enrolled via
 *                                        pending-deenroll.json instead, because
 *                                        only the service can decrypt its
 *                                        credential)
 */
import path from 'node:path';
import { AgentConfigError, type AgentConfig } from './config';
import { resolveAgentConfig } from './config-resolve';
import { createLogger, type Logger } from './logger';
import { withRetry } from './retry';
import { createAgentServer } from './server';
import { type GatewayStatusSummary } from './health';
import { AGENT_VERSION, PROTOCOL_VERSION } from './version';
import { ConnectorRegistry, canRead } from './connectors/registry';
import { SessionStore } from './session-store';
import { DataPlane } from './data-plane';
import { StorageRegistry, loadStorageRootConfig, mergeStorageRoots, storageRootsFromSources, type GatewayStorageRootConfig } from './storage/registry';import { StorageSessionStore } from './storage/storage-session-store';
import { StoragePlane } from './storage/storage-plane';
import { startDeliveryPoller } from './delivery/poller';
import { loadDeliveryConfig, type DeliveryConfig } from './delivery/delivery-config';
import { acquireSingleInstanceLock, SingleInstanceError, type SingleInstanceLock } from './single-instance';
import { createDpapiCredentialStore } from './credential-store-windows';
import { readPendingEnrollment, clearPendingEnrollment } from './pending-enrollment';
import { dpapiSelfTest, isDpapiPlatform } from './dpapi';
import { createDpapiSecretProtector, SOURCES_FILE_NAME, type SecretProtector } from './sources-file';
import { RevokedFolders } from './revoked-folders';
import {
  classifyEnrollmentFailure,
  isRetryableEnrollmentError,
  applyFolderRevocations,
  applyPendingAuthorizations,
  prepareSources,
  processDeenrollRequest,
  type EnrollmentErrorCode,
} from './startup-tasks';
import {
  ensureEnrolled,
  startHeartbeat,
  deenroll,
  createFileCredentialStore,
  createControlPlaneClient,
  EnrollmentRequiredError,
  type CredentialStore,
  type GatewayControlPlaneClient,
  type PersistedCredential,
  type HeartbeatHandle,
} from './enrollment';
import { resolveProxySettings, type FileProxyConfig, type ProxyCredentials } from './network-config';
import { loadProxyCredentials, ProxyCredentialsError, type ProxyCredentialsErrorCode } from './proxy-credentials';
import { buildTrustedCaList, summarizeTlsTrust, type TlsTrustSettings } from './tls-trust';
import { createTransport, type Transport } from './transport';
import { resolveSourceTls } from './source-tls';
import { localListenerEndpoint, sanitizeDashboardOrigins } from './dashboard-link';

/** Process exit code when the local listener cannot bind (port in use by
 *  another program or account). Distinct from 1 (configuration/other). */
const EXIT_LOCAL_PORT_UNAVAILABLE = 3;

/** The one place that decides how secrets are stored: DPAPI on Windows,
 *  plain files elsewhere (development/CI/Docker only). */
function resolveSecretStorage(stateDir: string): { credentialStore: CredentialStore; protector: SecretProtector | null } {
  if (isDpapiPlatform()) {
    return { credentialStore: createDpapiCredentialStore(stateDir), protector: createDpapiSecretProtector() };
  }
  return { credentialStore: createFileCredentialStore(stateDir), protector: null };
}

/**
 * Builds the ONE outbound transport every control-plane call uses (proxy and
 * CA trust; see transport.ts). Throws AgentConfigError for an invalid proxy
 * setting. Unusable proxy credentials are reported, not fatal: requests then
 * fail at the proxy (407) and are never sent around it.
 */
function setUpTransport(
  fileProxy: FileProxyConfig | undefined,
  tlsTrust: TlsTrustSettings,
  stateDir: string,
  protector: SecretProtector | null,
  logger: Logger,
): { transport: Transport; proxyCredentialsError: ProxyCredentialsErrorCode | null } {
  let credentials: ProxyCredentials | null = null;
  let proxyCredentialsError: ProxyCredentialsErrorCode | null = null;
  try {
    const loaded = loadProxyCredentials(stateDir, protector);
    credentials = loaded.credentials;
    if (loaded.migrated) logger.info('proxy-credentials.json was converted to the DPAPI-protected format.');
    if (credentials && !protector) {
      logger.warn('proxy-credentials.json is a plain file: no OS credential protection on this platform (development only).');
    }
  } catch (err) {
    if (!(err instanceof ProxyCredentialsError)) throw err;
    proxyCredentialsError = err.code;
    logger.error(err.message);
  }

  const proxy = resolveProxySettings(fileProxy, process.env, credentials);
  proxy.warnings.forEach((w) => logger.warn(w));
  const transport = createTransport({ proxy, ca: buildTrustedCaList(tlsTrust) });

  const s = transport.summary;
  const trust = summarizeTlsTrust(tlsTrust, process.env);
  logger.info(
    `outbound proxy: ${s.proxy === 'none' ? 'none (direct)' : `from ${s.proxy === 'config' ? 'config.json' : 'environment'}`}` +
      `${s.proxyAuthentication ? ', with Basic authentication' : ''}; NO_PROXY rules: ${s.noProxyRules}; loopback always direct`,
  );
  logger.info(
    `TLS trust: Node.js bundled CAs${trust.nodeExtraCaCerts ? ' + NODE_EXTRA_CA_CERTS' : ''}` +
      `${trust.windowsCertificateStore ? ' + Windows certificate store' : ''}` +
      `${trust.extraCaCertificates ? ` + ${trust.extraCaCertificates} CA certificate(s) from tls.extraCaCertsFile` : ''}; verification always on`,
  );
  return { transport, proxyCredentialsError };
}

async function runDeenroll(config: AgentConfig, logger: Logger, credentialStore: CredentialStore, transport: Transport): Promise<void> {
  if (!config.controlPlaneUrl) {
    logger.error('--deenroll requires GATEWAY_CONTROL_PLANE_URL to be set.');
    process.exit(1);
  }
  const existing = credentialStore.load();
  if (!existing) {
    logger.info('No persisted Gateway credential found — nothing to de-enroll.');
    return;
  }
  const client = createControlPlaneClient(config.controlPlaneUrl, transport);
  const { backendNotified } = await deenroll(client, existing, config.stateDir, credentialStore);
  if (backendNotified) {
    logger.info('De-enrolled: the backend has removed this device, and the local credential was cleared.');
  } else {
    logger.warn(
      'Could not reach the backend to de-enroll (the local credential was cleared anyway). ' +
        'If this device should stop being trusted, revoke it from DPDP’s Data Sources page.',
    );
  }
  logger.info('Re-enrollment will require a brand-new enrollment code.');
}

/**
 * Enrol (or reuse a persisted credential). Never fatal: on failure the agent
 * still starts as a health-only listener and reports a stable error code.
 *
 * The enrolment code comes from pending-enrollment.json (the Gateway Setup
 * wizard's hand-off) in preference to GATEWAY_ENROLLMENT_CODE. The pending
 * file is cleared on success AND on a definitive rejection (the code is
 * single-use and spent or invalid; retrying it on every restart cannot
 * succeed), but kept on a transient failure so the next start retries it.
 */
async function tryEnroll(
  config: AgentConfig,
  logger: Logger,
  credentialStore: CredentialStore,
  client: GatewayControlPlaneClient | null,
): Promise<{ credential: PersistedCredential | null; error: EnrollmentErrorCode | null }> {
  if (!config.controlPlaneUrl || !client) {
    logger.info('GATEWAY_CONTROL_PLANE_URL is not set — enrollment/heartbeat/pairing are unavailable.');
    return { credential: null, error: null };
  }

  let pending: ReturnType<typeof readPendingEnrollment> = null;
  try {
    pending = readPendingEnrollment(config.stateDir);
  } catch (err) {
    logger.warn(`Ignoring an unreadable pending-enrollment file: ${err instanceof Error ? err.message : String(err)}`);
    clearPendingEnrollment(config.stateDir);
  }

  try {
    const credential = await withRetry(
      () =>
        ensureEnrolled({
          stateDir: config.stateDir,
          client,
          enrollmentCode: pending?.enrollmentCode ?? config.enrollmentCode,
          platform: config.platform,
          agentVersion: AGENT_VERSION,
          displayName: pending?.displayName ?? config.displayName,
          log: logger.info,
          credentialStore,
        }),
      {
        maxAttempts: 5,
        baseDelayMs: 2_000,
        maxDelayMs: 60_000,
        isRetryable: isRetryableEnrollmentError,
        onRetry: (attempt, err, delayMs) => {
          logger.warn(
            `Gateway enrollment attempt ${attempt} failed (${err instanceof Error ? err.message : String(err)}) — retrying in ${Math.round(delayMs / 1000)}s.`,
          );
        },
      },
    );
    if (pending) clearPendingEnrollment(config.stateDir);
    return { credential, error: null };
  } catch (err) {
    const code = classifyEnrollmentFailure(err);
    if (err instanceof EnrollmentRequiredError) {
      logger.info(err.message);
    } else if (code === 'CREDENTIAL_UNREADABLE') {
      logger.error(
        `The saved device credential could not be read (${err instanceof Error ? err.message : 'unknown error'}). ` +
          'Use Gateway Setup -> Remove Gateway, then pair again with a new code.',
      );
    } else {
      logger.error(`Gateway enrollment failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (code === 'CODE_REJECTED' && pending) {
      logger.warn('The enrolment code was rejected and has been discarded. Generate a new code in the DPDP dashboard.');
      clearPendingEnrollment(config.stateDir);
    }
    return { credential: null, error: code };
  }
}

async function main(): Promise<void> {
  let config: AgentConfig;
  let deliveryConfig: DeliveryConfig;
  let configFilePath: string;
  let fileLogLevel: ReturnType<typeof resolveAgentConfig>['logLevel'];
  let fileProxy: FileProxyConfig | undefined;
  let tlsTrust: TlsTrustSettings;
  try {
    const resolved = resolveAgentConfig();
    config = resolved.config;
    configFilePath = resolved.configFilePath;
    fileLogLevel = resolved.logLevel;
    fileProxy = resolved.fileConfig?.proxy;
    tlsTrust = resolved.tlsTrust;
    deliveryConfig = loadDeliveryConfig();
  } catch (err) {
    // Sanitized: print only the (secret-free) message, then exit non-zero.
    const message = err instanceof AgentConfigError ? err.message : 'Invalid agent configuration.';
    console.error(`[agent] configuration error: ${message}`);
    process.exit(1);
    return;
  }

  const logger = createLogger(fileLogLevel ?? 'info');
  const log = (line: string): void => logger.info(line);
  logger.debug(`Config file: ${configFilePath} (merged under explicit env vars; env always wins).`);
  logger.debug(`State dir: ${config.stateDir}`);

  const { credentialStore, protector } = resolveSecretStorage(config.stateDir);

  let transport: Transport;
  let proxyCredentialsError: ProxyCredentialsErrorCode | null;
  try {
    ({ transport, proxyCredentialsError } = setUpTransport(fileProxy, tlsTrust, config.stateDir, protector, logger));
  } catch (err) {
    logger.error(`configuration error: ${err instanceof AgentConfigError ? err.message : 'invalid outbound network configuration.'}`);
    process.exit(1);
    return;
  }
  const client = config.controlPlaneUrl ? createControlPlaneClient(config.controlPlaneUrl, transport) : null;

  if (process.argv.includes('--deenroll')) {
    await runDeenroll(config, logger, credentialStore, transport);
    process.exit(0);
    return;
  }

  let instanceLock: SingleInstanceLock;
  try {
    instanceLock = acquireSingleInstanceLock(config.stateDir);
  } catch (err) {
    if (err instanceof SingleInstanceError) {
      logger.error(err.message);
    } else {
      logger.error(`Could not acquire the Gateway single-instance lock: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(1);
    return;
  }

  let credentialProtection: GatewayStatusSummary['credentialProtection'] = 'none';
  if (protector) {
    credentialProtection = dpapiSelfTest() ? 'dpapi' : 'unavailable';
    if (credentialProtection === 'unavailable') {
      logger.error(
        'Windows DPAPI is not usable under this service account, so device and source credentials cannot be stored or read. ' +
          'Check that the service runs as NT SERVICE\\DPDPGatewayAgent and that its profile exists.',
      );
    }
  } else {
    logger.warn('No OS credential protection on this platform: device and source credentials are stored as plain files (development only).');
  }

  await processDeenrollRequest({
    stateDir: config.stateDir,
    credentialStore,
    client,
    log,
  });

  const enrollment = await tryEnroll(config, logger, credentialStore, client);
  const credential = enrollment.credential;
  let enrollmentError: EnrollmentErrorCode | null = enrollment.error;

  // Heartbeat and the delivery poller start as soon as there is a credential,
  // independent of any data sources. A definitive rejection (revoked/expired)
  // stops BOTH, clears the dead credential, and is reported as
  // CREDENTIAL_REVOKED — no further calls are made with that token.
  let heartbeatHandle: HeartbeatHandle | undefined;
  let stopDeliveryPoller: (() => void) | undefined;
  // Folders removed in DPDP. Both registries below consult this on every
  // lookup, so a removal takes effect in this running process rather than at
  // the next restart. It only ever grows, and only with ids DPDP itself
  // reported as revoked.
  const revokedFolders = new RevokedFolders();
  const sourcesFilePath = path.join(config.stateDir, SOURCES_FILE_NAME);
  /** Fetches the removals DPDP has recorded and applies them BOTH in memory
   *  (effective immediately) and in sources.json (so they survive a restart).
   *  Safe to call repeatedly; a failure changes nothing. */
  const syncRevokedFolders = async (): Promise<void> => {
    if (!credential || !client) return;
    const before = revokedFolders.size;
    try {
      const revoked = await client.listFolderRevocations(credential.deviceToken);
      revokedFolders.add(...revoked.revokedSourceIds, ...revoked.revokedStorageRootIds);
    } catch {
      // Logged by applyFolderRevocations below; nothing to undo here.
    }
    await applyFolderRevocations({
      sourcesFilePath,
      protector,
      client,
      deviceToken: credential.deviceToken,
      log,
    });
    if (revokedFolders.size > before) {
      logger.info(`${revokedFolders.size - before} folder(s) removed in DPDP are no longer served by this Gateway.`);
    }
  };
  // Dashboard origins learned from the authenticated heartbeat (dashboard-link.ts);
  // the local listener accepts them in addition to config.allowedOrigins.
  let dashboardOrigins: readonly string[] = [];
  if (credential && client) {
    heartbeatHandle = startHeartbeat(
      client,
      credential,
      AGENT_VERSION,
      config.heartbeatIntervalSeconds,
      log,
      () => {
        stopDeliveryPoller?.();
        stopDeliveryPoller = undefined;
        credentialStore.clear();
        enrollmentError = 'CREDENTIAL_REVOKED';
        dashboardOrigins = [];
      },
      {
        localEndpoint: localListenerEndpoint(config),
        // Every successful check-in is also when removals are picked up —
        // which is what makes a removal recorded while this Gateway was
        // offline apply by itself on reconnect.
        onCheckIn: () => {
          void syncRevokedFolders();
        },
        onDashboardOrigins: (raw) => {
          const next = sanitizeDashboardOrigins(raw);
          if (next.join(' ') !== dashboardOrigins.join(' ')) {
            logger.info(`DPDP dashboard origins accepted by the local listener: ${next.length}`);
          }
          dashboardOrigins = next;
        },
      },
    );
  }

  // Folders an administrator approved in Gateway Setup: exchange each one for
  // its DPDP record ids BEFORE the sources are loaded, so a folder approved a
  // moment ago is already serving when this start finishes. Nobody copies an
  // id by hand; the local path never leaves this computer.
  let pendingFolderAuthorizations = 0;
  if (!process.env.GATEWAY_SOURCES?.trim()) {
    const authResult = await applyPendingAuthorizations({
      stateDir: config.stateDir,
      sourcesFilePath,
      protector,
      client,
      deviceToken: credential?.deviceToken ?? null,
      log,
    });
    pendingFolderAuthorizations = authResult.pending;
    if (authResult.applied > 0) logger.info(`Registered ${authResult.applied} authorized folder(s) with DPDP.`);
    // ...and in the other direction, BEFORE the registries are built, so a
    // folder removed while this Gateway was off is never served even once.
    await syncRevokedFolders();
  }

  // Sources: queued changes, legacy migration, then load (see startup-tasks.ts).
  // An invalid GATEWAY_SOURCES env var is still a fatal configuration error.
  let sourcesError: GatewayStatusSummary['sourcesError'] = null;
  let dataPlane: DataPlane | undefined;
  let sourceKinds: Record<string, number> = {};
  let sourcesConfigured = 0;
  // Manage-sources entries whose folder the administrator explicitly allowed
  // DPDP to WRITE to (access 'write'/'both'); they feed the storage plane below.
  let writeGrants: GatewayStorageRootConfig[] = [];
  try {
    const prepared = prepareSources({ stateDir: config.stateDir, sourcesFilePath, env: process.env, protector, log });
    sourcesError = prepared.error;
    // Read and write are separate grants: only readable entries are data
    // sources (counted, listed, and served by the data plane).
    const readable = prepared.sources.filter(canRead);
    writeGrants = storageRootsFromSources(prepared.sources);
    sourcesConfigured = readable.length;
    sourceKinds = readable.reduce<Record<string, number>>((acc, s) => ({ ...acc, [s.kind]: (acc[s.kind] ?? 0) + 1 }), {});
    // Database TLS trust (PostgreSQL sslCaFile): a source whose CA cannot be
    // loaded is left out rather than connected without it.
    const tlsResolved = resolveSourceTls(readable, configFilePath);
    tlsResolved.messages.forEach((m) => logger.error(m));
    if (tlsResolved.rejected > 0 && !sourcesError) sourcesError = 'TLS_CA_INVALID';
    const sources = tlsResolved.sources;
    if (sources.length > 0 && credential && client) {
      dataPlane = new DataPlane(
        new ConnectorRegistry(sources, undefined, revokedFolders),
        new SessionStore(),
        { tenantId: credential.tenantId, deviceId: credential.deviceId },
        { redeemPairing: (input) => client.redeemPairing(credential.deviceToken, input) },
      );
      logger.info(`Data plane active: ${sources.length} source(s) configured.`);
    } else if (sources.length > 0 && !credential) {
      logger.warn('Data sources are configured but this Gateway is not yet enrolled — pairing will fail until it is.');
    }
  } catch (err) {
    logger.error(`data-plane configuration error: ${err instanceof Error ? err.message : 'invalid'}`);
    process.exit(1);
    return;
  }

  // Storage plane: same gating as the data plane, separate config/registry.
  // Its roots = GATEWAY_STORAGE_ROOTS (unchanged) + the explicit write grants
  // from Manage sources. The SAME registry is the only way the delivery
  // poller below can reach a folder to write, so write authorization is
  // enforced in this process for both paths.
  let storagePlane: StoragePlane | undefined;
  let storageRegistry: StorageRegistry | undefined;
  let storageRootsConfiguredCount = 0;
  try {
    const merged = mergeStorageRoots(loadStorageRootConfig(), writeGrants);
    for (const id of merged.conflicts) {
      logger.error(`Storage location ${id} is authorized for two different folders; only the GATEWAY_STORAGE_ROOTS folder is used.`);
    }
    const storageRoots = merged.roots;
    storageRootsConfiguredCount = storageRoots.length;
    if (storageRoots.length > 0 && credential && client) {
      storageRegistry = new StorageRegistry(storageRoots, revokedFolders);
      storagePlane = new StoragePlane(
        storageRegistry,
        new StorageSessionStore(),
        { tenantId: credential.tenantId, deviceId: credential.deviceId },
        { redeemStoragePairing: (input) => client.redeemStoragePairing(credential.deviceToken, input) },
      );
    } else if (storageRoots.length > 0 && !credential) {
      logger.warn('Storage roots are configured but this Gateway is not yet enrolled — pairing will fail until it is.');
    }
  } catch (err) {
    logger.error(`storage-plane configuration error: ${err instanceof Error ? err.message : 'invalid'}`);
    process.exit(1);
    return;
  }

  // Started after the storage plane, so it knows which write-authorized
  // storage locations this Gateway can deliver Enterprise copies into.
  if (credential && client) {
    stopDeliveryPoller = startDeliveryPoller({
      client,
      deviceToken: credential.deviceToken,
      pollIntervalSeconds: deliveryConfig.pollIntervalSeconds,
      storageRegistry,
      log,
    });
  }

  // Live local status, served only to non-browser loopback callers (see
  // server.ts). Read fresh on every request.
  const getGatewayStatus = (): GatewayStatusSummary => ({
    enrolled: credential !== null && enrollmentError !== 'CREDENTIAL_REVOKED',
    deviceId: credential?.deviceId ?? null,
    heartbeat: !config.controlPlaneUrl ? 'disabled' : heartbeatHandle?.getState() ?? null,
    lastHeartbeatAt: heartbeatHandle?.getLastSuccessAt() ?? null,
    sourcesConfigured,
    storageRootsConfigured: storageRootsConfiguredCount,
    pendingFolderAuthorizations,
    sourceKinds,
    enrollmentError,
    sourcesError,
    credentialProtection,
    network: {
      ...transport.summary,
      tlsTrust: summarizeTlsTrust(tlsTrust, process.env),
      proxyCredentialsError,
      lastErrorCode: heartbeatHandle?.getLastErrorCode() ?? null,
    },
  });

  const server = createAgentServer(config, { dataPlane, storagePlane, log, getGatewayStatus, getDashboardOrigins: () => dashboardOrigins });

  // Without this handler a busy port crashed the process with an unexplained
  // exit code 1 (Phase 6: the full-stack Docker "agent" container publishes
  // 0.0.0.0:7071 as the desktop user, and Windows refuses another ACCOUNT --
  // the service's -- a bind to 127.0.0.1:7071 with EACCES). Exit with a
  // distinct code (recorded by WinSW in the Windows Application event log,
  // readable without admin) and say what to do. The service's recovery
  // settings restart it, so it comes up by itself once the port is free.
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
      logger.error(
        `Cannot open the local Gateway port ${config.bindHost}:${config.bindPort} (${err.code}): another program is already using port ${config.bindPort}` +
          ' (for example the DPDP Docker "agent" container, which publishes the same port). Only one DPDP Gateway can run on a computer:' +
          ` stop the other program, or set "bindPort" in config.json. Exiting with code ${EXIT_LOCAL_PORT_UNAVAILABLE}; the service restarts automatically.`,
      );
    } else {
      logger.error(`Cannot open the local Gateway port ${config.bindHost}:${config.bindPort} (${err.code ?? 'error'}).`);
    }
    heartbeatHandle?.();
    stopDeliveryPoller?.();
    instanceLock.release();
    void transport.close();
    process.exit(EXIT_LOCAL_PORT_UNAVAILABLE);
  });

  server.listen(config.bindPort, config.bindHost, () => {
    logger.info(
      `DPDP Local Agent v${AGENT_VERSION} (protocol ${PROTOCOL_VERSION}) listening on http://${config.bindHost}:${config.bindPort}`,
    );
    logger.info(`network mode: ${config.networkMode}`);
    logger.info(`allowed origins configured: ${config.allowedOrigins.length}`);
    logger.info(`control-plane configured: ${config.controlPlaneUrl ? 'yes' : 'no'}`);
    logger.info(`Gateway enrolled: ${credential ? `yes (device ${credential.deviceId})` : 'no'}`);
    logger.info(
      `submission delivery: ${stopDeliveryPoller ? `polling every ${deliveryConfig.pollIntervalSeconds}s` : 'not started (no device credential)'}`,
    );
    if (config.networkMode === 'non-loopback') {
      logger.warn(
        '============================================================\n' +
          ' WARNING: NON-LOOPBACK BIND. The agent is reachable over the\n' +
          ' network, not just this machine. Ensure firewall / network\n' +
          ' controls restrict access to trusted devices only. The\n' +
          ' listener is plain HTTP; do not expose it beyond a trusted LAN.\n' +
          '============================================================',
      );
    }
  });

  const shutdown = (): void => {
    heartbeatHandle?.();
    stopDeliveryPoller?.();
    instanceLock.release();
    void transport.close();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(`[agent] fatal startup error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
