// Plain-node test: `node src/config-path.test.js`. CONTRACT test: the wizard
// reads config.json from the same place the service does. Requires the agent
// to be built (`pnpm --filter @dpdp/agent build`), like the installer build.
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { defaultConfigFilePath, resolveInstallLayout } = require('./paths');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

const agentConfigPathsJs = path.resolve(__dirname, '..', '..', 'agent', 'dist', 'config-paths.js');
if (!fs.existsSync(agentConfigPathsJs)) {
  console.error(`FAIL: ${agentConfigPathsJs} not found -- run "pnpm --filter @dpdp/agent build" first.`);
  process.exit(1);
}
const { defaultConfigDir } = require(agentConfigPathsJs);

check("the wizard's config path equals the agent's real defaultConfigDir() + config.json", () => {
  const env = { ProgramData: 'D:\\PD' };
  assert.strictEqual(defaultConfigFilePath(env), path.join(defaultConfigDir('win32', env), 'config.json'));
});

check('both fall back to C:\\ProgramData identically when %ProgramData% is unset', () => {
  assert.strictEqual(defaultConfigFilePath({}), path.join(defaultConfigDir('win32', {}), 'config.json'));
});

check('installed layout: the helper is taken from {app}, derived from electron.exe\'s own location', () => {
  const layout = resolveInstallLayout('C:\\Program Files\\DPDP Gateway\\gateway-app\\electron\\electron.exe');
  assert.deepStrictEqual(layout, {
    installed: true,
    installRoot: 'C:\\Program Files\\DPDP Gateway',
    helperPath: 'C:\\Program Files\\DPDP Gateway\\elevated-helper.ps1',
  });
});

check('any other location is treated as a development checkout, never as an install root', () => {
  const layout = resolveInstallLayout('C:\\Users\\u\\Downloads\\electron.exe', 'E:\\repo\\gateway-app\\src');
  assert.strictEqual(layout.installed, false);
  assert.strictEqual(layout.installRoot, null);
  assert.strictEqual(layout.helperPath, path.resolve('E:\\repo\\gateway-installer\\service\\elevated-helper.ps1'));
});

console.log(`\n${passed} passed`);
