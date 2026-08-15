/**
 * Local Agent entrypoint (Phase 3B skeleton). A SEPARATE process from the DPDP
 * backend — it is not a Nest module and shares no runtime with the API.
 *
 * It loads network config from the environment, starts the localhost HTTP server,
 * and reports how it is exposed. If the bind host is non-loopback it prints a
 * prominent warning — the agent is never silently exposed to a network interface.
 *
 * Run:  node dist/index.js   (see agent/README.md)
 */
import { loadAgentConfig, AgentConfigError } from './config';
import { createAgentServer } from './server';
import { AGENT_VERSION, PROTOCOL_VERSION } from './version';
import { ConnectorRegistry, loadSourceConfig } from './connectors/registry';
import { SessionStore } from './session-store';
import { DataPlane, httpControlPlaneClient } from './data-plane';

function main(): void {
  let config;
  try {
    config = loadAgentConfig();
  } catch (err) {
    // Sanitized: print only the (secret-free) message, then exit non-zero.
    const message = err instanceof AgentConfigError ? err.message : 'Invalid agent configuration.';
    console.error(`[agent] configuration error: ${message}`);
    process.exit(1);
    return;
  }

  // Wire the data plane if any sources are configured. Identity + control-plane
  // URL come from configuration — no hardcoded network. With no sources, the
  // agent is the Phase-3B health-only skeleton.
  let dataPlane: DataPlane | undefined;
  try {
    const sources = loadSourceConfig();
    if (sources.length > 0) {
      dataPlane = new DataPlane(
        new ConnectorRegistry(sources),
        new SessionStore(),
        { tenantId: process.env.GATEWAY_TENANT_ID ?? '', deviceId: process.env.GATEWAY_DEVICE_ID ?? '' },
        httpControlPlaneClient({
          controlPlaneUrl: config.controlPlaneUrl ?? '',
          deviceToken: process.env.GATEWAY_DEVICE_TOKEN ?? '',
        }),
      );
    }
  } catch (err) {
    console.error(`[agent] data-plane configuration error: ${err instanceof Error ? err.message : 'invalid'}`);
    process.exit(1);
    return;
  }

  const server = createAgentServer(config, {
    dataPlane,
    log: (line) => console.log(`[agent] ${line}`),
  });

  server.listen(config.bindPort, config.bindHost, () => {
    console.log(
      `[agent] DPDP Local Agent v${AGENT_VERSION} (protocol ${PROTOCOL_VERSION}) ` +
        `listening on http://${config.bindHost}:${config.bindPort}`,
    );
    console.log(`[agent] network mode: ${config.networkMode}`);
    console.log(`[agent] allowed origins configured: ${config.allowedOrigins.length}`);
    console.log(`[agent] control-plane configured: ${config.controlPlaneUrl ? 'yes' : 'no (not used in Phase 3B)'}`);
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
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
