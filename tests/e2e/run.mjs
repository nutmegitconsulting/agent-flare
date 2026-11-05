#!/usr/bin/env node
// End to end through `wrangler dev`: real Worker, real Durable Object, real container, local R2 and KV.
// Access itself is simulated with a locally generated key (ALLOW_TEST_JWKS). Run from the repo root.
//   node tests/e2e/run.mjs
import { execFileSync, spawn } from "node:child_process";
import { generateKeyPairSync, createSign, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { WebSocket as WsClient } from "ws";
import { join } from "node:path";

const PORT = 8799;
const BASE = `http://localhost:${PORT}`;
const AUD = "test-aud";
const TEAM = "test.cloudflareaccess.com";
const PY = "/usr/local/bin/af-python";
const HOME = "/home/hermes/.hermes";
const SLEEP_AFTER_SECONDS = Number(process.env.E2E_SLEEP_AFTER_SECONDS || 75);
const persist = mkdtempSync(join(process.env.E2E_TMP || tmpdir(), "af-e2e-"));
const logPath = join(persist, "wrangler.log");

let passed = 0;
const ok = (name) => { passed++; console.log(`ok   - ${name}`); };
function fail(name, detail = "") {
  console.log(`FAIL - ${name} ${detail ? String(detail).slice(0, 1500) : ""}`);
  throw new Error(name);
}
const expect = (cond, name, detail) => (cond ? ok(name) : fail(name, detail));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- simulated Access ---
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwks = JSON.stringify({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "e2e", alg: "RS256" }] });
function jwt(sub, email, key = privateKey, claims = {}) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const body = `${b64({ alg: "RS256", kid: "e2e" })}.${b64({
    iss: `https://${TEAM}`, aud: [AUD], sub, email, exp: Math.floor(Date.now() / 1000) + 3600, ...claims,
  })}`;
  return `${body}.${createSign("RSA-SHA256").update(body).sign(key).toString("base64url")}`;
}

// --- a browser for one Access user ---
class Browser {
  constructor(sub, email) { Object.assign(this, { sub, email, token: jwt(sub, email), jar: new Map() }); }
  async fetch(path, init = {}) {
    const headers = new Headers(init.headers);
    headers.set("Cf-Access-Jwt-Assertion", this.token);
    if (this.jar.size) headers.set("cookie", [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "));
    const response = await fetch(path.startsWith("http") ? path : BASE + path, { redirect: "manual", ...init, headers });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const i = pair.indexOf("=");
      const [k, v] = [pair.slice(0, i), pair.slice(i + 1)];
      if (v && v !== '""') this.jar.set(k, v); else this.jar.delete(k);
    }
    return response;
  }
  async json(path, init) { return (await this.fetch(path, init)).json(); }
  async waitReady(timeoutMs = 240_000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      const response = await this.fetch("/__af/status").catch((e) => ({ error: e }));
      if (response.json) {
        last = await response.json().catch(() => null);
        if (last?.status?.state !== "starting" && last?.status) return last.status;
      }
      await sleep(1500);
    }
    fail("became ready in time", JSON.stringify(last));
  }
  async load(path = "/") {
    const hops = [];
    let target = path;
    for (let i = 0; i < 10; i++) {
      const r = await this.fetch(target, { headers: { accept: "text/html" } });
      hops.push([r.status, new URL(target, BASE).pathname]);
      const body = await r.text(); // A browser reads every body, and the container counts unread ones as busy.
      if (![301, 302, 303, 307].includes(r.status)) return { status: r.status, hops, body };
      target = new URL(r.headers.get("location"), BASE).href;
    }
    fail("too many redirects", JSON.stringify(hops));
  }
}

// --- containers, for inspecting what really happened inside ---
function containerOf(browser) {
  const ids = execFileSync("docker", ["ps", "-q", "--filter", "name=workerd"], { encoding: "utf8" }).split("\n").filter(Boolean);
  for (const id of ids) {
    try {
      const auth = execFileSync("docker", ["exec", id, "cat", "/run/agent-flare/auth.json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      if (JSON.parse(auth).sub === browser.sub) return id;
    } catch { /* not ours, or not hydrated */ }
  }
  return null;
}
function inside(browser, script) {
  const id = containerOf(browser);
  if (!id) throw new Error(`no container for ${browser.email}`);
  return execFileSync("docker", ["exec", id, "bash", "-c", script], { encoding: "utf8" }).trim();
}
const sql = (browser, code) => inside(browser, `${PY} -c "import sqlite3;c=sqlite3.connect('${HOME}/state.db');${code}"`);

function r2Put(key, file) {
  execFileSync("npx", ["wrangler", "r2", "object", "put", `agent-flare-state/${key}`, "--file", file, "--local", "--persist-to", persist],
    { stdio: "ignore" });
}
function grepTree(dir, needle) {
  const hits = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (path !== logPath && readFileSync(path).includes(needle)) hits.push(path);
    }
  };
  walk(dir);
  return hits;
}

// --- start ---
const MASTER = randomBytes(36).toString("base64");
writeFileSync(".dev.vars", [
  `MASTER_KEY=${MASTER}`, "CLOUDFLARE_AI_API_TOKEN=e2e-shared-token", "SHARED_FROM_SECRET=shared-secret-value", "TEMPLATE_SECRETS=SHARED_FROM_SECRET",
  "ALLOW_TEST_JWKS=1", `TEST_JWKS=${jwks}`, `SLEEP_AFTER=${SLEEP_AFTER_SECONDS}s`, "SNAPSHOT_INTERVAL_MINUTES=1",
].join("\n") + "\n");
writeFileSync(join(persist, "assignments.json"), JSON.stringify({
  users: { "alice@example.com": "team", "nokey@example.com": "bring-your-own" },
}));
writeFileSync(join(persist, "byo.json"), JSON.stringify({
  env: { BYO_KEY: "$NOT_A_SET_SECRET" },
  providers: [{ name: "byo", mode: "user_env", base_url: "https://y.example/v1", key_env: "BYO_KEY", models: { m2: {} } }],
}));
writeFileSync(join(persist, "template.json"), JSON.stringify({
  files: ["SOUL.md"],
  config_defaults: { display: { theme: "from-template" } },
  config_managed: { agent: { managed_key: "managed-value" } },
  env: { TEMPLATE_PLAIN: "plain-value", TEMPLATE_SECRET: "$SHARED_FROM_SECRET", STOLEN: "$MASTER_KEY" },
  providers: [{ name: "gw", mode: "api_token", base_url: "https://x.example/v1", key_env: "GW_KEY",
    gateway_id: "slug", model: "m", models: { m: { context_length: 1000 } } }],
}));
writeFileSync(join(persist, "SOUL.md"), "template soul\n");
r2Put("config/assignments.json", join(persist, "assignments.json"));
r2Put("templates/team/template.json", join(persist, "template.json"));
r2Put("templates/team/files/SOUL.md", join(persist, "SOUL.md"));
r2Put("templates/bring-your-own/template.json", join(persist, "byo.json"));

const wrangler = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--persist-to", persist, "--test-scheduled"],
  { stdio: ["ignore", "pipe", "pipe"], detached: true });
const log = [];
for (const stream of [wrangler.stdout, wrangler.stderr]) stream.on("data", (d) => log.push(d.toString()));
function stopAll() {
  writeFileSync(logPath, log.join(""));
  try { process.kill(-wrangler.pid, "SIGINT"); } catch {}
}
process.on("exit", stopAll);

const alice = new Browser("11111111-aaaa-4aaa-8aaa-111111111111", "alice@example.com");
const bob = new Browser("22222222-bbbb-4bbb-8bbb-222222222222", "alice@other.example");
const admin = new Browser("33333333-cccc-4ccc-8ccc-333333333333", "admin@example.com");
const nokey = new Browser("44444444-dddd-4ddd-8ddd-444444444444", "nokey@example.com");

try {
  for (let i = 0; ; i++) {
    const r = await fetch(`${BASE}/__af/status`).catch(() => null);
    if (r) break;
    if (i > 300) fail("wrangler dev came up", log.join("").slice(-1500));
    await sleep(1000);
  }
  ok("wrangler dev is up");

  console.log("== access");
  expect((await fetch(`${BASE}/`)).status === 401, "no token: 401");
  const forged = jwt(alice.sub, alice.email, generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey);
  expect((await fetch(`${BASE}/`, { headers: { "Cf-Access-Jwt-Assertion": forged } })).status === 403, "forged token: 403");
  expect((await fetch(`${BASE}/`, { headers: { "Cf-Access-Token": "opaque", "Cf-Access-Authenticated-User-Email": alice.email } })).status === 401, "identity headers alone: 401");
  expect((await alice.fetch("/__af/admin/users")).status === 403, "non-admin on admin route: 403");
  // Every kind of route, before any user has a container: nothing may answer without a verified token.
  const routes = [["GET", "/"], ["GET", "/login"], ["GET", "/api/health"], ["GET", "/api/status"], ["GET", "/api/ws"],
    ["GET", "/__af/status"], ["POST", "/__af/snapshot"], ["POST", "/__af/stop"], ["GET", "/__af/nope"],
    ["GET", "/__af/admin/users"], ["POST", "/__af/admin/users/x/stop"], ["POST", "/__af/admin/users/x/snapshot"],
    ["POST", "/__af/admin/users/x/prune"], ["PUT", "/__af/admin/prefill/a@example.com"]];
  const tokens = {
    none: [undefined, 401],
    forged: [forged, 403],
    "wrong audience": [jwt(alice.sub, alice.email, privateKey, { aud: ["other"] }), 403],
    "wrong issuer": [jwt(alice.sub, alice.email, privateKey, { iss: "https://evil.cloudflareaccess.com" }), 403],
    expired: [jwt(alice.sub, alice.email, privateKey, { exp: 1000 }), 403],
  };
  for (const [label, [token, want]] of Object.entries(tokens)) {
    const wrong = [];
    for (const [method, path] of routes) {
      const r = await fetch(`${BASE}${path}`, { method, headers: token ? { "Cf-Access-Jwt-Assertion": token } : {} });
      await r.body?.cancel();
      if (r.status !== want) wrong.push(`${method} ${path}: ${r.status}`);
    }
    expect(wrong.length === 0, `${label} token: all ${routes.length} routes refuse with ${want}`, wrong.join("; "));
  }

  console.log("== first launch");
  const t0 = Date.now();
  const starting = await alice.fetch("/", { headers: { accept: "text/html" } });
  const startingBody = await starting.text();
  expect(starting.status === 503 && startingBody.includes("Starting your agent"), "cold load shows the starting page", startingBody);
  const startingApi = await alice.fetch("/api/auth/me");
  await startingApi.body?.cancel();
  expect(startingApi.status === 503, "API answers 503 while starting");
  const status = await alice.waitReady();
  expect(status.state === "ready", `container ready in ${Math.round((Date.now() - t0) / 1000)}s`, JSON.stringify(status) + log.join("").slice(-1500));

  const page = await alice.load();
  expect(page.status === 200, "webapp page loads", JSON.stringify(page.hops) + page.body.slice(0, 300));
  expect(!page.hops.some(([, p]) => p === "/login"), "no second login", JSON.stringify(page.hops));
  const me = await alice.json("/api/auth/me");
  expect(me.email === alice.email || me.user?.email === alice.email, "Hermes sees the Access user", JSON.stringify(me));

  console.log("== websocket through the Worker");
  const { ticket } = await alice.json("/api/auth/ws-ticket", {
    method: "POST", headers: { origin: new URL(BASE).origin, "sec-fetch-site": "same-origin" },
  });
  expect(!!ticket, "websocket ticket issued");
  const wsUrl = `ws://localhost:${PORT}/api/ws?ticket=${ticket}`;
  const frame = await new Promise((resolve, reject) => {
    const socket = new WsClient(wsUrl, { headers: { "Cf-Access-Jwt-Assertion": alice.token, origin: BASE } });
    const timer = setTimeout(() => reject(new Error("no frame in 20s")), 20_000);
    socket.on("message", (data) => { clearTimeout(timer); socket.close(); resolve(String(data)); });
    socket.on("unexpected-response", (_, r) => { clearTimeout(timer); reject(new Error(`upgrade answered ${r.statusCode}`)); });
    socket.on("error", (e) => { clearTimeout(timer); reject(e); });
  }).catch((e) => fail("websocket connects", e.message + log.join("").slice(-1500)));
  expect(frame.includes("gateway.ready"), "websocket reaches Hermes", frame);

  console.log("== template");
  expect(inside(alice, `cat ${HOME}/SOUL.md`) === "template soul", "template file applied");
  const config = inside(alice, `cat ${HOME}/config.yaml`);
  expect(config.includes("from-template"), "template default applied", config);
  expect(config.includes("managed-value"), "managed key applied", config);
  expect(config.includes("cf-aig-metadata") && config.includes(alice.email), "provider tagged with the user", config);
  const modelInfo = await alice.json("/api/model/info");
  expect(modelInfo.provider === "gw" && modelInfo.model === "m", "first launch has the template's provider selected", JSON.stringify(modelInfo));
  const aliceConfig = (await admin.json("/__af/admin/users")).users.find((u) => u.sub === alice.sub).config;
  expect(aliceConfig.inference.selected === "gw" && !aliceConfig.warnings.some((w) => w.includes("provider")), "admin sees the provider selected", JSON.stringify(aliceConfig));
  expect(!config.includes("e2e-shared-token"), "provider credential not in config.yaml");
  const env = inside(alice, `cat ${HOME}/.env`);
  expect(env.includes("TEMPLATE_PLAIN=plain-value") && env.includes("TEMPLATE_SECRET=shared-secret-value") && env.includes("GW_KEY=e2e-shared-token"), "template env and secrets applied", "(env withheld)");

  expect(!env.includes("STOLEN=") && !env.includes(MASTER), "a template can't read MASTER_KEY");
  expect((await alice.fetch("/__af/stop", { method: "POST", headers: { origin: "https://evil.example" } })).status === 403, "cross-site stop refused");
  expect(inside(alice, `grep -c '^  cwd: ${HOME}/workspace' ${HOME}/config.yaml`) === "1", "agents work inside the snapshotted home");

  console.log("== provider secret missing");
  expect((await nokey.waitReady()).state === "ready", "a missing secret doesn't stop the container");
  const noKeyInfo = await nokey.json("/api/model/info");
  expect(noKeyInfo.provider === "" && noKeyInfo.model === "", "nothing selected that can't answer", JSON.stringify(noKeyInfo));
  const noKeyConfig = (await admin.json("/__af/admin/users")).users.find((u) => u.sub === nokey.sub).config;
  expect(noKeyConfig.inference.missing.includes("BYO_KEY") && noKeyConfig.warnings.some((w) => w.includes("NOT_A_SET_SECRET")), "admin sees what's missing, by name", JSON.stringify(noKeyConfig));
  const prefilled = await admin.fetch(`/__af/admin/prefill/${nokey.email}`, { method: "PUT", body: JSON.stringify({ BYO_KEY: "byo-prefill-secret" }) });
  await prefilled.body?.cancel();
  expect(prefilled.status === 200, "admin prefills the key");
  await nokey.json("/__af/stop", { method: "POST" });
  await sleep(3000);
  expect((await nokey.waitReady()).state === "ready", "wakes with the key");
  const byoInfo = await nokey.json("/api/model/info");
  expect(byoInfo.provider === "byo" && byoInfo.model === "m2", "the key selects the provider at the next boot", JSON.stringify(byoInfo));
  expect(!inside(nokey, `cat ${HOME}/config.yaml`).includes("byo-prefill-secret"), "the key isn't in config.yaml");
  await nokey.json("/__af/stop", { method: "POST" });
  await sleep(3000);

  console.log("== isolation");
  expect((await bob.waitReady()).state === "ready", "second user gets a container");
  expect(containerOf(alice) !== containerOf(bob), "same email local part, different containers");
  expect(inside(bob, `test -e ${HOME}/SOUL.md && cat ${HOME}/SOUL.md`) !== "template soul", "unassigned user gets no template");
  const bobWithAliceCookies = new Browser(bob.sub, bob.email);
  bobWithAliceCookies.jar = new Map(alice.jar);
  const crossSession = await bobWithAliceCookies.fetch("/api/auth/me");
  await crossSession.body?.cancel();
  expect(crossSession.status === 401, "one user's session is useless in another's container");
  expect((await alice.json("/__af/status")).email === alice.email, "status is the caller's own");

  console.log("== state round trip");
  sql(alice, "c.execute('CREATE TABLE IF NOT EXISTS e2e (v TEXT)');c.execute(\\\"INSERT INTO e2e VALUES ('survived')\\\");c.commit()");
  inside(alice, `echo USER_ADDED_KEY=e2e-user-secret >> ${HOME}/.env; echo 'mine' > ${HOME}/SOUL.md; mkdir -p ${HOME}/logs; head -c 5000000 /dev/urandom > ${HOME}/logs/huge.log`);
  const first = await alice.json("/__af/snapshot", { method: "POST" });
  expect(!!first.id, "snapshot taken", JSON.stringify(first) + log.join("").slice(-800));

  const stopped = await alice.json("/__af/stop", { method: "POST" });
  expect(stopped.status === "stopped", "container stopped");
  await sleep(3000);
  expect(!containerOf(alice), "container really gone");
  const cold = await alice.fetch("/", { headers: { accept: "text/html" } });
  expect(cold.status === 503, "next load wakes it");
  const restored = await alice.waitReady();
  expect(restored.state === "ready", "woke and hydrated", JSON.stringify(restored));
  expect(sql(alice, "print(c.execute('select v from e2e').fetchone()[0])") === "survived", "database row survived");
  expect(inside(alice, `cat ${HOME}/SOUL.md`) === "mine", "user's edit survived");
  expect(inside(alice, `cat ${HOME}/config.yaml`).includes("managed-value"), "managed key still applied");
  expect(inside(alice, `cat ${HOME}/.env`).includes("USER_ADDED_KEY=e2e-user-secret"), "user's secret survived, via KV");
  expect(inside(alice, `stat -c %a ${HOME}/.env`) === "600", ".env is private");
  expect((await alice.load()).status === 200, "webapp loads again after restore");

  console.log("== a snapshot of a restored home restores cleanly");
  await alice.json("/__af/stop", { method: "POST" });
  await sleep(3000);
  expect((await alice.waitReady()).state === "ready", "woke a second time");
  const lastRestore = (await admin.json("/__af/admin/users")).users.find((u) => u.sub === alice.sub).lastRestore;
  expect(lastRestore.kind === "restored" && lastRestore.skipped.length === 0, "no backup was skipped", JSON.stringify(lastRestore));

  console.log("== wake on a running container must not roll back");
  sql(alice, "c.execute(\\\"INSERT INTO e2e VALUES ('after-snapshot')\\\");c.commit()");
  const again = await alice.json("/__af/status");
  expect(again.status.state === "ready", "status on a live container");
  expect(sql(alice, "print(c.execute('select count(*) from e2e').fetchone()[0])") === "2", "live data untouched by further requests");

  console.log("== nothing secret in R2 or KV");
  for (const needle of ["e2e-user-secret", "e2e-shared-token", "byo-prefill-secret"]) {
    expect(grepTree(join(persist), needle).filter((p) => !p.endsWith(".log")).length === 0, `${needle} absent from all of local R2 and KV in plaintext`);
  }

  console.log("== bad backups");
  const adminUsers = await admin.json("/__af/admin/users");
  const aliceRow = adminUsers.users.find((u) => u.sub === alice.sub);
  expect(aliceRow?.backups >= 1, "admin can list users", JSON.stringify(adminUsers));
  const second = await alice.json("/__af/snapshot", { method: "POST" });
  expect(!!second.id, "second snapshot");
  writeFileSync(join(persist, "junk"), randomBytes(200_000));
  r2Put(`backups/${second.id}/data.sqsh`, join(persist, "junk"));
  await alice.json("/__af/stop", { method: "POST" });
  await sleep(3000);
  // The stop above took a third snapshot, which is good; corrupt that too.
  const third = (await admin.json("/__af/admin/users")).users.find((u) => u.sub === alice.sub);
  expect(third.backups === 5, "stop added a final snapshot", JSON.stringify(third));
  const index = execFileSync("npx", ["wrangler", "r2", "object", "get", `agent-flare-state/users/${alice.sub}/backups-index.json`, "--local", "--persist-to", persist, "--pipe"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const entries = JSON.parse(index);
  r2Put(`backups/${entries.at(-1).id}/data.sqsh`, join(persist, "junk"));
  const fellBack = await alice.waitReady();
  expect(fellBack.state === "ready", "corrupt newest backups: falls back to an older one", JSON.stringify(fellBack) + log.join("").slice(-1200));
  expect(sql(alice, "print(c.execute('select v from e2e').fetchone()[0])") === "survived", "older backup's data is there");

  console.log("== every backup bad: fail closed");
  // Backups that fail verify and backups that fail extraction both count as corrupt.
  await alice.json("/__af/stop", { method: "POST" });
  await sleep(3000);
  const allEntries = JSON.parse(execFileSync("npx", ["wrangler", "r2", "object", "get", `agent-flare-state/users/${alice.sub}/backups-index.json`, "--local", "--persist-to", persist, "--pipe"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  for (const entry of allEntries) r2Put(`backups/${entry.id}/data.sqsh`, join(persist, "junk"));
  const failed = await alice.waitReady();
  expect(failed.state === "failed", "refuses to start on an empty home", JSON.stringify(failed));
  const errorPage = await alice.fetch("/", { headers: { accept: "text/html" } });
  const errorBody = await errorPage.text();
  expect(errorPage.status === 500 && errorBody.includes("couldn't start"), "user sees an honest error page", errorBody.slice(0, 300));
  const refused = await alice.json("/__af/snapshot", { method: "POST" });
  expect(refused.skipped === "container not hydrated" || refused.skipped === "container not running", "snapshot refused when not hydrated", JSON.stringify(refused));
  await sleep(3000);
  const bobContainer = containerOf(bob)?.slice(0, 12);
  const strays = execFileSync("docker", ["ps", "--filter", "name=workerd", "--format", "{{.ID}} {{.Image}}"], { encoding: "utf8" })
    .split("\n").filter((l) => l.includes("hermessandbox") && !l.startsWith(bobContainer ?? "none"));
  expect(strays.length === 0, "failed container released its slot", strays.join("; "));
  const count = JSON.parse(execFileSync("npx", ["wrangler", "r2", "object", "get", `agent-flare-state/users/${alice.sub}/backups-index.json`, "--local", "--persist-to", persist, "--pipe"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })).length;
  expect(count === allEntries.length, "index untouched: nothing was deleted or overwritten");

  console.log("== idle: final snapshot, then sleep");
  await bob.waitReady();
  const before = (await admin.json("/__af/admin/users")).users.find((u) => u.sub === bob.sub);
  sql(bob, "c.execute('CREATE TABLE IF NOT EXISTS idle (v TEXT)');c.execute(\\\"INSERT INTO idle VALUES ('kept')\\\");c.commit()");
  await fetch(`${BASE}/cdn-cgi/handler/scheduled?cron=*/5+*+*+*+*`).catch(() => {});
  await sleep(5000);
  let asleep = false;
  for (let i = 0; i < 60 && !asleep; i++) {
    await fetch(`${BASE}/cdn-cgi/handler/scheduled?cron=*/5+*+*+*+*`).catch(() => {});
    await sleep(5000);
    asleep = !containerOf(bob);
  }
  expect(asleep, "idle container goes to sleep despite the snapshot cron", log.join("").slice(-1200));
  const after = (await admin.json("/__af/admin/users")).users.find((u) => u.sub === bob.sub);
  expect(after?.backups > (before?.backups ?? 0), "idle sleep took a final snapshot", JSON.stringify({ before, after }));
  expect((await bob.waitReady()).state === "ready", "wakes again");
  expect(sql(bob, "print(c.execute('select v from idle').fetchone()[0])") === "kept", "work from before the sleep survived");

  if (process.env.E2E_BIG_MB) {
    console.log("== large state");
    const mb = Number(process.env.E2E_BIG_MB);
    inside(bob, `mkdir -p ${HOME}/memories/big && head -c ${mb}000000 /dev/urandom > ${HOME}/memories/big/blob && sha256sum ${HOME}/memories/big/blob > /tmp/sum`);
    const sum = inside(bob, "cat /tmp/sum");
    let t = Date.now();
    const big = await bob.json("/__af/snapshot", { method: "POST" });
    expect(!!big.id, `${mb} MB snapshot in ${Math.round((Date.now() - t) / 1000)}s`, JSON.stringify(big));
    await bob.json("/__af/stop", { method: "POST" });
    await sleep(3000);
    t = Date.now();
    expect((await bob.waitReady()).state === "ready", `${mb} MB restore and boot in ${Math.round((Date.now() - t) / 1000)}s`);
    expect(inside(bob, `sha256sum ${HOME}/memories/big/blob`) === sum, "large file intact");
  }

  console.log("== concurrent snapshots");
  await bob.waitReady();
  const beforeBurst = (await admin.json("/__af/admin/users")).users.find((u) => u.sub === bob.sub).backups;
  const burst = await Promise.all([1, 2, 3].map(() => bob.json("/__af/snapshot", { method: "POST" })));
  expect(burst.every((r) => r.id), "three at once all succeed", JSON.stringify(burst));
  const afterBurst = (await admin.json("/__af/admin/users")).users.find((u) => u.sub === bob.sub).backups;
  expect(afterBurst === beforeBurst + 3, "all three are in the index", `${beforeBurst} -> ${afterBurst}`);
  await bob.json("/__af/stop", { method: "POST" });
  await sleep(3000);
  expect((await bob.waitReady()).state === "ready", "restores after the burst");
  const burstRestore = (await admin.json("/__af/admin/users")).users.find((u) => u.sub === bob.sub).lastRestore;
  expect(burstRestore.skipped.length === 0, "no snapshot from the burst was corrupt", JSON.stringify(burstRestore));

  console.log(`PASS: ${passed} checks`);
  process.exitCode = 0;
} catch (err) {
  console.log(`\n${passed} passed before failure: ${err.message}`);
  writeFileSync(logPath, log.join(""));
  console.log(`wrangler log: ${logPath}`);
  process.exitCode = 1;
} finally {
  stopAll();
  // Only this project's: another project's wrangler dev has workerd containers too.
  const ours = execFileSync("docker", ["ps", "--filter", "name=workerd", "--format", "{{.ID}} {{.Image}}"], { encoding: "utf8" })
    .split("\n").filter((l) => l.includes("hermessandbox")).map((l) => l.split(" ")[0]);
  for (const id of ours) {
    try { execFileSync("docker", ["rm", "-f", id], { stdio: "ignore" }); } catch {}
  }
  if (process.exitCode === 0) rmSync(persist, { recursive: true, force: true });
  if (existsSync(".dev.vars")) rmSync(".dev.vars");
  setTimeout(() => process.exit(process.exitCode), 1000);
}
