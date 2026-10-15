<#
  .SYNOPSIS
    The ONE elevation-gated action the Gateway Setup app (gateway-app/) ever
    runs. Installed to {app} (Program Files, writable only by
    Administrators). Started via Start-Process -Verb RunAs, so every
    invocation is a UAC consent the user sees.

  .DESCRIPTION
    Actions:
      pair        queue a pairing code + workspace URL for the service
      add-source  queue one data source (may contain a database password)
      remove      ask the service to de-enrol and clear its credential
      restart     restart the service

    Security properties:
      - Self-locating: the install directory is derived from this script's
        own path, never taken from the caller, so a caller cannot point it
        at a different node.exe or script.
      - Secrets never appear on any command line (visible to process
        listings and to Windows process-creation auditing). They arrive in
        a request file in the CALLER's temp directory (owner-only ACL),
        whose name must match dpdp-gw-request-<32 hex>.json, which must not
        be a link, must be <= 64 KiB, and which is overwritten and deleted
        as soon as it has been read. The secret is then handed to
        cli-pair.js on stdin.
      - It writes only through agent/dist/cli-pair.js, which validates
        everything with the same code the service uses. It never decrypts
        anything: the service account encrypted the credentials, and this
        process runs as the consenting administrator, a different account.
      - The outcome (ok / error text, never a secret) is written to
        dpdp-gw-result-<same hex>.json beside the request, because an
        elevated process's stdout cannot be captured by its non-elevated
        caller.
#>
#Requires -RunAsAdministrator
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('pair', 'add-source', 'remove', 'restart')]
  [string]$Action,

  [Parameter(Mandatory = $true)]
  [string]$RequestFile
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ServiceName = 'DPDPGatewayAgent'
$InstallDir = Split-Path -Parent $PSCommandPath
$NodeExe = Join-Path $InstallDir 'runtime\node.exe'
$CliScript = Join-Path $InstallDir 'agent\dist\cli-pair.js'
$Utf8 = New-Object System.Text.UTF8Encoding($false)
$ResultFile = $null

function Write-Result([bool]$Ok, [string]$ErrorText) {
  if (-not $ResultFile) { return }
  $payload = if ($Ok) { @{ ok = $true } } else { @{ ok = $false; error = $ErrorText } }
  [System.IO.File]::WriteAllText($ResultFile, (ConvertTo-Json $payload -Compress), $Utf8)
}

function Read-RequestFile([string]$Path) {
  $leaf = Split-Path -Leaf $Path
  if ($leaf -notmatch '^dpdp-gw-request-([0-9a-f]{32})\.json$') {
    throw 'The request file name was rejected.'
  }
  $id = $Matches[1]
  $item = Get-Item -LiteralPath $Path -Force
  if ($item.PSIsContainer) { throw 'The request file is a directory.' }
  if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'The request file must not be a link.' }
  if ($item.Length -gt 65536) { throw 'The request file is too large.' }

  $script:ResultFile = Join-Path $item.DirectoryName "dpdp-gw-result-$id.json"
  try {
    return [System.IO.File]::ReadAllText($item.FullName, $Utf8)
  } finally {
    try { [System.IO.File]::WriteAllBytes($item.FullName, (New-Object byte[] ([int]$item.Length))) } catch {}
    Remove-Item -LiteralPath $item.FullName -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-Cli([string]$CliAction, [string]$StdinText) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $NodeExe
  # Constant arguments only -- no caller data is ever placed here.
  $psi.Arguments = "`"$CliScript`" $CliAction" + $(if ($null -ne $StdinText) { ' --stdin' } else { '' })
  $psi.WorkingDirectory = $InstallDir
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = $Utf8
  $psi.StandardErrorEncoding = $Utf8

  $proc = [System.Diagnostics.Process]::Start($psi)
  # Write raw UTF-8 bytes to the BASE stream and close THAT: closing the
  # StreamWriter wrapper would flush its encoding preamble (a BOM) after our
  # bytes.
  $stdin = $proc.StandardInput.BaseStream
  if ($null -ne $StdinText) {
    $bytes = $Utf8.GetBytes($StdinText)
    $stdin.Write($bytes, 0, $bytes.Length)
    $stdin.Flush()
  }
  $stdin.Close()
  $stdout = $proc.StandardOutput.ReadToEnd()
  $stderr = $proc.StandardError.ReadToEnd()
  $proc.WaitForExit()

  $line = (($stdout, $stderr) -join "`n").Trim().Split("`n") | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1
  $parsed = $null
  if ($line) { try { $parsed = $line | ConvertFrom-Json } catch {} }
  if ($proc.ExitCode -ne 0 -or -not $parsed -or -not $parsed.ok) {
    if ($parsed -and $parsed.PSObject.Properties['error']) { throw [string]$parsed.error }
    throw "The Gateway configuration step failed (exit $($proc.ExitCode))."
  }
}

function Restart-Gateway {
  $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if (-not $svc) { throw "The '$ServiceName' service is not installed. Reinstall DPDP Gateway." }
  Restart-Service -Name $ServiceName -Force
  $svc.WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
}

try {
  foreach ($required in @($NodeExe, $CliScript)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "A Gateway file is missing ($required). Reinstall DPDP Gateway." }
  }

  $requestText = Read-RequestFile $RequestFile

  switch ($Action) {
    'pair'       { Invoke-Cli 'pair' $requestText; Restart-Gateway }
    'add-source' { Invoke-Cli 'add-source' $requestText; Restart-Gateway }
    'remove'     { Invoke-Cli 'remove' $null; Restart-Gateway }
    'restart'    { Restart-Gateway }
  }

  Write-Result $true $null
  exit 0
} catch {
  Write-Result $false ([string]$_.Exception.Message)
  exit 1
} finally {
  if (Get-Variable -Name requestText -ErrorAction SilentlyContinue) { $requestText = $null }
}
