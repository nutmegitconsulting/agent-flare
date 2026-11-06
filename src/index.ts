/**
 * Agent Flare Worker: one hostname behind Cloudflare Access, one container per Access user.
 *
 *   Browser -> Access -> this Worker -> the caller's own sandbox -> Hermes webapp :9120
 *
 * /__af/*   Agent Flare's own routes
 * anything else  proxied to the caller's Hermes webapp, HTTP and WebSocket
 *
 * The container key comes only from a verified Access JWT, so no request parameter can reach
 * another user's container. Admin routes are the one exception, and they check ADMIN_EMAILS.
 */
import { getSandbox } from "@cloudflare/sandbox";
import { Hono } from "hono";
import { AccessError, verifyAccessJwt, type AccessIdentity } from "./access";
import { adminScreens } from "./admin";
import type { Env } from "./env";
import { parseLeaseHours } from "./lease";
import { capacityPage, parkedPage, startingPage } from "./pages";
import { getIndex } from "./persistence";
import { AgentSandbox, HermesSandbox, WEBAPP_PORT, type ReadyState } from "./sandbox";
import { putSealed, prefillKey } from "./secrets";
import { forbiddenTestSettings } from "./test-settings";

export { AgentSandbox, HermesSandbox };

type Vars = { identity: AccessIdentity; jwt: string };
const app = new Hono<{ Bindings: Env; Variables: Vars }>();

const DEFAULT_SNAPSHOT_INTERVAL_MINUTES = 10;

function sandboxFor(env: Env, sub: string) {
  return getSandbox(env.Sandbox as never, sub.toLowerCase(), {
    sleepAfter: env.SLEEP_AFTER || "30m",
  }) as unknown as DurableObjectStub<AgentSandbox> & AgentSandbox;
}

app.use("*", async (c, next) => {
  const forbidden = forbiddenTestSettings(c.env, new URL(c.req.url).hostname);
  if (forbidden.length) {
    console.error(`[config] refusing to serve: test settings are set: ${forbidden.join(", ")}`);
    return c.text("This deployment is misconfigured", 500);
  }
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

// The status chip. Reading this can't wake a container or count as activity.
app.get("/__af/lease", async (c) => {
  return c.json(await sandboxFor(c.env, c.get("identity").sub).leaseStatus(), 200, { "cache-control": "no-store" });
});

app.post("/__af/lease", async (c) => {
  const { hours } = await c.req.json<{ hours?: unknown }>().catch(() => ({ hours: undefined }));
  const leaseHours = parseLeaseHours(hours);
  if (!leaseHours) return c.json({ error: "hours must be 1 or 2" }, 400);
  const result = await sandboxFor(c.env, c.get("identity").sub).keepAwake(leaseHours);
  return c.json(result, "error" in result ? 409 : 200);
});

app.post("/__af/lease/stop", async (c) => {
  const result = await sandboxFor(c.env, c.get("identity").sub).stopByUser();
  return c.json(result, "error" in result ? 500 : 200);
});

// The chip reporting a tap, a keystroke, a page load, or an agent mid-turn. The only thing that holds off idle.
app.post("/__af/activity", async (c) => {
  const body = await c.req.json<{ busy?: boolean }>().catch(() => ({ busy: false }));
  await sandboxFor(c.env, c.get("identity").sub).noteUserAction(body.busy === true);
  return c.json({ ok: true });
});

app.post("/__af/wake", async (c) => {
  await sandboxFor(c.env, c.get("identity").sub).wake();
  return c.redirect("/", 303);
});

// Local tests only, like TEST_JWKS: moves the caller's own lease clock back.
app.post("/__af/test/age", async (c) => {
  if (c.env.ALLOW_TEST_JWKS !== "1") return c.text("Not found", 404);
  const { ms } = await c.req.json<{ ms: number }>();
  await sandboxFor(c.env, c.get("identity").sub).ageForTest(ms);
  return c.json({ ok: true });
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

/** Every user with a backup or a running container, and what's known about each. */
admin.get("/users", async (c) => {
  const listing = await c.env.BACKUP_BUCKET.list({ prefix: "users/", delimiter: "/" });
  const subs = [...new Set([
    ...listing.delimitedPrefixes.map((p) => p.split("/")[1]),
    ...(await activeUsers(c.env.BACKUP_BUCKET)),
  ])];
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

adminScreens(admin, (env, sub) => sandboxFor(env, sub), (bucket) => activeUsers(bucket));
app.route("/__af/admin", admin);
app.all("/__af/*", (c) => c.text("Not found", 404));

// ---------------------------------------------------------------------------
// Everything else: the caller's Hermes webapp
// ---------------------------------------------------------------------------

function isDocumentLoad(request: Request): boolean {
  if (request.method !== "GET" || !(request.headers.get("accept") ?? "").includes("text/html")) return false;
  // A script can send an Accept header, but not this one.
  const mode = request.headers.get("sec-fetch-mode");
  return !mode || mode === "navigate";
}

function notReady(request: Request, status: ReadyState): Response {
  if (status.state === "parked" && isDocumentLoad(request)) {
    return new Response(parkedPage(), {
      status: 503,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }
  if (status.state === "capacity" && isDocumentLoad(request)) {
    return new Response(capacityPage(), {
      status: 503,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "retry-after": "60" },
    });
  }
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
  // Hermes trusts these from the Worker, so none of them can be the browser's own values.
  headers.delete("x-forwarded-prefix");
  const clientIp = headers.get("cf-connecting-ip");
  if (clientIp) headers.set("x-forwarded-for", clientIp);
  else headers.delete("x-forwarded-for");
  headers.set("x-forwarded-proto", "https");
  headers.set("x-forwarded-host", url.host);
  return new Request(request, { headers });
}

app.all("*", async (c) => {
  const identity = c.get("identity");
  const sandbox = sandboxFor(c.env, identity.sub);
  // Only a page load starts a container. An open tab's API calls and socket retries can't.
  const status = await sandbox.ensureReady(identity, new URL(c.req.url).origin, c.get("jwt"), isDocumentLoad(c.req.raw));
  if (status.state !== "ready") return notReady(c.req.raw, status);

  const request = forProxy(c.req.raw);
  const upgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket";
  const connection = request.headers.get("connection")?.toLowerCase().includes("upgrade");
  if (upgrade && connection) {
    return sandbox.wsConnect(request, WEBAPP_PORT);
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
