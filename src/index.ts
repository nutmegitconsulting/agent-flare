import { Hono } from "hono";
import { getSandbox } from "@cloudflare/sandbox";
import { HermesSandbox } from "./sandbox";
export { HermesSandbox };
import type { Env } from "./env";

// Helper to avoid deep type instantiation
function getSandboxAny(ns: any, id: string, options?: any): any {
  return getSandbox(ns, id, options);
}

const app = new Hono<{ Bindings: Env; Variables: { userId: string } }>();

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
// Client init: provision tunnel for this user (R2-backed, no DO)
// ---------------------------------------------------------------------------

app.post("/api/client-init", async (c) => {
  const userId = c.get("userId");
  const credsKey = `users/${userId}/cloudflared/creds.json`;

  // Check if already provisioned in R2
  const existing = await c.env.BACKUP_BUCKET.head(credsKey);
  if (existing) {
    const obj = await c.env.BACKUP_BUCKET.get(credsKey);
    const data = obj ? await obj.json() as { hostname: string } : null;
    if (data?.hostname) {
      // Fetch or generate session token even for existing tunnels
      const tokenKey = `users/${userId}/session-token.json`;
      let sessionToken = "";
      const tokenObj = await c.env.BACKUP_BUCKET.get(tokenKey);
      if (tokenObj) {
        const tokenData = await tokenObj.json() as { token: string };
        sessionToken = tokenData.token;
      } else {
        sessionToken = generateSessionToken();
        await c.env.BACKUP_BUCKET.put(tokenKey, JSON.stringify({ token: sessionToken }), {
          httpMetadata: { contentType: "application/json" },
        });
      }
      return c.json({ userId, hostname: data.hostname, sessionToken, existing: true });
    }
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

  // Store tunnel creds in R2 for persistence across sleeps
  await c.env.BACKUP_BUCKET.put(credsKey, JSON.stringify({ hostname, token: tunnelToken }), {
    httpMetadata: { contentType: "application/json" },
  });

  // Generate and store a unique dashboard session token for this user
  const tokenKey = `users/${userId}/session-token.json`;
  const sessionToken = generateSessionToken();
  await c.env.BACKUP_BUCKET.put(tokenKey, JSON.stringify({ token: sessionToken }), {
    httpMetadata: { contentType: "application/json" },
  });

  return c.json({ userId, hostname, sessionToken, existing: false });
});

// ---------------------------------------------------------------------------
// Status: check if tunnel is ready
// ---------------------------------------------------------------------------

app.get("/api/status", async (c) => {
  const userId = c.get("userId");
  const credsKey = `users/${userId}/cloudflared/creds.json`;

  const obj = await c.env.BACKUP_BUCKET.head(credsKey);
  const provisioned = !!obj;

  let hostname: string | null = null;
  if (provisioned) {
    const getObj = await c.env.BACKUP_BUCKET.get(credsKey);
    if (getObj) {
      const data = await getObj.json() as { hostname: string };
      hostname = data.hostname || null;
    }
  }

  return c.json({ userId, provisioned, hostname });
});

// ---------------------------------------------------------------------------
// Wake sandbox: ensure container is running with tunnel + state
// ---------------------------------------------------------------------------

app.post("/api/wake", async (c) => {
  const userId = c.get("userId");
  const credsKey = `users/${userId}/cloudflared/creds.json`;

  const getObj = await c.env.BACKUP_BUCKET.get(credsKey);
  if (!getObj) {
    return c.json({ error: "Tunnel not provisioned. Call /api/client-init first." }, 400);
  }

  const { token: tunnelToken } = await getObj.json() as { token: string };

  // Retrieve the user's dashboard session token
  const tokenKey = `users/${userId}/session-token.json`;
  const tokenObj = await c.env.BACKUP_BUCKET.get(tokenKey);
  let sessionToken = "";
  if (tokenObj) {
    const tokenData = await tokenObj.json() as { token: string };
    sessionToken = tokenData.token;
  }

  const sandbox: any = getSandboxAny(c.env.Sandbox, userId, { sleepAfter: "30m" });

  // Set env vars BEFORE first container interaction so entrypoint sees them on boot
  const workerOrigin = new URL(c.req.url).origin;
  await sandbox.setEnvVars({
    HERMES_USER_ID: userId,
    CLOUDFLARED_TOKEN: tunnelToken,
    HERMES_DASHBOARD_SESSION_TOKEN: sessionToken,
    SNAPSHOT_UPLOAD_URL: `${workerOrigin}/internal/upload-snapshot`,
    SNAPSHOT_DOWNLOAD_URL: `${workerOrigin}/internal/download-snapshot`,
    UPLOAD_TOKEN: c.env.UPLOAD_TOKEN,
  });

  // Warmup ping to force container creation if sleeping
  try {
    await sandbox.fetch(new Request("http://internal/ping", { method: "GET" }));
  } catch {
    // container may still be booting; client can retry
  }

  return c.json({ userId, status: "awake" });
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
  try {
    await sandbox.destroy();
    return c.json({ userId, status: "destroyed" });
  } catch (e: any) {
    return c.json({ userId, error: e.message || String(e) }, 500);
  }
});

// Internal admin: destroy by userId (token-auth, for scripts)
app.post("/internal/destroy", async (c) => {
  const auth = c.req.header("Authorization");
  if (!auth || auth !== `Bearer ${c.env.UPLOAD_TOKEN}`) {
    return c.text("unauthorized", 401);
  }
  const userId = c.req.query("userId");
  if (!userId) {
    return c.text("missing userId", 400);
  }
  const sandbox: any = getSandboxAny(c.env.Sandbox, userId);
  try {
    await sandbox.destroy();
    return c.json({ userId, status: "destroyed" });
  } catch (e: any) {
    return c.json({ userId, error: e.message || String(e) }, 500);
  }
});

// ---------------------------------------------------------------------------
// Internal: container -> Worker -> R2 snapshot upload
// ---------------------------------------------------------------------------

app.post("/internal/upload-snapshot", async (c) => {
  const auth = c.req.header("Authorization");
  if (!auth || auth !== `Bearer ${c.env.UPLOAD_TOKEN}`) {
    return c.text("unauthorized", 401);
  }

  const userId = c.req.header("X-User-Id");
  const type = c.req.header("X-Snapshot-Type") || "hourly";
  if (!userId) return c.text("missing X-User-Id", 400);

  const body = await c.req.arrayBuffer();
  if (!body || body.byteLength === 0) {
    return c.text("empty body", 400);
  }

  const key = type === "final"
    ? `backups/${userId}/final.sqfs`
    : `backups/${userId}/hourly/${Date.now()}.sqfs`;

  await c.env.BACKUP_BUCKET.put(key, body, {
    httpMetadata: { contentType: "application/octet-stream" },
  });

  // Prune old hourly snapshots (keep last 24)
  if (type === "hourly") {
    const list = await c.env.BACKUP_BUCKET.list({ prefix: `backups/${userId}/hourly/` });
    const objects = list.objects.sort(
      (a: any, b: any) => new Date(b.uploaded).getTime() - new Date(a.uploaded).getTime()
    );
    for (let i = 24; i < objects.length; i++) {
      await c.env.BACKUP_BUCKET.delete(objects[i].key);
    }
  }

  return c.json({ success: true, key });
});

// ---------------------------------------------------------------------------
// Internal: container -> Worker -> R2 snapshot download (for restore)
// ---------------------------------------------------------------------------

app.get("/internal/download-snapshot", async (c) => {
  const auth = c.req.header("Authorization");
  if (!auth || auth !== `Bearer ${c.env.UPLOAD_TOKEN}`) {
    return c.text("unauthorized", 401);
  }

  const userId = c.req.query("userId");
  if (!userId) return c.text("missing userId", 400);

  // Try final first, then latest hourly
  const finalKey = `backups/${userId}/final.sqfs`;
  const finalObj = await c.env.BACKUP_BUCKET.head(finalKey);
  if (finalObj) {
    const obj = await c.env.BACKUP_BUCKET.get(finalKey);
    if (obj && obj.body) {
      return new Response(obj.body, {
        headers: { "Content-Type": "application/octet-stream" },
      });
    }
  }

  const list = await c.env.BACKUP_BUCKET.list({ prefix: `backups/${userId}/hourly/` });
  if (!list.objects.length) {
    return c.text("no snapshot found", 404);
  }

  const latest = list.objects.sort(
    (a: any, b: any) => new Date(b.uploaded).getTime() - new Date(a.uploaded).getTime()
  )[0];

  const obj = await c.env.BACKUP_BUCKET.get(latest.key);
  if (!obj || !obj.body) {
    return c.text("snapshot not found", 404);
  }

  return new Response(obj.body, {
    headers: { "Content-Type": "application/octet-stream" },
  });
});

export default app;
