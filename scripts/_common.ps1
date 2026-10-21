# Shared helpers for the scripts in this folder. Dot-source it: . "$PSScriptRoot\_common.ps1"
#
# Configuration (environment variables, all optional except the secret when you do not want a prompt):
#   SCREENER_SUPABASE_URL  project URL, default https://pkfptuwwgyvjxvumqika.supabase.co
#   SCREENER_SITE_URL      site URL, default https://stock-screener.avramovioan.workers.dev
#   SCREENER_CRON_SECRET   the CRON_SHARED_SECRET; when unset the scripts ask for it once per session (hidden input)

$script:ProjectUrl = if ($env:SCREENER_SUPABASE_URL) { $env:SCREENER_SUPABASE_URL.TrimEnd('/') } else { 'https://pkfptuwwgyvjxvumqika.supabase.co' }
$script:SiteUrl = if ($env:SCREENER_SITE_URL) { $env:SCREENER_SITE_URL.TrimEnd('/') } else { 'https://stock-screener.avramovioan.workers.dev' }
$script:CachedCronSecret = $null

function Get-CronSecret {
  <# Returns the cron secret as a plain string: $env:SCREENER_CRON_SECRET, else one hidden prompt per session. Never printed. #>
  if ($env:SCREENER_CRON_SECRET) { return $env:SCREENER_CRON_SECRET }
  if (-not $script:CachedCronSecret) {
    $secure = Read-Host -Prompt 'CRON_SHARED_SECRET (input hidden)' -AsSecureString
    $script:CachedCronSecret = [System.Net.NetworkCredential]::new('', $secure).Password
    if (-not $script:CachedCronSecret) { throw 'No secret entered.' }
  }
  return $script:CachedCronSecret
}

function Invoke-ScreenerFunction {
  <#
  Calls <project>/functions/v1/<Name>, prints "HTTP <code>" and the JSON answer pretty-printed, returns the parsed object.
  -Auth cron sends the x-cron-secret header; -Auth none sends no credentials.
  #>
  param(
    [Parameter(Mandatory)][string]$Name,
    $Body = $null,
    [ValidateSet('cron', 'none')][string]$Auth = 'none',
    [string]$Method = 'POST'
  )
  $headers = @{}
  if ($Auth -eq 'cron') { $headers['x-cron-secret'] = Get-CronSecret }
  $uri = "$script:ProjectUrl/functions/v1/$Name"
  $request = @{ Uri = $uri; Method = $Method; Headers = $headers; SkipHttpErrorCheck = $true; StatusCodeVariable = 'status' }
  if ($null -ne $Body -and $Method -ne 'GET') {
    $request['ContentType'] = 'application/json'
    $request['Body'] = if ($Body -is [string]) { $Body } else { $Body | ConvertTo-Json -Depth 10 -Compress }
  }
  Write-Host "$Method $uri"
  $answer = Invoke-RestMethod @request
  Write-Host "HTTP $status"
  if ($answer -is [string]) { Write-Host $answer } else { Write-Host ($answer | ConvertTo-Json -Depth 10) }
  return $answer
}

function Confirm-Action {
  <# Asks Y/N before an action with side effects. -Force skips the question. Returns $true to go on. #>
  param([Parameter(Mandatory)][string]$Message, [switch]$Force)
  if ($Force) { return $true }
  $reply = Read-Host -Prompt "$Message Continue? (y/N)"
  if ($reply -match '^(y|yes)$') { return $true }
  Write-Host 'Cancelled.'
  return $false
}
