# DPDP Local Data Agent — Phase 3B skeleton

A **separately-runnable** localhost process (not part of the Nest backend) whose
only job in Phase 3B is to **prove the `Browser → Local Agent` network boundary
works safely** before any files, databases, pairing, enrollment, or raw data are
introduced. It reads no customer data, connects to nothing, and persists nothing.

## Start it locally

```bash
pnpm --filter @dpdp/agent build
pnpm --filter @dpdp/agent start
```

By default it listens on **`http://127.0.0.1:7071`** (loopback only). Then:

```bash
curl http://127.0.0.1:7071/health
# {"status":"ok","agentVersion":"0.1.0","protocolVersion":"gateway-3a.1","networkMode":"loopback"}
```

Configuration is environment-driven (see `.env.example`). With Node ≥ 20.11 you
can load a file: `node --env-file=.env dist/index.js`.

## File-based configuration (for an installed, background Gateway)

Environment variables remain the dev/CI/Docker mechanism and always win when
set. A real client install (a background OS service with no shell to export
`GATEWAY_*` vars into) instead reads two files from disk:

- **`config.json`** — ordinary, non-secret settings only (`controlPlaneUrl`,
  `displayName`, `heartbeatIntervalSeconds`, `bindHost`, `bindPort`,
  `allowedOrigins`, `logLevel`). Validated the same way env vars are. Default
  location: `%ProgramData%\DPDP Gateway\config\config.json` on Windows, or
  `$XDG_CONFIG_HOME/dpdp-gateway/config.json` (falling back to
  `~/.config/dpdp-gateway/config.json`) on Linux. Override the path with
  `GATEWAY_CONFIG_PATH`.
- **`sources.json`** — the file-based alternative to `GATEWAY_SOURCES`
  (which still wins if set). Lives in the **state** directory, next to
  `device-credential.json`. See "Credential storage" below for its encrypted
  format and migration.

Neither file is required: a fresh install with neither present behaves
exactly as before (defaults, then `EnrollmentRequiredError` until a code is
supplied). The state directory itself defaults to
`%ProgramData%\DPDP Gateway\state` (Windows) or `$XDG_STATE_HOME/dpdp-gateway`
(falling back to `~/.local/state/dpdp-gateway`) on Linux, unless
`GATEWAY_STATE_DIR` is set explicitly (Docker always sets it).

**Why `%ProgramData%` and not `%APPDATA%` on Windows:** the agent runs as a
Windows Service under its own account (`NT SERVICE\DPDPGatewayAgent`), while
`config.json` and the hand-off files are written by the Gateway Setup app's
elevated helper, running as a *different* Windows account. `%APPDATA%` is
per-account; `%ProgramData%` is machine-wide. `config\` is writable only by
Administrators (it decides where the device token is sent); `state\` only by
the service account and Administrators. See `gateway-installer/README.md`.

## Credential storage (Windows)

Only the service encrypts or decrypts, always under its own identity, using
Windows DPAPI (CurrentUser scope; `src/dpapi.ts`). Data reaches PowerShell
on **stdin**, never on a command line.

- `device-credential.json`: `{ "dpapi": "<hex>" }` (the whole credential).
- `sources.json`, format **v2**:
  `{ "format": "dpdp-gateway-sources", "version": 2, "sources": [...] }`.
  Non-secret fields stay readable (sourceId, kind, host, port, user,
  database, roots, column settings); each connection's `password` becomes
  `"secrets": { "password": { "scheme": "dpapi-user", "v": 1, "data": "<hex>" } }`.
  Empty passwords are not wrapped. A clear-text secret inside a v2 file is
  rejected as corrupt.
- **Legacy v1** (a bare JSON array with clear-text passwords, Phase 1/2) is
  still read. On Windows the service migrates it to v2 at startup (atomic
  replace, no plaintext backup kept). On Linux/dev there is no OS credential
  store, so files stay v1 and the agent logs that they are unencrypted.
- **New/changed sources** arrive in `pending-sources.json` (written by the
  elevated helper via `dist/cli-pair.js add-source --stdin`). The service
  merges them on its next start, rewrites `sources.json`, then overwrites and
  deletes the pending file. Plaintext exists there only between the helper
  writing it and the service restarting, inside the `state` ACL.
- **Failures never discard data.** Status codes (in `/health`'s local status,
  `sourcesError`): `UNDECRYPTABLE` (encrypted under another identity, e.g. the
  service account or its profile was recreated -> re-add the source),
  `UNSUPPORTED_VERSION` (written by a newer Gateway, or an unknown secret
  scheme/envelope version -> upgrade), `CORRUPT`, `PROTECTION_UNAVAILABLE`.
  The service keeps running with no sources (so status stays visible) and
  leaves the file and any pending queue untouched.
- All writes are atomic (same-directory temp file, fsync, rename).
- At startup the service runs a DPAPI self-test and reports
  `credentialProtection: "dpapi" | "unavailable" | "none"`.

**Assumption to verify on a real install:** DPAPI CurrentUser works for the
virtual service account, including after reboot (the same mechanism SQL
Server uses for its service master key under `NT SERVICE\MSSQLSERVER`). The
self-test makes a failure visible immediately; see the acceptance checklist.

## Configuration — three SEPARATE network concepts

| Variable | Concept | Default | Notes |
| --- | --- | --- | --- |
| `GATEWAY_BIND_HOST` | Where the agent **listens** | `127.0.0.1` | Never auto-`0.0.0.0`. A non-loopback value is allowed but reported loudly. |
| `GATEWAY_BIND_PORT` | Listen port | `7071` | 1–65535. |
| `GATEWAY_ALLOWED_ORIGINS` | Which **web origins** may call the agent | *(empty)* | Exact, comma-separated. No `*`, no substring/loose matching. |
| `GATEWAY_ALLOWED_HOSTS` | Extra **Host header** names accepted | *(empty)* | Only for browsers reaching the agent through a DNS name. Loopback names and the bind host are always accepted. |
| `GATEWAY_CONTROL_PLANE_URL` | The DPDP workspace (enrol, heartbeat, pairing, delivery) | *(none)* | The Setup app only accepts `https://` (or `http://localhost`). |

These are independent: the bind address is not the origin allowlist, and neither
is the control-plane URL.

## Why the secure default is `127.0.0.1`

`127.0.0.1` is not routable off the machine, so a loopback-only agent has **no
inbound network exposure** — the browser reaching it is a same-machine call. This
is the safe default for a per-desktop SaaS agent.

### Non-loopback / LAN mode

This is a real platform, not a localhost-only prototype, so the bind address is
**configurable** for LAN testing and enterprise/container deployment (e.g. a
laptop's browser reaching an Agent running on another machine). When configured
with a non-loopback address the agent:

- binds to it (LAN/enterprise/Docker address you supply), and
- **detects and prints a prominent warning** that it is reachable over the
  network — it is never *silently* exposed.

For any non-loopback deployment you **must** add network controls (firewall
rules restricting the port to trusted devices). The listener is plain HTTP;
do not expose it beyond a trusted LAN. The Windows Gateway product never sets
a non-loopback bind (and its `config.json` is writable only by Administrators).

## Local listener security model

Applied to **every** request, in this order:
1. **Size**: bodies over 4 KiB are refused (`413`) before routing.
2. **Host** (`src/host-auth.ts`): the `Host` header must name a loopback
   address (`localhost`, `127.0.0.0/8`, `[::1]`), the bind host, or a name in
   `GATEWAY_ALLOWED_HOSTS`; otherwise `403 INVALID_HOST`. This is the
   **DNS-rebinding** defense: a hostile page whose own hostname resolves to
   127.0.0.1 makes same-origin requests that carry no `Origin` header, but
   its `Host` is still the attacker's name. A missing `Host` is refused.
3. **Origin**: a presented `Origin` must be an exact allowlist match, else
   `403`; CORS reflects only that exact origin, never `*`. CORS is not
   authentication.
4. **Routes**: `GET /health`, plus the data/storage-plane routes when
   configured, which require a session token obtained through backend-brokered
   pairing. **There are no pairing, enrolment, credential, source-management,
   restart or other control routes over HTTP** -- those happen only through
   the Setup app's UAC-elevated helper. Anything else is `404`; other methods
   on `/health` are `405`.

`/health` returns liveness (`status`, `agentVersion`, `protocolVersion`,
`networkMode`) to everyone who passes the checks above -- this is all the DPDP
dashboard needs. The `gateway` status block (enrolled, device ID, heartbeat
state/time, source **counts by kind** -- never source IDs, hosts or paths --,
`enrollmentError`, `sourcesError`, `credentialProtection`) is returned only
to a caller that sends **no `Origin`** and uses a **loopback `Host`**: the
Setup app's main process, or any process already running on this machine.

**Residual risks (documented, not fixed):**
- Any local process (any user on the machine) can read that status block:
  whether the device is paired, its device ID, and how many sources of each
  kind exist. It cannot read credentials, change anything, or trigger
  actions. Restricting it further would need an authenticated local channel
  (e.g. a named pipe with an ACL), judged not worth the complexity for this data.
- The listener is plain HTTP on loopback. Loopback traffic does not leave
  the machine; a local attacker able to sniff it already has more power. Data-
  plane responses (customer rows to an authorized browser) also travel over
  this loopback HTTP. No local TLS was added: it would need a per-machine
  certificate trusted by browsers, with its own issuance/rotation lifecycle,
  for little gain on loopback.

## Outbound TLS (to the DPDP workspace)

- The Setup app and `cli-pair` only accept `https://` workspace URLs
  (`http://localhost` for development). Certificate validation is Node's
  default and is never disabled. There is **no certificate pinning**, on
  purpose: pinning breaks legitimate certificate rotation.
- Node validates against its **bundled** Mozilla CA list, not the Windows
  certificate store. Networks that intercept TLS with a private CA, or
  require an HTTP proxy (Node's `fetch` does not use the Windows proxy
  settings), will fail to connect until an administrator adds the CA via
  `NODE_EXTRA_CA_CERTS` (service environment) or proxy support is built.
  Tracked as a deployment limitation.

## What Phase 3B deliberately does NOT do

No Azure enrollment, device registration, pairing-nonce redemption, session
establishment, filesystem access, CSV/Excel parsing, PostgreSQL/MySQL/SQL Server
connectors, database credentials, Docker packaging, Windows service, installer,
auto-update, device private key, persistence of any kind, or raw-data viewer
integration. There is exactly one route, `GET /health`. SchemaSource (S4) and
Tier-2 are untouched.

## How this evolves later

- **3C** — secure enrollment + the pairing-nonce → session flow (the auth-header
  boundary here becomes real session validation against the control plane).
- **3D** — filesystem connector (allowed-roots enforcement, path containment).
- **3E** — Excel/CSV `read()` through the agent (bounded, in memory).
- **3F** — the raw-data viewer wired to the agent (data plane; still never via
  Azure).
- **3G+** — security testing, Enterprise (Docker) packaging, DB connectors.

Raw customer values will only ever flow **Agent → authorized browser** on the
data plane, transiently, and never through Azure or into central storage.
