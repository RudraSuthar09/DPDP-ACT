; DPDP Platform -- main Windows installer (Inno Setup): DPDP-Setup.exe
;
; Installs:
;   1. The DPDP Platform desktop app: the raw Electron runtime + desktop\src
;      (staged by desktop\scripts\package.ps1). It opens the hosted app at
;      https://app.hhgoa.work. Nothing runs locally: no Docker, no backend,
;      no database, no .env, no keys.
;   2. Optionally (task "gateway", on by default) the DPDP Enterprise Gateway,
;      by running the UNMODIFIED standalone Gateway installer
;      (gateway-installer\dist\DPDPGatewaySetup-<version>.exe) silently, then
;      verifying the Windows service with verify-gateway-service.ps1.
;
; This is a NEW installer. installer\DPDP-Platform-Setup.iss (the older
; Docker-based, per-user installer) is left untouched. The Gateway installer
; stays independently usable for separate machines.
;
; Admin is required because the Gateway is a Windows service. One UAC prompt
; covers both; the bundled Gateway installer inherits this elevation.
;
; Build (from the repo root):
;   powershell -ExecutionPolicy Bypass -File gateway-installer\scripts\build-agent-bundle.ps1 -Compile
;   powershell -ExecutionPolicy Bypass -File desktop\scripts\package.ps1
;   iscc installer\DPDP-Setup.iss
; Output: installer\dist\DPDP-Setup.exe
;
; SIGNING: unsigned (no code-signing certificate yet) -- a release blocker,
; same as the Gateway installer (see gateway-installer\README.md).

#define MyAppName "DPDP Platform"
#define MyAppVersion "1.1.0"
#define MyAppPublisher "DPDP"
#define MyAppURL "https://app.hhgoa.work"
#ifndef GatewayVersion
  #define GatewayVersion "0.1.0"
#endif
#define GatewaySetupName "DPDPGatewaySetup-" + GatewayVersion + ".exe"
#define GatewayServiceName "DPDPGatewayAgent"

[Setup]
; A GUID distinct from DPDP-Platform-Setup.iss (8B6B0F1E-...) and from the
; Gateway (A3E1C9F4-...): a different product entry with its own uninstaller.
AppId={{5D2C7A41-9E3B-4F6D-8A1C-2B7E9F04D6A3}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
DefaultDirName={autopf}\DPDP Platform
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir=dist
OutputBaseFilename=DPDP-Setup
Compression=lzma2
SolidCompression=yes
UninstallDisplayName={#MyAppName}
UninstallDisplayIcon={app}\electron\electron.exe
SetupLogging=yes
WizardStyle=modern

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "gateway"; Description: "Install the DPDP Enterprise Gateway (Windows service that connects this computer's databases and folders to DPDP)"; GroupDescription: "Components:"
Name: "desktopicon"; Description: "Create a &desktop icon"; GroupDescription: "Additional icons:"

[Files]
; Desktop app only: the Electron runtime and the app source. Nothing else.
Source: "..\desktop\dist\electron\*"; DestDir: "{app}\electron"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\desktop\dist\app\*"; DestDir: "{app}\app"; Flags: ignoreversion recursesubdirs createallsubdirs
; Extracted to {tmp} only when needed (ExtractTemporaryFile below), never
; installed; {tmp} is removed when Setup ends.
Source: "..\gateway-installer\dist\{#GatewaySetupName}"; Flags: dontcopy
Source: "verify-gateway-service.ps1"; Flags: dontcopy

[Icons]
Name: "{autoprograms}\DPDP Platform"; Filename: "{app}\electron\electron.exe"; Parameters: """{app}\app"""; WorkingDir: "{app}\electron"
Name: "{autodesktop}\DPDP Platform"; Filename: "{app}\electron\electron.exe"; Parameters: """{app}\app"""; WorkingDir: "{app}\electron"; Tasks: desktopicon

[UninstallDelete]
; Written during install (not part of [Files]). Uninstalling DPDP Platform
; does NOT uninstall the Gateway: it has its own entry in Apps & features, and
; its device credentials are kept (see gateway-installer\README.md).
Type: files; Name: "{app}\gateway-install.log"

[Run]
; runasoriginaluser: the apps must NOT inherit the installer's elevation.
Filename: "{app}\electron\electron.exe"; Parameters: """{app}\app"""; WorkingDir: "{app}\electron"; \
  Description: "Open DPDP Platform"; Flags: postinstall nowait skipifsilent runasoriginaluser
; The Gateway's own Setup app (installed by the Gateway installer). Pairing
; needs a one-time code from DPDP: Data Sources -> Connect Enterprise Gateway.
Filename: "{autopf}\DPDP Gateway\gateway-app\electron\electron.exe"; Parameters: """{autopf}\DPDP Gateway\gateway-app\app"""; \
  Description: "Pair the DPDP Gateway with your workspace (needs a code from DPDP: Data Sources > Connect Enterprise Gateway)"; \
  Flags: postinstall nowait skipifsilent runasoriginaluser unchecked; Tasks: gateway; Check: GatewayInstalledOk

[Code]
var
  GatewayAttempted: Boolean;
  GatewayFailed: Boolean;
  GatewayError: String;

function GatewayInstalledOk(): Boolean;
begin
  Result := GatewayAttempted and (not GatewayFailed);
end;

function PowerShellExe(): String;
begin
  Result := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
end;

function VerifyMessage(Code: Integer): String;
begin
  case Code of
    10: Result := 'The Gateway Windows service ({#GatewayServiceName}) was not registered.';
    11: Result := 'The Gateway Windows service is not set to start automatically.';
    12: Result := 'The Gateway Windows service is not running under its own account (NT SERVICE\{#GatewayServiceName}).';
    13: Result := 'The Gateway Windows service was registered but did not reach the Running state.';
  else
    Result := 'The Gateway Windows service could not be checked (code ' + IntToStr(Code) + ').';
  end;
end;

procedure InstallGateway();
var
  SetupExe, VerifyScript, GatewayLog, ErrFile: String;
  ResultCode: Integer;
  Detail: AnsiString;
begin
  GatewayAttempted := True;
  GatewayFailed := False;
  GatewayError := '';

  WizardForm.StatusLabel.Caption := 'Installing the DPDP Enterprise Gateway service...';
  ExtractTemporaryFile('{#GatewaySetupName}');
  ExtractTemporaryFile('verify-gateway-service.ps1');
  SetupExe := ExpandConstant('{tmp}\{#GatewaySetupName}');
  VerifyScript := ExpandConstant('{tmp}\verify-gateway-service.ps1');
  GatewayLog := ExpandConstant('{app}\gateway-install.log');

  { The unmodified Gateway installer, silently. It inherits this Setup's
    elevation. /SUPPRESSMSGBOXES: its own failure dialog would otherwise
    block a silent run; the failure is detected by the check below. }
  if not Exec(SetupExe, '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- /LOG="' + GatewayLog + '"',
              '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
  begin
    GatewayFailed := True;
    GatewayError := 'The Gateway installer could not be started: ' + SysErrorMessage(ResultCode);
  end
  else if ResultCode <> 0 then
  begin
    GatewayFailed := True;
    GatewayError := 'The Gateway installer exited with code ' + IntToStr(ResultCode) + '.';
  end;

  { Never trust the exit code alone: the Gateway installer exits 0 even when
    its service step failed. Verify registered + Automatic + account + Running. }
  if not GatewayFailed then
  begin
    WizardForm.StatusLabel.Caption := 'Checking the DPDP Gateway service...';
    if not Exec(PowerShellExe(), '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + VerifyScript + '"',
                '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    begin
      GatewayFailed := True;
      GatewayError := 'The Gateway service check could not be run: ' + SysErrorMessage(ResultCode);
    end
    else if ResultCode <> 0 then
    begin
      GatewayFailed := True;
      GatewayError := VerifyMessage(ResultCode);
    end;
  end;

  if GatewayFailed then
  begin
    { The Gateway installer's own explanation, when it wrote one. }
    ErrFile := ExpandConstant('{autopf}\DPDP Gateway\install-service.error.txt');
    if LoadStringFromFile(ErrFile, Detail) and (Trim(String(Detail)) <> '') then
      GatewayError := GatewayError + #13#10#13#10 + Trim(String(Detail));
    Log('DPDP Gateway installation FAILED: ' + GatewayError);
    SuppressibleMsgBox('DPDP Platform was installed, but the DPDP Enterprise Gateway was NOT installed correctly.' + #13#10#13#10 +
      GatewayError + #13#10#13#10 +
      'Logs: ' + GatewayLog + #13#10 + '      ' + ExpandConstant('{autopf}\DPDP Gateway\install-service.log') + #13#10#13#10 +
      'You can retry later with the standalone DPDP Gateway installer.', mbCriticalError, MB_OK, IDOK);
  end
  else
    Log('DPDP Gateway installed and verified: service registered, Automatic, running.');
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if (CurStep = ssPostInstall) and WizardIsTaskSelected('gateway') then
    InstallGateway();
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if (CurPageID = wpFinished) and GatewayFailed then
  begin
    WizardForm.FinishedHeadingLabel.Caption := 'DPDP Gateway was NOT installed';
    WizardForm.FinishedLabel.Caption :=
      'The DPDP Platform app was installed, but the DPDP Enterprise Gateway service was not installed correctly.' + #13#10#13#10 +
      GatewayError + #13#10#13#10 +
      'Details: ' + ExpandConstant('{app}\gateway-install.log');
  end;
end;

{ A silent/scripted install must not report success either: a non-zero exit
  code when the Gateway was requested but failed. 100 is outside Inno's own
  1-8 range. }
function GetCustomSetupExitCode(): Integer;
begin
  if GatewayFailed then
    Result := 100
  else
    Result := 0;
end;
