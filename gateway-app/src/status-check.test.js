// Plain-node test: `node src/status-check.test.js`.
'use strict';

const assert = require('node:assert');
const { interpretStatus, isThisGateway, parseServiceState, MESSAGES } = require('./status-check');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

// What 127.0.0.1:7071 actually returned on the Phase 6 test machine: the
// full-stack Docker agent container, NOT the Windows service.
const DOCKER_AGENT_REPLY = { status: 'ok', agentVersion: '0.1.0', protocolVersion: 'gateway-3a.1', networkMode: 'non-loopback' };
// What this computer's installed service returns to the Setup app.
const OUR_SERVICE_REPLY = {
  status: 'ok',
  agentVersion: '0.1.0',
  protocolVersion: 'gateway-3a.1',
  networkMode: 'loopback',
  gateway: { enrolled: false, heartbeat: null, enrollmentError: null },
};

check('parseServiceState reads sc.exe query output and exit codes', () => {
  assert.strictEqual(parseServiceState(0, 'SERVICE_NAME: DPDPGatewayAgent\r\n        STATE              : 4  RUNNING \r\n'), 'running');
  assert.strictEqual(parseServiceState(0, '        STATE              : 1  STOPPED \r\n'), 'stopped');
  assert.strictEqual(parseServiceState(0, '        STATE              : 2  START_PENDING \r\n'), 'starting');
  assert.strictEqual(parseServiceState(0, '        STATE              : 3  STOP_PENDING \r\n'), 'stopped');
  assert.strictEqual(parseServiceState(1060, ''), 'missing');
  assert.strictEqual(parseServiceState(5, ''), 'unknown');
  assert.strictEqual(parseServiceState(0, 'garbage'), 'unknown');
});

check('only our own service counts as "this Gateway"', () => {
  assert.strictEqual(isThisGateway(OUR_SERVICE_REPLY), true);
  assert.strictEqual(isThisGateway(DOCKER_AGENT_REPLY), false);
  assert.strictEqual(isThisGateway({ ...OUR_SERVICE_REPLY, networkMode: 'non-loopback' }), false);
  assert.strictEqual(isThisGateway(null), false);
});

check('(Phase 6 root cause) the Docker agent answering port 7071 is reported as PORT_IN_USE, never as "service running"', () => {
  for (const state of ['stopped', 'running', 'starting', 'unknown']) {
    const r = interpretStatus(state, { reachable: true, health: DOCKER_AGENT_REPLY });
    assert.strictEqual(r.reachable, false, state);
    assert.strictEqual(r.problem, 'PORT_IN_USE', state);
    assert.match(r.error, /dpdp-agent/);
    assert.match(r.error, /GW-PORT-IN-USE/);
  }
});

check('our service running and answering -> reachable, with its status', () => {
  const r = interpretStatus('running', { reachable: true, health: OUR_SERVICE_REPLY });
  assert.deepStrictEqual(r, { reachable: true, health: OUR_SERVICE_REPLY, problem: null });
  assert.strictEqual(interpretStatus('unknown', { reachable: true, health: OUR_SERVICE_REPLY }).reachable, true);
});

check('service missing / stopped / starting are each reported distinctly', () => {
  assert.strictEqual(interpretStatus('missing', { reachable: true, health: OUR_SERVICE_REPLY }).problem, 'SERVICE_MISSING');
  assert.strictEqual(interpretStatus('stopped', { reachable: false, error: 'x' }).problem, 'SERVICE_NOT_RUNNING');
  const starting = interpretStatus('starting', { reachable: false, error: 'not yet' });
  assert.strictEqual(starting.problem, 'NOT_RESPONDING');
  assert.strictEqual(starting.error, 'not yet');
});

check('messages carry references and no internal details', () => {
  for (const m of Object.values(MESSAGES)) assert.ok(!/token|password|C:\\|ProgramData/i.test(m));
  assert.match(MESSAGES.SERVICE_NOT_RUNNING, /GW-SERVICE-STOPPED/);
});

console.log(`\n${passed} passed`);
