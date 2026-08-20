<#
.SYNOPSIS
  Polls backend/agent/frontend until healthy, or times out. Exit code 0 = all
  healthy, 1 = timed out.
#>
param(
  [int]$TimeoutSeconds = 120
)

$targets = @(
  @{ Name = 'backend';  Url = 'http://localhost:3001/health' },
  @{ Name = 'agent';    Url = 'http://localhost:7071/health' },
  @{ Name = 'frontend'; Url = 'http://localhost:3000/' }
)

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$pending = $targets.Clone()

while ($pending.Count -gt 0 -and (Get-Date) -lt $deadline) {
  $stillPending = @()
  foreach ($t in $pending) {
    try {
      $resp = Invoke-WebRequest -Uri $t.Url -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
      if ($resp.StatusCode -lt 500) {
        Write-Output "  [ok] $($t.Name) ($($t.Url))"
      } else {
        $stillPending += $t
      }
    } catch {
      $stillPending += $t
    }
  }
  $pending = $stillPending
  if ($pending.Count -gt 0) { Start-Sleep -Seconds 2 }
}

if ($pending.Count -gt 0) {
  Write-Warning "Timed out waiting for: $(($pending | ForEach-Object { $_.Name }) -join ', ')"
  exit 1
}

Write-Output 'All services healthy.'
exit 0
