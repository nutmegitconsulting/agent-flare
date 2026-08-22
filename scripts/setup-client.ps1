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
# 2. Authenticate with Cloudflare Access (opens browser once, caches locally)
# ---------------------------------------------------------------------------
Write-Host "`nAuthenticating with Cloudflare Access..."
Write-Host "  App URL: $AccessAppUrl"

& $CloudflaredPath access login $AccessAppUrl 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Error "cloudflared access login failed (exit code $LASTEXITCODE)."
    exit 1
}
Write-Host "Access authentication successful."

# ---------------------------------------------------------------------------
# 3. Provision tunnel (one-time per user)
# ---------------------------------------------------------------------------
Write-Host "`nProvisioning tunnel via Worker..."

$proc = Start-Process -FilePath $CloudflaredPath `
    -ArgumentList @("access", "curl", "$WorkerUrl/api/client-init", "-s", "-X", "POST") `
    -RedirectStandardOutput "client-init-out.txt" `
    -RedirectStandardError  "client-init-err.txt" `
    -Wait -PassThru -NoNewWindow

$initJson = Get-Content "client-init-out.txt" -Raw -ErrorAction SilentlyContinue
$initErr  = Get-Content "client-init-err.txt"  -Raw -ErrorAction SilentlyContinue
Remove-Item "client-init-out.txt", "client-init-err.txt" -ErrorAction SilentlyContinue

if ($proc.ExitCode -ne 0 -or -not $initJson) {
    Write-Error "cloudflared access curl failed (exit code $($proc.ExitCode)).`nSTDERR:`n$initErr"
    exit 1
}

try {
    $initRes = $initJson | ConvertFrom-Json
} catch {
    Write-Error "Invalid JSON from Worker: $initJson"
    exit 1
}

$hostname = $initRes.hostname
$userId   = $initRes.userId
$sessionToken = $initRes.sessionToken

# Sanitize userId for local use (strip domain from email)
$userId = $userId.Split("@")[0]

if (-not $hostname -or -not $userId) {
    Write-Error "Worker response missing hostname or userId."
    exit 1
}

Write-Host "Tunnel provisioned:"
Write-Host "  User ID:  $userId"
Write-Host "  Hostname: $hostname"

# Display session token for Hermes Desktop GUI
if ($sessionToken) {
    Write-Host ""
    Write-Host "========================================"
    Write-Host "  Hermes Dashboard Session Token"
    Write-Host "========================================"
    Write-Host "$sessionToken"
    Write-Host "========================================"
    Write-Host "Copy the token above into your Hermes Desktop GUI."
    Write-Host ""
}

# ---------------------------------------------------------------------------
# 4. Wake sandbox container
# ---------------------------------------------------------------------------
Write-Host "`nWaking sandbox container..."

$proc2 = Start-Process -FilePath $CloudflaredPath `
    -ArgumentList @("access", "curl", "$WorkerUrl/api/wake", "-s", "-X", "POST") `
    -RedirectStandardOutput "wake-out.txt" `
    -RedirectStandardError  "wake-err.txt" `
    -Wait -PassThru -NoNewWindow

$wakeJson = Get-Content "wake-out.txt" -Raw -ErrorAction SilentlyContinue
$wakeErr  = Get-Content "wake-err.txt"  -Raw -ErrorAction SilentlyContinue
Remove-Item "wake-out.txt", "wake-err.txt" -ErrorAction SilentlyContinue

if ($proc2.ExitCode -ne 0 -or -not $wakeJson) {
    Write-Error "cloudflared access curl failed (exit code $($proc2.ExitCode)).`nSTDERR:`n$wakeErr"
    exit 1
}

try {
    $wakeRes = $wakeJson | ConvertFrom-Json
} catch {
    Write-Error "Invalid JSON from Worker: $wakeJson"
    exit 1
}

# ---------------------------------------------------------------------------
# 5. Poll container until it's actually running (provisioning can take 2-5 min)
# ---------------------------------------------------------------------------
Write-Host "`nSandbox status: $($wakeRes.status)"
Write-Host "Container is waking - this may take 2-5 minutes on first boot..."

$maxWaitSeconds = 300
$pollIntervalSeconds = 10
$elapsed = 0
$isReady = $false
$state = $null

while ($elapsed -lt $maxWaitSeconds) {
    Start-Sleep -Seconds $pollIntervalSeconds
    $elapsed += $pollIntervalSeconds

    $pollProc = Start-Process -FilePath $CloudflaredPath `
        -ArgumentList @("access", "curl", "$WorkerUrl/api/admin/status?userId=$userId", "-s") `
        -RedirectStandardOutput "status-out.txt" `
        -RedirectStandardError  "status-err.txt" `
        -Wait -PassThru -NoNewWindow

    $pollJson = Get-Content "status-out.txt" -Raw -ErrorAction SilentlyContinue
    $pollErr  = Get-Content "status-err.txt"  -Raw -ErrorAction SilentlyContinue
    Remove-Item "status-out.txt", "status-err.txt" -ErrorAction SilentlyContinue

    if ($pollProc.ExitCode -eq 0 -and $pollJson) {
        try {
            $pollRes = $pollJson | ConvertFrom-Json
            $state = $pollRes.state
            $status = if ($state.status) { $state.status } else { "unknown" }

            if ($status -eq "running" -or $status -eq "healthy") {
                Write-Host "Sandbox status: $status (ready!)"
                $isReady = $true
                break
            } elseif ($status -eq "stopped_with_code") {
                Write-Host "Sandbox status: stopped_with_code (exit code $($state.exitCode)) - provisioning may have failed."
                Write-Host "Response: $pollJson"
                exit 1
            } else {
                Write-Host "Sandbox status: $status (${elapsed}s elapsed)..."
            }
        } catch {
            Write-Host "Waiting... (${elapsed}s elapsed, could not parse status)"
        }
    } else {
        Write-Host "Waiting... (${elapsed}s elapsed, status check failed)"
    }
}

if (-not $isReady) {
    Write-Error "Timed out waiting for container to be ready after $maxWaitSeconds seconds.`nLast state: $($state | ConvertTo-Json -Compress)"
    exit 1
}

# ---------------------------------------------------------------------------
# 6. Save connection profile for daily use
# ---------------------------------------------------------------------------
$profileDir = Join-Path $env:USERPROFILE ".hermes-cloudflare-v6"
New-Item -ItemType Directory -Force -Path $profileDir | Out-Null

$profile = @{
    workerUrl    = $WorkerUrl
    hostname     = $hostname
    userId       = $userId
    sessionToken = $sessionToken
    accessAppUrl = $AccessAppUrl
    localPort    = $LocalPort
    createdAt    = (Get-Date -Format "o")
} | ConvertTo-Json -Depth 3

$profilePath = Join-Path $profileDir "profile.json"
Set-Content -Path $profilePath -Value $profile

Write-Host "`nProfile saved to: $profilePath"

# ---------------------------------------------------------------------------
# 7. Start local TCP proxy
# ---------------------------------------------------------------------------
Write-Host "`nStarting cloudflared access tcp proxy..."
Write-Host "  Remote:  $hostname"
Write-Host "  Local:   localhost:$LocalPort"
Write-Host "`nLeave this running. Point Hermes Desktop GUI to localhost:$LocalPort"
Write-Host "Press Ctrl+C to stop.`n"

& $CloudflaredPath access tcp --hostname $hostname --url localhost:$LocalPort
