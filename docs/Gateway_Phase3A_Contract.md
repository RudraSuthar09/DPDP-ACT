# Gateway — Phase 3A Security Contract

> **Status:** Contract only. Nothing in this phase runs. This document and
> `shared/src/gateway.ts` define the wire shapes, names, scopes, TTLs and rules
> for the future Gateway / Local Data Agent (I1 Mode-B). The enforcement
> mechanisms belong to later phases (3B onward).

## 0. The one clarification that governs this whole phase

**The Phase-3A types/contracts are SECURITY CONTRACTS, not implementations of the
security mechanisms.** A shape that names a field does not enforce the rule that
field exists to serve:

- token types do **not** by themselves make tokens non-replayable;
- nonce types do **not** by themselves enforce single-use;
- Origin constants do **not** by themselves enforce Origin validation;
- device public-key types do **not** by themselves establish device identity;
- audit metadata types do **not** by themselves guarantee audit safety;
- filesystem path types do **not** by themselves enforce path containment.

Each enforcement mechanism (the loopback listener that checks Origin, the Azure
store that atomically marks a nonce consumed, the agent that canonicalises a path
and refuses one outside an allowed root, the crypto that proves device identity)
is a **later phase**. Phase 3A gives those mechanisms a precise shape to satisfy,
and a set of build-time guards that fail if the shape is ever weakened.

## 1. Control plane vs data plane

The Gateway is split into two planes, and the split is load-bearing.

| | Control plane | Data plane |
| --- | --- | --- |
| Path | Agent → outbound HTTPS → **Azure** | Browser → `127.0.0.1` → **Local Agent** → customer data |
| Carries | enrollment, device identity, heartbeat, authorization, pairing/session negotiation, revocation, config metadata, **audit metadata** | discover / search / read / metadata of the customer's own source |
| Raw customer values? | **NEVER** | Transiently only (agent memory → browser memory), **never routed through Azure** |
| Inbound firewall port on client? | No (outbound-only) | No (`127.0.0.1` is not routable off-host) |

**Why raw data never uses Azure as a relay:** the browser and the agent are on
the same physical machine. A same-machine hop cannot be made more secure by
detouring through the internet, and routing bytes through Azure would forfeit the
easy, provable guarantee that Azure never receives a customer value — the exact
guarantee Phase 2 already demonstrated for the browser-local viewer.

## 2. Transport & Origin security (V1 decision)

- **V1 transport:** plain **HTTP on `127.0.0.1`** (`GATEWAY_V1_TRANSPORT`,
  `GATEWAY_LOOPBACK_HOST`). The agent binds **only** to loopback — never
  `0.0.0.0`, never a LAN IP, never a public IP.
- **TLS / mTLS on the loopback hop is a FUTURE hardening option**, deliberately
  out of scope for 3A (documented here so the decision is explicit, not silent).
- **Two controls, both required** on every data-plane request:
  1. **Exact Origin allowlist** (`GATEWAY_ALLOWED_ORIGINS`) — no `*`, no
     substring/loose hostname matching. A malicious site's `fetch` carries its
     own Origin, which is not on the list; a page cannot forge the Origin header.
  2. **Custom non-simple auth header** (`GATEWAY_AUTH_HEADER`) — its presence
     forces a CORS preflight, so a cross-site "simple request" can't reach the
     real handler without the browser first performing the CORS check.

Neither control is implemented in 3A; the constants and the rule are the
contract, and a guard test fails the build if a wildcard ever appears.

## 3. Device identity (asymmetric, private key never leaves the device)

At enrollment the device generates a keypair **locally**. Only the **public key**
and identifying metadata are sent to Azure (`DeviceEnrollmentRequest`). There is
deliberately **no field anywhere in the contract for a private key** — it must
never leave the device, never reach Azure, never reach the browser, never be
logged. Azure stores the public identity + status (`DeviceIdentity`); a device is
bound to exactly one tenant. Revocation flips `status → 'revoked'` and Azure stops
issuing sessions to it.

## 4. Pairing flow (nonce is redeemed by the agent through its own channel)

```
User logs into DPDP Shield (existing auth)
  ↓
Opens a Gateway-connected source's viewer
  ↓
Backend verifies: tenant + user + role + source + data_access_mode=gateway_connected
                  + active source + an enrolled/eligible device
  ↓
Azure issues a single-use PAIRING NONCE, scoped {tenant,user,source,device},
  TTL = GATEWAY_PAIRING_NONCE_TTL_SECONDS
  ↓
Browser calls the localhost agent, presenting the nonce
  ↓
Agent redeems the nonce over its OWN outbound Azure control channel (/gateway/pair/redeem)
  ↓
Azure verifies nonce + tenant + user + source + device, marks it consumed (single-use)
  ↓
Agent receives a short-lived session (GatewaySession) and hands the opaque token to the browser
  ↓
Browser makes future data requests directly to localhost (Origin + GATEWAY_AUTH_HEADER + token)
  ↓
Azure is NOT involved in raw-data transfer
```

The load-bearing detail: the agent does not verify a presented credential in
isolation — it **redeems** the nonce through its already-trusted outbound channel,
so a forged or replayed nonce cannot establish a session. (Phase 3A defines the
contract for this; it does not implement the redemption.)

## 5. Session token contract

`GatewaySession` is **opaque and scoped**: an opaque random `token` (no customer
value ever encoded into it), scoped to tenant + user + source + device, short-lived
(`GATEWAY_SESSION_TTL_SECONDS`), revocable (`status`), and tied to exactly one
pairing (`pairingNonce`). In the enforcing phases it is additionally never
persisted to disk, never in `localStorage`, never in an agent-set cookie, never in
logs. The type gives those rules a home; it does not implement them.

## 6. Control-plane API contract (recommended route names only)

`GATEWAY_CONTROL_ROUTES` enumerates the eventual operations as **string constants,
not Nest routes**: `/gateway/enroll`, `/heartbeat`, `/pair/redeem`,
`/session/refresh`, `/deenroll`, `/revoke`. Each request/response type is defined
with its auth, binding, TTL and replay behaviour documented inline. **Phase 3A
creates none of these endpoints.** When built, they follow the existing API
conventions (`TenantGuard`, `@Roles(owner|dpo|compliance_officer)`, `@Audited`).

## 7. Data-plane API contract (schemas only)

`GATEWAY_DATA_ROUTES`: `/health`, `/session/establish`, `/source/discover`,
`/source/search`, `/source/read`, `/source/metadata`. Every read/search is:

- **source-scoped** and **session-scoped** (`sourceId` + session token required);
- **bounded** (`limit` capped at `GATEWAY_READ_MAX_LIMIT`, default
  `GATEWAY_READ_DEFAULT_LIMIT`) and **paginated** (`cursor`);
- **cancelable** (`requestId`);
- **by opaque, source-agnostic handle, never by a resource the browser named** —
  the browser can only reference a `ResourceHandle` (`resourceKind: file | table |
  query`) that `discover()`/`search()` already returned from within the authorized
  set, and the Gateway resolves that handle **internally** to the concrete
  file/table/query. The browser never sends a filesystem path, raw SQL, a table
  name as a trusted identifier, or a credential — none of those fields exist on
  any data-plane request or on `ResourceHandle`/`ResourceDescriptor`.

`ResourceHandle` is the generalization of the former file-specific handle: a file
source yields `file` handles, a database yields `table` (or saved `query`)
handles, and the browser treats them identically. `ResourceDescriptor` carries a
Gateway-chosen display **label** only (never a path/SQL/credential/value), purely
so the UI can render a list.

There is **no** unrestricted `read everything` shape anywhere: no `/all-data`, no
`/dump`, no `readAll`. `GatewaySourceReadResponse.rows` is the **only** place raw
rows appear in the entire contract, and it is a **data-plane-only** type — no
control DTO carries anything like it (a guard test pins this).

## 8. Connector interface — separate from SchemaSource (S4)

`DataConnector` (`discover / search / read / metadata / healthCheck`) is the
agent-side connector contract. It is **a different capability from `SchemaSource`**
(S4), which stays introspection-only and row-free **forever**. `DataConnector`
may read bounded raw rows — but only on the data plane, in agent memory, for an
authorized session. Phase 3A defines the **interface only**; there is no
implementation, and it never extends or imports `SchemaSource`.

## 9. Filesystem security contract

The browser must never hand the agent an arbitrary path. A source is configured
with an allowlist of roots (`GatewayAllowedRoot`; `local_path` or the
higher-risk, opt-in `unc`). Before any read, the agent's resolver must perform, in
order (`GATEWAY_PATH_RESOLUTION_STEPS`):

1. `canonicalize`
2. `resolve_symlinks_and_junctions` (resolve **before** the containment check, so
   a symlink inside an allowed root can't point outside it)
3. `verify_descendant_of_allowed_root` (strict descendant after canonicalisation)
4. `verify_extension_allowlist` (`GATEWAY_FILE_TYPE_ALLOWLIST` = `.csv`, `.xlsx`)

Threats the resolver must defeat are enumerated (`GATEWAY_PATH_THREATS`): `../`
traversal, absolute-path injection, symlink, junction, UNC, hidden/system/
executable files, path-encoding tricks, case-sensitivity. A denied resolution
returns a **code** (`GatewayPathResolutionResult.deniedReason`), never the
offending path. **None of this is implemented in 3A** — it is the contract the
future agent resolver must satisfy.

## 10. Error model

`GATEWAY_ERROR_CODES` is a fixed union of safe codes (`INVALID_ORIGIN`,
`INVALID_TOKEN`, `INVALID_NONCE`, `TENANT_MISMATCH`, `SOURCE_MISMATCH`,
`DEVICE_MISMATCH`, `PATH_NOT_ALLOWED`, `SESSION_EXPIRED`, `AGENT_REVOKED`, …).
`GatewayError` carries a code + a generic message and has **no field** for a path,
filename, row, cell, or any customer value.

## 11. Audit contract (metadata only — S5 implementation unchanged)

`GATEWAY_AUDIT_ACTIONS` names the eventual events (`gateway.session.created`,
`…closed`, `gateway.source.discovered`, `…searched`, `gateway.raw_access.viewed`,
`…failed`). `GatewayAuditMetadata` is structurally limited to
`{tenantId, userId, sourceId, deviceId, operation, timestamp, durationMs, status,
rowCount?}` — no customer name, Aadhaar, PAN, phone, email, address, row, cell,
file contents, query result, or sensitive filename. This **defines the contract**;
it does **not** modify the S5 interceptor, sink, or hash chain. When built, Gateway
control operations are `@Audited` with these names and annotate with this shape —
the same discipline as `datasource.raw_access.viewed` (Phase 2).

`rowCount` is a count in the same safe class as Tier-2's relay byte-count; a count
can be weakly informative in rare contexts, which is an organisational
access-policy matter (open question), not something this shape can encode away.

## 12. Agent log allowlist

The future agent's local logs use an allowlisted metadata schema
(`GATEWAY_LOG_FIELDS`): `sourceId`, `deviceId`, `operation`, `timestamp`,
`durationMs`, `status`, `rowCount`, `errorCategory`, `fileHandle`. Notably, files
are referenced by **opaque handle**, not by name — a filename such as
`Divorce_Settlement_Priya.xlsx` leaks even if the file is never opened.

## 13. What Phase 3A does NOT include

No Gateway server, Local Agent, localhost listener, Nest Gateway module,
controller, service, migration, table, connector implementation, filesystem
access, raw-data API, device enrollment, pairing implementation, session
implementation, or frontend change. `SchemaSource` (S4) and Tier-2 are untouched.

## 14. Later phases (unchanged from the approved discovery plan)

3B agent skeleton · 3C secure enrollment + browser↔agent session · 3D filesystem
connector (enumeration, path safety) · 3E Excel/CSV `read()` · 3F viewer wired to
the agent · 3G security testing · 3H Enterprise packaging (Docker) · 3I database
connector groundwork. Each sub-phase is independently testable and gated on
explicit approval.
