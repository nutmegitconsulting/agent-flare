# Hermes V6 Windows Client Setup
# Run once per machine. Provisions a tunnel, wakes the sandbox, and starts the local TCP proxy.
# Requires: cloudflared CLI (winget install --id Cloudflare.cloudflared)

param(
    [string]$WorkerUrl    = "https://hermes.nutmegit.com",
    [string]$AccessAppUrl = "https://hermes.nutmegit.com",
    [string]$LocalPort    = "9119",
    [string]$CloudflaredPath = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source,
    # V8 (optional): custom domain of your Cloudflare AI Gateway (Access-protected).
    # When set, the script does a second Access login for the gateway, then
    # delivers scripts/reference-providers.json + the gateway Access JWT to the
    # worker, which injects the custom_providers section on wake.
    [string]$GatewayDomain = ""
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
# 2. Authenticate with Cloudflare Access (at most ONE browser prompt per run)
#    Reuse strategy: probe the local cloudflared token cache first; if a valid
#    app token exists, skip the browser entirely. Otherwise run login ONCE,
#    verify it actually returned a token, and reuse that JWT explicitly on
#    every request below so no per-request challenge can ever pop up.
# ---------------------------------------------------------------------------
Write-Host "`nAuthenticating with Cloudflare Access..."
Write-Host "  App URL: $AccessAppUrl"

$jwt = $null
$probeOut = & $CloudflaredPath access token -app=$AccessAppUrl 2>$null
if ($LASTEXITCODE -eq 0 -and $probeOut) {
    $candidate = @($probeOut | Where-Object { $_ -match "^eyJ" }) | Select-Object -First 1
    if ($candidate) { $jwt = $candidate.Trim() }
}

if (-not $jwt) {
    Write-Host "  No cached token - opening the browser once for authorization..."
    $loginOut = (& $CloudflaredPath access login $AccessAppUrl 2>&1) | Out-String
    if ($loginOut -match "eyJ[A-Za-z0-9_\-\.=]+") {
        $jwt = $Matches[0].Trim()
    }
    if (-not $jwt) {
        Write-Error "cloudflared access login did not produce a token (exit code $LASTEXITCODE). Login output:`n$loginOut"
        exit 1
    }
}
Write-Host "Access token ready - it will be reused for every request (no further prompts)."

# All authenticated requests go through this helper: URL first (cloudflared
# requires the URL before flags), then the acquired JWT as an explicit header
# so individual requests never fall back to their own (possibly empty) cache.
function Invoke-AccessCurl {
    param([Parameter(Mandatory)][string]$Url, [string[]]$ExtraArgs = @())
    $output = & $CloudflaredPath access curl $Url -H "CF-Access-Jwt-Assertion: $jwt" @ExtraArgs 2>&1
    [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = (($output | Out-String).Trim()) }
}

# ---------------------------------------------------------------------------
# 3. Provision tunnel (one-time per user)
# ---------------------------------------------------------------------------
Write-Host "`nProvisioning tunnel via Worker..."

$initRes = Invoke-AccessCurl -Url "$WorkerUrl/api/client-init" -ExtraArgs @("-X", "POST")
if ($initRes.ExitCode -ne 0 -or -not $initRes.Output) {
    Write-Error "cloudflared access curl failed (exit code $($initRes.ExitCode)).`nOutput:`n$($initRes.Output)"
    exit 1
}
$initJson = $initRes.Output

try {
    $init = $initJson | ConvertFrom-Json
} catch {
    Write-Error "Invalid JSON from Worker: $initJson"
    exit 1
}

$hostname = $init.hostname
$userId   = $init.userId
$sessionToken = $init.sessionToken

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
# 3b. AI Gateway providers (V8, optional)
#     If -GatewayDomain is set: second Access login for the gateway's custom
#     domain, then deliver the provider config (reference-providers.json,
#     edited for your gateway) + the Access JWT to the worker. The worker
#     injects the custom_providers section into config.yaml on the next wake.
# ---------------------------------------------------------------------------
$providersDelivered = $false
if ($GatewayDomain) {
    $gatewayBase = $GatewayDomain.TrimEnd("/")
    Write-Host "`nAuthenticating with AI Gateway Access..."
    Write-Host "  Gateway domain: $gatewayBase"
    # Gateway is a different Access app: try cached token first, one login if absent.
    $gwToken = $null
    $gwProbe = & $CloudflaredPath access token -app=$gatewayBase 2>$null
    if ($LASTEXITCODE -eq 0) {
        $gwCandidate = @($gwProbe | Where-Object { $_ -match "^eyJ" }) | Select-Object -First 1
        if ($gwCandidate) { $gwToken = $gwCandidate.Trim() }
    }
    if (-not $gwToken) {
        $gwLoginOut = (& $CloudflaredPath access login $gatewayBase 2>&1) | Out-String
        if ($gwLoginOut -match "eyJ[A-Za-z0-9_\-\.=]+") {
            $gwToken = $Matches[0].Trim()
        }
    }

    if (-not $gwToken -or $gwToken -match "^(https?://|Error|error)") {
        Write-Host "Gateway Access login did not return a token. Skipping provider setup."
        Write-Host "  (Finish the browser login and re-run this script.)"
    } else {
        $providersFile = Join-Path $PSScriptRoot "reference-providers.json"
        if (-not (Test-Path $providersFile)) {
            Write-Error "Providers file not found: $providersFile. Edit scripts/reference-providers.json for your gateway first."
            exit 1
        }
        $providersJson = Get-Content $providersFile -Raw

        Write-Host "Delivering provider config to worker..."
        $putRes = Invoke-AccessCurl -Url "$WorkerUrl/api/admin/providers?userId=$userId" -ExtraArgs @("-X", "PUT", "-H", "Content-Type: application/json", "-d", $providersJson)
        $putOut = $putRes.Output
        if ($putRes.ExitCode -ne 0 -or -not $putOut) {
            Write-Warning "Failed to PUT providers (will retry next run): $putOut"
        } else {
            Write-Host "  Providers stored: $putOut"
            $jwtBody = ('{{"jwt":"{0}"}}' -f $gwToken.Replace('\', '\\').Replace('"', '\"'))
            $jwtRes = Invoke-AccessCurl -Url "$WorkerUrl/api/admin/gateway-jwt?userId=$userId" -ExtraArgs @("-X", "POST", "-H", "Content-Type: application/json", "-d", $jwtBody)
            $jwtOut = $jwtRes.Output
            if ($jwtRes.ExitCode -ne 0 -or -not $jwtOut) {
                Write-Warning "Failed to POST gateway JWT (will retry next run): $jwtOut"
            } else {
                Write-Host "  Gateway JWT stored: $jwtOut"
                $providersDelivered = $true
            }
        }
    }
}

# ---------------------------------------------------------------------------
# 4. Wake sandbox container
# ---------------------------------------------------------------------------
Write-Host "`nWaking sandbox container..."

$wakeRes = Invoke-AccessCurl -Url "$WorkerUrl/api/wake" -ExtraArgs @("-X", "POST")
if ($wakeRes.ExitCode -ne 0 -or -not $wakeRes.Output) {
    Write-Error "cloudflared access curl failed (exit code $($wakeRes.ExitCode)).`nOutput:`n$($wakeRes.Output)"
    exit 1
}
$wakeJson = $wakeRes.Output

try {
    $wake = $wakeJson | ConvertFrom-Json
} catch {
    Write-Error "Invalid JSON from Worker: $wakeJson"
    exit 1
}

# ---------------------------------------------------------------------------
# 5. Poll container platform status AND startup script progress in real-time
# ---------------------------------------------------------------------------
Write-Host "`nSandbox status: $($wake.status)"
Write-Host "Container is waking - this may take 2-5 minutes on first boot..."

$maxWaitSeconds = 300
$pollIntervalSeconds = 2
$elapsed = 0
$isReady = $false
$startupComplete = $false
$lastStartupStatus = ""
$platformStatus = "unknown"
$lastPlatformStatus = ""

while ($elapsed -lt $maxWaitSeconds) {
    Start-Sleep -Seconds $pollIntervalSeconds
    $elapsed += $pollIntervalSeconds

    # --- A. Poll startup script status ---
    $statusRes = Invoke-AccessCurl -Url "$WorkerUrl/api/debug/exec?userId=$userId&cmd=cat%20/home/hermes/.hermes/.startup-status%202%3E%261%20%7C%7C%20echo%20NOT_STARTED"
    $statusText = $statusRes.Output

    $currentStartupStatus = ""
    if ($statusRes.ExitCode -eq 0 -and $statusText) {
        if ($statusText -match '"stdout"\s*:\s*"([^"]*)"') {
            $currentStartupStatus = $Matches[1] -replace '\\n', ''
        } else {
            $currentStartupStatus = $statusText.Trim()
        }
    }

    # Update startup status display if it changed
    if ($currentStartupStatus -and $currentStartupStatus -ne $lastStartupStatus) {
        $lastStartupStatus = $currentStartupStatus
    }

    # V6 wrote "Startup complete."; V7's final status (same point in boot,
    # immediately before `exec hermes serve`) is "Starting hermes serve...".
    if ($currentStartupStatus -eq "Startup complete." -or $currentStartupStatus -eq "Starting hermes serve...") {
        $startupComplete = $true
    }

    # --- B. Poll platform status every ~10 seconds (every 5th iteration) ---
    if ($elapsed % 10 -eq 0 -or -not $lastPlatformStatus) {
        $pollRes = Invoke-AccessCurl -Url "$WorkerUrl/api/admin/status?userId=$userId"
        $pollJson = $pollRes.Output

        if ($pollRes.ExitCode -eq 0 -and $pollJson) {
            try {
                $pollRes2 = $pollJson | ConvertFrom-Json
                $state = $pollRes2.state
                $platformStatus = if ($state.status) { $state.status } else { "unknown" }

                if ($platformStatus -eq "stopped_with_code") {
                    Write-Host "`nSandbox status: stopped_with_code (exit code $($state.exitCode)) - provisioning may have failed."
                    Write-Host "Response: $pollJson"
                    exit 1
                }

                $lastPlatformStatus = $platformStatus
            } catch {
                $lastPlatformStatus = "unknown"
            }
        }
    }

    # --- C. Show single overwritten line ---
    $displayStatus = if ($lastStartupStatus) { $lastStartupStatus } else { "Container booting..." }
    Write-Host "`r  [Startup] $displayStatus (platform: $lastPlatformStatus, ${elapsed}s)" -NoNewline

    # Exit when both startup is complete and platform is running/healthy
    if ($startupComplete -and ($lastPlatformStatus -eq "running" -or $lastPlatformStatus -eq "healthy")) {
        Write-Host ""  # newline
        $isReady = $true
        break
    }
}

if (-not $isReady) {
    Write-Error "`nTimed out waiting for container after $maxWaitSeconds seconds.`nPlatform: $lastPlatformStatus | Startup: $lastStartupStatus"
    exit 1
}

Write-Host "Container is ready!"

# ---------------------------------------------------------------------------
# 7. Save connection profile for daily use
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

Write-Host "Profile saved to: $profilePath"

# ---------------------------------------------------------------------------
# 8. Start local TCP proxy
# ---------------------------------------------------------------------------
Write-Host "`nStarting cloudflared access tcp proxy..."
Write-Host "  Remote:  $hostname"
Write-Host "  Local:   localhost:$LocalPort"
Write-Host "`nLeave this running. Point Hermes Desktop GUI to localhost:$LocalPort"
Write-Host "Press Ctrl+C to stop.`n"

& $CloudflaredPath access tcp --hostname $hostname --url localhost:$LocalPort
