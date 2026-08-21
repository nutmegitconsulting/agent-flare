# Hermes V6 Windows Client Setup
# Run once per machine. Provisions a tunnel, wakes the sandbox, and starts the local TCP proxy.
# Requires: cloudflared CLI (winget install --id Cloudflare.cloudflared)

param(
    [string]$WorkerUrl    = "https://hermes-agent.hermes-test.app",
    [string]$AccessAppUrl = "https://hermes-agent.hermes-test.app",
    [string]$LocalPort    = "9119",
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
# 2. Authenticate with Cloudflare Access (non-interactive where possible)
# ---------------------------------------------------------------------------
Write-Host "`nAuthenticating with Cloudflare Access..."
Write-Host "  App URL: $AccessAppUrl"

# Try silent token fetch first (cached from previous login)
$jwt = & $CloudflaredPath access token -app=$AccessAppUrl 2> $null

if (-not $jwt) {
    Write-Host "No cached token. Opening browser for login..."
    & $CloudflaredPath access login $AccessAppUrl 2> $null

    $jwt = & $CloudflaredPath access token -app=$AccessAppUrl 2> $null
    if (-not $jwt) {
        Write-Error "Access authentication failed. Complete browser login and retry."
        exit 1
    }
}

Write-Host "Access authentication successful."

# ---------------------------------------------------------------------------
# 3. Provision tunnel (one-time per user)
# ---------------------------------------------------------------------------
Write-Host "`nProvisioning tunnel via Worker..."

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
Write-Host "`nWaking sandbox container..."

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
    localPort    = $LocalPort
    createdAt    = (Get-Date -Format "o")
} | ConvertTo-Json -Depth 3

$profilePath = Join-Path $profileDir "profile.json"
Set-Content -Path $profilePath -Value $profile

Write-Host "`nProfile saved to: $profilePath"

# ---------------------------------------------------------------------------
# 6. Start local TCP proxy
# ---------------------------------------------------------------------------
Write-Host "`nStarting cloudflared access tcp proxy..."
Write-Host "  Remote:  $hostname"
Write-Host "  Local:   localhost:$LocalPort"
Write-Host "`nLeave this running. Point Hermes Desktop GUI to localhost:$LocalPort"
Write-Host "Press Ctrl+C to stop.`n"

& $CloudflaredPath access tcp --hostname $hostname --url localhost:$LocalPort
