# Hermes Cloudflare V6 — Windows Client Setup
# Requires: PowerShell 5.1+ or PowerShell Core, cloudflared installed

param(
    [string]$Hostname = "",
    [string]$ApiEndpoint = "https://hermes-cloudflare-v6.yourdomain.com"
)

$ErrorActionPreference = "Stop"

function Test-Cloudflared {
    try {
        $null = Get-Command cloudflared -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Install-Cloudflared {
    Write-Host "cloudflared not found. Downloading..."
    $url = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
    $out = "$env:LOCALAPPDATA\cloudflared\cloudflared.exe"
    New-Item -ItemType Directory -Force -Path (Split-Path $out) | Out-Null
    Invoke-WebRequest -Uri $url -OutFile $out
    # Add to PATH for this session
    $env:PATH = "$env:PATH;$(Split-Path $out)"
    Write-Host "cloudflared installed to $out"
}

function Get-AccessJWT {
    param([string]$AudTag)
    # Open browser for Cloudflare Access login
    $loginUrl = "https://calm-waterfall-91be.cloudflareaccess.com/cdn-cgi/access/login?aud=$AudTag"
    Start-Process $loginUrl
    Read-Host "Press Enter after completing browser login"
    # cloudflared will handle JWT acquisition automatically on first access tcp call
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if (-not (Test-Cloudflared)) {
    Install-Cloudflared
}

Write-Host "=== Hermes Cloudflare V6 Client Setup ==="

# Step 1: Authenticate and get tunnel info from API
Write-Host "Authenticating with Cloudflare Access..."
# The API will validate CF-Access-Jwt-Assertion and provision the tunnel

if (-not $Hostname) {
    Write-Host "No hostname provided. You will need to run /api/client-init first."
    Write-Host "API Endpoint: $ApiEndpoint/api/client-init"
    Write-Host ""
    Write-Host "After getting your hostname, run:"
    Write-Host "  cloudflared access tcp --hostname <your-hostname> --url localhost:9119"
    exit 0
}

# Step 2: Start local TCP proxy
Write-Host "Starting cloudflared TCP proxy..."
Write-Host "  Local:    localhost:9119"
Write-Host "  Remote:   $Hostname"
Write-Host ""
Write-Host "Keep this window open. Press Ctrl+C to stop."
Write-Host ""

cloudflared access tcp --hostname $Hostname --url localhost:9119
