# DPDP Gateway -- Windows installer

A **separate product** from `installer/` (the full-stack, Docker-based
installer, which this does not touch). This installs only the lightweight
Gateway agent as a Windows Service, plus the small "DPDP Gateway Setup" app
used to pair it with an existing DPDP workspace and add data sources.
Targets Windows 10/11 and Windows Server 2016+ (x64). Requires Administrator
to install.

## What gets installed

| Location | Contents | Who can write |
| --- | --- | --- |
| `C:\Program Files\DPDP Gateway\` | `runtime\node.exe` (pinned Node.js), `agent\` (compiled agent, production deps only), `DPDPGatewayAgent.exe` + `.xml` (WinSW service wrapper), `install-service.ps1`, `uninstall-service.ps1`, `elevated-helper.ps1`, `gateway-app\` (Electron + Setup app), `MANIFEST.sha256` | Administrators only (install refuses otherwise) |
| `%ProgramData%\DPDP Gateway\config\` | `config.json` -- workspace URL and other non-secret settings | Administrators, SYSTEM. Service and local users: **read-only** |
| `%ProgramData%\DPDP Gateway\state\` | `device-credential.json`, `sources.json` (both DPAPI-encrypted), hand-off files, `agent.lock`, `logs\` | Administrators, SYSTEM, and the service account (Modify). Nobody else can read it. |

## Security model

**Service identity.** The service runs as the virtual account
`NT SERVICE\DPDPGatewayAgent` -- no password to store, isolated from other
services and users. WinSW 2.x ignores any username passed to `install`
(it would register the service as LocalSystem), so `install-service.ps1` sets
the account with `sc.exe config obj=` and **verifies it with `sc.exe qc`,
refusing to start the service otherwise**.

**Credentials at rest.** The device token and every source password are
encrypted with Windows DPAPI (CurrentUser scope) **by the service itself**,
so they are bound to the service account. Only the service ever encrypts or
decrypts them. The Setup app and its elevated helper never do: they run as a
different Windows account (with over-the-shoulder UAC, possibly a third one)
and could not decrypt the service's data anyway. Instead they leave
plaintext hand-off files in the protected `state` directory
(`pending-enrollment.json`, `pending-sources.json`, `pending-deenroll.json`)
and restart the service, which applies them under its own identity and then
scrubs and deletes them.

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
counts by kind -- never source names) goes only to local non-browser callers.

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
- the staging tree contains a `.env` file, a key/certificate, Gateway runtime state, or test files.

Electron's version and package integrity are pinned by `pnpm-lock.yaml`
(installed with `--frozen-lockfile`); Electron's own installer verifies its
download against its published checksums.

### Integrity vs. authenticity, and code signing (RELEASE BLOCKER)

`MANIFEST.sha256` and the pinned hashes prove **integrity**: the shipped
files are exactly what this repository built and reviewed. They do not prove
**who published** the installer. Only Authenticode signing does that.
Checked with `Get-AuthenticodeSignature` on the staged files:

| File | Signature |
| --- | --- |
| `runtime\node.exe` | **Valid** -- OpenJS Foundation (copied unmodified from the official zip) |
| `DPDPGatewayAgent.exe` (WinSW) | **Not signed** |
| `gateway-app\electron\electron.exe` | **Not signed** |
| `DPDPGatewaySetup-<version>.exe` (installer + uninstaller) | **Not signed** |
| `*.ps1` scripts | **Not signed** |

No DPDP code-signing certificate is available, and none is faked. Expect
SmartScreen warnings, and note that the UAC prompt for the elevated helper
shows "Windows PowerShell" rather than a DPDP publisher.

Production signing, once a real (preferably EV) code-signing certificate
exists, typically on a hardware token/HSM:
1. Sign the staged executables before compiling:
   `signtool sign /fd SHA256 /tr <RFC3161 timestamp URL> /td SHA256 /a <file>`
   for `staging\DPDPGatewayAgent.exe` and `staging\gateway-app\electron\electron.exe`
   (leave `node.exe` as is). Sign the `.ps1` files with
   `Set-AuthenticodeSignature` if the deployment uses an AllSigned execution policy.
2. Regenerate `MANIFEST.sha256` (rerun the manifest step) so it matches the signed files.
3. Add `SignTool=` to `setup.iss` (`[Setup]`) pointing at the same signtool
   command, so Inno Setup signs the installer and its uninstaller.
4. Verify with `signtool verify /pa /v` on every signed file.

## Install / upgrade / uninstall behavior

- **Install** registers the service, sets and verifies its account, creates
  the `%ProgramData%` directories with explicit ACLs (taking ownership, so a
  folder pre-created by another user cannot keep extra rights; links/junctions
  are refused), configures SCM restart-on-failure, starts it, and waits for
  Running. Any failure is reported in a dialog and in
  `{app}\install-service.log`; the Setup log (`/LOG`) records it too.
- **Upgrade** (running a newer installer) stops the service before replacing
  files and **keeps the service registration**, so the device identity and
  its DPAPI-protected credentials survive. ACLs are re-applied.
- **Rerunning** install or uninstall is safe (idempotent).
- **Uninstall** removes the service and the program files. Customer state in
  `%ProgramData%\DPDP Gateway` (device credential, sources, logs) is **kept**
  so a reinstall resumes. Uninstalling does **not** de-enrol the device: use
  Setup -> Remove Gateway first, or revoke the device in the DPDP dashboard.
  `uninstall-service.ps1 -PurgeState` (manual, as Administrator) deletes the
  state as well.

## What has been verified, and how

Run on a Windows 11 development machine **without Administrator rights**:

| Check | How | Real or mocked |
| --- | --- | --- |
| DPAPI round-trips (credential + sources, non-ASCII, restart) | `agent` Jest suites `dpapi`, `credential-store-windows`, `sources-file`, `startup.e2e` | Real DPAPI, **under the developer's account**, not the service account |
| Agent startup: queued source merged, legacy file encrypted, no passwords in logs, rebinding refused, second instance refused | `agent/src/startup.e2e.spec.ts` (real compiled agent process) | Real process + real DPAPI |
| Elevated helper: request validation, scrub, UTF-8 stdin hand-off, cli-pair writes, error reporting | `gateway-installer\tests\validate-elevated-helper.ps1` | Real PowerShell + real agent CLI, with **only** `#Requires -RunAsAdministrator` removed; service restart asserted to fail (no service) |
| UAC-cancel / launch-failure exit codes, argument quoting and injection | `gateway-app` `elevated-command.test.js` | Real PowerShell, `Start-Process` shadowed (no UAC prompt) |
| Script syntax | PowerShell parser on all `.ps1` files | Real |
| Virtual-account SID resolution | `sc.exe showsid DPDPGatewayAgent` | Real (works without admin) |
| Installer build + compile | `build-agent-bundle.ps1 -Compile` | Real |

**Not executed (requires an elevated session and/or a real tenant):** the
installer actually installing; service registration under the virtual
account; ACLs on `%ProgramData%`; service start/stop/restart and recovery;
DPAPI under `NT SERVICE\DPDPGatewayAgent` (including after reboot); the real
UAC prompt; upgrade and uninstall; pairing against a real DPDP tenant.

## Acceptance checklist (Administrator-capable Windows machine + a test tenant)

Record the result of every step. Stop at the first failure.

**Install**
1. As a standard user, confirm `C:\ProgramData\DPDP Gateway` does not exist (or note who owns it).
2. Run `DPDPGatewaySetup-<version>.exe`; accept UAC. Expect no error dialog.
3. `sc.exe qc DPDPGatewayAgent` -> `SERVICE_START_NAME : NT SERVICE\DPDPGatewayAgent`, `START_TYPE : AUTO_START`.
4. `sc.exe qfailure DPDPGatewayAgent` -> three RESTART actions.
5. `Get-Service DPDPGatewayAgent` -> Running. `Get-CimInstance Win32_Process -Filter "name='node.exe'"` -> command line `"...\runtime\node.exe" "...\agent\dist\index.js"`, and `(Get-Process node -IncludeUserName).UserName` -> `NT SERVICE\DPDPGatewayAgent`.
6. `icacls "C:\Program Files\DPDP Gateway"` -> no write for Users/Authenticated Users.
7. `icacls "C:\ProgramData\DPDP Gateway\config"` -> Administrators/SYSTEM F; the service SID and Users RX only. `icacls ...\state` -> Administrators/SYSTEM F; service SID M; **no Users**.
8. As a standard user: `Get-Content C:\ProgramData\DPDP Gateway\state\*` -> Access denied. `Set-Content ...\config\config.json x` -> Access denied.
9. `Invoke-RestMethod http://127.0.0.1:7071/health` -> `gateway.credentialProtection` is `dpapi` (proves DPAPI works under the service account).
10. `Invoke-WebRequest http://127.0.0.1:7071/health -Headers @{Host='evil.example'}` -> 403.

**Pairing**
11. Dashboard -> Data Sources -> Connect Enterprise Gateway; copy the code.
12. Start "DPDP Gateway Setup" (Start menu) as the standard user. Confirm in Task Manager it is **not** elevated.
13. Enter the workspace URL (`https://...`) and the code; accept UAC (also try with a *different* admin account if your test plan includes over-the-shoulder elevation). Expect "Gateway connected".
14. Dashboard shows the device as active with a recent heartbeat.
15. `Get-Content C:\ProgramData\DPDP Gateway\state\device-credential.json` (as admin) -> only `{"dpapi": "<hex>"}`; `pending-enrollment.json` is gone.
16. Repeat 11-13 with an **expired or already-used** code on a fresh install -> the wizard shows the "rejected" message quickly (not a timeout).
17. Click "No" on the UAC prompt during pairing -> "Windows permission was not granted".

**Sources**
18. Setup -> Manage sources -> add a PostgreSQL/MySQL/SQL Server source with a non-ASCII password. Accept UAC.
19. As admin, `sources.json` contains `"format": "dpdp-gateway-sources"` and no password text; `pending-sources.json` is gone; status shows the source kind.
20. In the dashboard, pair the source and read data through the Gateway browser -> works (proves the service decrypted the password).

**Restart / recovery**
21. Reboot. Without logging in, check from another machine or after login that the service is Running and the dashboard heartbeat resumes. Status still `dpapi`; the source still works (DPAPI after reboot).
22. `Stop-Process -Name node -Force` (as admin) -> WinSW restarts it within ~5 s.
23. Disconnect the network for 5 min, reconnect -> heartbeat resumes without intervention.
24. Revoke the device in the dashboard -> within one heartbeat interval the status shows "revoked"; heartbeat stops (no further 401s in `state\logs`).

**Upgrade**
25. Install a newer build over this one -> no re-pairing needed; the same device ID; sources still work.

**Remove / uninstall**
26. Setup -> Remove Gateway (fresh pairing first) -> dashboard no longer lists the device; `device-credential.json` is gone; status "Not enrolled".
27. Uninstall from Apps & Features -> the service is gone (`sc.exe query DPDPGatewayAgent` -> 1060); `C:\ProgramData\DPDP Gateway` remains.
28. Reinstall -> pairs/resumes as documented above. Then `uninstall-service.ps1 -InstallDir ... -PurgeState` as admin removes `C:\ProgramData\DPDP Gateway`.

**Logs**
29. Search `C:\ProgramData\DPDP Gateway\state\logs\*` and `{app}\install-service.log` for the enrolment code, the device token and the source password -> no matches.
