// Renderer -- runs under contextIsolation:true, sandbox:true. Only
// `window.gateway.*` (preload.js's narrow bridge) and plain DOM APIs are
// available; there is no Node `require` here at all.
'use strict';

const screens = ['welcome', 'connect', 'pair', 'verify', 'complete', 'status', 'sources'];
function showScreen(name) {
  for (const s of screens) {
    document.getElementById(`screen-${s}`).classList.toggle('active', s === name);
  }
}

function setError(elId, message) {
  const el = document.getElementById(elId);
  if (!message) {
    el.classList.remove('show');
    el.textContent = '';
  } else {
    el.textContent = message;
    el.classList.add('show');
  }
}

function setBusy(buttonEl, busy, busyLabel, idleLabel) {
  buttonEl.disabled = busy;
  buttonEl.innerHTML = busy ? `<span class="spinner"></span>${busyLabel}` : idleLabel;
}

// In-memory only -- never written to disk/localStorage by this app. The
// enrolment code itself is handed straight to the elevated helper and
// never stored here beyond the lifetime of this one pairing attempt.
let workspaceUrl = null;

// --- Screen A: Welcome ------------------------------------------------------

document.getElementById('btn-welcome-start').addEventListener('click', () => showScreen('connect'));

// --- Screen B: Connect workspace --------------------------------------------

document.getElementById('btn-connect-back').addEventListener('click', () => showScreen('welcome'));

document.getElementById('btn-connect-continue').addEventListener('click', async () => {
  const input = document.getElementById('connect-url');
  const btn = document.getElementById('btn-connect-continue');
  setError('connect-error', null);
  setBusy(btn, true, 'Checking...', 'Continue');
  try {
    const result = await window.gateway.validateWorkspaceUrl(input.value);
    if (!result.ok) {
      setError('connect-error', result.reason);
      return;
    }
    workspaceUrl = result.url;
    showScreen('pair');
  } finally {
    setBusy(btn, false, '', 'Continue');
  }
});

// --- Screen C: Pair device --------------------------------------------------

document.getElementById('btn-pair-back').addEventListener('click', () => showScreen('connect'));

document.getElementById('btn-pair-submit').addEventListener('click', async () => {
  const code = document.getElementById('pair-code').value.trim();
  const name = document.getElementById('pair-name').value.trim();
  const btn = document.getElementById('btn-pair-submit');
  setError('pair-error', null);

  if (!code) {
    setError('pair-error', 'Enter the enrolment code from your DPDP dashboard.');
    return;
  }
  if (!workspaceUrl) {
    // Defensive -- Screen B always runs first in the normal flow.
    setError('pair-error', 'Workspace URL is missing. Go back and re-enter it.');
    return;
  }

  setBusy(btn, true, 'Requesting permission...', 'Pair device');
  try {
    const result = await window.gateway.pair(code, workspaceUrl, name || undefined);
    if (!result.ok) {
      setError(
        'pair-error',
        result.cancelled
          ? 'Windows permission was not granted. Pairing requires a one-time confirmation to configure the Gateway service.'
          : result.error || 'Could not pair this device. Check the code and try again.',
      );
      return;
    }
    showScreen('verify');
    startVerification();
  } finally {
    setBusy(btn, false, '', 'Pair device');
  }
});

// --- Screen D: Verify connection ---------------------------------------------

// Stable codes from the service's local status (agent/src/startup-tasks.ts,
// sources-file.ts). Never contains backend text or secrets.
const ENROLLMENT_ERROR_TEXT = {
  CODE_REJECTED:
    'DPDP rejected the enrolment code. It may be mistyped, expired (codes last about 15 minutes), already used, or your workspace may already have an active Gateway (revoke it in the dashboard first). Generate a new code and try again.',
  BACKEND_UNREACHABLE: 'The Gateway could not reach your DPDP workspace. Check the URL and this computer\'s internet/proxy settings.',
  CREDENTIAL_UNREADABLE: 'The saved Gateway credential cannot be read on this computer. Use Remove Gateway, then pair again with a new code.',
  CREDENTIAL_REVOKED: 'This Gateway was revoked or its credential expired in DPDP. Use Remove Gateway, then pair again with a new code.',
  PROXY_AUTH_FAILED:
    'Your network\'s proxy server rejected the Gateway\'s proxy credentials. An administrator needs to check proxy-credentials.json (see the DPDP Gateway README) and restart the service.',
  PROXY_UNREACHABLE:
    'The proxy server configured for the Gateway could not be reached or refused the connection. The Gateway never bypasses a configured proxy; an administrator needs to check the proxy settings.',
  TLS_CERTIFICATE_REJECTED:
    'The DPDP workspace\'s security certificate was not trusted. If your network inspects HTTPS traffic, an administrator must add your organisation\'s CA certificate to the Gateway configuration (see the DPDP Gateway README).',
  PROTECTION_UNAVAILABLE:
    'Windows credential protection (DPAPI) is not working for the Gateway service account, so credentials cannot be stored. Reinstall DPDP Gateway; if it persists, contact support.',
};
// Heartbeat failure codes (agent transport.ts) that need an administrator.
// Transient ones (timeouts, DNS, HTTP 5xx) are deliberately not shown.
const NETWORK_ERROR_TO_TEXT_KEY = {
  PROXY_AUTH_FAILED: 'PROXY_AUTH_FAILED',
  PROXY_REFUSED: 'PROXY_UNREACHABLE',
  PROXY_UNREACHABLE: 'PROXY_UNREACHABLE',
  TLS_UNTRUSTED: 'TLS_CERTIFICATE_REJECTED',
  TLS_HOSTNAME_MISMATCH: 'TLS_CERTIFICATE_REJECTED',
  TLS_FAILED: 'TLS_CERTIFICATE_REJECTED',
};
const SOURCES_ERROR_TEXT = {
  UNDECRYPTABLE: 'Saved source credentials cannot be decrypted (the service account changed). Re-add the affected sources.',
  CORRUPT: 'The sources file is damaged. It was left unchanged; contact support.',
  UNSUPPORTED_VERSION: 'The sources file was written by a newer Gateway version. Upgrade instead of downgrading.',
  PROTECTION_UNAVAILABLE: 'Source credentials are encrypted but Windows credential protection is unavailable.',
};

let verifyTimer = null;
let verifyAttempts = 0;
const VERIFY_MAX_ATTEMPTS = 20; // ~30s at 1.5s intervals
const VERIFY_INTERVAL_MS = 1500;

function setCheck(id, done) {
  const el = document.getElementById(id);
  el.classList.toggle('done', done);
  el.querySelector('.icon').innerHTML = done ? '&#10003;' : '&#9675;';
}

function stopVerification() {
  if (verifyTimer) clearTimeout(verifyTimer);
  verifyTimer = null;
}

async function verifyTick() {
  verifyAttempts += 1;
  const result = await window.gateway.getStatus();

  const reachable = result.reachable === true;
  setCheck('check-service', reachable);

  const gw = reachable && result.health ? result.health.gateway : null;
  const enrolled = !!(gw && gw.enrolled);
  setCheck('check-enrolled', enrolled);

  setCheck('check-heartbeat', enrolled && gw.heartbeat === 'connected');

  if (reachable && enrolled && gw.heartbeat === 'connected') {
    stopVerification();
    setTimeout(() => showScreen('complete'), 600);
    return;
  }

  // The service reports WHY pairing failed; stop waiting and say so.
  const failure = gw && (gw.enrollmentError || (gw.credentialProtection === 'unavailable' ? 'PROTECTION_UNAVAILABLE' : null));
  if (failure && failure !== 'BACKEND_UNREACHABLE') {
    stopVerification();
    setError('verify-error', ENROLLMENT_ERROR_TEXT[failure] || 'Pairing failed. Check the Gateway logs.');
    document.getElementById('btn-verify-retry').style.display = '';
    return;
  }

  if (verifyAttempts >= VERIFY_MAX_ATTEMPTS) {
    stopVerification();
    setError(
      'verify-error',
      'This is taking longer than expected. The Gateway service may still be starting, or the enrolment code may have expired. You can retry, or go back and request a new code from your dashboard.',
    );
    document.getElementById('btn-verify-retry').style.display = '';
    return;
  }

  verifyTimer = setTimeout(verifyTick, VERIFY_INTERVAL_MS);
}

function startVerification() {
  verifyAttempts = 0;
  setError('verify-error', null);
  document.getElementById('btn-verify-retry').style.display = 'none';
  for (const id of ['check-service', 'check-enrolled', 'check-heartbeat']) setCheck(id, false);
  verifyTick();
}

document.getElementById('btn-verify-cancel').addEventListener('click', () => {
  stopVerification();
  showScreen('pair');
});

document.getElementById('btn-verify-retry').addEventListener('click', () => startVerification());

// --- Screen E: Complete ------------------------------------------------------

document.getElementById('btn-complete-status').addEventListener('click', () => {
  showScreen('status');
  startStatusPolling();
});

// --- Status screen -----------------------------------------------------------

const HEARTBEAT_LABEL = {
  connecting: { text: 'Connecting...', cls: 'degraded' },
  connected: { text: 'Connected', cls: 'connected' },
  degraded: { text: 'Reconnecting...', cls: 'degraded' },
  auth_failed: { text: 'Revoked -- action needed', cls: 'error' },
  stopped: { text: 'Stopped', cls: 'unknown' },
  disabled: { text: 'Not configured', cls: 'unknown' },
};

function renderBadge(elId, heartbeat, reachable) {
  const el = document.getElementById(elId);
  if (!reachable) {
    el.innerHTML = '<span class="badge error"><span class="dot"></span>Service unreachable</span>';
    return;
  }
  const label = HEARTBEAT_LABEL[heartbeat] || { text: 'Unknown', cls: 'unknown' };
  el.innerHTML = `<span class="badge ${label.cls}"><span class="dot"></span>${label.text}</span>`;
}

function formatRelativeTime(iso) {
  if (!iso) return 'Never';
  const diffMs = Date.now() - new Date(iso).getTime();
  const sec = Math.round(diffMs / 1000);
  if (sec < 5) return 'Just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  return `${hr}h ago`;
}

let statusTimer = null;
let lastKnownSourceKinds = {};

async function refreshStatus() {
  const [status, config] = await Promise.all([window.gateway.getStatus(), window.gateway.getConfig()]);
  const gw = status.reachable && status.health ? status.health.gateway : null;

  renderBadge('status-badge', gw ? gw.heartbeat : null, status.reachable);
  document.getElementById('status-workspace').textContent = config.controlPlaneUrl || 'Not configured';
  document.getElementById('status-device').textContent = (gw && gw.enrolled && gw.deviceId) || 'Not enrolled';
  document.getElementById('status-heartbeat').textContent = gw ? formatRelativeTime(gw.lastHeartbeatAt) : '-';
  document.getElementById('status-version').textContent = (status.health && status.health.agentVersion) || '-';
  document.getElementById('status-sources').textContent = gw ? String(gw.sourcesConfigured) : '-';

  const problems = [];
  if (!status.reachable) problems.push(status.error);
  if (gw && gw.credentialProtection === 'unavailable') problems.push(ENROLLMENT_ERROR_TEXT.PROTECTION_UNAVAILABLE);
  if (gw && gw.enrollmentError && ENROLLMENT_ERROR_TEXT[gw.enrollmentError]) problems.push(ENROLLMENT_ERROR_TEXT[gw.enrollmentError]);
  const net = gw && gw.network;
  if (net && net.proxyCredentialsError) {
    problems.push('The Gateway\'s proxy credentials file could not be used. An administrator needs to write it again in plain form and restart the service (see the DPDP Gateway README).');
  }
  const heartbeatProblem = net && NETWORK_ERROR_TO_TEXT_KEY[net.lastErrorCode];
  if (heartbeatProblem && heartbeatProblem !== gw.enrollmentError) problems.push(ENROLLMENT_ERROR_TEXT[heartbeatProblem]);
  if (gw && gw.sourcesError) problems.push(SOURCES_ERROR_TEXT[gw.sourcesError] || 'Data sources could not be loaded.');
  setError('status-error', problems.length ? problems.join(' ') : null);

  workspaceUrl = config.controlPlaneUrl || workspaceUrl;
  lastKnownSourceKinds = (gw && gw.sourceKinds) || {};
}

function startStatusPolling() {
  refreshStatus();
  if (statusTimer) clearInterval(statusTimer);
  statusTimer = setInterval(refreshStatus, 5000);
}

document.getElementById('btn-status-reconnect').addEventListener('click', async () => {
  const btn = document.getElementById('btn-status-reconnect');
  setBusy(btn, true, 'Reconnecting...', 'Reconnect');
  setError('status-error', null);
  try {
    const result = await window.gateway.reconnect();
    if (!result.ok) {
      setError('status-error', result.cancelled ? 'Permission was not granted.' : result.error || 'Could not reconnect.');
    } else {
      setTimeout(refreshStatus, 2000);
    }
  } finally {
    setBusy(btn, false, '', 'Reconnect');
  }
});

document.getElementById('btn-status-dashboard').addEventListener('click', () => {
  if (workspaceUrl) window.gateway.openExternal(workspaceUrl);
});

document.getElementById('btn-status-remove').addEventListener('click', async () => {
  const confirmed = window.confirm(
    'Remove this Gateway? It will be de-enrolled from your DPDP workspace, and you will need a new enrolment code to reconnect.',
  );
  if (!confirmed) return;

  const btn = document.getElementById('btn-status-remove');
  setBusy(btn, true, 'Removing...', 'Remove Gateway');
  setError('status-error', null);
  try {
    const result = await window.gateway.remove();
    if (!result.ok) {
      setError('status-error', result.cancelled ? 'Permission was not granted.' : result.error || 'Could not remove the Gateway.');
      return;
    }
    if (statusTimer) clearInterval(statusTimer);
    workspaceUrl = null;
    showScreen('welcome');
  } finally {
    setBusy(btn, false, '', 'Remove Gateway');
  }
});

// --- Source configuration ---------------------------------------------------

const DB_KINDS = new Set(['postgresql', 'mysql', 'sqlserver']);
const KIND_LABEL = {
  postgresql: 'PostgreSQL',
  mysql: 'MySQL',
  sqlserver: 'SQL Server',
  filesystem: 'Folder (any files)',
  csv: 'Folder (CSV)',
  excel: 'Folder (Excel)',
};

function renderSourcesList() {
  // DOM nodes + textContent only: nothing from the service is ever parsed as HTML.
  const list = document.getElementById('sources-list');
  list.replaceChildren();
  const entries = Object.entries(lastKnownSourceKinds);
  if (entries.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'No sources configured yet';
    list.appendChild(li);
    return;
  }
  for (const [kind, count] of entries) {
    const li = document.createElement('li');
    li.className = 'done';
    li.textContent = `${KIND_LABEL[kind] || kind} × ${Number(count)}`;
    list.appendChild(li);
  }
}

function updateSourceFieldVisibility() {
  const kind = document.getElementById('source-kind').value;
  document.getElementById('source-fields-db').style.display = DB_KINDS.has(kind) ? '' : 'none';
  document.getElementById('source-fields-file').style.display = DB_KINDS.has(kind) ? 'none' : '';
}

function clearSourceForm() {
  for (const id of ['source-id', 'source-host', 'source-port', 'source-user', 'source-password', 'source-database', 'source-root']) {
    document.getElementById(id).value = '';
  }
}

document.getElementById('btn-status-sources').addEventListener('click', () => {
  renderSourcesList();
  updateSourceFieldVisibility();
  setError('sources-error', null);
  showScreen('sources');
});

document.getElementById('source-kind').addEventListener('change', updateSourceFieldVisibility);

document.getElementById('btn-sources-back').addEventListener('click', () => {
  document.getElementById('source-password').value = '';
  showScreen('status');
});

document.getElementById('btn-sources-add').addEventListener('click', async () => {
  const kind = document.getElementById('source-kind').value;
  const input = { sourceId: document.getElementById('source-id').value.trim(), kind };
  if (DB_KINDS.has(kind)) {
    input.connection = {
      host: document.getElementById('source-host').value,
      port: document.getElementById('source-port').value,
      user: document.getElementById('source-user').value,
      password: document.getElementById('source-password').value,
      database: document.getElementById('source-database').value,
    };
  } else {
    input.root = document.getElementById('source-root').value;
  }

  const btn = document.getElementById('btn-sources-add');
  setError('sources-error', null);
  setBusy(btn, true, 'Adding source...', 'Add source');
  try {
    // Validated (again) in the main process, then in the agent itself.
    const result = await window.gateway.addSource(input);
    if (!result.ok) {
      setError('sources-error', result.cancelled ? 'Permission was not granted.' : result.error || 'Could not add this source.');
      return;
    }
    clearSourceForm();
    await refreshStatus();
    renderSourcesList();
  } finally {
    setBusy(btn, false, '', 'Add source');
  }
});

// --- Initial load: if already enrolled, skip straight to status ------------

(async () => {
  const status = await window.gateway.getStatus();
  if (status.reachable && status.health && status.health.gateway && status.health.gateway.enrolled) {
    showScreen('status');
    startStatusPolling();
  }
})();
