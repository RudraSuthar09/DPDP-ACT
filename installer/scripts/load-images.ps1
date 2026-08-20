param([string]$InstallRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path)
Get-ChildItem (Join-Path $InstallRoot 'dist\images\*.tar') | ForEach-Object {
  Write-Output "Loading $($_.Name)..."
  docker load -i $_.FullName
}
