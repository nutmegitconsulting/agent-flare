import { Hono } from "hono";
import { getSandbox } from "@cloudflare/sandbox";
import { HermesSandbox } from "./sandbox";
export { HermesSandbox };
import type { Env } from "./env";
import { createSnapshot, restoreLatest, snapshotIfDue } from "./persistence";
import { pruneSnapshots } from "./prune";
import {
  getTunnelCreds,
  putTunnelCreds,
  getSessionToken,
  putSessionToken,
} from "./credentials";
import {
  injectProviders,
  loadProviders,
  saveProviders,
  storeGatewayJwt,
  validateProviders,
} from "./providers";

// Helper to avoid deep type instantiation
function getSandboxAny(ns: any, id: string, options?: any): any {
  return getSandbox(ns, id, options);
}

const app = new Hono<{ Bindings: Env; Variables: { userId: string } }>();

// Minimum age of the latest backup before the cron takes a fresh snapshot.
// Cadence set by SNAPSHOT_INTERVAL_MINUTES (wrangler var), default 60 (hourly).
const DEFAULT_SNAPSHOT_INTERVAL_MINUTES = 60;
function snapshotIntervalMs(env: Env): number {
  const minutes = Number(env.SNAPSHOT_INTERVAL_MINUTES);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_SNAPSHOT_INTERVAL_MINUTES) * 60_000;
}

// ---------------------------------------------------------------------------
// Cron user registry (R2 json): the scheduled() handler snapshots only users
// whose containers are currently running. A sleeping container has no live
// data change, so skipping it is safe. Written on wake, cleared on stop/destroy.
// ---------------------------------------------------------------------------
const ACTIVE_USERS_KEY = "active-users.json";

async function readActiveUsers(bucket: R2Bucket): Promise<string[]> {
  const obj = await bucket.get(ACTIVE_USERS_KEY);
  if (!obj) return [];
  try {
    return await obj.json();
  } catch {
    return [];
  }
}

async function addActiveUser(bucket: R2Bucket, userId: string): Promise<void> {
  const users = await readActiveUsers(bucket);
  if (!users.includes(userId)) {
    users.push(userId);
    await bucket.put(ACTIVE_USERS_KEY, JSON.stringify(users));
  }
}

async function removeActiveUser(bucket: R2Bucket, userId: string): Promise<void> {
  const users = await readActiveUsers(bucket);
  if (users.includes(userId)) {
    await bucket.put(ACTIVE_USERS_KEY, JSON.stringify(users.filter((u) => u !== userId)));
  }
}

/** Cron tick: snapshot every running active user whose latest backup is older
 *  than the interval. Never starts cold containers (getState gate). Per-user
 *  try/caught so one bad user can't fail the tick. */
async function runCronSnapshots(env: Env): Promise<void> {
  const users = await readActiveUsers(env.BACKUP_BUCKET);
  if (!users.length) return;
  for (const userId of users) {
    try {
      const sandbox: any = getSandboxAny(env.Sandbox, userId);
      const state = await sandbox.getState();
      // getState() returns {status, lastChange}. Live containers report "healthy"
      // (set once ports are ready); "running" is only the transient startup state
      // and "stopped" means slept/exited. Skipping anything not healthy/running
      // never starts cold containers. (Old code compared the object to a string,
      // which was always true — snapshots never ran.)
      if (!state || !["healthy", "running"].includes(state.status)) continue;
      await snapshotIfDue(sandbox, env.BACKUP_BUCKET, userId, snapshotIntervalMs(env));
    } catch (e: any) {
      console.error(`[cron] snapshot failed for ${userId}: ${e?.message || e}`);
    }
  }
}

// Sanitize userId for use in DNS hostnames (strip @domain.com, keep local part)
function sanitizeForDns(userId: string): string {
  return userId.split("@")[0];
}

// Generate a cryptographically secure session token
function generateSessionToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Middleware: Cloudflare Access JWT validation (skip for /internal/*)
// ---------------------------------------------------------------------------

app.use("*", async (c, next) => {
  if (c.req.path.startsWith("/internal/")) {
    return await next();
  }

  const jwt = c.req.header("CF-Access-Jwt-Assertion") || c.req.header("Cf-Access-Token");
  if (!jwt) return c.text("missing Access JWT", 401);

  // If token is opaque (not a JWT), trust Cloudflare edge validation and proceed
  const jwtParts = jwt.split(".");
  if (jwtParts.length !== 3) {
    console.log("Opaque token detected (not a JWT), trusting Cloudflare edge validation");
    // Cloudflare Access token in Cf-Access-Token header is already validated by edge
    // Extract user identity from Cloudflare headers if available
    const email = c.req.header("Cf-Access-Authenticated-User-Email");
    c.set("userId", sanitizeForDns(email || "opaque-user"));
    return await next();
  }

  try {
    const certsRes = await fetch(
      "https://calm-waterfall-91be.cloudflareaccess.com/cdn-cgi/access/certs"
    );
    if (!certsRes.ok) throw new Error("Failed to fetch Access certs");
    const certs = await certsRes.json() as { keys: { kid: string; x5c: string[] }[] };

    const [headerB64, payloadB64] = jwtParts;
    const header = JSON.parse(atob(headerB64)) as { kid: string };
    const payload = JSON.parse(atob(payloadB64)) as { email?: string; sub?: string; aud?: string | string[]; exp?: number };

    const aud = payload.aud;
    const audMatch = Array.isArray(aud)
      ? aud.includes(c.env.ACCESS_AUD_TAG)
      : aud === c.env.ACCESS_AUD_TAG;
    if (!audMatch) {
      console.error("JWT aud mismatch:", aud, "!==", c.env.ACCESS_AUD_TAG);
      throw new Error("JWT audience mismatch");
    }
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) throw new Error("JWT expired");

    const cert = certs.keys.find((k) => k.kid === header.kid);
    if (!cert) throw new Error("Signing cert not found");

    c.set("userId", sanitizeForDns(payload.email || payload.sub || "unknown"));
    await next();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("JWT validation failed:", msg);
    return c.text("invalid Access JWT: " + msg, 401);
  }
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

app.get("/health", (c) => c.json({ status: "ok" }));

// ---------------------------------------------------------------------------
// Client init: provision tunnel for this user (KV-backed credentials, no DO)
// ---------------------------------------------------------------------------

app.post("/api/client-init", async (c) => {
  const userId = c.get("userId");

  // Check if already provisioned (credentials live in KV, not the backup bucket)
  const existing = await getTunnelCreds(c.env.CREDENTIALS_KV, userId);
  if (existing?.hostname) {
    // Fetch or generate session token even for existing tunnels
    let sessionToken = await getSessionToken(c.env.CREDENTIALS_KV, userId);
    if (!sessionToken) {
      sessionToken = generateSessionToken();
      await putSessionToken(c.env.CREDENTIALS_KV, userId, sessionToken);
    }
    return c.json({ userId, hostname: existing.hostname, sessionToken, existing: true });
  }

  // Race: two requests could both pass the head() check above.
  // We accept this small window; the second write will overwrite with the same data.

  const safeId = sanitizeForDns(userId);

  const tunnelRes = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${c.env.CF_ACCOUNT_ID}/cfd_tunnel`,
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + c.env.CF_API_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: `hermes-${safeId}`, config_src: "cloudflare" }),
    }
  );

  if (!tunnelRes.ok) {
    const err = await tunnelRes.text();
    console.error("Tunnel creation failed:", err);
    return c.json({ error: "Failed to create tunnel", detail: err }, 500);
  }

  const tunnelJson = await tunnelRes.json() as { result: { id: string; token: string } };
  const tunnelId = tunnelJson.result.id;
  const tunnelToken = tunnelJson.result.token;

  const hostname = `hermes-${safeId}.hermes-test.app`;
  await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${c.env.CF_ACCOUNT_ID}/cfd_tunnel/${tunnelId}/configurations`,
    {
      method: "PUT",
      headers: {
        Authorization: "Bearer " + c.env.CF_API_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        config: {
          ingress: [
            { hostname, service: "tcp://localhost:9119" },
            { service: "http_status:404" },
          ],
        },
      }),
    }
  );

  // Create DNS CNAME pointing tunnel hostname to Cloudflare argo tunnel
  await fetch(
    `https://api.cloudflare.com/client/v4/zones/${c.env.CF_ZONE_ID}/dns_records`,
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + c.env.CF_API_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "CNAME",
        name: hostname,
        content: `${tunnelId}.cfargotunnel.com`,
        ttl: 1,
        proxied: true,
      }),
    }
  );

  // Store tunnel creds in KV for persistence across sleeps — OUT of the
  // backup bucket so third-party R2 backups never carry usable credentials
  await putTunnelCreds(c.env.CREDENTIALS_KV, userId, { hostname, token: tunnelToken });

  // Generate and store a unique dashboard session token for this user
  const sessionToken = generateSessionToken();
  await putSessionToken(c.env.CREDENTIALS_KV, userId, sessionToken);

  return c.json({ userId, hostname, sessionToken, existing: false });
});

// ---------------------------------------------------------------------------
// Status: check if tunnel is ready
// ---------------------------------------------------------------------------

app.get("/api/status", async (c) => {
  const userId = c.get("userId");

  const creds = await getTunnelCreds(c.env.CREDENTIALS_KV, userId);
  const provisioned = !!creds;

  return c.json({ userId, provisioned, hostname: creds?.hostname ?? null });
});

// ---------------------------------------------------------------------------
// Wake sandbox: ensure container is running with tunnel + state
// ---------------------------------------------------------------------------

app.post("/api/wake", async (c) => {
  const userId = c.get("userId");

  // Tunnel + session credentials come from KV (never the backup bucket)
  const tunnelCreds = await getTunnelCreds(c.env.CREDENTIALS_KV, userId);
  if (!tunnelCreds) {
    return c.json({ error: "Tunnel not provisioned. Call /api/client-init first." }, 400);
  }
  const tunnelToken = tunnelCreds.token;
  const sessionToken = (await getSessionToken(c.env.CREDENTIALS_KV, userId)) ?? "";

  const sandbox: any = getSandboxAny(c.env.Sandbox, userId, { sleepAfter: "30m" });

  // Set env vars BEFORE first container interaction so the defaultSession
  // tree sees them on boot. (The CMD child can NEVER see these — different
  // process tree; anything reaching the CMD goes via the bootstrap file below.)
  await sandbox.setEnvVars({
    HERMES_USER_ID: userId,
    CLOUDFLARED_TOKEN: tunnelToken,
    HERMES_DASHBOARD_SESSION_TOKEN: sessionToken,
  });

  // Register this user as active for the cron snapshot loop (see runCronSnapshots).
  try {
    await addActiveUser(c.env.BACKUP_BUCKET, userId);
  } catch (e: any) {
    console.error(`[wake] active-user registry write failed for ${userId}: ${e?.message || e}`);
  }

  // SDK-native restore: extract the newest backup into /home/hermes before the
  // boot script unblocks. restoreLatest no-ops (returns false) when no backup
  // exists, and clears a stale handle when the backup has expired/been pruned.
  // A failed restore must NOT fail the wake — surface it in the response and
  // let the container come up on whatever is on disk.
  let restored = false;
  let restoreError: string | undefined;
  try {
    restored = await restoreLatest(sandbox, c.env.BACKUP_BUCKET, userId);
  } catch (e: any) {
    restoreError = e?.message || String(e);
    console.error(`[wake] restore failed for ${userId} (continuing): ${restoreError}`);
  }

  // V8 provider injection — must complete BEFORE the boot script unblocks,
  // so the first `hermes serve` reads config.yaml with its custom_providers
  // section and .env with the key_env credentials. Same failure policy as
  // restore: never fail the wake; the container boots without custom
  // providers (today's behavior) and the error surfaces in the response.
  let providersWritten = 0;
  let providersError: string | undefined;
  try {
    const result = await injectProviders(sandbox, c.env.CREDENTIALS_KV, c.env.BACKUP_BUCKET, userId, c.env.CLOUDFLARE_AI_API_TOKEN || "");
    providersWritten = result.providersWritten;
    if (result.errors.length) {
      console.warn(`[wake:${userId}] provider warnings: ${result.errors.join("; ")}`);
    }
  } catch (e: any) {
    providersError = e?.message || String(e);
    console.error(`[wake] provider injection failed for ${userId} (continuing): ${providersError}`);
  }

  // Unblock the boot poll. start-hermes.sh gates on /tmp/restore-done — written
  // after restoreBackup succeeds (or immediately when no backup exists) so the
  // first `hermes serve` reads the restored tree.
  try {
    await sandbox.writeFile("/tmp/restore-done", "restored:" + restored);
  } catch (e: any) {
    console.error(`[wake] restore-done marker write failed for ${userId}: ${e?.message || e}`);
  }

  // Bootstrap file — SHRUNK to what the CMD genuinely needs. No upload token,
  // Access JWT, or URLs: the container performs no uploads anymore (the SDK
  // uploads backups through the bound R2). Written on every wake so a rotated
  // token / refreshed dashboard session token is picked up live.
  try {
    const bootstrap = JSON.stringify({
      userId,
      cloudflaredToken: tunnelToken,
      dashboardSessionToken: sessionToken,
    });
    await sandbox.writeFile("/run/hermes-bootstrap.json", bootstrap);
  } catch (e: any) {
    console.error(`[wake] bootstrap write failed for ${userId}: ${e?.message || e}`);
  }

  // Warmup ping to force container creation if sleeping
  let pingOk = false;
  try {
    await sandbox.fetch(new Request("http://internal/ping", { method: "GET" }));
    pingOk = true;
  } catch {
    // container may still be booting; client can retry
  }

  // Get actual container state for client polling
  let state = null;
  try {
    state = await sandbox.getState();
  } catch {
    // DO may be new, no state yet
  }

  return c.json({
    userId,
    status: "awake",
    pingOk,
    restored,
    ...(restoreError ? { restoreError } : {}),
    providersWritten,
    ...(providersError ? { providersError } : {}),
    state,
  });
});

// ---------------------------------------------------------------------------
// Debug: run a command inside the sandbox and return output
// ---------------------------------------------------------------------------
app.get("/api/debug/exec", async (c) => {
  const userId = c.get("userId") || c.req.query("userId");
  if (!userId) {
    return c.json({ error: "Missing userId" }, 400);
  }
  const cmd = c.req.query("cmd") || "ps aux";
  const sandbox: any = getSandboxAny(c.env.Sandbox, userId);
  try {
    const res = await sandbox.exec(cmd);
    return c.json({ userId, cmd, stdout: res.stdout || "", stderr: res.stderr || "", exitCode: res.exitCode ?? -1 });
  } catch (e: any) {
    return c.json({ userId, cmd, error: e.message || String(e) }, 500);
  }
});

// Admin: destroy a specific user's sandbox instance (idempotent)
app.post("/api/admin/destroy", async (c) => {
  const userId = c.req.query("userId");
  if (!userId) {
    return c.json({ error: "Missing userId query param" }, 400);
  }
  const sandbox: any = getSandboxAny(c.env.Sandbox, userId);
  // Best-effort final backup before the container is gone. Short timeout —
  // destroy must not hang. Never blocks the destroy itself.
  try {
    await createSnapshot(sandbox, c.env.BACKUP_BUCKET, userId);
  } catch (e: any) {
    console.error(`[admin/destroy] final backup failed for ${userId} (continuing): ${e?.message || e}`);
  }
  try {
    await removeActiveUser(c.env.BACKUP_BUCKET, userId);
  } catch { /* best-effort */ }
  try {
    await sandbox.destroy();
    return c.json({ userId, status: "destroyed" });
  } catch (e: any) {
    return c.json({ userId, error: e.message || String(e) }, 500);
  }
});

// Admin: graceful stop by userId (SIGTERM, then final backup, then stop)
app.post("/api/admin/stop", async (c) => {
  const userId = c.req.query("userId");
  if (!userId) {
    return c.json({ error: "Missing userId query param" }, 400);
  }
  const sandbox: any = getSandboxAny(c.env.Sandbox, userId);
  // Final backup before stop: captures the live tree so the next wake
  // restores to exactly this point. Best-effort — a snapshot hiccup must not
  // block the stop.
  try {
    await createSnapshot(sandbox, c.env.BACKUP_BUCKET, userId);
  } catch (e: any) {
    console.error(`[admin/stop] final backup failed for ${userId} (continuing): ${e?.message || e}`);
  }
  try {
    await removeActiveUser(c.env.BACKUP_BUCKET, userId);
  } catch { /* best-effort */ }
  try {
    await sandbox.stop();
    return c.json({ userId, status: "stopped" });
  } catch (e: any) {
    return c.json({ userId, error: e.message || String(e) }, 500);
  }
});

// Admin: prune backups for userId
app.post("/api/admin/prune", async (c) => {
  const userId = c.req.query("userId");
  if (!userId) return c.json({ error: "Missing userId query param" }, 400);
  const t0 = Date.now();
  try {
    const { kept, deleted } = await pruneSnapshots(c.env.BACKUP_BUCKET, userId);
    return c.json({ userId, kept, deleted, duration_ms: Date.now() - t0 });
  } catch (e: any) {
    return c.json({ userId, error: e?.message || String(e), duration_ms: Date.now() - t0 }, 500);
  }
});

// Admin: check container state for userId
app.get("/api/admin/status", async (c) => {
  const userId = c.req.query("userId");
  if (!userId) {
    return c.json({ error: "Missing userId query param" }, 400);
  }
  const sandbox: any = getSandboxAny(c.env.Sandbox, userId);
  try {
    const state = await sandbox.getState();
    return c.json({ userId, state });
  } catch (e: any) {
    return c.json({ userId, error: e.message || String(e) }, 500);
  }
});

// Admin: force a snapshot of a running user's /home/hermes to R2 now.
// Useful for ops + validating the createBackup path (and for round-trip tests).
app.post("/api/admin/snapshot", async (c) => {
  const userId = c.req.query("userId");
  if (!userId) {
    return c.json({ error: "Missing userId query param" }, 400);
  }
  const sandbox: any = getSandboxAny(c.env.Sandbox, userId);
  const t0 = Date.now();
  try {
    const handle = await createSnapshot(sandbox, c.env.BACKUP_BUCKET, userId);
    return c.json({ userId, ok: true, handle, duration_ms: Date.now() - t0 });
  } catch (e: any) {
    return c.json({ userId, ok: false, error: e?.message || String(e), duration_ms: Date.now() - t0 }, 500);
  }
});

// Admin: force-restore the latest R2 backup into a user's /home/hermes.
// For round-trip tests — kill/stop the running serve first so the restore
// doesn't fight live writes.
app.post("/api/admin/restore", async (c) => {
  const userId = c.req.query("userId");
  if (!userId) {
    return c.json({ error: "Missing userId query param" }, 400);
  }
  const sandbox: any = getSandboxAny(c.env.Sandbox, userId);
  const t0 = Date.now();
  try {
    const restored = await restoreLatest(sandbox, c.env.BACKUP_BUCKET, userId);
    return c.json({ userId, ok: true, restored, duration_ms: Date.now() - t0 });
  } catch (e: any) {
    return c.json({ userId, ok: false, error: e?.message || String(e), duration_ms: Date.now() - t0 }, 500);
  }
});

// ---------------------------------------------------------------------------
// V8: per-user AI Gateway providers (see src/providers.ts)
//   PUT  /api/admin/providers?userId=  body = providers array (no secrets)
//   GET  /api/admin/providers?userId=  current stored file
//   POST /api/admin/gateway-jwt?userId=  body = { jwt }  (session credential
//        for mode=jwt entries; client re-sends it on each setup run)
// JWT-authed like the rest of the API (Access). The caller's JWT is the
// credential for their own jwt-mode provider — no extra identity plumbing.
// ---------------------------------------------------------------------------

app.put("/api/admin/providers", async (c) => {
  const userId = c.req.query("userId") || c.get("userId");
  if (!userId) return c.json({ error: "Missing userId" }, 400);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Body must be a JSON array of provider entries" }, 400);
  }
  const parsed = validateProviders(body);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  await saveProviders(c.env.BACKUP_BUCKET, userId, parsed.entries);
  return c.json({ userId, ok: true, count: parsed.entries.length });
});

app.get("/api/admin/providers", async (c) => {
  const userId = c.req.query("userId") || c.get("userId");
  if (!userId) return c.json({ error: "Missing userId" }, 400);
  const entries = await loadProviders(c.env.BACKUP_BUCKET, userId);
  return c.json({ userId, providers: entries ?? [] });
});

app.post("/api/admin/gateway-jwt", async (c) => {
  const userId = c.req.query("userId") || c.get("userId");
  if (!userId) return c.json({ error: "Missing userId" }, 400);
  let body: { jwt?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Body must be { \"jwt\": \"...\" }" }, 400);
  }
  if (!body.jwt || typeof body.jwt !== "string" || body.jwt.length < 20) {
    return c.json({ error: "Missing or implausibly short jwt" }, 400);
  }
  await storeGatewayJwt(c.env.CREDENTIALS_KV, userId, body.jwt);
  return c.json({ userId, ok: true });
});

// ---------------------------------------------------------------------------
// Scheduled: hourly cron. Snapshot every running active user whose latest
// backup is older than SNAPSHOT_INTERVAL_MINUTES. Never starts cold
// containers (getState gate); sleeping users are skipped safely.
// ---------------------------------------------------------------------------
export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        if (event.cron === "0 */2 * * *") {
          // Prune pass: run retention rules for every known user
          try {
            const users = await readActiveUsers(env.BACKUP_BUCKET);
            for (const userId of users) {
              try {
                const { kept, deleted } = await pruneSnapshots(env.BACKUP_BUCKET, userId);
                if (deleted > 0) console.log(`[cron:prune] ${userId}: deleted=${deleted}, kept=${kept}`);
              } catch (e: any) {
                console.error(`[cron:prune] ${userId}: ${e?.message || e}`);
              }
            }
          } catch (err) {
            console.error("[scheduled] prune pass failed:", err);
          }
          return;
        }
        // Snapshot pass (*/5 * * * *)
        try {
          await runCronSnapshots(env);
        } catch (err) {
          console.error("[scheduled] cron snapshot pass failed:", err);
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
