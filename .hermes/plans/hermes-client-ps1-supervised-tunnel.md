# hermes-client.ps1 — Supervised Tunnel + Desktop Auto-Launch

## Objective
Replace the manual two-step workflow (`setup-client.ps1` then manually start Hermes Desktop GUI) with a single script that provisions (once), resumes from profile (daily), supervises the cloudflared tunnel in the background, and optionally auto-launches the Hermes Desktop application.

## Background
`scripts/setup-client.ps1` was the original client-side script. It performed one-time provisioning, saved a profile, then blocked the console with a foreground `cloudflared access tcp` call. The user still had to:
1. Copy the session token into Hermes Desktop GUI manually.
2. Leave the PowerShell window open forever.
3. Restart the tunnel manually if it dropped.

## Design Decisions

### New file instead of editing setup-client.ps1
`setup-client.ps1` remains as the canonical reference provisioning script. The new `scripts/hermes-client.ps1` adds launcher/supervisor features on top. This avoids destabilizing the proven provisioning path.

### Resume vs. provision gate
At the top of the script:
- If `~\.hermes-cloudflare-v6\profile.json` exists and `-ForceSetup` is not set → re-authenticate with Access and skip straight to tunnel supervision.
- If no profile or `-ForceSetup` → run full `client-init`, wake, poll, save profile, then start supervision.

### Supervised tunnel (background process + watchdog) -- SUPERSEDED
The original design hid cloudflared and watchdogged it. Windows testing showed the watchdog added no resilience (cloudflared reconnects to the edge itself), orphaned the proxy when the console window closed, and `Test-NetConnection` could hang. **Current design:** wake the container, launch Hermes Desktop in the background (it retries its own connection), then run `cloudflared access tcp` in the **foreground** -- live console output, Ctrl+C kills the tunnel directly, no hidden processes, no log files, no restart loop.

### Desktop auto-launch
`-LaunchDesktop` enables auto-detection of `Hermes.exe` (searches `LOCALAPPDATA\Programs\Hermes`, `LOCALAPPDATA\Hermes`, `ProgramFiles\Hermes`, `ProgramFiles(x86)\Hermes`). Detected once after the tunnel port is confirmed up via `Test-NetConnection`. Launch happens exactly once per session to avoid spawning duplicates.

`-HermesDesktopPath` overrides the auto-search.

`-TunnelOnly` suppresses desktop launch even if the EXE is found.

### Auto-configure GUI
`-AutoConfigure` writes `%USERPROFILE%\.hermes\gui_config.json`:
```json
{
  "endpoint": "http://localhost:9119",
  "session_token": "..."
}
```
This eliminates the manual copy-paste of the session token on first run.

### Encoding-safe implementation
Initial attempt used backtick line continuation (`` ` ``), which tripped PowerShell’s parser when the file was read across a WSL `\wsl$` mapped drive due to subtle byte sequence interactions. **Fix:** eliminated all backtick line continuations and replaced them with **PowerShell splatting** (`@{}` + `@spArgs`), which is parser-safe and more readable.

### Start-Process dual-redirect limitation (found in Windows testing)
`Start-Process` **throws** when `-RedirectStandardOutput` and `-RedirectStandardError` point to the *same* file ("This command cannot be run because ... are same"). The original watchdog passed `$tunnelLog` to both, so the tunnel never started. **Fix:** split the streams — stderr (where cloudflared logs) owns `tunnel.log`, stdout gets a side file `tunnel.out.log`; both rotate at 10MB. Verified under Windows PowerShell 5.1.

## Files Changed
- **Created:** `scripts/hermes-client.ps1`
- **Unchanged:** `scripts/setup-client.ps1` (preserved as reference)

## Usage

```powershell
# First-time setup + supervised tunnel + auto-launch + write gui_config
.\scripts\hermes-client.ps1 -LaunchDesktop -AutoConfigure

# Daily resume (reads profile, skips provisioning)
.\scripts\hermes-client.ps1 -LaunchDesktop

# Tunnel only, no desktop
.\scripts\hermes-client.ps1 -TunnelOnly

# Force re-provision from scratch
.\scripts\hermes-client.ps1 -ForceSetup -LaunchDesktop -AutoConfigure
```

## Parameters

| Parameter | Type | Default | Purpose |
|-----------|------|---------|---------|
| `-WorkerUrl` | string | `https://hermes-agent.hermes-test.app` | Worker endpoint |
| `-AccessAppUrl` | string | `https://hermes-agent.hermes-test.app` | Cloudflare Access app URL |
| `-LocalPort` | string | `9119` | Local TCP proxy port |
| `-CloudflaredPath` | string | auto-detected | Path to `cloudflared.exe` |
| `-GatewayDomain` | string | `""` | AI Gateway custom domain (optional V8) |
| `-LaunchDesktop` | switch | false | Auto-start Hermes Desktop when tunnel is up |
| `-HermesDesktopPath` | string | `""` | Override path to `Hermes.exe` |
| `-AutoConfigure` | switch | false | Write `~\.hermes\gui_config.json` with session token |
| `-TunnelOnly` | switch | false | Start tunnel supervision without launching desktop |
| `-ForceSetup` | switch | false | Ignore saved profile and re-run full setup |

## Open Items
None. Current design (post-Windows-testing): wake -> desktop background -> foreground tunnel. Two fixes landed along the way:
1. **Start-Process dual-redirect** (see above) -- found when the watchdog failed to launch cloudflared at all.
2. **Resume-path sandbox wake** -- the tunnel's connector lives INSIDE the sandbox container; an idled-out container leaves the proxy looping on `websocket: bad handshake`. `Invoke-SandboxWake` runs before supervision: POSTs `/api/wake`, polls up to 120s if booting, continues with a warning on timeout. Verified live: wake returned `healthy`, end-to-end `curl localhost:9119` returned the Hermes page.
3. **Watchdog removed entirely** at user request after `Test-NetConnection` hung ("Waiting for response") in real use. Foreground tunnel is the final pattern.
