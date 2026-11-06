#!/usr/bin/env node
// End to end through `wrangler dev`: real Worker, real Durable Object, real container, local R2 and KV.
// Access itself is simulated with a locally generated key (ALLOW_TEST_JWKS). Run from the repo root.
//   node tests/e2e/run.mjs
import { execFileSync, spawn } from "node:child_process";
import { generateKeyPairSync, createSign, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { request as httpRequest } from "node:http";
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

function pageLoad(url, headers) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { headers: Object.fromEntries(headers) }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const out = new Headers();
        for (let i = 0; i < res.rawHeaders.length; i += 2) out.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
        resolve(new Response(res.statusCode === 304 ? null : Buffer.concat(chunks), { status: res.statusCode, headers: out }));
      });
    });
    req.on("error", reject);
    req.end();
  });
}

// --- a browser for one Access user ---
class Browser {
  constructor(sub, email) { Object.assign(this, { sub, email, token: jwt(sub, email), jar: new Map() }); }
  async fetch(path, init = {}) {
    const headers = new Headers(init.headers);
    headers.set("Cf-Access-Jwt-Assertion", this.token);
    if (this.jar.size) headers.set("cookie", [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "));
    // A browser's page load says Sec-Fetch-Mode: navigate, and only that may start a container. Node's fetch
    // always says "cors", so page loads go through node:http, which sends what it's given.
    const isPageLoad = (headers.get("accept") ?? "").includes("text/html") && (!headers.has("sec-fetch-mode") || headers.get("sec-fetch-mode") === "navigate");
    if (isPageLoad) headers.set("sec-fetch-mode", "navigate");
    const url = path.startsWith("http") ? path : BASE + path;
    const response = isPageLoad ? await pageLoad(url, headers) : await fetch(url, { redirect: "manual", ...init, headers });
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
writeFileSync(join(persist, "tiers.json"), JSON.stringify({ m: "medium" }));
r2Put("config/model-tiers.json", join(persist, "tiers.json"));

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
const carol = new Browser("55555555-eeee-4eee-8eee-555555555555", "carol@example.com");

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
    ["GET", "/__af/lease"], ["POST", "/__af/lease"], ["POST", "/__af/lease/stop"], ["POST", "/__af/wake"], ["POST", "/__af/activity"],
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
  expect(config.includes("model_aliases") && config.includes("|m") && config.includes("model: m"), "the tier mark is in the model's name, aliased to the real ID", config);
  expect(JSON.parse(inside(alice, `cat ${HOME}/ui-preferences.json`)).values["hermes-desktop-mode-v1"] === "dark", "a new home starts in dark mode");
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

  const row = async (who) => (await admin.json("/__af/admin/users")).users.find((u) => u.sub === who.sub);
  console.log("== admin screens");
  const form = (fields) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE, "sec-fetch-site": "same-origin" }, body: new URLSearchParams(fields).toString() });
  const adminRoutes = [["POST", `/__af/admin/u/${alice.sub}/keep-awake`], ["POST", `/__af/admin/u/${alice.sub}/stop`], ["GET", `/__af/admin/u/${alice.sub}/backups/00000000-0000-4000-8000-000000000000`], ["POST", "/__af/admin/settings"], ["GET", "/__af/admin"], ["GET", `/__af/admin/u/${alice.sub}`], ["GET", "/__af/admin/roles"], ["GET", "/__af/admin/roles/new"], ["GET", "/__af/admin/roles/team"], ["GET", "/__af/admin/audit"], ["GET", "/__af/admin/users"],
    ["POST", `/__af/admin/u/${alice.sub}/role`], ["POST", `/__af/admin/u/${alice.sub}/override`], ["POST", `/__af/admin/u/${alice.sub}/key`], ["POST", `/__af/admin/u/${alice.sub}/apply`],
    ["POST", "/__af/admin/assign"], ["POST", "/__af/admin/roles/team"], ["POST", "/__af/admin/roles/team/key"]];
  const adminForged = jwt(admin.sub, admin.email, generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey);
  for (const [label, token, want] of [["non-admin", alice.token, 403], ["no token", null, 401], ["forged admin", adminForged, 403], ["admin email for another audience", jwt(admin.sub, admin.email, privateKey, { aud: ["other"] }), 403]]) {
    const wrong = [];
    for (const [method, path] of adminRoutes) {
      const init = { method, redirect: "manual", headers: { ...(token ? { "Cf-Access-Jwt-Assertion": token } : {}), origin: BASE, "x-admin-email": admin.email, "cf-access-authenticated-user-email": admin.email, "content-type": "application/x-www-form-urlencoded" }, ...(method === "POST" ? { body: "role=team&value=x" } : {}) };
      if (method === "GET") delete init.headers.origin;
      const r = await fetch(BASE + path, init);
      await r.body?.cancel();
      if (r.status !== want) wrong.push(`${method} ${path}: ${r.status}`);
    }
    expect(wrong.length === 0, `${label}: all ${adminRoutes.length} admin screen routes refuse with ${want}`, wrong.join("; "));
  }
  for (const [label, headers] of [["another origin", { origin: "https://evil.example" }], ["an opaque origin", { origin: "null" }], ["a cross-site fetch", { "sec-fetch-site": "cross-site" }]]) {
    const r = await admin.fetch(`/__af/admin/assign`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: "email=evil@example.com&role=team" });
    await r.body?.cancel();
    expect(r.status === 403, `a write from ${label} is refused`, String(r.status));
  }
  const usersPage = await admin.fetch("/__af/admin");
  const usersHtml = await usersPage.text();
  expect(usersPage.status === 200 && usersHtml.includes(alice.email) && usersPage.headers.get("content-security-policy").includes("default-src 'none'"), "users screen lists users, with a strict CSP", usersHtml.slice(0, 300));
  expect(!usersHtml.includes("<script"), "the screens carry no script");

  // A role with a hostile name in the fields: everything user-derived must come back escaped.
  const hostile = '<img src=x onerror=alert(1)>';
  const saved = await admin.fetch("/__af/admin/roles/engineers", form({ name: "gw", mode: "api_token", base_url: "https://x.example/v1", key_env: "GW_KEY", gateway_id: "eng-gw", credential: "", models: "m 1000\n+ big 2000", model: "big" }));
  await saved.body?.cancel();
  expect(saved.status === 303, "admin creates a role", String(saved.status));
  const badRole = await admin.fetch("/__af/admin/roles/bad", form({ name: hostile, mode: "api_token", base_url: "https://x.example/v1", key_env: "GW_KEY", gateway_id: "g", models: "m", model: "" }));
  const badHtml = await badRole.text();
  expect(badRole.status === 400 && !badHtml.includes("<img"), "a hostile role field is refused, and escaped", badHtml.slice(0, 300));
  const overrideHostile = await admin.fetch(`/__af/admin/u/${alice.sub}/override`, form({ role: "", gateway_id: "", models: hostile, default_model: "" }));
  const overrideHtml = await overrideHostile.text();
  expect(overrideHostile.status === 400 && !overrideHtml.includes("<img") && overrideHtml.includes("&#60;img"), "a hostile override is refused, and escaped", overrideHtml.slice(0, 300));

  console.log("== admin: container, backups, cap");
  const adminKeep = await admin.fetch(`/__af/admin/u/${alice.sub}/keep-awake`, form({ hours: "2" }));
  await adminKeep.body?.cancel();
  const adminLease = (await row(alice)).lease;
  expect(adminKeep.status === 303 && adminLease.reason === "lease" && adminLease.stopsAt - Date.now() <= 7_200_000, "an admin keeps a user's container awake, 2 hours at most", JSON.stringify(adminLease));
  const adminBad = await admin.fetch(`/__af/admin/u/${alice.sub}/keep-awake`, form({ hours: "8" }));
  await adminBad.body?.cancel();
  expect(adminBad.status === 400, "and can't choose 8 hours");
  const adminSnap = await alice.json("/__af/snapshot", { method: "POST" });
  expect(!!adminSnap.id, "a backup exists to list", JSON.stringify(adminSnap));
  const adminPage = await (await admin.fetch(`/__af/admin/u/${alice.sub}`)).text();
  expect(adminPage.includes("Kept awake until") && adminPage.includes("(newest)") && adminPage.includes("any passwords or keys"), "the user's page shows state, backups and the warning", adminPage.slice(0, 300));
  const downloadPath = `/__af/admin/u/${alice.sub}/backups/${adminSnap.id}`;
  const download = await admin.fetch(downloadPath);
  const downloaded = Buffer.from(await download.arrayBuffer());
  expect(download.status === 200 && downloaded.length > 1000 && download.headers.get("content-disposition").includes(adminSnap.id), "an admin downloads a backup", `${download.status} ${downloaded.length}`);
  const notAdmin = await alice.fetch(downloadPath);
  await notAdmin.body?.cancel();
  expect(notAdmin.status === 403, "a non-admin can't, even their own");
  for (const [label, path] of [["another user's ID", `/__af/admin/u/${bob.sub}/backups/${adminSnap.id}`], ["a made-up ID", `/__af/admin/u/${alice.sub}/backups/00000000-0000-4000-8000-000000000000`], ["a path", `/__af/admin/u/${alice.sub}/backups/..%2F..%2Fconfig%2Fassignments.json`], ["an object key", `/__af/admin/u/${alice.sub}/backups/config%2Fassignments.json`]]) {
    const r = await admin.fetch(path);
    await r.body?.cancel();
    expect(r.status === 404, `${label} can't fetch anything`, String(r.status));
  }
  const auditPage = await (await admin.fetch("/__af/admin/audit")).text();
  expect(auditPage.includes("backup.download") && auditPage.includes(adminSnap.id) && auditPage.includes("keep-awake"), "the audit shows the download and who did it");
  const capSet = await admin.fetch("/__af/admin/settings", form({ maxAwake: "1" }));
  await capSet.body?.cancel();
  const capBad = await admin.fetch("/__af/admin/settings", form({ maxAwake: "lots" }));
  await capBad.body?.cancel();
  expect(capSet.status === 303 && capBad.status === 400, "an admin sets the cap, with a valid number only");
  const dave = new Browser("77777777-abab-4bab-8bab-777777777777", "dave@example.com");
  const atCapacity = await dave.fetch("/", { headers: { accept: "text/html" } });
  const capacityBody = await atCapacity.text();
  expect(atCapacity.status === 503 && capacityBody.includes("At capacity"), "over the cap, a user sees the capacity page", capacityBody.slice(0, 200));
  await sleep(3000);
  expect(!containerOf(dave) && containerOf(alice), "and gets no container, and a running one isn't stopped");
  const capOff = await admin.fetch("/__af/admin/settings", form({ maxAwake: "0" }));
  await capOff.body?.cancel();
  const daveOk = await dave.fetch("/", { headers: { accept: "text/html" } });
  await daveOk.text();
  expect((await dave.waitReady()).state === "ready", "with the cap at 0, they start");
  await dave.json("/__af/stop", { method: "POST" });
  await sleep(3000);
  const adminStop = await admin.fetch(`/__af/admin/u/${alice.sub}/stop`, form({}));
  await adminStop.body?.cancel();
  expect(adminStop.status === 303, "an admin stops a user's container, saving first");
  await sleep(3000);
  expect(!containerOf(alice), "and it's gone");
  const aliceWake = await alice.fetch("/__af/wake", { method: "POST", headers: { origin: BASE, "sec-fetch-site": "same-origin" } });
  await aliceWake.body?.cancel();
  expect((await alice.waitReady()).state === "ready", "the user wakes it");

  const appliedBefore = (await admin.json("/__af/admin/users")).users.find((u) => u.sub === alice.sub).config.fingerprint;
  const assignedAlice = await admin.fetch(`/__af/admin/u/${alice.sub}/role`, form({ role: "engineers" }));
  await assignedAlice.body?.cancel();
  expect(assignedAlice.status === 303, "admin assigns a role");
  const pendingHtml = await (await admin.fetch(`/__af/admin/u/${alice.sub}`)).text();
  expect(pendingHtml.includes("Change waiting for next boot") && pendingHtml.includes("<strong>engineers</strong>"), "the screen shows the new effective role, waiting for next boot", pendingHtml.slice(0, 500));
  expect((await alice.json("/api/model/info")).provider === "gw" && !inside(alice, `cat ${HOME}/config.yaml`).includes("eng-gw"), "a running container doesn't change until it restarts");

  const adminKey = "e2e-admin-set-provider-key";
  const setKey = await admin.fetch(`/__af/admin/u/${alice.sub}/key`, form({ provider: "gw", action: "set", value: adminKey }));
  await setKey.body?.cancel();
  expect(setKey.status === 303, "admin sets a key for the user");
  const overridden = await admin.fetch(`/__af/admin/u/${alice.sub}/override`, form({ role: "", gateway_id: "alice-gw", models: "", default_model: "m" }));
  await overridden.body?.cancel();
  expect(overridden.status === 303, "admin sets per-user overrides");

  for (const path of ["/__af/admin", `/__af/admin/u/${alice.sub}`, "/__af/admin/roles", "/__af/admin/roles/engineers", "/__af/admin/audit", "/__af/admin/users"]) {
    const text = await (await admin.fetch(path)).text();
    if (text.includes(adminKey)) fail(`a key appears at ${path}`);
  }
  ok("the key appears on no admin screen or API");
  const auditHtml = await (await admin.fetch("/__af/admin/audit")).text();
  expect(auditHtml.includes("key.set") && auditHtml.includes("role.assign") && auditHtml.includes(admin.email), "the audit shows who changed what");

  const applied = await admin.fetch(`/__af/admin/u/${alice.sub}/apply`, form({}));
  await applied.body?.cancel();
  expect(applied.status === 303, "admin applies the change");
  await sleep(3000);
  expect(!containerOf(alice), "applying stops the container, after a snapshot");
  expect((await alice.waitReady()).state === "ready", "the user wakes on their next visit");
  const afterApply = inside(alice, `cat ${HOME}/config.yaml`);
  expect(afterApply.includes("+big"), "a mark typed in the role form reaches the picker", afterApply.slice(0, 400));
  expect((await (await admin.fetch("/__af/admin/roles/engineers")).text()).includes("+ big 2000"), "the role form shows the mark with the model");
  expect(afterApply.includes("alice-gw") && afterApply.includes("big"), "the new role and the override are in place", afterApply.slice(0, 400));
  expect(inside(alice, `cat ${HOME}/SOUL.md`) === "template soul", "the user's files are untouched by the change");
  const keyInEnv = inside(alice, `grep -c '^GW_KEY=${adminKey}$' ${HOME}/.env`);
  expect(keyInEnv === "1", "the user's key reaches .env at boot");
  const roleInfo = await alice.json("/api/model/info");
  expect(roleInfo.model === "m", "the override's default model is selected", JSON.stringify(roleInfo));
  const upToDate = await (await admin.fetch(`/__af/admin/u/${alice.sub}`)).text();
  expect(upToDate.includes("Running config is up to date") && (await admin.json("/__af/admin/users")).users.find((u) => u.sub === alice.sub).config.fingerprint !== appliedBefore, "pending clears after the restart");
  // Back to the template the rest of this suite expects.
  for (const [path, fields] of [[`/__af/admin/u/${alice.sub}/override`, { role: "", gateway_id: "", models: "", default_model: "" }], [`/__af/admin/u/${alice.sub}/role`, { role: "team" }], [`/__af/admin/u/${alice.sub}/key`, { provider: "gw", action: "clear" }]]) {
    const r = await admin.fetch(path, form(fields));
    await r.body?.cancel();
  }
  await alice.json("/__af/stop", { method: "POST" });
  await sleep(3000);
  expect((await alice.waitReady()).state === "ready", "wakes with the original role");

  console.log("== keep awake and stop");
  const tick = () => fetch(`${BASE}/cdn-cgi/handler/scheduled?cron=*/5+*+*+*+*`).catch(() => {});
  const jsonPost = (body) => ({ method: "POST", headers: { "content-type": "application/json", origin: BASE, "sec-fetch-site": "same-origin" }, body: JSON.stringify(body ?? {}) });
  const backupsOf = async (who) => (await row(who))?.backups ?? 0;
  expect((await carol.json("/__af/lease")).state === "asleep", "the chip's read shows asleep, and doesn't start anything");
  await sleep(2000);
  expect(!containerOf(carol), "reading the state doesn't wake a container");
  expect((await carol.waitReady()).state === "ready", "the user's container starts");
  inside(carol, `test -s ${HOME}/desktop-plugins/agent-flare/plugin.js`);
  ok("the chip plugin is installed in the Hermes home");
  await carol.load();
  const pluginRoot = await carol.json("/api/desktop-plugins/root");
  const pluginList = await carol.fetch(`/api/desktop-plugins/list?path=${encodeURIComponent(pluginRoot.root ?? pluginRoot.path ?? pluginRoot)}`);
  const pluginBody = await pluginList.text();
  expect(pluginList.status === 200 && pluginBody.includes("agent-flare"), "Hermes lists the plugin", pluginBody.slice(0, 200));
  const activityBefore = (await row(carol)).lastUserActivity;
  const awake = await carol.json("/__af/lease");
  expect(awake.state === "awake" && awake.reason === "cap" && !awake.warn, "no lease: awake, with the forgotten-tab cap", JSON.stringify(awake));
  expect(awake.idleAt === undefined, "before the chip reports, no idle time is claimed", JSON.stringify(awake));
  expect((await row(carol)).lastUserActivity === activityBefore, "the chip's read isn't activity");
  await sleep(1100);
  const written = await carol.fetch("/api/auth/ws-ticket", { method: "POST", headers: { origin: BASE, "sec-fetch-site": "same-origin" } });
  await written.body?.cancel();
  const afterWrite = await carol.json("/__af/lease");
  expect(afterWrite.stopsAt > awake.stopsAt && afterWrite.idleAt === undefined, "with no chip, a write through the webapp extends the cap, and doesn't start the chip's rule", JSON.stringify(afterWrite));
  for (const [label, body, want] of [["8 hours", { hours: 8 }, 400], ["3 hours", { hours: 3 }, 400], ["1.5 hours", { hours: 1.5 }, 400], ["no hours", {}, 400], ["a string", { hours: "1" }, 400]]) {
    const r = await carol.fetch("/__af/lease", jsonPost(body));
    await r.body?.cancel();
    expect(r.status === want, `a lease of ${label} is refused`, String(r.status));
  }
  for (const path of ["/__af/lease", "/__af/lease/stop", "/__af/wake"]) {
    const r = await carol.fetch(path, { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: '{"hours":1}' });
    await r.body?.cancel();
    expect(r.status === 403, `a cross-site POST to ${path} is refused`, String(r.status));
  }
  expect(containerOf(carol), "and the container is still up");
  const tapped = await carol.json("/__af/lease", jsonPost({ hours: 1 }));
  const remaining = tapped.leaseUntil - Date.now();
  expect(remaining > 3_590_000 && remaining <= 3_600_000, "a tap gives a lease of 1 hour", JSON.stringify(tapped));
  const renewed = await carol.json("/__af/lease", jsonPost({ hours: 2 }));
  expect(renewed.leaseUntil - Date.now() <= 7_200_000, "tapping again can't stack past 2 hours", JSON.stringify(renewed));
  const again1 = await carol.json("/__af/lease", jsonPost({ hours: 1 }));
  expect(again1.leaseUntil < renewed.leaseUntil, "a shorter tap replaces it");
  tapped.leaseUntil = again1.leaseUntil;
  const leased = await carol.json("/__af/lease");
  expect(leased.reason === "lease" && leased.stopsAt === tapped.leaseUntil && !leased.warn, "the chip shows the lease");
  await sleep((SLEEP_AFTER_SECONDS + 25) * 1000);
  expect(containerOf(carol), "a lease holds the container past its idle time, with nothing connected");
  await carol.fetch("/__af/test/age", jsonPost({ ms: 51 * 60_000 }));
  expect((await carol.json("/__af/lease")).warn === true, "the last 10 minutes show a warning");
  await tick();
  await sleep(3000);
  expect(containerOf(carol), "before its end, the cron leaves a lease alone");
  const beforeEnd = await backupsOf(carol);
  await carol.fetch("/__af/test/age", jsonPost({ ms: 10 * 60_000 }));
  await tick();
  for (let i = 0; i < 20 && containerOf(carol); i++) await sleep(1500);
  expect(!containerOf(carol), "at its end the lease stops the container");
  expect(await backupsOf(carol) > beforeEnd, "and it took a snapshot first");
  const parkedDoc = await carol.fetch("/", { headers: { accept: "text/html" } });
  const parkedBody = await parkedDoc.text();
  expect(parkedDoc.status === 503 && parkedBody.includes("Wake it up"), "the page offers a wake button", parkedBody.slice(0, 200));
  const polled = await carol.fetch("/api/status");
  await polled.body?.cancel();
  await carol.fetch("/api/health").then((r) => r.body?.cancel());
  expect(polled.status === 503, "an open tab's polling is refused");
  await sleep(5000);
  expect(!containerOf(carol), "and can't start it again");
  expect((await carol.json("/__af/lease")).state === "parked", "the chip's read says so");
  expect((await (await admin.fetch("/__af/admin")).text()).includes("until the user wakes it"), "the admin screen says so");
  const woken = await carol.fetch("/__af/wake", { method: "POST", headers: { origin: BASE, "sec-fetch-site": "same-origin" } });
  await woken.body?.cancel();
  expect(woken.status === 303 && woken.headers.get("location") === "/", "a tap on wake goes back to the app");
  expect((await carol.waitReady()).state === "ready", "and starts it");
  expect(!(await carol.json("/__af/lease")).reason?.includes("lease"), "with no old lease");

  await carol.load();
  const { ticket: capTicket } = await carol.json("/api/auth/ws-ticket", { method: "POST", headers: { origin: BASE, "sec-fetch-site": "same-origin" } });
  const openTab = new WsClient(`ws://localhost:${PORT}/api/ws?ticket=${capTicket}`, { headers: { "Cf-Access-Jwt-Assertion": carol.token, origin: BASE } });
  await new Promise((resolve, reject) => { openTab.once("message", resolve); openTab.once("error", reject); setTimeout(() => reject(new Error("no frame")), 20_000); })
    .catch((e) => fail("a tab's socket opens", e.message));
  const closed = new Promise((resolve) => openTab.once("close", resolve));
  await carol.fetch("/__af/test/age", jsonPost({ ms: 11 * 3_600_000 }));
  await tick();
  await sleep(3000);
  expect(containerOf(carol), "under the cap, an open tab keeps its container");
  const beforeCap = await backupsOf(carol);
  await carol.fetch("/__af/test/age", jsonPost({ ms: 3_600_000 }));
  await tick();
  for (let i = 0; i < 20 && containerOf(carol); i++) await sleep(1500);
  expect(!containerOf(carol), "the forgotten-tab cap stops it, with a socket open");
  expect(await backupsOf(carol) > beforeCap, "after a snapshot");
  await Promise.race([closed, sleep(10_000)]);
  await sleep(5000);
  expect(!containerOf(carol), "and the tab can't bring it back");
  openTab.terminate();
  const carolWake = await carol.fetch("/__af/wake", { method: "POST", headers: { origin: BASE, "sec-fetch-site": "same-origin" } });
  await carolWake.body?.cancel();
  expect((await carol.waitReady()).state === "ready", "wakes again");

  await carol.load();
  const asleepStop = await carol.fetch("/__af/stop", { method: "POST", headers: { origin: BASE, "sec-fetch-site": "same-origin" } });
  await asleepStop.body?.cancel();
  await sleep(3000);
  expect(!containerOf(carol), "stopped, not planned, for the tab's retries");
  const retry = await carol.fetch("/api/status");
  await retry.body?.cancel();
  await carol.fetch("/api/config", { headers: { accept: "text/html", "sec-fetch-mode": "cors" } }).then((r) => r.body?.cancel());
  const retrySocket = await new Promise((resolve) => {
    const socket = new WsClient(`ws://localhost:${PORT}/api/ws?ticket=x`, { headers: { "Cf-Access-Jwt-Assertion": carol.token, origin: BASE } });
    socket.on("unexpected-response", (_, r) => resolve(r.statusCode));
    socket.on("open", () => { socket.close(); resolve(101); });
    socket.on("error", () => resolve("error"));
  });
  expect(retry.status === 503 && retrySocket === 503, "a tab's API call and socket retry are refused", `${retry.status} ${retrySocket}`);
  await sleep(5000);
  expect(!containerOf(carol), "and can't start a sleeping container");
  expect((await carol.json("/__af/lease")).state === "asleep", "the chip's read says stopped");
  const reloaded = await carol.fetch("/", { headers: { accept: "text/html", "sec-fetch-mode": "navigate" } });
  await reloaded.text();
  expect(reloaded.status === 503, "a page load shows the starting page");
  expect((await carol.waitReady()).state === "ready", "and starts it");
  const reloadedPage = await carol.load();
  expect(reloadedPage.status === 200, "the reload lands on the new backend", JSON.stringify(reloadedPage.hops));
  const stillSignedIn = await carol.fetch("/api/auth/me");
  await stillSignedIn.body?.cancel();
  expect(stillSignedIn.status === 200, "still signed in after the restart");

  console.log("== an open, idle tab stops on time");
  await carol.load();
  const { ticket: idleTicket } = await carol.json("/api/auth/ws-ticket", { method: "POST", headers: { origin: BASE, "sec-fetch-site": "same-origin" } });
  const idleTab = new WsClient(`ws://localhost:${PORT}/api/ws?ticket=${idleTicket}`, { headers: { "Cf-Access-Jwt-Assertion": carol.token, origin: BASE } });
  await new Promise((resolve, reject) => { idleTab.once("message", resolve); idleTab.once("error", reject); setTimeout(() => reject(new Error("no frame")), 20_000); })
    .catch((e) => fail("the tab's socket opens", e.message));
  const reported = await carol.fetch("/__af/activity", { method: "POST", headers: { origin: BASE, "sec-fetch-site": "same-origin" } });
  await reported.body?.cancel();
  const crossReport = await carol.fetch("/__af/activity", { method: "POST", headers: { origin: "https://evil.example" } });
  await crossReport.body?.cancel();
  expect(reported.status === 200 && crossReport.status === 403, "the chip's report works, same-origin only");
  const idleAt = (await carol.json("/__af/lease")).idleAt;
  expect(idleAt > Date.now() && idleAt <= Date.now() + SLEEP_AFTER_SECONDS * 1000, "and the chip now has a real idle time", String(idleAt));
  const tabStarted = Date.now();
  let tabUp = true;
  // The SDK's alarm wakes at most 3 minutes apart, or at its own idle time if sooner, so a stop can be that late.
  while (tabUp && Date.now() - tabStarted < (2 * SLEEP_AFTER_SECONDS + 30) * 1000) {
    await carol.fetch("/api/status").then((r) => r.body?.cancel());
    await carol.fetch("/api/profiles").then((r) => r.body?.cancel());
    const seen = await carol.json("/__af/lease");
    if (seen.idleAt && seen.idleAt !== idleAt) fail("polling moved the idle time", JSON.stringify({ idleAt, seen }));
    if (idleTab.readyState === WsClient.OPEN) idleTab.send('{"jsonrpc":"2.0","id":9,"method":"ping","params":{}}');
    await sleep(4000);
    tabUp = !!containerOf(carol);
  }
  const tabTook = Math.round((Date.now() - tabStarted) / 1000);
  expect(!tabUp && tabTook >= SLEEP_AFTER_SECONDS - 5, `an open socket and a polling tab don't hold it up: stopped after ${tabTook}s of ${SLEEP_AFTER_SECONDS}s idle`, String(tabTook));
  idleTab.terminate();
  await sleep(4000);
  expect(!containerOf(carol), "and the tab's retries don't bring it back");
  const carolPage = await carol.fetch("/", { headers: { accept: "text/html" } });
  await carolPage.text();
  expect((await carol.waitReady()).state === "ready", "a page load does");

  console.log("== a lease holds it past idle, then ends");
  const leasedAgain = await carol.fetch("/__af/lease", jsonPost({ hours: 1 }));
  await leasedAgain.body?.cancel();
  expect(leasedAgain.status === 200, "keep awake");
  await sleep((SLEEP_AFTER_SECONDS + 25) * 1000);
  expect(containerOf(carol), "after a report, a lease still holds it past its idle time");
  await carol.fetch("/__af/test/age", jsonPost({ ms: 3_600_000 }));
  await tick();
  for (let i = 0; i < 20 && containerOf(carol); i++) await sleep(1500);
  expect(!containerOf(carol), "and stops it at the lease's end");
  const carolWake3 = await carol.fetch("/__af/wake", { method: "POST", headers: { origin: BASE, "sec-fetch-site": "same-origin" } });
  await carolWake3.body?.cancel();
  expect((await carol.waitReady()).state === "ready", "wakes again");

  const beforeStop2 = await backupsOf(carol);
  const stopped2 = await carol.fetch("/__af/lease/stop", jsonPost({}));
  await stopped2.body?.cancel();
  expect(stopped2.status === 200, "a tap on stop works");
  await sleep(3000);
  expect(!containerOf(carol) && await backupsOf(carol) > beforeStop2, "it snapshots and stops");
  expect((await carol.json("/__af/status")).status.state === "parked", "and stays stopped");
  const carolWake2 = await carol.fetch("/__af/wake", { method: "POST", headers: { origin: BASE, "sec-fetch-site": "same-origin" } });
  await carolWake2.body?.cancel();

  console.log("== isolation");
  // The section above outlasts the idle time, so alice may have gone to sleep.
  await alice.waitReady();
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
  for (const needle of ["e2e-user-secret", "e2e-shared-token", "byo-prefill-secret", "e2e-admin-set-provider-key"]) {
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
  const beforeStop = (await admin.json("/__af/admin/users")).users.find((u) => u.sub === alice.sub).backups;
  await alice.json("/__af/stop", { method: "POST" });
  await sleep(3000);
  // The stop above took a further snapshot, which is good; corrupt that too.
  const third = (await admin.json("/__af/admin/users")).users.find((u) => u.sub === alice.sub);
  expect(third.backups === beforeStop + 1, "stop added a final snapshot", JSON.stringify(third));
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
  expect(["container not hydrated", "container not running", "container stopping"].includes(refused.skipped), "snapshot refused when not hydrated", JSON.stringify(refused));
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

  expect(!log.join("").includes("e2e-admin-set-provider-key"), "the admin-set key is in no Worker log");
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
  const ours = execFileSync("docker", ["ps", "-q", "--filter", "name=workerd-agent-flare"], { encoding: "utf8" }).split("\n").filter(Boolean);
  for (const id of ours) {
    try { execFileSync("docker", ["rm", "-f", id], { stdio: "ignore" }); } catch {}
  }
  if (process.exitCode === 0) rmSync(persist, { recursive: true, force: true });
  if (existsSync(".dev.vars")) rmSync(".dev.vars");
  setTimeout(() => process.exit(process.exitCode), 1000);
}
