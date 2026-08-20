# Hermes V6 Client Setup
# Run once per Windows machine, then use hermes-connect.ps1 for daily use.

param(
  [Parameter(Mandatory=$true)]
  [string]$WorkerUrl,

  [string]$AccessAppUrl = "https://hermes-agent.yourdomain.com",
  [string]$CloudflaredPath = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
)

# ---------------------------------------------------------------------------
# 1. Verify cloudflared is installed
# ---------------------------------------------------------------------------
if (-not $CloudflaredPath) {
  Write-Host "cloudflared not found. Install it first:"
  Write-Host "  winget install --id Cloudflare.cloudflared"
  exit 1
}

Write-Host "cloudflared found at: $CloudflaredPath"

# ---------------------------------------------------------------------------
# 2. Get Cloudflare Access JWT
# ---------------------------------------------------------------------------
Write-Host "Checking Cloudflare Access authentication..."
$jwt = & $CloudflaredPath access token -app=$AccessAppUrl 2> $null

if (-not $jwt) {
  Write-Host "Not authenticated. Opening browser for Cloudflare Access login..."
  Start-Process $AccessAppUrl
  Read-Host "Sign in with your identity provider, then press Enter to continue"

  $jwt = & $CloudflaredPath access token -app=$AccessAppUrl 2> $null
  if (-not $jwt) {
    Write-Error "Failed to get Access JWT. Ensure you completed browser authentication."
    exit 1
  }
}

Write-Host "Access JWT acquired."

# ---------------------------------------------------------------------------
# 3. Provision tunnel (one-time per user)
# ---------------------------------------------------------------------------
Write-Host "Provisioning tunnel via Worker..."

try {
  $initRes = Invoke-RestMethod -Uri "$WorkerUrl/api/client-init" `
    -Method POST `
    -Headers @{ "CF-Access-Jwt-Assertion" = $jwt } `
    -ContentType "application/json"
} catch {
  Write-Error "Failed to provision tunnel: $($_.Exception.Message)"
  exit 1
}

$hostname = $initRes.hostname
$userId   = $initRes.userId

Write-Host "Tunnel provisioned:"
Write-Host "  User ID:  $userId"
Write-Host "  Hostname: $hostname"

# ---------------------------------------------------------------------------
# 4. Wake sandbox container
# ---------------------------------------------------------------------------
Write-Host "Waking sandbox container..."

try {
  $wakeRes = Invoke-RestMethod -Uri "$WorkerUrl/api/wake" `
    -Method POST `
    -Headers @{ "CF-Access-Jwt-Assertion" = $jwt } `
    -ContentType "application/json"
  Write-Host "Sandbox status: $($wakeRes.status)"
} catch {
  Write-Error "Failed to wake sandbox: $($_.Exception.Message)"
  exit 1
}

# ---------------------------------------------------------------------------
# 5. Save connection profile for daily use
# ---------------------------------------------------------------------------
$profileDir = Join-Path $env:USERPROFILE ".hermes-cloudflare-v6"
New-Item -ItemType Directory -Force -Path $profileDir | Out-Null

$profile = @{
  workerUrl    = $WorkerUrl
  hostname     = $hostname
  userId       = $userId
  accessAppUrl = $AccessAppUrl
} | ConvertTo-Json -Depth 3

$profilePath = Join-Path $profileDir "profile.json"
Set-Content -Path $profilePath -Value $profile

Write-Host "Profile saved to: $profilePath"

# ---------------------------------------------------------------------------
# 6. Start local TCP proxy
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "Starting cloudflared access tcp proxy..."
Write-Host "This opens 127.0.0.1:9119 for the Hermes Desktop GUI."
Write-Host ""
Write-Host "Ctrl+C to stop."
Write-Host ""

& $CloudflaredPath access tcp --hostname $hostname --url localhost:9119
