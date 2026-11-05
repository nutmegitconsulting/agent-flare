/**
 * Agent Flare Worker: one hostname behind Cloudflare Access, one container per Access user.
 *
 *   Browser -> Access -> this Worker -> the caller's own sandbox -> Hermes webapp :443
 *
 * /__af/*   Agent Flare's own routes
 * anything else  proxied to the caller's Hermes webapp, HTTP and WebSocket
 *
 * The container key comes only from a verified Access JWT, so no request parameter can reach
 * another user's container. Admin routes are the one exception, and they check ADMIN_EMAILS.
 */
import { switchPort } from "@cloudflare/containers";
import { getSandbox } from "@cloudflare/sandbox";
import { Hono } from "hono";
import { AccessError, verifyAccessJwt, type AccessIdentity } from "./access";
import type { Env } from "./env";
import { startingPage } from "./pages";
import { getIndex } from "./persistence";
import { HermesSandbox, WEBAPP_PORT, type ReadyState } from "./sandbox";
import { putSealed, prefillKey } from "./secrets";

export { HermesSandbox };

type Vars = { identity: AccessIdentity; jwt: string };
const app = new Hono<{ Bindings: Env; Variables: Vars }>();

const DEFAULT_SNAPSHOT_INTERVAL_MINUTES = 10;

function sandboxFor(env: Env, sub: string) {
  return getSandbox(env.Sandbox as never, sub.toLowerCase(), {
    sleepAfter: env.SLEEP_AFTER || "30m",
  }) as unknown as DurableObjectStub<HermesSandbox> & HermesSandbox;
}

app.use("*", async (c, next) => {
  const jwt = c.req.header("Cf-Access-Jwt-Assertion");
  if (!jwt) return c.text("Access token required", 401);
  try {
    const identity = await verifyAccessJwt(jwt, {
      teamDomain: c.env.ACCESS_TEAM_DOMAIN,
      audience: c.env.ACCESS_AUD_TAG,
      jwksJson: c.env.ALLOW_TEST_JWKS === "1" ? c.env.TEST_JWKS : undefined,
    });
    c.set("identity", identity);
    c.set("jwt", jwt);
  } catch (err) {
    if (err instanceof AccessError) {
      console.warn(`[access] rejected: ${err.message}`);
      return c.text("Invalid Access token", 403);
    }
    throw err;
  }
  await next();
});

// ---------------------------------------------------------------------------
// The caller's own container
// ---------------------------------------------------------------------------

// The Worker's own writes can't rely on the Access cookie's SameSite setting to stop cross-site POSTs.
app.use("/__af/*", async (c, next) => {
  if (c.req.method === "GET") return next();
  const origin = c.req.header("origin");
  const site = c.req.header("sec-fetch-site");
  const crossOrigin = origin && new URL(origin).host !== new URL(c.req.url).host;
  if (crossOrigin || (site && !["same-origin", "none"].includes(site))) {
    return c.text("Cross-site request refused", 403);
  }
  await next();
});

app.get("/__af/status", async (c) => {
  const { sub, email } = c.get("identity");
  const sandbox = sandboxFor(c.env, sub);
  const status = await sandbox.ensureReady(c.get("identity"), new URL(c.req.url).origin, c.get("jwt"));
  return c.json({ email, status });
});

app.post("/__af/snapshot", async (c) => {
  const result = await sandboxFor(c.env, c.get("identity").sub).snapshotNow();
  return c.json(result);
});

app.post("/__af/stop", async (c) => {
  await sandboxFor(c.env, c.get("identity").sub).stopWithSnapshot();
  return c.json({ status: "stopped" });
});

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

const admin = new Hono<{ Bindings: Env; Variables: Vars }>();

admin.use("*", async (c, next) => {
  const admins = (c.env.ADMIN_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (!admins.includes(c.get("identity").email)) return c.text("Admins only", 403);
  await next();
});

/** Every user with an index, and what's known about each. */
admin.get("/users", async (c) => {
  const listing = await c.env.BACKUP_BUCKET.list({ prefix: "users/", delimiter: "/" });
  const subs = listing.delimitedPrefixes.map((p) => p.split("/")[1]);
  const users = await Promise.all(subs.map(async (sub) => {
    const backups = await getIndex(c.env.BACKUP_BUCKET, sub).catch(() => []);
    const details = await sandboxFor(c.env, sub).describe();
    const newest = backups.at(-1);
    return { sub, ...details, backups: backups.length, newestBackup: newest?.createdAt ?? null };
  }));
  return c.json({ users });
});

admin.post("/users/:sub/stop", async (c) => {
  await sandboxFor(c.env, c.req.param("sub")).stopWithSnapshot();
  return c.json({ status: "stopped" });
});

admin.post("/users/:sub/snapshot", async (c) => {
  return c.json(await sandboxFor(c.env, c.req.param("sub")).snapshotNow());
});

admin.post("/users/:sub/prune", async (c) => {
  return c.json(await sandboxFor(c.env, c.req.param("sub")).prune());
});

/** Set .env values for a user before their first login, e.g. a personal API key. */
admin.put("/prefill/:email", async (c) => {
  const body = await c.req.json<Record<string, string>>().catch(() => null);
  if (!body || typeof body !== "object" || Object.values(body).some((v) => typeof v !== "string" || /[\r\n]/.test(v))) {
    return c.json({ error: "body must be a JSON object of single-line strings" }, 400);
  }
  await putSealed(c.env.CREDENTIALS_KV, c.env.MASTER_KEY, prefillKey(c.req.param("email")), body);
  return c.json({ ok: true, keys: Object.keys(body) });
});

app.route("/__af/admin", admin);
app.all("/__af/*", (c) => c.text("Not found", 404));

// ---------------------------------------------------------------------------
// Everything else: the caller's Hermes webapp
// ---------------------------------------------------------------------------

function isDocumentLoad(request: Request): boolean {
  return request.method === "GET" && (request.headers.get("accept") ?? "").includes("text/html");
}

function notReady(request: Request, status: ReadyState): Response {
  if (isDocumentLoad(request)) {
    return new Response(startingPage(status), {
      status: status.state === "failed" ? 500 : 503,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "retry-after": "2" },
    });
  }
  return Response.json(
    { error: "starting", status },
    { status: status.state === "failed" ? 500 : 503, headers: { "retry-after": "2" } },
  );
}

/** The request Hermes sees. The Access JWT stays out: the agent has no need for the user's token. */
function forProxy(request: Request): Request {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.delete("cf-access-jwt-assertion");
  headers.delete("cf-access-authenticated-user-email");
  headers.delete("cf-access-token");
  const cookie = headers.get("cookie");
  if (cookie) {
    const kept = cookie.split(";").map((p) => p.trim()).filter((p) => !p.startsWith("CF_Authorization="));
    if (kept.length) headers.set("cookie", kept.join("; "));
    else headers.delete("cookie");
  }
  // Addressing is ours to decide; the SDK would act on these.
  for (const name of [...headers.keys()]) {
    if (name.startsWith("x-sandbox-") || name === "cf-container-target-port") headers.delete(name);
  }
  headers.set("x-forwarded-proto", "https");
  headers.set("x-forwarded-host", url.host);
  return new Request(request, { headers });
}

app.all("*", async (c) => {
  const identity = c.get("identity");
  const sandbox = sandboxFor(c.env, identity.sub);
  const status = await sandbox.ensureReady(identity, new URL(c.req.url).origin, c.get("jwt"));
  if (status.state !== "ready") return notReady(c.req.raw, status);

  const request = forProxy(c.req.raw);
  const upgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket";
  const connection = request.headers.get("connection")?.toLowerCase().includes("upgrade");
  if (upgrade && connection) {
    // Not sandbox.wsConnect: it refuses ports below 1024, and the webapp is on 443.
    return sandbox.fetch(switchPort(request, WEBAPP_PORT));
  }
  // sandbox.fetch picks a port from the request unless both headers are present, and a half-formed
  // upgrade could land on the control port. So anything else goes to the webapp by explicit port.
  return sandbox.containerFetch(request, WEBAPP_PORT);
});

// ---------------------------------------------------------------------------
// Cron: snapshots for running users; retention every two hours
// ---------------------------------------------------------------------------

const PRUNE_CRON = "0 */2 * * *";

async function activeUsers(bucket: R2Bucket): Promise<string[]> {
  const subs: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: "active/", cursor });
    subs.push(...page.objects.map((o) => o.key.slice("active/".length)));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return subs;
}

async function runSnapshots(env: Env): Promise<void> {
  const minutes = Number(env.SNAPSHOT_INTERVAL_MINUTES);
  const intervalMs = (Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_SNAPSHOT_INTERVAL_MINUTES) * 60_000;
  await Promise.all((await activeUsers(env.BACKUP_BUCKET)).map(async (sub) => {
    try {
      const result = await sandboxFor(env, sub).snapshotIfDue(intervalMs);
      if ("id" in result) console.log(`[cron:snapshot] ${sub}: ${result.id}`);
    } catch (err) {
      console.error(`[cron:snapshot] ${sub}: ${err instanceof Error ? err.message : err}`);
    }
  }));
}

async function runPrune(env: Env): Promise<void> {
  const listing = await env.BACKUP_BUCKET.list({ prefix: "users/", delimiter: "/" });
  for (const prefix of listing.delimitedPrefixes) {
    const sub = prefix.split("/")[1];
    try {
      const result = await sandboxFor(env, sub).prune();
      if (result?.deleted) console.log(`[cron:prune] ${sub}: deleted ${result.deleted}, kept ${result.kept}`);
    } catch (err) {
      console.error(`[cron:prune] ${sub}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(event.cron === PRUNE_CRON ? runPrune(env) : runSnapshots(env));
  },
} satisfies ExportedHandler<Env>;
