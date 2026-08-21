# Hermes V6 Admin: Destroy Sandbox Instance by Container ID
# Requires: cloudflared CLI (authenticated) and wrangler CLI
# Usage: .\scripts\destroy-instance.ps1 -InstanceId "<hex-id>"

param(
    [Parameter(Mandatory = $true)]
    [string]$InstanceId,

    [string]$WorkerUrl    = "https://hermes-agent.hermes-test.app",
    [string]$AccessAppUrl = "https://hermes-agent.hermes-test.app",
    [string]$CloudflaredPath = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
)

# ---------------------------------------------------------------------------
# 1. Verify cloudflared is installed
# ---------------------------------------------------------------------------
if (-not $CloudflaredPath) {
    Write-Error "cloudflared not found. Install it first:`n  winget install --id Cloudflare.cloudflared"
    exit 1
}

# ---------------------------------------------------------------------------
# 2. Authenticate with Cloudflare Access
# ---------------------------------------------------------------------------
Write-Host "Authenticating with Cloudflare Access..."
& $CloudflaredPath access login $AccessAppUrl 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Error "cloudflared access login failed (exit code $LASTEXITCODE)."
    exit 1
}
Write-Host "Access authentication successful."

# ---------------------------------------------------------------------------
# 3. Resolve instance ID to userId (name) via Wrangler
# ---------------------------------------------------------------------------
Write-Host "`nResolving instance ID '$InstanceId' to userId..."

# Get the container application ID from wrangler.jsonc
$appId = $null
$wranglerJson = Get-Content ".\wrangler.jsonc" -Raw -ErrorAction SilentlyContinue
if ($wranglerJson) {
    # Extract the container name from wrangler.jsonc: "name": "hermes-cloudflare-v6-hermessandbox"
    if ($wranglerJson -match '"name"\s*:\s*"([^"]+)"') {
        $appName = $Matches[1]
    }
}

if (-not $appName) {
    Write-Error "Could not determine container application name from wrangler.jsonc."
    exit 1
}

# Get container list to find the application ID
$containerList = npx wrangler containers list --json 2>$null | ConvertFrom-Json
$containerApp = $containerList | Where-Object { $_.name -eq $appName }

if (-not $containerApp) {
    Write-Error "Container application '$appName' not found."
    exit 1
}

$appId = $containerApp.id
Write-Host "Found container app: $appName (ID: $appId)"

# List instances and find the one matching the given ID
$instances = npx wrangler containers instances $appId --json 2>$null | ConvertFrom-Json
$target = $instances | Where-Object { $_.id -eq $InstanceId }

if (-not $target) {
    Write-Error "Instance '$InstanceId' not found in container app '$appName'."
    Write-Host "`nAvailable instances:"
    $instances | ForEach-Object { Write-Host "  ID: $($_.id)  Name: $($_.name)  State: $($_.state)" }
    exit 1
}

$userId = $target.name
Write-Host "Resolved to userId: $userId (state: $($target.state))"

# ---------------------------------------------------------------------------
# 4. Call Worker admin destroy endpoint
# ---------------------------------------------------------------------------
Write-Host "`nSending destroy command..."

$proc = Start-Process -FilePath $CloudflaredPath `
    -ArgumentList @("access", "curl", "$WorkerUrl/api/admin/destroy?userId=$userId", "-s", "-X", "POST") `
    -RedirectStandardOutput "destroy-out.txt" `
    -RedirectStandardError  "destroy-err.txt" `
    -Wait -PassThru -NoNewWindow

$destroyJson = Get-Content "destroy-out.txt" -Raw -ErrorAction SilentlyContinue
$destroyErr  = Get-Content "destroy-err.txt"  -Raw -ErrorAction SilentlyContinue
Remove-Item "destroy-out.txt", "destroy-err.txt" -ErrorAction SilentlyContinue

if ($proc.ExitCode -ne 0 -or -not $destroyJson) {
    Write-Error "Destroy call failed (exit code $($proc.ExitCode)).`nSTDERR:`n$destroyErr"
    exit 1
}

try {
    $destroyRes = $destroyJson | ConvertFrom-Json
} catch {
    Write-Error "Invalid JSON from Worker: $destroyJson"
    exit 1
}

if ($destroyRes.error) {
    Write-Error "Worker returned error: $($destroyRes.error)"
    exit 1
}

Write-Host "Instance destroyed successfully:"
Write-Host "  userId: $($destroyRes.userId)"
Write-Host "  status: $($destroyRes.status)"
