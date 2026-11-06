; DPDP Gateway -- Windows installer (Inno Setup).
;
; A SEPARATE product path from installer\DPDP-Platform-Setup.iss (the
; existing full-stack, Docker-based installer). This one installs ONLY the
; lightweight Gateway agent, as a genuine Windows Service, for a client who
; already has a DPDP SaaS tenant and needs their on-prem data sources
; connected to it -- no Docker, no PowerShell for the end user, no manually
; edited JSON or environment variables.
;
; Unlike the existing installer (PrivilegesRequired=lowest, no service),
; this one REQUIRES admin: installing/managing a Windows Service is an
; inherently admin-gated Windows operation. There is no way to avoid this
; for a real background service, and this script does not pretend
; otherwise.
;
; Build:
;   1. powershell -ExecutionPolicy Bypass -File gateway-installer\scripts\build-agent-bundle.ps1
;      (assembles gateway-installer\build\staging -- agent, vendored Node.js
;      runtime, WinSW, and the Gateway Setup app)
;   2. iscc gateway-installer\setup.iss
; Output: gateway-installer\dist\DPDPGatewaySetup-<version>.exe
;
; SIGNING: this installer, and every .exe it stages (DPDPGatewayAgent.exe /
; WinSW, runtime\node.exe, the Gateway Setup app's .exe), are UNSIGNED. No
; code-signing certificate was available during this phase. This is an
; explicit, documented release blocker -- see gateway-installer/README.md --
; not a claim of production-ready, signed distribution.

#define MyAppName "DPDP Gateway"
; The build script passes /DMyAppVersion=<agent version> after checking that
; agent, gateway-app and this installer agree (see build-agent-bundle.ps1).
#ifndef MyAppVersion
  #define MyAppVersion "0.1.0"
#endif
#define MyAppPublisher "DPDP"
#define MyAppURL "https://dpdp.example.com"
#define StagingDir "build\staging"

[Setup]
; A GUID distinct from the existing installer's AppId (8B6B0F1E-...) --
; this is a DIFFERENT product; the two must never be seen by Windows (or by
; this Inno Setup project) as the same installed application, upgrade
; target, or uninstall entry.
AppId={{A3E1C9F4-2D6B-4A8E-9C3F-7B1D4E6A9C21}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
; Machine-wide install: a Windows Service is machine-wide by nature (it can
; run with no one logged in), so {autopf} (Program Files) is correct here --
; unlike the existing installer's deliberate {userappdata} per-user choice,
; which suits a per-user Docker-orchestrating tool, not a real service.
DefaultDirName={autopf}\DPDP Gateway
DisableDirPage=yes
DisableProgramGroupPage=yes
; This is the one deliberate, necessary difference from the existing
; installer's PrivilegesRequired=lowest: installing a Windows Service is an
; admin-gated OS operation. There is no non-admin way to do this.
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=dist
OutputBaseFilename=DPDPGatewaySetup-{#MyAppVersion}
Compression=lzma2
SolidCompression=yes
UninstallDisplayName={#MyAppName}
SetupLogging=yes
MinVersion=10.0
; No SignTool directive: unsigned, deliberately and visibly (see this
; file's header and gateway-installer/README.md). Do not add a SignTool
; line without also obtaining and configuring a real code-signing
; certificate -- a SignTool directive with no valid certificate would
; silently fail the build rather than silently ship unsigned, which is a
; worse failure mode to debug than today's honest "unsigned" state.


[Files]
; Everything below lands in {app} (Program Files): writable only by
; Administrators. install-service.ps1 refuses to register the service if
; that is not true, because the service and the elevated helper execute
; these files.
Source: "{#StagingDir}\agent\*"; DestDir: "{app}\agent"; Flags: recursesubdirs ignoreversion
Source: "{#StagingDir}\runtime\node.exe"; DestDir: "{app}\runtime"; Flags: ignoreversion
Source: "{#StagingDir}\DPDPGatewayAgent.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StagingDir}\DPDPGatewayAgent.xml"; DestDir: "{app}"; Flags: ignoreversion
; Scripts come from STAGING (copied there by build-agent-bundle.ps1) so that
; MANIFEST.sha256 covers exactly what is installed.
Source: "{#StagingDir}\install-service.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StagingDir}\uninstall-service.ps1"; DestDir: "{app}"; Flags: ignoreversion
; The ONLY script the Gateway Setup app elevates (UAC). It locates itself,
; so it must live in {app}.
Source: "{#StagingDir}\elevated-helper.ps1"; DestDir: "{app}"; Flags: ignoreversion
; Read-only, redacting evidence collector for administrators/support (run elevated).
Source: "{#StagingDir}\collect-diagnostics.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StagingDir}\gateway-app\electron\*"; DestDir: "{app}\gateway-app\electron"; Flags: recursesubdirs ignoreversion
Source: "{#StagingDir}\gateway-app\app\*"; DestDir: "{app}\gateway-app\app"; Flags: recursesubdirs ignoreversion
Source: "{#StagingDir}\MANIFEST.sha256"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\DPDP Gateway Setup"; Filename: "{app}\gateway-app\electron\electron.exe"; Parameters: """{app}\gateway-app\app"""
Name: "{autodesktop}\DPDP Gateway Setup"; Filename: "{app}\gateway-app\electron\electron.exe"; Parameters: """{app}\gateway-app\app"""; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut for Gateway Setup"; GroupDescription: "Additional shortcuts:"

[UninstallDelete]
; Written by install-service.ps1 at install time (not part of [Files]).
Type: files; Name: "{app}\install-service.log"
Type: files; Name: "{app}\install-service.error.txt"

[Run]
; runasoriginaluser: the wizard must NOT inherit the installer's elevation.
; It is an ordinary app; its privileged steps each ask UAC explicitly.
Filename: "{app}\gateway-app\electron\electron.exe"; Parameters: """{app}\gateway-app\app"""; Description: "Connect this Gateway to your DPDP workspace"; Flags: postinstall nowait skipifsilent runasoriginaluser

[Code]
const
  ServiceName = 'DPDPGatewayAgent';

function PowerShellExe(): String;
begin
  Result := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
end;

function ServiceExists(): Boolean;
var
  ResultCode: Integer;
begin
  Result := Exec(ExpandConstant('{sys}\sc.exe'), 'query ' + ServiceName, '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
end;

{ Upgrade: stop the running service BEFORE files are replaced, otherwise
  node.exe / WinSW are locked. The registration itself is kept (see
  install-service.ps1), so the device identity and credentials survive. }
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  Result := '';
  if ServiceExists() then
  begin
    Log('Stopping ' + ServiceName + ' before upgrading files.');
    Exec(ExpandConstant('{sys}\net.exe'), 'stop ' + ServiceName, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    { net stop: 0 = stopped, 2 = already stopped. }
    if (ResultCode <> 0) and (ResultCode <> 2) then
      Result := 'The DPDP Gateway service could not be stopped (net stop exit code ' + IntToStr(ResultCode) + '). Stop it from services.msc and run Setup again.';
  end;
end;

function RunScript(const Script, ExtraArgs: String; var ResultCode: Integer): Boolean;
begin
  Result := Exec(PowerShellExe(),
    '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\' + Script) + '" -InstallDir "' + ExpandConstant('{app}') + '"' + ExtraArgs,
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
end;

var
  ServiceInstallFailed: Boolean;
  ServiceInstallError: String;

{ Exit codes are checked (the previous [Run]-based version ignored them), and
  success is only believed if the service really exists afterwards. On
  failure the script's own message (e.g. WinSW's error) is shown, the
  Finished page says the installation is incomplete, and the Gateway Setup
  app is not offered (it cannot pair without the service). }
procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
  Detail: AnsiString;
begin
  if CurStep = ssPostInstall then
  begin
    ServiceInstallFailed := not RunScript('install-service.ps1', '', ResultCode);
    if (not ServiceInstallFailed) and (not ServiceExists()) then
    begin
      ServiceInstallFailed := True;
      ResultCode := -2;
    end;
    if ServiceInstallFailed then
    begin
      ServiceInstallError := '';
      if LoadStringFromFile(ExpandConstant('{app}\install-service.error.txt'), Detail) then
        ServiceInstallError := Trim(String(Detail));
      if ServiceInstallError = '' then
        ServiceInstallError := 'The service was not registered (exit code ' + IntToStr(ResultCode) + ').';
      Log('install-service.ps1 failed (exit code ' + IntToStr(ResultCode) + '): ' + ServiceInstallError);
      SuppressibleMsgBox('The DPDP Gateway service could not be installed or started.' + #13#10#13#10 +
        ServiceInstallError + #13#10#13#10 +
        'Full log: ' + ExpandConstant('{app}\install-service.log'), mbCriticalError, MB_OK, IDOK);
    end;
  end;
end;

procedure CurPageChanged(CurPageID: Integer);
var
  I: Integer;
begin
  if (CurPageID = wpFinished) and ServiceInstallFailed then
  begin
    WizardForm.FinishedHeadingLabel.Caption := 'DPDP Gateway was NOT fully installed';
    WizardForm.FinishedLabel.Caption :=
      'The program files were copied, but the DPDP Gateway service could not be installed, so this computer cannot be paired yet.' + #13#10#13#10 +
      ServiceInstallError + #13#10#13#10 +
      'Details: ' + ExpandConstant('{app}\install-service.log');
    for I := 0 to WizardForm.RunList.Items.Count - 1 do
      WizardForm.RunList.Checked[I] := False;
    WizardForm.RunList.Visible := False;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  ResultCode: Integer;
begin
  // usUninstall runs before the program directory is deleted, so WinSW is still present.
  if CurUninstallStep = usUninstall then
  begin
    if not RunScript('uninstall-service.ps1', '', ResultCode) then
      SuppressibleMsgBox('The DPDP Gateway service could not be removed cleanly (exit code ' + IntToStr(ResultCode) + '). ' +
        'Run "sc.exe delete ' + ServiceName + '" as Administrator.', mbError, MB_OK, IDOK);
  end;
end;
