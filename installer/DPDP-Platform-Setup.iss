; DPDP Platform -- Windows installer (Inno Setup).
;
; ONE installer for both SaaS and Enterprise -- the license key entered on
; first run determines the mode (see frontend ActivationGate / backend
; InstallationService). This script never asks "SaaS or Enterprise" and
; never hardcodes a license, deployment type, or database credential.
;
; Build:  iscc installer\DPDP-Platform-Setup.iss
; Output: installer\dist\DPDP-Platform-Setup.exe
;
; Prerequisite (v1, documented -- not bundled): Docker Desktop for Windows
; must already be installed and running. See installer\README.md.

#define MyAppName "DPDP Platform"
#define MyAppVersion "1.0.1"
#define MyAppPublisher "DPDP"
#define MyAppURL "http://localhost:3000"

[Setup]
AppId={{8B6B0F1E-6E4A-4C1A-9D8B-0F1E6E4A4C1A}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
; Per-user install, deliberately: this tool orchestrates Docker as the
; current user and touches no system-wide state, so it needs no admin
; rights / UAC prompt -- one less prerequisite for the customer, and this
; app is single-user local software, not a shared system service.
DefaultDirName={userappdata}\DPDP Platform
; Locked to the default location (no "choose install folder" page): a
; custom location -- e.g. a different drive's root -- is untested territory
; (permissions, AV scanning behaviour, and every relative path in
; runtime\docker-compose.runtime.yml/the scripts have only ever been proven
; against this exact per-user path). Root-caused a real "Cannot find
; module ...\desktop\app" failure on an install redirected to E:\ that
; could not be reproduced against the default location.
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=dist
OutputBaseFilename=DPDP-Platform-Setup-v2
Compression=lzma2
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayName={#MyAppName}
WizardStyle=modern

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop icon"; GroupDescription: "Additional icons:"

[Files]
Source: "runtime\*"; DestDir: "{app}\runtime"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "scripts\*"; DestDir: "{app}\scripts"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "dist\images\*.tar"; DestDir: "{app}\dist\images"; Flags: ignoreversion
; The desktop shell: the raw Electron runtime + our own tiny, dependency-free
; app source (see installer\scripts\package-images.ps1's "Desktop shell
; staging" step -- no electron-packager, just `electron.exe <app-dir>`).
Source: "dist\desktop\electron\*"; DestDir: "{app}\desktop\electron"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "dist\desktop\app\*"; DestDir: "{app}\desktop\app"; Flags: ignoreversion recursesubdirs createallsubdirs

[Dirs]
Name: "{app}\config"
Name: "{app}\logs"

[Icons]
; The primary entry point -- opens the DPDP application window directly,
; starting the existing Docker runtime first if it isn't already up (see
; desktop\src\main.js). No browser involved.
Name: "{group}\DPDP Platform"; Filename: "{app}\desktop\electron\electron.exe"; \
  Parameters: """{app}\desktop\app"" --install-root=""{app}"""; WorkingDir: "{app}\desktop\electron"
Name: "{userdesktop}\DPDP Platform"; Filename: "{app}\desktop\electron\electron.exe"; \
  Parameters: """{app}\desktop\app"" --install-root=""{app}"""; WorkingDir: "{app}\desktop\electron"; Tasks: desktopicon
; Secondary/troubleshooting entries -- the browser is never the primary UX.
Name: "{group}\Open DPDP in Browser (troubleshooting)"; Filename: "http://localhost:3000"
Name: "{group}\Stop DPDP"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\stop.ps1"""
Name: "{group}\Restart DPDP"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\restart.ps1"""
Name: "{group}\Uninstall DPDP"; Filename: "{uninstallexe}"

[Run]
; Check Docker is present/running BEFORE trying to load images -- a clear,
; actionable failure instead of a confusing docker-load error.
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\assert-docker.ps1"""; \
  StatusMsg: "Checking Docker Desktop..."; Flags: runhidden

; Load the three bundled images (dpdp-backend, dpdp-frontend:installer,
; dpdp-agent) -- no build step, no source tree needed on this machine.
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\load-images.ps1"" -InstallRoot ""{app}"""; \
  StatusMsg: "Loading DPDP application images..."; Flags: runhidden

; Standard "Launch after install" checkbox (unchecked run is skipped
; entirely under /SILENT or /VERYSILENT, so this never affects automated
; installs). The desktop shell itself handles starting the runtime and
; will show its own clear error if the central database connection has
; not been configured yet (config\.env) -- see installer\README.md.
Filename: "{app}\desktop\electron\electron.exe"; \
  Parameters: """{app}\desktop\app"" --install-root=""{app}"""; \
  WorkingDir: "{app}\desktop\electron"; \
  Description: "Launch DPDP Platform"; Flags: postinstall skipifsilent nowait

[UninstallRun]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\uninstall-cleanup.ps1"""; \
  RunOnceId: "DpdpUninstallCleanup"; Flags: runhidden
