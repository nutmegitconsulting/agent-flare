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

See `plans/Hermes Implementation Plan V6.md` for full architecture specification.

## License

This project is licensed under the MIT License.

Portions of this project are derived from [**hermes-flare**](https://github.com/carimura/hermes-flare) by Carter Morgan, which is licensed under the Apache License, Version 2.0. Specifically:

- The R2-backed squashfs state persistence pattern (`createBackup` / `restoreBackup`)
- The sentinel-file integrity check approach for ephemeral container state hydration
- The separation of install path (`/opt/hermes-install`) from mutable state (`/home/hermes`)

The Apache License, Version 2.0 applies to those derived portions. A copy of the Apache 2.0 license is included in this repository for compliance. All original work in this project is licensed under MIT.

We gratefully acknowledge the hermes-flare project for demonstrating Cloudflare Sandbox persistence patterns that inform this implementation.
