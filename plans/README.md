# Hermes Cloudflare V6

Hermes Agent deployed on Cloudflare Sandbox with Hermes Desktop GUI connectivity via Cloudflare Tunnel.

## Overview

This project deploys the Hermes AI Agent inside Cloudflare Sandbox containers, using Cloudflare Tunnel for secure connectivity from a local Hermes Desktop GUI. It replaces the previous SSH-tunnel-based architecture with a serverless, ephemeral compute model backed by Cloudflare's edge infrastructure.

## Architecture

- **Frontend:** Hermes Desktop GUI (Windows) connects to `localhost:9119`
- **Transport:** `cloudflared access tcp` proxies local TCP to Cloudflare Tunnel
- **Edge:** Cloudflare Access authenticates and routes to Tunnel origin
- **Backend:** Cloudflare Sandbox + Durable Object runs Hermes Agent
- **Persistence:** R2-backed squashfs snapshots (state hydration on container wake)

## Quick Start

See `plans/ONBOARDING.md` for full setup instructions.

## Security Notes

The current implementation places two sensitive values in the container environment via `setEnvVars`:

- **`UPLOAD_TOKEN`** — a global bearer token used by the container to authenticate snapshot uploads to the Worker's `/internal/upload-snapshot` endpoint.
- **`TUNNEL_TOKEN`** — the per-user Cloudflare Tunnel credential used by `cloudflared tunnel run`.

Both tokens are visible to any process running inside the container, including the Hermes agent itself. This means a compromised or misconfigured AI agent could theoretically read these values and leak them into a repository upload, chat output, or other untrusted destination.

**This is a known compromise.** We accept it for now because:

- The in-container snapshot loop requires some form of authentication to write state back to R2.
- The Cloudflare Tunnel architecture requires the token to be accessible to the `cloudflared` process.
- Cloudflare Sandbox is a single-container runtime; there is no sidecar or separate-privilege model to isolate cloudflared from the agent.

**Future hardening (not yet implemented):**

1. **Replace `UPLOAD_TOKEN`** with per-session presigned URLs or SDK `createBackup()` / `restoreBackup()` methods, eliminating the global bearer from container env entirely.
2. **Move `TUNNEL_TOKEN` to a restricted file** (e.g., `/run/creds.json` with `0400 root:root` permissions) and run `cloudflared` as a separate user from the Hermes agent, preventing accidental reads.
3. **Evaluate Worker-driven snapshots** as an alternative to the in-container loop, which would remove all upload credentials from the container.

## License

This project is licensed under the MIT License.

Portions of this project are derived from [**hermes-flare**](https://github.com/carimura/hermes-flare) by Carter Morgan, which is licensed under the Apache License, Version 2.0. Specifically:

- The R2-backed squashfs state persistence pattern (`createBackup` / `restoreBackup`)
- The sentinel-file integrity check approach for ephemeral container state hydration
- The separation of install path (`/opt/hermes-install`) from mutable state (`/home/hermes`)

The Apache License, Version 2.0 applies to those derived portions. A copy of the Apache 2.0 license is included in this repository for compliance. All original work in this project is licensed under MIT.

We gratefully acknowledge the hermes-flare project for demonstrating Cloudflare Sandbox persistence patterns that inform this implementation.
