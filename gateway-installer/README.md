# DPDP Gateway -- Windows installer

A **separate product** from `installer/` (the full-stack, Docker-based
installer, which this does not touch). This installs only the lightweight
Gateway agent as a Windows Service, plus the small "DPDP Gateway Setup" app
used to pair it with an existing DPDP workspace and add data sources.
Targets Windows 10/11 and Windows Server 2016+ (x64). Requires Administrator
to install.

> **Release status: NOT production-ready.** Administrator-only steps, reboot
> persistence, real-tenant pairing and real corporate proxies have not been
> verified, and nothing is code-signed. See "What has been verified" and the
> acceptance checklist below.

## What gets installed

| Location | Contents | Who can write |
| --- | --- | --- |
| `C:\Program Files\DPDP Gateway\` | `runtime\node.exe` (pinned Node.js), `agent\` (compiled agent, production deps only), `DPDPGatewayAgent.exe` + `.xml` (WinSW service wrapper), `install-service.ps1`, `uninstall-service.ps1`, `elevated-helper.ps1`, `collect-diagnostics.ps1`, `gateway-app\` (Electron + Setup app), `MANIFEST.sha256` | Administrators only (install refuses otherwise) |
| `%ProgramData%\DPDP Gateway\config\` | `config.json` (workspace URL, optional `proxy` / `tls`), optional corporate CA bundle (e.g. `corp-ca.pem`) | Administrators, SYSTEM. Service and local users: **read-only** |
| `%ProgramData%\DPDP Gateway\state\` | `device-credential.json`, `sources.json`, `proxy-credentials.json` (all DPAPI-encrypted by the service), hand-off files, `agent.lock`, `logs\` | Administrators, SYSTEM, and the service account (Modify). Nobody else can read it. |

## Security model

**Service identity.** The service runs as the virtual account
`NT SERVICE\DPDPGatewayAgent` -- no password to store, isolated from other
services and users. WinSW 2.x ignores any username passed to `install`
(it would register the service as LocalSystem), so `install-service.ps1` sets
the account with `sc.exe config obj=` and **verifies it with `sc.exe qc`,
refusing to start the service otherwise**.

**Credentials at rest.** The device token, every source password and the
outbound-proxy password are encrypted with Windows DPAPI (CurrentUser scope)
**by the service itself**, so they are bound to the service account. Only the
service ever encrypts or decrypts them. The Setup app and its elevated helper
never do: they run as a different Windows account (with over-the-shoulder UAC,
possibly a third one) and could not decrypt the service's data anyway.
Instead they leave plaintext hand-off files in the protected `state`
directory (`pending-enrollment.json`, `pending-sources.json`,
`pending-deenroll.json`) and restart the service, which applies them under
its own identity and then scrubs and deletes them. An administrator-written
`proxy-credentials.json` is likewise re-written protected on the next start.

**Privileged actions.** The Setup app has exactly one privileged path: it
asks UAC to run `{app}\elevated-helper.ps1` with one of four fixed actions
(`pair`, `add-source`, `remove`, `restart`). Secrets never go on a command line
(visible to process listings and to process-creation auditing): they travel
in a single-use request file in the user's own temp directory, which the
helper validates (strict name, size cap, not a link), reads, scrubs and
deletes, then passes to `agent\dist\cli-pair.js` on **stdin**. The helper
locates itself; it never takes an install path from its caller.

**Local listener.** See `agent/README.md` -> "Local listener security model".
In short: loopback HTTP only, every request's `Host` must be a loopback name
(DNS-rebinding defense), browsers get liveness only, no control endpoints
exist over HTTP, and detailed status (device ID, connection state, source
counts by kind -- never source names, never proxy hosts) goes only to local
non-browser callers.

**Outbound connections.** One HTTP client (undici, pinned) and one shared
transport for every call to DPDP; HTTPS through a proxy is a CONNECT tunnel
(TLS end to end); certificate verification cannot be disabled; a configured
proxy is never bypassed; loopback is always direct. Full rules:
`agent/README.md` -> "Outbound connections: proxy and TLS trust".

## Enterprise networks: proxy and corporate CA (administrator procedure)

The Gateway does **not** read the Windows/Internet Options proxy settings,
PAC/WPAD, or (by default) the Windows certificate store. Configure it
explicitly, then restart the service. Do this **before** pairing on a network
that needs it; pairing keeps these settings.

All commands: elevated Windows PowerShell.

```powershell
$cfgFile = 'C:\ProgramData\DPDP Gateway\config\config.json'
$cfg = if (Test-Path $cfgFile) { Get-Content $cfgFile -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }

# 1. Proxy (http:// or https:// proxy URL, NO user name/password here)
$cfg | Add-Member -Force -NotePropertyName proxy -NotePropertyValue ([pscustomobject]@{
  url = 'http://proxy.corp.example:8080'
  noProxy = @('intranet.corp.example', '10.0.0.0/8')   # optional
})

# 2. Corporate TLS-inspection CA (only if your proxy re-signs HTTPS).
#    Either copy the CA (PEM, CA certificates only) into the config folder ...
Copy-Item 'D:\certs\corp-root-ca.pem' 'C:\ProgramData\DPDP Gateway\config\corp-ca.pem'
$cfg | Add-Member -Force -NotePropertyName tls -NotePropertyValue ([pscustomobject]@{ extraCaCertsFile = 'corp-ca.pem' })
#    ... or trust the Windows certificate store (where Group Policy deploys corporate roots):
# $cfg | Add-Member -Force -NotePropertyName tls -NotePropertyValue ([pscustomobject]@{ useWindowsCertificateStore = $true })

# Write without a BOM (the agent also tolerates one).
[IO.File]::WriteAllText($cfgFile, ($cfg | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding $false))
```

Proxy authentication (Basic only), if the proxy requires it. The password is
typed at a prompt, so it never appears on a command line or in PowerShell
history; the file inherits the `state` ACL (Administrators + service only):

```powershell
$u = Read-Host 'Proxy user name'
$p = Read-Host 'Proxy password' -AsSecureString
$b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($p)
try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
[IO.File]::WriteAllText('C:\ProgramData\DPDP Gateway\state\proxy-credentials.json',
  (@{ username = $u; password = $plain } | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding $false))
Remove-Variable plain, p, b
```

Then apply and check:

```powershell
Restart-Service DPDPGatewayAgent
(Invoke-RestMethod http://127.0.0.1:7071/health).gateway.network | ConvertTo-Json -Depth 4
# expect: proxy "config"; proxyAuthentication true (if credentials set);
#         proxyCredentialsError null; customTrust true (if a CA is set); lastErrorCode null once connected
Get-Content 'C:\ProgramData\DPDP Gateway\state\proxy-credentials.json'   # now {"format":"dpdp-gateway-proxy-credentials","version":2,...}, no password
```

Rules the service enforces (it refuses to start, with a message in
`state\logs`, rather than guess): no credentials in `config.json`; the CA file
must be inside the config folder (a link pointing elsewhere is refused) and
must contain only valid CA certificates (no private key). Not supported:
NTLM/Kerberos-only proxies (allow-list this computer at the proxy instead),
SOCKS, PAC/WPAD. Environment variables (`HTTPS_PROXY`, `NO_PROXY`,
`NODE_EXTRA_CA_CERTS`) are honoured when `config.json` has no `proxy`, but
are not recommended for the service (machine environment changes reach
services only after a reboot, and they are readable by other processes).

## Diagnostics and acceptance evidence

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File 'C:\Program Files\DPDP Gateway\collect-diagnostics.ps1'
```

Read-only; writes a folder and `.zip` to the Desktop (`-OutputDir` to
change). Contents: service registration/state/recovery/SID type, `icacls`
for every Gateway directory, `config.json` with the proxy host, NO_PROXY
entries and CA path removed, CA bundle summary (thumbprints and dates only),
state directory **file names, sizes and formats only**, the local `/health`
status, redacted log tails, Service Control Manager events, and a check of
every installed file against `MANIFEST.sha256`. It never decrypts or prints a
credential file, changes nothing, and makes no internet connections (a test
from the admin's session would not use the service's proxy, CA or identity).
Redaction is best effort: **review before sharing**.

## Build

```powershell
# Full release build: agent + runtime + WinSW + Setup app, release audit,
# manifest, and the installer itself (needs Inno Setup 6).
powershell -ExecutionPolicy Bypass -File gateway-installer\scripts\build-agent-bundle.ps1 -Compile
```

Output: `gateway-installer\dist\DPDPGatewaySetup-<version>.exe` (the script
prints its SHA-256). The build **fails** if:
- `agent/package.json`, `agent/src/version.ts` and `gateway-app/package.json` disagree on the version;
- Node.js or WinSW does not match its pinned SHA-256 (downloads are HTTPS-only and cached in `build\cache`);
- the staging tree contains a `.env` file, a key/certificate, Gateway runtime state (including `proxy-credentials.json`), test files, `__fixtures__` or `mock-*` files (test fixtures, including TEST-ONLY TLS keys and the mock proxy/backend/PostgreSQL servers, are pruned first; the audit proves they are gone);
- any of the agent's `devDependencies` is present in the staged `node_modules`;
- a file the release depends on is missing (agent entry points, the transport and TLS modules, undici, node.exe, WinSW, the Setup app);
- `MANIFEST.sha256` does not have exactly one entry per staged file. The four service scripts are installed **from staging**, so the manifest covers every file Setup installs (before Phase 5 the scripts were not in it).

npm dependencies (including `undici` 6.29.0, exact) and Electron are pinned
by `pnpm-lock.yaml` with integrity hashes and installed with
`--frozen-lockfile`; Electron's installer verifies its download against its
published checksums.

### Integrity vs. authenticity, and code signing (RELEASE BLOCKER)

`MANIFEST.sha256` and the pinned hashes prove **integrity**: the shipped
files are exactly what this repository built and reviewed. They do not prove
**who published** the installer. Only Authenticode signing does that.
Checked with `Get-AuthenticodeSignature` on the staged files:

| Distributable | Needs signing | Current state |
| --- | --- | --- |
| `DPDPGatewaySetup-<version>.exe` (installer; Inno also writes the uninstaller) | Yes | **Not signed** |
| `DPDPGatewayAgent.exe` (WinSW, third-party, runs as the service) | Yes (re-sign, or use a signed WinSW build) | **Not signed** |
| `gateway-app\electron\electron.exe` (Setup app host) | Yes | **Not signed** |
| `install-service.ps1`, `uninstall-service.ps1`, `elevated-helper.ps1`, `collect-diagnostics.ps1` | Yes if the organisation enforces `AllSigned`; recommended (the helper is run elevated) | **Not signed** |
| `runtime\node.exe` | Already signed by its publisher; do not modify | **Valid** -- OpenJS Foundation |
| Electron's DLLs / `.node` modules under `gateway-app\electron\` | Ship as published by Electron | Checked only for `electron.exe`; not individually verified |
| JavaScript (`agent\dist`, `node_modules`, `gateway-app\app`) | Not Authenticode-signable; covered by `MANIFEST.sha256` (which itself is only trustworthy once the installer is signed) | n/a |

No DPDP code-signing certificate is available, and none is faked. Expect
SmartScreen warnings, and note that the UAC prompt for the elevated helper
shows "Windows PowerShell" rather than a DPDP publisher.

Production signing, once a real (preferably EV) code-signing certificate
exists, typically on a hardware token/HSM:
1. Sign the staged executables before compiling:
   `signtool sign /fd SHA256 /tr <RFC3161 timestamp URL> /td SHA256 /a <file>`
   for `staging\DPDPGatewayAgent.exe` and `staging\gateway-app\electron\electron.exe`
   (leave `node.exe` as is). Sign the `.ps1` files with
   `Set-AuthenticodeSignature -TimestampServer <url>` (they are copied from
   `service\`; sign those sources or the staged copies consistently).
2. Regenerate `MANIFEST.sha256` (rerun the manifest step) so it matches the signed files.
3. Add `SignTool=` to `setup.iss` (`[Setup]`) pointing at the same signtool
   command, so Inno Setup signs the installer and its uninstaller.
4. Verify every file: `signtool verify /pa /v <file>` and
   `Get-AuthenticodeSignature <file> | Format-List Status, SignerCertificate, TimeStamperCertificate`
   (expect `Status: Valid`, the DPDP publisher, and a timestamp).

There is no auto-updater; updates are new installer builds.

## Install / upgrade / uninstall behavior

- **Install** registers the service, sets and verifies its account, creates
  the `%ProgramData%` directories with explicit ACLs (taking ownership, so a
  folder pre-created by another user cannot keep extra rights; links/junctions
  are refused), configures SCM restart-on-failure, starts it, and waits for
  Running. Any failure is reported in a dialog and in
  `{app}\install-service.log`; the Setup log (`/LOG`) records it too.
- **Upgrade** (running a newer installer) stops the service before replacing
  files and **keeps the service registration**, so the device identity and
  its DPAPI-protected credentials survive. ACLs are re-applied. `config.json`
  (including `proxy` / `tls`) and the CA file are kept.
- **Rerunning** install or uninstall is safe (idempotent).
- **Uninstall** removes the service and the program files. Customer state in
  `%ProgramData%\DPDP Gateway` (device credential, sources, proxy credentials,
  logs) is **kept** so a reinstall resumes. Uninstalling does **not**
  de-enrol the device: use Setup -> Remove Gateway first, or revoke the device
  in the DPDP dashboard. `uninstall-service.ps1 -PurgeState` (manual, as
  Administrator) deletes the state as well.

## What has been verified, and how

Run on a Windows 11 development machine **without Administrator rights**:

| Check | How | Real or simulated |
| --- | --- | --- |
| DPAPI round-trips (credential, sources, proxy credentials, non-ASCII, restart) | `agent` Jest suites `dpapi`, `credential-store-windows`, `sources-file`, `proxy-credentials`, `startup.e2e`, `network.e2e` | Real DPAPI, **under the developer's account**, not the service account |
| Agent startup: queued source merged, legacy file encrypted, no passwords in logs, rebinding refused, second instance refused | `agent/src/startup.e2e.spec.ts` (real compiled agent process) | Real process + real DPAPI |
| Proxy: CONNECT tunnelling for enrol/heartbeat/submission calls, Basic auth, 407/403/drop/down handling, no direct fallback, NO_PROXY, loopback direct, TLS end to end through the tunnel | `agent` `transport.spec.ts` and `network.e2e.spec.ts` | Real undici, real TLS, real sockets (incl. this machine's LAN address); the proxy and DPDP backend are **local mock servers**, not a real corporate proxy or tenant |
| Corporate CA: trust from `config.json` read at process start; untrusted and wrong-host certificates fatal | same, with a TEST-ONLY CA (`agent/src/__fixtures__/tls`) | Real TLS; simulated CA |
| Windows certificate store read (`tls.getCACertificates('system')`) | `tls-trust.spec.ts` | Real, developer account only |
| PostgreSQL TLS: trusted (custom CA, by name and by IP), untrusted, host-name mismatch (by name and IP), server refuses TLS, handshake dropped, no plaintext fallback, plaintext config unchanged, sanitized errors | `agent/src/connectors/db/postgres-tls.spec.ts` | Real `pg` driver + real TLS against a **simulated** PostgreSQL wire-protocol server with TEST-ONLY certificates; **no real PostgreSQL server** |
| Elevated helper: request validation, scrub, UTF-8 stdin hand-off, cli-pair writes, error reporting | `gateway-installer\tests\validate-elevated-helper.ps1` | Real PowerShell + real agent CLI, with **only** `#Requires -RunAsAdministrator` removed; service restart asserted to fail (no service) |
| Diagnostics collector: output contains none of 8 planted secrets/internal hosts; manifest tamper detected | `gateway-installer\tests\validate-collect-diagnostics.ps1` | Real PowerShell 5.1 against a **simulated** install/ProgramData layout, not elevated, no service |
| UAC-cancel / launch-failure exit codes, argument quoting and injection | `gateway-app` `elevated-command.test.js` | Real PowerShell, `Start-Process` shadowed (no UAC prompt) |
| Script syntax | PowerShell parser on all `.ps1` files | Real |
| Virtual-account SID resolution | `sc.exe showsid DPDPGatewayAgent` | Real (works without admin) |
| Installer build + compile | `build-agent-bundle.ps1 -Compile` | Real |

**Not executed (requires an elevated session, a real network and/or a real
tenant):** the installer actually installing; service registration under the
virtual account; ACLs on `%ProgramData%`; service start/stop/restart and
recovery; DPAPI under `NT SERVICE\DPDPGatewayAgent` (including after
reboot); the Windows certificate store as seen by the virtual account; the
real UAC prompt; upgrade and uninstall; a real corporate proxy (including
TLS inspection and authentication); pairing against a real DPDP tenant;
`collect-diagnostics.ps1` on a real installation.

## Release gates (all OPEN)

None of these is satisfied by unit tests, mock servers or the developer-account
runs above. Each needs the acceptance checklist below on real infrastructure:

1. Administrator-capable Windows installation and ACL validation (A).
2. DPAPI under the real service identity `NT SERVICE\DPDPGatewayAgent` (A9).
3. Reboot persistence of the service, credentials and sources (D).
4. Real-tenant pairing and source operation, including database TLS against a real server (B, C).
5. Upgrade and uninstall (G, H).
6. A real corporate proxy, including authentication and TLS inspection (F).
7. Legitimate code signing and signature verification (see "Integrity vs. authenticity").
8. Not Gateway-only, but shipped with the full-stack Docker product: the agent container's `GATEWAY_NO_PROXY` behaviour behind a real Docker proxy configuration (`scripts/validate-compose-agent-proxy.ps1` checks only the rendered configuration and the routing logic).

## Acceptance checklist (Administrator-capable Windows machine + a test tenant)

Use an elevated PowerShell unless a step says "standard user". Record the
command output for every step (or run `collect-diagnostics.ps1` at the
marked points and keep the zip). Stop at the first failure. Never paste
enrolment codes, tokens or passwords into the evidence.

Helpers used below:

```powershell
function GwStatus { (Invoke-RestMethod http://127.0.0.1:7071/health).gateway }
function GwNodePid { (Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object CommandLine -like '*\agent\dist\index.js*').ProcessId }
```

**A. Install**
1. As a standard user: `Test-Path 'C:\ProgramData\DPDP Gateway'` -> `False` (if `True`, note the owner: `(Get-Acl 'C:\ProgramData\DPDP Gateway').Owner`).
2. Run `DPDPGatewaySetup-<version>.exe /LOG="$env:TEMP\gw-setup.log"`; accept UAC. Expect no error dialog. Record `Get-FileHash` of the installer.
3. `sc.exe qc DPDPGatewayAgent` -> `SERVICE_START_NAME : NT SERVICE\DPDPGatewayAgent`, `START_TYPE : 2 AUTO_START`.
4. `sc.exe qfailure DPDPGatewayAgent` -> three `RESTART` actions. `sc.exe qsidtype DPDPGatewayAgent` -> `UNRESTRICTED`.
5. `Get-Service DPDPGatewayAgent` -> `Running`. `(Get-Process -Id (GwNodePid) -IncludeUserName).UserName` -> `NT SERVICE\DPDPGatewayAgent`.
6. `icacls 'C:\Program Files\DPDP Gateway'` -> no `(W)`, `(M)` or `(F)` for `Users` / `Authenticated Users`.
7. `icacls 'C:\ProgramData\DPDP Gateway\config'` -> `BUILTIN\Administrators:(OI)(CI)(F)`, `NT AUTHORITY\SYSTEM:(OI)(CI)(F)`, `NT SERVICE\DPDPGatewayAgent:(OI)(CI)(RX)`, `BUILTIN\Users:(OI)(CI)(RX)`, nothing else. `icacls '...\state'` -> Administrators/SYSTEM `(F)`, `NT SERVICE\DPDPGatewayAgent:(OI)(CI)(M)`, **no Users**.
8. As a standard user: `Get-ChildItem 'C:\ProgramData\DPDP Gateway\state'` -> access denied; `Set-Content 'C:\ProgramData\DPDP Gateway\config\config.json' x` -> access denied.
9. `(GwStatus).credentialProtection` -> `dpapi`. **This proves DPAPI works under the service account**; everything below depends on it.
10. `curl.exe --noproxy '*' -s -o NUL -w '%{http_code}' -H 'Host: evil.example' http://127.0.0.1:7071/health` -> `403`.
11. `& 'C:\Program Files\DPDP Gateway\collect-diagnostics.ps1'` -> keep the zip (baseline). Its summary shows `manifestMismatches: 0` and no warnings.

**B. Pairing**
12. Dashboard -> Data Sources -> Connect Enterprise Gateway; note the **Server address** and copy the code (both shown in the same panel).
13. Start "DPDP Gateway Setup" (Start menu) as the standard user. Task Manager -> Details -> "Elevated" column shows `No` for `electron.exe`.
14. Enter the **server address** from step 12 and the code; accept UAC (also with a *different* admin account if your plan covers over-the-shoulder elevation). Expect "Gateway connected" within ~30 s; the status screen shows **Connected**.
14a. Negative checks (each on a fresh pairing): enter the *dashboard's* web address instead of the server address -> the wizard says it is not the DPDP server and Back returns to the address screen; disconnect the network and pair -> after at most ~2 minutes the wizard says DPDP could not be reached; reconnect, click **Try again** (accept UAC) -> Connected without a new code (if the code has not expired).
15. `GwStatus | Select-Object enrolled, deviceId, heartbeat, lastHeartbeatAt, enrollmentError` -> `True`, a device ID, `connected`, a recent time, empty. The dashboard lists the same device ID as active.
16. `(Get-Content 'C:\ProgramData\DPDP Gateway\state\device-credential.json' -Raw | ConvertFrom-Json).PSObject.Properties.Name` -> only `dpapi`. `Test-Path '...\state\pending-enrollment.json'` -> `False`.
17. On a fresh install, pair with an **expired or already-used** code -> the wizard shows the "rejected" message within seconds; `(GwStatus).enrollmentError` -> `CODE_REJECTED`.
18. Click "No" on the UAC prompt during pairing -> "Windows permission was not granted"; nothing changed in `state`.

**C. Sources**
19. Setup -> Manage sources -> add a PostgreSQL/MySQL/SQL Server source with a non-ASCII password. Accept UAC.
20. `Get-Content '...\state\sources.json' -Raw` contains `"format": "dpdp-gateway-sources"` and `"version": 2` and **not** the password; `pending-sources.json` is gone; `(GwStatus).sourceKinds` shows the kind.
21. In the dashboard, pair the source and read data through the Gateway browser -> works (the service decrypted the password).
21a. Database TLS (needs a real PostgreSQL with TLS, ideally a private-CA certificate): set `"ssl": true` on the source (see `agent/README.md` -> "Database TLS"), restart -> reading data **fails** (`PERMISSION_DENIED`) until the CA is configured; copy the CA to the config folder, add `"sslCaFile"`, restart -> reading works. Point `host` at a name/IP not in the certificate -> fails. On the database server, `SELECT ssl, version FROM pg_stat_ssl WHERE pid <> pg_backend_pid();` shows `t` for the Gateway's connection.

**D. Reboot persistence**
22. `Restart-Computer`. Do not log in for 2 minutes; then the dashboard shows a heartbeat newer than the boot time (`(Get-CimInstance Win32_OperatingSystem).LastBootUpTime`).
23. After logging in: `(GwStatus).credentialProtection` -> `dpapi`, `enrolled` -> `True`, the same device ID as step 15, the source from step 21 still reads data.

**E. Recovery**
24. `Stop-Process -Id (GwNodePid) -Force` -> within ~10 s `Get-Service DPDPGatewayAgent` is `Running` with a new `GwNodePid`.
25. Network outage: `Get-NetAdapter | Where-Object Status -eq Up | Disable-NetAdapter -Confirm:$false` (console session, not RDP). After 2 heartbeat intervals (default 60 s): `(GwStatus).heartbeat` -> `degraded`, `(GwStatus).network.lastErrorCode` -> e.g. `DNS_FAILED` / `CONNECT_FAILED` / `PROXY_UNREACHABLE`. Re-enable (`Enable-NetAdapter`) -> within 2 intervals `heartbeat` -> `connected`, `lastErrorCode` -> empty, with no restart.
26. Revoke the device in the dashboard -> within one interval `(GwStatus).enrollmentError` -> `CREDENTIAL_REVOKED`; `state\logs` shows one "Heartbeat stopped" line and no further 401s.

**F. Proxy and corporate CA** (needs a real proxy; a lab Squid with Basic auth and, for inspection, ssl-bump is enough; record its product/version)
27. Block direct egress for the service so a bypass would be visible: `New-NetFirewallRule -DisplayName 'GW direct block' -Direction Outbound -Program 'C:\Program Files\DPDP Gateway\runtime\node.exe' -RemotePort 443 -Protocol TCP -Action Block` (adjust if your proxy itself listens on 443).
28. Configure `proxy` (and `proxy-credentials.json` if needed) as in "Enterprise networks" above; `Restart-Service DPDPGatewayAgent`. `(GwStatus).network` -> `proxy: config`, `proxyAuthentication` as configured, `proxyCredentialsError` empty; `heartbeat` -> `connected`. The proxy's access log shows `CONNECT <workspace host>:443` from this computer. `proxy-credentials.json` now starts with `{"format":"dpdp-gateway-proxy-credentials"`.
29. `Get-NetTCPConnection -OwningProcess (GwNodePid) -State Established | Select-Object RemoteAddress, RemotePort` -> only the proxy and loopback addresses.
30. Wrong proxy password (rewrite the file, restart) -> `(GwStatus).network.lastErrorCode` (or `enrollmentError` on a fresh pairing) -> `PROXY_AUTH_FAILED`; still only proxy connections (step 29). Restore.
31. Stop the proxy -> `lastErrorCode` -> `PROXY_UNREACHABLE`; the firewall rule's blocked count (or the absence of direct connections in step 29) shows no bypass. Start the proxy -> `connected` again without a restart.
32. TLS inspection on, `tls` not configured -> `lastErrorCode` -> `TLS_UNTRUSTED`. Add the CA (`extraCaCertsFile`, or `useWindowsCertificateStore` with the CA in `Cert:\LocalMachine\Root`), restart -> `connected`; `(GwStatus).network.customTrust` -> `True`.
33. Put the CA file outside the config folder and point `extraCaCertsFile` at it, restart -> the service fails to start and `state\logs\*.err.log` says the file must be inside the Gateway config directory. Restore. Remove the firewall rule from step 27.
34. Run `collect-diagnostics.ps1` -> the zip contains no proxy host name, no proxy password, and the CA appears only as thumbprint and dates.

**G. Upgrade**
35. Install a newer build over this one -> no re-pairing; the same device ID; sources still work; `config.json` still has `proxy`/`tls`; `(GwStatus).credentialProtection` -> `dpapi`.

**H. Remove / uninstall**
36. Setup -> Remove Gateway -> the dashboard no longer lists the device; `device-credential.json` is gone; `(GwStatus).enrolled` -> `False`.
37. Uninstall from Apps & Features -> `sc.exe query DPDPGatewayAgent` -> `FAILED 1060`; `C:\ProgramData\DPDP Gateway` remains.
38. Reinstall -> resumes as documented. Then, as admin, `& 'C:\Program Files\DPDP Gateway\uninstall-service.ps1' -InstallDir 'C:\Program Files\DPDP Gateway' -PurgeState` removes `C:\ProgramData\DPDP Gateway`.

**I. Secrets in logs**
39. `Select-String -Path 'C:\ProgramData\DPDP Gateway\state\logs\*', 'C:\Program Files\DPDP Gateway\install-service.log' -SimpleMatch -Pattern '<enrolment code>', '<source password>', '<proxy password>'` -> no matches; `Select-String ... -Pattern 'eyJ[A-Za-z0-9_-]{10,}\.'` -> no matches (no device token). Type the secrets interactively; do not save this command in the evidence.
