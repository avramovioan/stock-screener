<#
.SYNOPSIS
  Prints the security headers of the deployed site (like curl -I).
.DESCRIPTION
  Sends a HEAD request to $env:SCREENER_SITE_URL (default https://stock-screener.avramovioan.workers.dev). Read-only, no credentials.
  A good answer is HTTP 200 with content-security-policy, strict-transport-security, x-content-type-options, referrer-policy,
  permissions-policy and x-frame-options present; missing ones are shown in red. strict-transport-security is expected to be missing
  on workers.dev (HSTS is switched on in Cloudflare for a custom domain, go-live part M).
#>
. "$PSScriptRoot\_common.ps1"
Write-Host "HEAD $script:SiteUrl"
$response = Invoke-WebRequest -Uri $script:SiteUrl -Method Head -SkipHttpErrorCheck -MaximumRedirection 0 -ErrorAction SilentlyContinue
Write-Host "HTTP $([int]$response.StatusCode)"
foreach ($name in 'content-security-policy', 'strict-transport-security', 'x-content-type-options', 'referrer-policy', 'permissions-policy', 'x-frame-options', 'cross-origin-opener-policy') {
  $value = $response.Headers[$name]
  if ($value) { Write-Host "${name}: $($value -join '; ')" -ForegroundColor Green }
  else { Write-Host "${name}: (missing)" -ForegroundColor Red }
}
