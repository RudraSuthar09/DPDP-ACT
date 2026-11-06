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
  `allowedOrigins`, `logLevel`, and the outbound `proxy` / `tls` settings
  described under "Outbound connections"). Validated the same way env vars
  are. Unlike the other fields, `proxy` takes precedence over environment
  variables. Default
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
`enrollmentError`, `sourcesError`, `credentialProtection`, and the `network`
summary -- labels and counts, never a proxy host or CA path) is returned only
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

## Outbound connections: proxy and TLS trust

Every agent -> DPDP backend call (enrolment, heartbeat, session refresh,
pairing redemption, de-enrolment, submission list/claim/ack/fail) goes through
**one** HTTP call site (`requestJson` in `src/enrollment.ts`) using
[undici](https://github.com/nodejs/undici) 6.29.0 (the HTTP client Node.js
itself bundles, pinned exactly) and **one** shared transport
(`src/transport.ts`). Database connectors, file connectors and the local
listener never use it: they are not backend HTTP calls and are never proxied.

### Proxy

| Precedence | Setting | Notes |
|---|---|---|
| 1 | `config.json` `"proxy": { "url": "http://proxy.corp:8080", "noProxy": ["intranet.corp"] }` | Recommended for the service. Applies to http:// and https:// destinations. |
| 1 | `config.json` `"proxy": "none"` | Forces direct connections and ignores proxy environment variables. |
| 2 | `https_proxy`/`HTTPS_PROXY` (https:// destinations), `http_proxy`/`HTTP_PROXY` (http://), `no_proxy`/`NO_PROXY` | Used only when config.json has no `"proxy"`. Lower-case wins. HTTP_PROXY alone does **not** proxy https:// (curl/Node.js convention; a startup warning says so). |
| 3 | nothing set | Direct. |

- Proxy URLs: `http://` or `https://` (TLS to the proxy), `host:port`
  without a scheme means `http://`. SOCKS, PAC files, WPAD and the Windows
  (WinINET/WinHTTP) proxy settings are **not** read.
- HTTPS destinations use an HTTP `CONNECT` tunnel: TLS is end to end, so the
  proxy never sees the device token (unless it performs TLS inspection; see
  below).
- **Loopback destinations are always direct.** A **configured proxy is never
  bypassed**: if it is down, refuses the tunnel or rejects the credentials,
  the request fails and is reported; it is not retried directly.
- `NO_PROXY` entries (comma/space separated, case-insensitive): `*` (all),
  `<local>` (dot-less names), `example.com` / `.example.com` /
  `*.example.com` (the domain and all subdomains), IPv4/IPv6 addresses and
  CIDR ranges (match only destinations written as that literal address; no
  DNS lookups), each optionally with `:port`. Invalid entries are a startup
  configuration error rather than being ignored.
- **Proxy authentication: Basic only.** Credentials are never accepted in
  `config.json` (every local user can read it; the agent refuses to start).
  Put them in the **state** directory as `proxy-credentials.json`:
  `{ "username": "...", "password": "..." }`. On Windows the service rewrites
  it DPAPI-protected on its next start
  (`{ "format": "dpdp-gateway-proxy-credentials", "version": 2, "protected": {...} }`).
  It applies only to a `config.json` proxy. Environment proxy URLs may carry
  `user:pass@` (standard), but environment variables are readable by other
  processes; prefer the file. NTLM/Kerberos (Negotiate) proxies are not
  supported: allow-list the Gateway's machine, or use Basic.
- Proxy credentials go only to the proxy (`Proxy-Authorization` on the
  CONNECT request), never to DPDP; they never appear in logs, status or
  command lines.

### TLS trust (corporate TLS inspection)

Certificate verification is always on: there is no option to disable it, no
`rejectUnauthorized: false`, and hostname checks always apply (boundary.spec.ts
fails the build if any of that appears). No certificate pinning (it breaks
legitimate rotation). By default the agent trusts Node.js's bundled Mozilla
roots, **not** the Windows certificate store. An administrator can add trust,
read once at service start:

- `"tls": { "extraCaCertsFile": "corp-ca.pem" }`: a PEM bundle **inside the
  config directory** (`%ProgramData%\DPDP Gateway\config`, admin-only
  writable). Relative paths resolve against that directory; paths (or links)
  outside it are refused, so a standard user cannot plant a CA. The file may
  contain only CA certificates (no private key, no server certificate, none
  expired). The certificates are **added** to the bundled roots.
- `"tls": { "useWindowsCertificateStore": true }`: also trust the Windows
  certificate store roots (where Group Policy deploys corporate CAs), read via
  Node.js's own `tls.getCACertificates('system')`.
- `NODE_EXTRA_CA_CERTS` still works if present in the process environment at
  start-up, but for the service prefer config.json: the WinSW XML is replaced
  on upgrade, and machine-wide environment changes reach services only after a
  reboot.

Changes to `config.json`, the CA file or `proxy-credentials.json` take effect
when the service restarts (`Restart-Service DPDPGatewayAgent`).

### Docker: `GATEWAY_NO_PROXY`

`GATEWAY_NO_PROXY` (same syntax as `NO_PROXY`) is **added** to whichever
exclusion list is in effect (environment `NO_PROXY` or `config.json`
`proxy.noProxy`), never replacing it. Both full-stack Compose files set it to
`backend`, because the Docker CLI injects `HTTP(S)_PROXY`/`NO_PROXY` into
containers when a proxy is configured in `~/.docker/config.json`, and the
agent would otherwise send `http://backend:3001` to that external proxy.
Validate with `scripts/validate-compose-agent-proxy.ps1`.

### Diagnostics

Failures with no HTTP response become stable codes with actionable messages
that never contain a URL, host, credential or token: `PROXY_AUTH_FAILED`,
`PROXY_REFUSED`, `PROXY_UNREACHABLE`, `DNS_FAILED`, `CONNECT_FAILED`,
`TLS_UNTRUSTED`, `TLS_HOSTNAME_MISMATCH`, `TLS_FAILED`, `TIMEOUT`,
`NETWORK_ERROR`. Enrolment maps them to `enrollmentError`
`PROXY_AUTH_FAILED` / `PROXY_UNREACHABLE` / `TLS_CERTIFICATE_REJECTED` /
`BACKEND_UNREACHABLE`; a reply that is not the DPDP API (non-JSON, or 404/405
on the enrolment route -- usually the dashboard's web address entered instead
of the server address) is `WRONG_SERVER` and is not retried. The first
heartbeat is sent immediately at start-up, then every interval; TLS and proxy-auth failures are not retried. The local
status block includes `network`: `proxy` (`none`/`config`/`environment`),
`proxyAuthentication`, `noProxyRules`, `customTrust`, `tlsTrust` counts,
`proxyCredentialsError`, and the latest heartbeat `lastErrorCode`. Startup
logs one line each for the proxy source and the trust sources, without hosts
or paths.

Timeouts are undici's defaults (connect 10 s, headers/body 300 s), unchanged
from Node's global `fetch` used before. Known upstream issue worked around in
`transport.ts`: undici 6.x reconnects forever when a proxy closes the socket
before answering CONNECT; the transport makes that fail once.

## Database TLS (PostgreSQL)

Database connections do **not** use the outbound HTTP transport or its
`config.json` `tls` trust: each database source has its own settings, on its
`connection` (and `writeConnection`) object:

| Field | Meaning |
|---|---|
| `"ssl": true` | Require TLS. The server certificate **and host name** are verified (equivalent to libpq `sslmode=verify-full`). If the server refuses TLS, or the certificate is untrusted, expired or for another host, the connection fails; it never falls back to plaintext and never skips verification. |
| `"sslCaFile": "pg-ca.pem"` | Optional; requires `"ssl": true`. PEM file of the CA(s) that issued the server's certificate (private PKI, a self-signed server certificate that is itself a CA, or a cloud provider bundle such as Amazon RDS's). Must live **inside the Gateway config directory** (`%ProgramData%\DPDP Gateway\config` on Windows; admin-only) and contain only valid CA certificates. When set, **only** these CAs are trusted for that connection (libpq `sslrootcert`). |
| `ssl` absent or `false` | Plaintext, unchanged from before. Use only on networks where that is acceptable. |

Without `sslCaFile`, the server certificate must chain to Node.js's bundled
public roots. The host in `"host"` must appear in the certificate's SAN (a DNS
name, or an IP-address SAN when connecting by IP).

A source whose `sslCaFile` cannot be loaded (missing, outside the config
directory, not a CA, expired, contains a key) is **left out** at startup and
the local status reports `sourcesError: "TLS_CA_INVALID"`; the log names it by
position and kind only. TLS failures at connect time reach the browser only as
the sanitized `PERMISSION_DENIED` code (no host, certificate or driver text).

**Migration (behaviour change).** Before this change, `"ssl": true` encrypted
the connection but accepted **any** certificate. A source that pointed at a
server with a self-signed or private-CA certificate will now fail to connect
until an administrator adds `sslCaFile` (or replaces the server certificate
with one from a public CA). There is deliberately no switch to restore the old
behaviour. To check a server's chain from the Gateway machine:
`openssl s_client -starttls postgres -connect db.example:5432 -servername db.example -showcerts`.

Setting it on an installed Gateway (elevated PowerShell): copy the CA into
`C:\ProgramData\DPDP Gateway\config\`, then edit
`C:\ProgramData\DPDP Gateway\state\sources.json` and add `"ssl": true,
"sslCaFile": "pg-ca.pem"` to the source's `connection` object (its non-secret
fields are plain JSON; leave the `secrets` block untouched), then
`Restart-Service DPDPGatewayAgent`. The Gateway Setup wizard does not offer
TLS settings yet: sources it adds connect without TLS.

**Other drivers (not changed in this phase, tracked):** SQL Server sets
`trustServerCertificate: true` (any certificate accepted), and MySQL verifies
the chain but not the host name (mysql2 needs `verifyIdentity: true`).

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
