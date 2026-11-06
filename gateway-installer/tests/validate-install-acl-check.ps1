<#
  Validates install-service.ps1's Assert-AdminOnlyWritable WITHOUT running the
  rest of the script (no admin needed): the function is loaded from the
  script's own AST, so the real code is tested.

  - Passes for a folder with the standard Program Files permissions
    (Users: Read & execute, inherit-only GENERIC_READ|GENERIC_EXECUTE,
    CREATOR OWNER, TrustedInstaller). Until Phase 6 it did NOT: the write
    mask contained read bits, so every real install was refused.
    Uses the REAL installed folder when present, plus a temp copy of the
    Program Files ACL.
  - Refuses folders/files where Users/Everyone/Authenticated Users can write
    (Modify, Write, GENERIC_WRITE, Delete, ChangePermissions).

    powershell -NoProfile -ExecutionPolicy Bypass -File gateway-installer\tests\validate-install-acl-check.ps1 [-InstalledDir 'C:\Program Files\DPDP Gateway']
#>
param([string]$InstalledDir = 'C:\Program Files\DPDP Gateway')
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$script = Join-Path $PSScriptRoot '..\service\install-service.ps1'
$ast = [System.Management.Automation.Language.Parser]::ParseFile($script, [ref]$null, [ref]$null)
$fn = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Assert-AdminOnlyWritable' }, $true)
if (-not $fn) { throw 'Assert-AdminOnlyWritable not found in install-service.ps1' }
. ([scriptblock]::Create($fn.Extent.Text))

$passed = 0; $failed = 0
function Check([string]$Name, [scriptblock]$Body, [bool]$ExpectRefusal) {
  $refused = $false
  try { & $Body } catch { $refused = $_.Exception.Message -like 'Refusing to install*' }
  if ($refused -eq $ExpectRefusal) { $script:passed++; Write-Host "  ok    $Name" } else { $script:failed++; Write-Host "  FAIL  $Name (refused=$refused)" }
}

$root = Join-Path ([IO.Path]::GetTempPath()) ('dpdp-aclcheck-' + [Guid]::NewGuid().ToString('N'))
function New-Case([string]$Name, [string[]]$Grants, [switch]$ChildFile) {
  $d = Join-Path $root $Name
  New-Item -ItemType Directory -Force -Path $d | Out-Null
  $target = $d
  if ($ChildFile) { $target = Join-Path $d 'child.txt'; Set-Content -LiteralPath $target -Value 'x' }
  & icacls.exe $target /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" /Q | Out-Null
  if ($ChildFile) { & icacls.exe $target /grant:r "*S-1-5-18:F" "*S-1-5-32-544:F" /Q | Out-Null }
  foreach ($g in $Grants) { & icacls.exe $target /grant $g /Q | Out-Null }
  return $d
}

try {
  Write-Host 'Assert-AdminOnlyWritable:'
  if (Test-Path -LiteralPath $InstalledDir) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    Check "REAL installed folder ($InstalledDir) is accepted" { Assert-AdminOnlyWritable $InstalledDir } $false
    Write-Host "        ($([int]$sw.Elapsed.TotalSeconds) s for $(@(Get-ChildItem -LiteralPath $InstalledDir -Recurse -Force -ErrorAction SilentlyContinue).Count) items)"
  } else {
    Write-Host "  skip  REAL installed folder (not present: $InstalledDir)"
  }

  # The standard Program Files grants for Users, as on a real install.
  $standard = @('*S-1-5-32-545:(RX)', '*S-1-5-32-545:(OI)(CI)(IO)(GR,GE)', '*S-1-3-0:(OI)(CI)(IO)(F)')
  Check 'standard Program Files permissions (Users RX + inherit-only GR,GE + CREATOR OWNER) are accepted' { Assert-AdminOnlyWritable (New-Case 'standard' $standard) } $false
  Check 'Users: Modify is refused' { Assert-AdminOnlyWritable (New-Case 'users-modify' @('*S-1-5-32-545:(OI)(CI)M')) } $true
  Check 'Users: Write only is refused' { Assert-AdminOnlyWritable (New-Case 'users-write' @('*S-1-5-32-545:(W)')) } $true
  Check 'Authenticated Users: inherit-only GENERIC_WRITE is refused' { Assert-AdminOnlyWritable (New-Case 'auth-gw' @('*S-1-5-11:(OI)(CI)(IO)(GW)')) } $true
  Check 'Everyone: Delete is refused' { Assert-AdminOnlyWritable (New-Case 'everyone-delete' @('*S-1-1-0:(D)')) } $true
  Check 'Users: ChangePermissions is refused' { Assert-AdminOnlyWritable (New-Case 'users-wdac' @('*S-1-5-32-545:(WDAC)')) } $true
  Check 'a writable FILE inside an otherwise safe folder is refused' { Assert-AdminOnlyWritable (New-Case 'child-file' @('*S-1-5-32-545:(M)') -ChildFile) } $true
} finally {
  if (Test-Path $root) { & icacls.exe $root /reset /T /Q 2>$null | Out-Null; Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Host ''
Write-Host "$passed passed, $failed failed"
if ($failed -gt 0) { exit 1 }
exit 0
