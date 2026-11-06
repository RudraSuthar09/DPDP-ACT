// Decides whether the local status the Setup app read really comes from THIS
// computer's DPDP Gateway service. Pure (no Electron), so it is unit-tested.
//
// Phase 6: port 7071 can be answered by ANOTHER program -- on a machine that
// also runs the full-stack Docker setup, the Docker "agent" container
// publishes 0.0.0.0:7071. Windows then refuses the service (a different
// account) its own bind with EACCES, the service keeps stopping, and the old
// check showed "Gateway service running" based on the Docker container's
// reply while pairing never progressed.
'use strict';

/** Parses `sc.exe query` output/exit code into a coarse state. */
function parseServiceState(exitCode, stdout) {
  if (exitCode === 1060) return 'missing';
  if (exitCode !== 0) return 'unknown';
  const m = /STATE\s*:\s*\d+\s+([A-Z_]+)/.exec(String(stdout || ''));
  if (!m) return 'unknown';
  if (m[1] === 'RUNNING') return 'running';
  if (m[1] === 'START_PENDING') return 'starting';
  return 'stopped';
}

/**
 * Our agent answers a local, Origin-less request with its `gateway` status
 * block and reports networkMode "loopback" (the installed service never binds
 * a network interface). Anything else on the port is another program.
 */
function isThisGateway(health) {
  return !!(health && typeof health === 'object' && health.gateway && typeof health.gateway === 'object' && health.networkMode === 'loopback');
}

const MESSAGES = {
  SERVICE_MISSING:
    'The DPDP Gateway service is not installed on this computer. Run the DPDP Gateway installer again. Reference: GW-SERVICE-MISSING.',
  PORT_IN_USE:
    'Another program is using the Gateway\'s local port 7071 (for example the DPDP Docker "agent" container), so the DPDP Gateway service cannot start. ' +
    'Only one DPDP Gateway can run on a computer: stop the other program (in Docker Desktop, stop the "dpdp-agent" container), then click Try again. Reference: GW-PORT-IN-USE.',
  SERVICE_NOT_RUNNING:
    'The DPDP Gateway service is not running (it may be stopping repeatedly). Click Try again to restart it; if it keeps happening, check the Windows Services app. Reference: GW-SERVICE-STOPPED.',
  NOT_RESPONDING: 'The DPDP Gateway service is starting and not answering yet.',
};

/**
 * Combines the Windows service state with the probe of 127.0.0.1:7071.
 * Returns the shape the renderer already uses ({ reachable, health, error })
 * plus a stable `problem` code. `reachable` is true ONLY for our own service.
 */
function interpretStatus(serviceState, probe) {
  if (serviceState === 'missing') return { reachable: false, problem: 'SERVICE_MISSING', error: MESSAGES.SERVICE_MISSING };
  const answered = !!(probe && probe.reachable);
  if (answered && isThisGateway(probe.health) && serviceState !== 'stopped') {
    return { reachable: true, health: probe.health, problem: null };
  }
  if (answered) return { reachable: false, problem: 'PORT_IN_USE', error: MESSAGES.PORT_IN_USE };
  if (serviceState === 'stopped') return { reachable: false, problem: 'SERVICE_NOT_RUNNING', error: MESSAGES.SERVICE_NOT_RUNNING };
  return { reachable: false, problem: 'NOT_RESPONDING', error: (probe && probe.error) || MESSAGES.NOT_RESPONDING };
}

module.exports = { parseServiceState, isThisGateway, interpretStatus, MESSAGES };
