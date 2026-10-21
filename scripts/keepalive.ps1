<#
.SYNOPSIS
  Runs the keep-alive check (the same one the GitHub workflow runs) from this computer.
.DESCRIPTION
  Runs "bun run keepalive" (tools/keepalive.ts) from the repository root. It signs in as the keep-alive user, reads app_settings,
  scan_status and health, and fails when the data is stale. Read-only. Needs these variables; missing ones are asked for
  (passwords and keys with hidden input) and exist only for this run:
    SUPABASE_URL (defaults to the project URL), ANON_KEY, KEEPALIVE_EMAIL, KEEPALIVE_PASSWORD, optional KEEPALIVE_MAX_AGE_HOURS.
  A good answer is exit code 0 and a line saying the checks passed; "::error::" lines name what failed.
#>
. "$PSScriptRoot\_common.ps1"
function Read-Missing([string]$Name, [switch]$Hidden, [string]$Default) {
  if (Get-Item -Path "Env:$Name" -ErrorAction SilentlyContinue) { return }
  if ($Default) { Set-Item -Path "Env:$Name" -Value $Default; return }
  if ($Hidden) {
    $secure = Read-Host -Prompt "$Name (input hidden)" -AsSecureString
    Set-Item -Path "Env:$Name" -Value ([System.Net.NetworkCredential]::new('', $secure).Password)
  } else {
    Set-Item -Path "Env:$Name" -Value (Read-Host -Prompt $Name)
  }
}
$names = 'SUPABASE_URL', 'ANON_KEY', 'KEEPALIVE_EMAIL', 'KEEPALIVE_PASSWORD'
$before = @{}
foreach ($n in $names) { $before[$n] = [Environment]::GetEnvironmentVariable($n) }
try {
  Read-Missing 'SUPABASE_URL' -Default $script:ProjectUrl
  Read-Missing 'ANON_KEY' -Hidden
  Read-Missing 'KEEPALIVE_EMAIL'
  Read-Missing 'KEEPALIVE_PASSWORD' -Hidden
  Push-Location (Split-Path $PSScriptRoot -Parent)
  try { bun run keepalive; Write-Host "exit code: $LASTEXITCODE" } finally { Pop-Location }
} finally {
  foreach ($n in $names) { [Environment]::SetEnvironmentVariable($n, $before[$n]) }
}
