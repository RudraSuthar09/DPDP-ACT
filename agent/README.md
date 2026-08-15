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

## Configuration — three SEPARATE network concepts

| Variable | Concept | Default | Notes |
| --- | --- | --- | --- |
| `GATEWAY_BIND_HOST` | Where the agent **listens** | `127.0.0.1` | Never auto-`0.0.0.0`. A non-loopback value is allowed but reported loudly. |
| `GATEWAY_BIND_PORT` | Listen port | `7071` | 1–65535. |
| `GATEWAY_ALLOWED_ORIGINS` | Which **web origins** may call the agent | *(empty)* | Exact, comma-separated. No `*`, no substring/loose matching. |
| `GATEWAY_CONTROL_PLANE_URL` | Where the agent reaches **Azure** later | *(none)* | Validated but **not used in Phase 3B**. |

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

For any non-loopback deployment you **must** add appropriate network controls
(firewall rules restricting the port to trusted devices). TLS/mTLS is a **later
hardening phase**; do not expose a non-TLS agent beyond a trusted LAN.

## What `/health` does

Returns agent **metadata only**: `status`, `agentVersion`, `protocolVersion`, and
`networkMode` (`loopback` / `non-loopback`). It never returns customer data,
filesystem contents, environment variables, credentials, tokens, private keys,
the bind address, the origin allowlist, or the control-plane URL.

Security applied to every request: exact-Origin allowlist (a presented Origin
must match, else `403`; CORS reflection is the exact origin, never `*`), an
auth-header **boundary** (if the `x-dpdp-gateway-session` header is present it must
be well-formed, else `401` — real session validation is Phase 3C), oversized-
request rejection (`413`), and sanitized errors (a code + generic message, never
echoing input). Logs carry method/path/status/decision/mode only — never a token,
header value, or body.

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
