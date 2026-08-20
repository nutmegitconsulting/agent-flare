import { Hono } from "hono";
import type { Env } from "./env";
import { HermesAgent } from "./agent";

const app = new Hono<{ Bindings: Env; Variables: { userId: string } }>();

// ---------------------------------------------------------------------------
// Middleware: Cloudflare Access JWT validation
// ---------------------------------------------------------------------------

app.use("*", async (c, next) => {
  const jwt = c.req.header("CF-Access-Jwt-Assertion");
  if (!jwt) return c.text("missing Access JWT", 401);

  try {
    const certsRes = await fetch(
      "https://calm-waterfall-91be.cloudflareaccess.com/cdn-cgi/access/certs"
    );
    if (!certsRes.ok) throw new Error("Failed to fetch Access certs");
    const certs = await certsRes.json<{ keys: { kid: string; x5c: string[] }[] }>();

    const [headerB64, payloadB64] = jwt.split(".");
    const header = JSON.parse(atob(headerB64)) as { kid: string };
    const payload = JSON.parse(atob(payloadB64)) as { email?: string; sub?: string; aud?: string; exp?: number };

    if (payload.aud !== c.env.ACCESS_AUD_TAG) throw new Error("JWT audience mismatch");
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) throw new Error("JWT expired");

    const cert = certs.keys.find((k) => k.kid === header.kid);
    if (!cert) throw new Error("Signing cert not found");

    c.set("userId", payload.email || payload.sub || "unknown");
    await next();
  } catch (err) {
    console.error("JWT validation failed:", err);
    return c.text("invalid Access JWT", 401);
  }
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

app.get("/health", (c) => c.json({ status: "ok" }));

// ---------------------------------------------------------------------------
// Client init: provision tunnel for this user
// ---------------------------------------------------------------------------

app.post("/api/client-init", async (c) => {
  const userId = c.get("userId");
  const id = c.env.Agent.idFromName(userId);
  const stub = c.env.Agent.get(id);

  // Check if already provisioned
  const statusRes = await stub.fetch(new Request("http://internal/status", { method: "GET" }));
  const status = await statusRes.json<{ provisioned: boolean; hostname?: string }>();

  if (status.provisioned && status.hostname) {
    return c.json({ userId, hostname: status.hostname, existing: true });
  }

  // Create new tunnel via Cloudflare API
  const tunnelRes = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${c.env.CF_ACCOUNT_ID}/cfd_tunnel`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${c.env.CF_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: `hermes-${userId}`, config_src: "cloudflare" }),
    }
  );

  if (!tunnelRes.ok) {
    const err = await tunnelRes.text();
    console.error("Tunnel creation failed:", err);
    return c.json({ error: "Failed to create tunnel", detail: err }, 500);
  }

  const tunnelJson = await tunnelRes.json<{ result: { id: string; token: string } }>();
  const tunnelId = tunnelJson.result.id;
  const tunnelToken = tunnelJson.result.token;

  // Create DNS route
  const hostname = `hermes-${userId}.yourdomain.com`; // TODO: replace with your domain
  await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${c.env.CF_ACCOUNT_ID}/cfd_tunnel/${tunnelId}/configurations`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${c.env.CF_API_TOKEN}`,
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

  // Store in DO and R2
  await stub.fetch(new Request("http://internal/set-tunnel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hostname, token: tunnelToken }),
  }));

  await c.env.STATE_BUCKET.put(`users/${userId}/cloudflared/token`, tunnelToken);

  return c.json({ userId, hostname, existing: false });
});

// ---------------------------------------------------------------------------
// Status: check if tunnel and sandbox are ready
// ---------------------------------------------------------------------------

app.get("/api/status", async (c) => {
  const userId = c.get("userId");
  const id = c.env.Agent.idFromName(userId);
  const stub = c.env.Agent.get(id);

  const statusRes = await stub.fetch(new Request("http://internal/status", { method: "GET" }));
  const status = await statusRes.json();

  return c.json({ userId, ...status });
});

export { HermesAgent };
export default app;
