import { AsyncLocalStorage } from "node:async_hooks";
import { chooseTheme, contrastWarnings, customCookie, CUSTOM_FIELDS, DEFAULT_THEME, THEME_NAMES, themeCookie, themeFromCookies, THEMES, validateCustom, type Theme, type ThemeName } from "./themes";
/**
 * The admin screens. Server-rendered, with no script. They are mounted behind the same checks as every admin
 * route: the Worker's Access JWT verification and ADMIN_EMAILS. Cross-site writes are refused by a WAF rule. ADMIN_EMAILS
 * is a Worker var, and nothing here can change it, so an admin can't lose access through these screens.
 *
 * A role is a template; assigning one is an entry in assignments.users. Roles set which models appear in the
 * picker and the default. They make things easy, and they aren't access limits.
 *
 * Keys are write-only. Nothing here reads a value: screens show only where a key comes from and when it changed.
 */
import type { Context, Hono } from "hono";
import type { AccessIdentity } from "./access";
import { clearProviderKey, keyStatuses, setProviderKey, type KeyScope, type KeyStatus } from "./credentials";
import { configFingerprint, overrideKey, resolveEffective, type Effective, type UserOverride } from "./effective";
import type { Env } from "./env";
import { escapeHtml as e } from "./pages";
import { backupKey, getIndex, type BackupEntry } from "./persistence";
import { awakeCount, loadSettings, saveSettings } from "./settings";
import { parseLeaseHours } from "./lease";
import { TIER_MARKS, validateProviders, type GatewayProviderEntry, type ModelTier, type ModelTiers } from "./providers";
import type { AgentSandbox } from "./sandbox";
import { loadAssignments, loadTiers, templateSecrets, TIERS_KEY, type Assignments, type TemplateDefinition } from "./templates";

type Vars = { identity: AccessIdentity; jwt: string };
type App = Hono<{ Bindings: Env; Variables: Vars }>;
type Ctx = Context<{ Bindings: Env; Variables: Vars }>;
type SandboxFor = (env: Env, sub: string) => AgentSandbox;

const ROLE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const EMAIL_RE = /^[^\s@<>"']{1,128}@[^\s@<>"']{1,128}$/;
const GATEWAY_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MODEL_RE = /^[A-Za-z0-9@][A-Za-z0-9@._:/+-]{0,127}$/;
const AUDIT_PREFIX = "audit/";
const MAX_KEY_LENGTH = 4096;
/** What a line of models may start with. */
const MARK_INPUT = Object.fromEntries(Object.entries(TIER_MARKS).map(([tier, mark]) => [mark, tier as ModelTier]));

function splitMark(line: string): { tier?: ModelTier; rest: string } {
  const [first, ...rest] = line.split(/\s+/);
  const tier = MARK_INPUT[first];
  return tier && rest.length ? { tier, rest: rest.join(" ") } : { rest: line };
}

const mark = (tiers: ModelTiers, id: string) => (tiers[id] ? `${TIER_MARKS[tiers[id]]} ` : "");

// ---------------------------------------------------------------------------
// Audit: one new object per change, never rewritten. Holds names and fields, never a value of a key.
// ---------------------------------------------------------------------------

interface AuditRecord {
  at: string;
  actor: string;
  action: string;
  target: string;
  detail?: Record<string, unknown>;
}

export async function audit(c: Ctx, action: string, target: string, detail?: Record<string, unknown>): Promise<void> {
  const at = new Date();
  // Inverted time, so listing returns the newest first.
  const order = String(9_999_999_999_999 - at.getTime()).padStart(13, "0");
  const record: AuditRecord = { at: at.toISOString(), actor: c.get("identity").email, action, target, ...(detail ? { detail } : {}) };
  await c.env.BACKUP_BUCKET.put(`${AUDIT_PREFIX}${order}-${crypto.randomUUID()}.json`, JSON.stringify(record));
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

export const pageContext = new AsyncLocalStorage<{ name: ThemeName | "custom"; tokens: Theme; path: string; savedCustom: Theme | null }>();

function themeForm(current: ThemeName | "custom", path: string): string {
  const label = (name: string) => name[0].toUpperCase() + name.slice(1);
  const button = (name: string) => name === current
    ? `<button name="theme" value="${name}" class="current" aria-current="true">${label(name)} (current)</button>`
    : `<button name="theme" value="${name}">${label(name)}</button>`;
  // Fixed colours, whatever a custom theme has made of the rest of the page.
  const reset = current === "custom"
    ? `<button name="reset" value="1" style="background:#000;color:#fff;border:2px solid #fff;margin:0">Reset to Ember</button>` : "";
  return `<form method="post" action="/__af/admin/theme" class="themes"><input type="hidden" name="back" value="${e(path)}"><span class="muted">Theme</span>
    ${[...THEME_NAMES.map(button), button("custom")].join(" ")} <a href="/__af/admin/theme">Edit colours</a> ${reset}</form>`;
}

export function page(title: string, body: string, status = 200): Response {
  const context = pageContext.getStore() ?? { name: DEFAULT_THEME, tokens: THEMES[DEFAULT_THEME], path: "/__af/admin", savedCustom: null };
  const t = context.tokens;
  return new Response(`<!doctype html>
<html lang="en" style="background:${t.bg}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${e(title)} · Agent Flare</title>
<style>
  :root { color-scheme:dark; --bg:${t.bg}; --surface:${t.surface}; --surface-2:${t.surface2}; --fg:${t.fg}; --muted:${t.muted}; --line:${t.line}; --field-line:${t.fieldLine}; --warn:${t.warn}; --link:${t.link}; --accent:${t.accent}; --on-accent:${t.onAccent}; --accent-hover:${t.accentHover}; }
  html { background:var(--bg); }
  body { margin:0 auto; max-width:60rem; padding:16px; background:var(--bg); color:var(--fg); font:15px/1.5 system-ui,sans-serif; }
  a { color:var(--link); } nav { background:var(--surface-2); margin:-16px -16px 0; padding:.5rem 16px; display:flex; flex-wrap:wrap; align-items:center; gap:.25rem 1rem; } nav a { display:inline-block; padding:.45rem 0; }
  h1 { font-size:1.3rem; } h2 { font-size:1.05rem; margin-top:1.75rem; }
  .scroll { overflow-x:auto; } table { border-collapse:collapse; width:100%; }
  th,td { text-align:left; padding:.35rem .6rem; border-bottom:1px solid var(--line); vertical-align:top; overflow-wrap:anywhere; } th { background:var(--surface); }
  label { display:block; margin:.6rem 0 .15rem; }
  input,select,textarea { font:inherit; max-width:100%; box-sizing:border-box; background:var(--surface); color:var(--fg); border:1px solid var(--field-line); border-radius:4px; padding:.35rem .5rem; }
  input[type=text],input[type=password],textarea { width:32rem; } .muted { color:var(--muted); } .warn { color:var(--warn); }
  code { overflow-wrap:anywhere; } form.inline { display:inline; }
  button { font:inherit; margin-top:.6rem; padding:.4rem .9rem; background:var(--accent); color:var(--on-accent); border:0; border-radius:4px; cursor:pointer; } button:hover { background:var(--accent-hover); }
  .themes { margin-left:auto; display:flex; flex-wrap:wrap; align-items:center; gap:.4rem; } .themes button { margin:0; background:transparent; color:var(--link); border:1px solid var(--field-line); }
  .themes button:hover { background:var(--surface); } .themes button.current { color:var(--fg); font-weight:600; border-color:var(--fg); }
  :focus-visible { outline:2px solid var(--link); outline-offset:2px; }
  @media (pointer:coarse), (max-width:40rem) { input,select,button,nav a { min-height:44px; } }
</style></head><body>
<nav><a href="/__af/admin">Users</a><a href="/__af/admin/roles">Roles</a><a href="/__af/admin/audit">Audit</a>${themeForm(context.name, context.path)}</nav>
<h1>${e(title)}</h1>${body}</body></html>`, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "same-origin",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    },
  });
}

const problem = (message: string, back: string) =>
  page("That didn't save", `<p class="warn">${e(message)}</p><p>Nothing was changed. <a href="${e(back)}">Back</a></p>`, 400);

const seeOther = (location: string) => new Response(null, { status: 303, headers: { location } });
const when = (iso: string | null | undefined) => (iso ? e(iso.replace("T", " ").slice(0, 16)) + " UTC" : "not recorded");

function keyText(status: KeyStatus | undefined): string {
  if (!status || status.source === "none") return `<span class="warn">Not set</span>`;
  if (status.source === "worker-secret") return "Set, from the Worker secret";
  return `Set, for this ${status.source}. Changed ${when(status.changedAt)}`;
}

function roleOptions(roles: string[], selected: string | null | undefined, none: string): string {
  return `<option value="">${e(none)}</option>` +
    roles.map((r) => `<option value="${e(r)}"${r === selected ? " selected" : ""}>${e(r)}</option>`).join("");
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function listRoles(bucket: R2Bucket): Promise<string[]> {
  const listing = await bucket.list({ prefix: "templates/", delimiter: "/" });
  return listing.delimitedPrefixes.map((p) => p.split("/")[1]).sort();
}

async function readDefinition(bucket: R2Bucket, role: string): Promise<TemplateDefinition | null> {
  const object = await bucket.get(`templates/${role}/template.json`);
  return object ? ((await object.json()) as TemplateDefinition) : null;
}

interface UserView {
  sub: string;
  email: string | null;
  details: Awaited<ReturnType<AgentSandbox["describe"]>>;
  backups: number;
  effective: Effective | null;
  keys: Record<string, KeyStatus>;
  tiers: ModelTiers;
  pending: boolean;
}

async function readUser(c: Ctx, sandboxFor: SandboxFor, sub: string): Promise<UserView> {
  const details = await sandboxFor(c.env, sub).describe();
  const backups = (await getIndex(c.env.BACKUP_BUCKET, sub).catch(() => [])).length;
  const email = details.identity;
  if (!email) return { sub, email, details, backups, effective: null, keys: {}, tiers: {}, pending: false };
  const effective = await resolveEffective(c.env.BACKUP_BUCKET, email, details.groups ?? [], templateSecrets(c.env));
  const keys = await keyStatuses(c.env, email, effective.role, effective.providers);
  const tiers = await loadTiers(c.env.BACKUP_BUCKET);
  const applied = (details.config as { fingerprint?: string } | null)?.fingerprint;
  return { sub, email, details, backups, effective, keys, tiers, pending: !!applied && applied !== await configFingerprint(effective, keys, tiers) };
}

const minutesFrom = (at: number | null | undefined) => (at ? `${Math.max(0, Math.ceil((at - Date.now()) / 60_000))} min` : "unknown");
const when2 = (ms: number | null | undefined) => (ms ? when(new Date(ms).toISOString()) : "unknown");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function backupRows(base: string, backups: BackupEntry[], lastRestore: { id?: string; at?: number; skipped?: string[] } | null): string {
  const newest = backups.at(-1)?.id;
  return [...backups].reverse().map((b) => {
    const size = b.stagedBytes;
    const status = lastRestore?.id === b.id ? `Restored and verified ${when2(lastRestore.at)}`
      : lastRestore?.skipped?.includes(b.id) ? "Failed verification" : "Not restored yet";
    return `<tr><td>${when(b.createdAt)}${b.id === newest ? " <strong>(newest)</strong>" : ""}</td>
      <td>${size ? `${(size / 1_048_576).toFixed(1)} MB` : "unknown"}</td>
      <td>${e(status)}</td>
      <td><a href="${base}/backups/${encodeURIComponent(b.id)}">Download</a></td></tr>`;
  }).join("");
}

const PENDING = `<span class="warn">Change waiting for next boot</span>`;

function statusText(user: UserView): string {
  const state = user.details.status;
  if (user.details.parked) return "Stopped, until the user wakes it";
  if (state.state === "failed") return `<span class="warn">Failed</span>`;
  return state.state === "ready" ? "Ready" : `Asleep or starting`;
}

const SOURCE_TEXT: Record<Effective["source"], string> = {
  override: "per-user override",
  role: "assigned role",
  assignment: "group, domain or default assignment",
  none: "nothing assigned",
};

function modelList(provider: GatewayProviderEntry, tiers: ModelTiers): string {
  const selected = provider.model ?? Object.keys(provider.models)[0];
  return `<ul>${Object.keys(provider.models).map((m) => `<li><code>${e(mark(tiers, m))}${e(m)}</code>${m === selected ? " <span class=muted>(default)</span>" : ""}</li>`).join("")}</ul>`;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function adminScreens(admin: App, sandboxFor: SandboxFor, activeUsers: (bucket: R2Bucket) => Promise<string[]>): void {
  // The theme comes from cookies, checked here on every request, and reaches page() without passing through each route.
  admin.use("*", (c, next) => {
    const url = new URL(c.req.url);
    const theme = themeFromCookies(c.req.header("cookie"));
    return pageContext.run({ ...theme, path: url.pathname + url.search }, () => next());
  });

  admin.post("/theme", async (c) => {
    const { cookies, location } = chooseTheme(await c.req.parseBody(), c.req.header("cookie"));
    const headers = new Headers({ location });
    for (const cookie of cookies) headers.append("set-cookie", cookie);
    return new Response(null, { status: 303, headers });
  });

  admin.get("/theme", (c) => {
    const { tokens, name } = pageContext.getStore()!;
    const warnings = name === "custom" ? contrastWarnings(tokens) : [];
    return page("Theme colours", `
      ${warnings.length ? `<p class="warn" style="background:#000;color:#fff;padding:.5rem;border:2px solid #fff">Some text may be hard to read: ${warnings.map(e).join("; ")}. It's saved anyway.</p>` : ""}
      <p class="muted">Each one as #rrggbb. Saved in this browser only.</p>
      <form method="post" action="/__af/admin/theme/custom">
        ${CUSTOM_FIELDS.map(([key, label]) => `<label for="c-${key}">${e(label)}</label><input id="c-${key}" type="text" name="${key}" value="${e(tokens[key])}" pattern="#[0-9a-fA-F]{6}" maxlength="7" required>`).join("")}
        <br><button>Save</button>
      </form>`);
  });

  admin.post("/theme/custom", async (c) => {
    const result = validateCustom(await c.req.parseBody());
    if ("invalid" in result) return problem(`Each colour has to be #rrggbb. Check: ${result.invalid.join(", ")}.`, "/__af/admin/theme");
    const headers = new Headers({ location: "/__af/admin/theme" });
    headers.append("set-cookie", customCookie(result.theme));
    headers.append("set-cookie", themeCookie("custom"));
    return new Response(null, { status: 303, headers });
  });

  admin.get("/", async (c) => {
    const listing = await c.env.BACKUP_BUCKET.list({ prefix: "users/", delimiter: "/" });
    const subs = [...new Set([...listing.delimitedPrefixes.map((p) => p.split("/")[1]), ...(await activeUsers(c.env.BACKUP_BUCKET))])];
    const users = await Promise.all(subs.map((sub) => readUser(c, sandboxFor, sub)));
    const rows = users.map((u) => `<tr>
      <td><a href="/__af/admin/u/${encodeURIComponent(u.sub)}">${e(u.email ?? u.sub)}</a></td>
      <td>${statusText(u)}</td><td>${u.backups}</td><td>${e(u.effective?.role ?? "none")}</td>
      <td>${e((u.details.config as { inference?: { selected?: string | null } } | null)?.inference?.selected ?? "none")}</td>
      <td>${u.pending ? PENDING : "Up to date"}</td></tr>`).join("");
    return page("Users", `<div class="scroll"><table><tr><th>User</th><th>Status</th><th>Backups</th><th>Role</th><th>Provider</th><th>Config</th></tr>
      ${rows || `<tr><td colspan="6" class="muted">Nobody has logged in yet.</td></tr>`}</table></div>
      <h2>Containers awake at once</h2>
      <p>${await awakeCount(c.env.BACKUP_BUCKET)} awake now. Containers already running are never stopped by this. Someone over the limit sees an "at capacity" page.</p>
      <form method="post" action="/__af/admin/settings"><label for="max-awake">Limit, 0 for no limit</label>
        <input id="max-awake" type="text" inputmode="numeric" name="maxAwake" value="${(await loadSettings(c.env.BACKUP_BUCKET)).maxAwake}"> <button>Save</button></form>
      <p class="muted">Admins come from the ADMIN_EMAILS Worker variable. These screens can't change it.</p>`);
  });

  admin.get("/u/:sub", async (c) => {
    const sub = c.req.param("sub");
    const user = await readUser(c, sandboxFor, sub);
    if (!user.email || !user.effective) return page("Unknown user", `<p>No one with this ID has logged in.</p>`, 404);
    const { effective: eff } = user;
    const base = `/__af/admin/u/${encodeURIComponent(sub)}`;
    const roles = await listRoles(c.env.BACKUP_BUCKET);
    const override: UserOverride = eff.override ?? {};
    const assignments = await loadAssignments(c.env.BACKUP_BUCKET);
    const assigned = Object.entries(assignments?.users ?? {}).find(([k]) => k.toLowerCase() === user.email!.toLowerCase())?.[1];
    const providers = eff.providers.map((p) => `<h3><code>${e(p.name)}</code></h3>
      <p>Gateway: <code>${e(p.gateway_id ?? "none")}</code>. Key: ${keyText(user.keys[p.name])}</p>
      <p>Models in the picker:</p>${modelList(p, user.tiers)}
      <form method="post" action="${base}/key"><input type="hidden" name="provider" value="${e(p.name)}">
        <label for="key-${e(p.name)}">New key for this user only</label>
        <input id="key-${e(p.name)}" type="password" name="value" autocomplete="off">
        <button name="action" value="set">Save key</button>
        <button name="action" value="clear">Remove this user's key</button></form>`).join("");
    const templateKeys = eff.template;
    return page(user.email, `
      <p>${statusText(user)}. ${user.backups} backup(s). ${user.pending ? PENDING : "Running config is up to date."}</p>
      ${user.details.status.state === "failed" ? `<p class="warn">${e(user.details.status.error)}</p>` : ""}
      <h2>Container</h2>
      ${(() => {
        const lease = user.details.lease as { state: string; reason?: string; stopsAt?: number; idleAt?: number };
        return lease.state === "awake"
          ? `<p>Awake. ${lease.reason === "lease" ? `Kept awake until ${when2(lease.stopsAt)}.` : lease.idleAt ? `Idle time runs out in ${minutesFrom(lease.idleAt)}.` : "The user's status chip hasn't reported yet."}</p>
             <form method="post" action="${base}/keep-awake" class="inline"><button name="hours" value="1">Keep awake 1 hour</button> <button name="hours" value="2">Keep awake 2 hours</button></form>
             <form method="post" action="${base}/stop" class="inline"><button>Stop, saving first</button></form>`
          : `<p>${lease.state === "parked" ? "Stopped, until the user wakes it." : "Asleep. It starts when the user opens the page."}</p>`;
      })()}
      <h2>Backups</h2>
      <p class="warn">A download holds this person's chats and files, and any passwords or keys in them.</p>
      <div class="scroll"><table><tr><th>When</th><th>Size</th><th>Status</th><th></th></tr>
      ${backupRows(base, await getIndex(c.env.BACKUP_BUCKET, sub).catch(() => []), user.details.lastRestore as never) || `<tr><td colspan="4" class="muted">No backups yet.</td></tr>`}</table></div>

      <h2>Effective config</h2>
      <p>Role: <strong>${e(eff.role ?? "none")}</strong>, from ${e(SOURCE_TEXT[eff.source])}. Order: per-user override, then assigned role, then group, domain and default assignments.</p>
      ${providers || `<p class="muted">No providers. This user opens Hermes's own setup.</p>`}
      <p>Reapplied every boot, and the role wins: ${e(Object.keys(templateKeys?.configManaged ?? {}).join(", ") || "none")}.<br>
         Set once, then the user's to change: ${e(Object.keys(templateKeys?.configDefaults ?? {}).join(", ") || "none")}.<br>
         Environment variables from the role: ${e(Object.keys(templateKeys?.env ?? {}).join(", ") || "none")}.</p>

      <h2>Role</h2>
      <form method="post" action="${base}/role"><label for="role">Assigned role</label>
        <select id="role" name="role">${roleOptions(roles, assigned, "No direct assignment")}</select>
        <button>Save role</button></form>

      <h2>Overrides for this user</h2>
      <p class="muted">These replace what the role says for this user. Leave blank to use the role.</p>
      <form method="post" action="${base}/override">
        <label for="o-role">Role, ahead of any assignment</label>
        <select id="o-role" name="role">${roleOptions(roles, override.role, "None")}</select>
        <label for="o-gw">Gateway name</label><input id="o-gw" type="text" name="gateway_id" value="${e(override.gateway_id ?? "")}">
        <label for="o-models">Models in the picker, one per line</label>
        <textarea id="o-models" name="models" rows="5">${e((override.models ?? []).join("\n"))}</textarea>
        <label for="o-default">Default model</label><input id="o-default" type="text" name="default_model" value="${e(override.default_model ?? "")}">
        <br><button>Save overrides</button></form>

      <h2>When changes take effect</h2>
      <p>Every change on this page applies at this user's next boot: when their container wakes after sleeping, or when you apply it below. A running container doesn't change until then.</p>
      <p>A default model applies only if the user hasn't picked their own. Their conversations, files and their own settings stay as they are. A model list and default make choosing easy, and they aren't access limits.</p>
      <form method="post" action="${base}/apply"><button>Apply now: save a snapshot, then restart on next visit</button></form>
      <p class="muted">If the snapshot fails, the container stays up and nothing changes. This ends any turn in progress.</p>`);
  });

  admin.post("/u/:sub/keep-awake", async (c) => {
    const sub = c.req.param("sub");
    const back = `/__af/admin/u/${encodeURIComponent(sub)}`;
    const { identity: email } = await sandboxFor(c.env, sub).describe();
    if (!email) return problem("No one with this ID has logged in.", "/__af/admin");
    const hours = parseLeaseHours(Number(String((await c.req.parseBody()).hours ?? "")));
    if (!hours) return problem("Keep awake is 1 or 2 hours.", back);
    const result = await sandboxFor(c.env, sub).keepAwake(hours);
    if ("error" in result) return problem("The container isn't running.", back);
    await audit(c, "keep-awake", email, { hours });
    return seeOther(back);
  });

  admin.post("/u/:sub/stop", async (c) => {
    const sub = c.req.param("sub");
    const back = `/__af/admin/u/${encodeURIComponent(sub)}`;
    const { identity: email } = await sandboxFor(c.env, sub).describe();
    if (!email) return problem("No one with this ID has logged in.", "/__af/admin");
    const result = await sandboxFor(c.env, sub).stopByUser();
    if ("error" in result) {
      await audit(c, "stop.failed", email);
      return problem("The snapshot failed, so the container stays up and nothing changed.", back);
    }
    await audit(c, "stop", email, { result: result.status });
    return seeOther(back);
  });

  // Only an ID in this user's own index resolves, and it only ever names that backup's archive, so this can't
  // reach any other object in the bucket. Streams from R2: nothing is held in memory.
  admin.get("/u/:sub/backups/:id", async (c) => {
    const sub = c.req.param("sub");
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.text("Not found", 404);
    const { identity: email } = await sandboxFor(c.env, sub).describe();
    const entry = (await getIndex(c.env.BACKUP_BUCKET, sub).catch(() => [])).find((b) => b.id === id);
    if (!email || !entry) return c.text("Not found", 404);
    const key = backupKey(entry.id);
    const object = await c.env.BACKUP_BUCKET.get(key);
    if (!object) return c.text("Not found", 404);
    await audit(c, "backup.download", email, { backup: id });
    return new Response(object.body, {
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(object.size),
        "content-disposition": `attachment; filename="agent-flare-${id}.sqsh"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  });

  admin.post("/settings", async (c) => {
    const value = Number(String((await c.req.parseBody()).maxAwake ?? ""));
    if (!Number.isInteger(value) || value < 0 || value > 10_000) return problem("That has to be a whole number, 0 for no limit.", "/__af/admin");
    await saveSettings(c.env.BACKUP_BUCKET, { maxAwake: value });
    await audit(c, "settings.max-awake", "all", { maxAwake: value });
    return seeOther("/__af/admin");
  });

  admin.post("/u/:sub/role", async (c) => {
    const sub = c.req.param("sub");
    const back = `/__af/admin/u/${encodeURIComponent(sub)}`;
    const { identity: email } = await sandboxFor(c.env, sub).describe();
    if (!email) return problem("No one with this ID has logged in.", "/__af/admin");
    const role = String((await c.req.parseBody()).role ?? "");
    const error = await assign(c, email, role);
    return error ? problem(error, back) : seeOther(back);
  });

  admin.post("/u/:sub/override", async (c) => {
    const sub = c.req.param("sub");
    const back = `/__af/admin/u/${encodeURIComponent(sub)}`;
    const { identity: email } = await sandboxFor(c.env, sub).describe();
    if (!email) return problem("No one with this ID has logged in.", "/__af/admin");
    const body = await c.req.parseBody();
    const role = String(body.role ?? "").trim();
    const gateway_id = String(body.gateway_id ?? "").trim();
    const default_model = String(body.default_model ?? "").trim();
    const models = String(body.models ?? "").split("\n").map((m) => splitMark(m.trim()).rest).filter(Boolean);
    if (role && !(await readDefinition(c.env.BACKUP_BUCKET, role))) return problem("That role doesn't exist.", back);
    if (gateway_id && !GATEWAY_RE.test(gateway_id)) return problem("Gateway names are letters, digits, dashes and underscores.", back);
    const badModel = [...models, ...(default_model ? [default_model] : [])].find((m) => !MODEL_RE.test(m));
    if (badModel) return problem(`That isn't a model ID: ${badModel}`, back);
    if (default_model && models.length && !models.includes(default_model)) return problem("The default model has to be in the list.", back);
    const override: UserOverride = {
      ...(role ? { role } : {}), ...(gateway_id ? { gateway_id } : {}),
      ...(models.length ? { models } : {}), ...(default_model ? { default_model } : {}),
    };
    if (Object.keys(override).length) await c.env.BACKUP_BUCKET.put(overrideKey(email), JSON.stringify(override));
    else await c.env.BACKUP_BUCKET.delete(overrideKey(email));
    await audit(c, "override.set", email, { ...override });
    return seeOther(back);
  });

  admin.post("/u/:sub/key", async (c) => {
    const sub = c.req.param("sub");
    const back = `/__af/admin/u/${encodeURIComponent(sub)}`;
    const { identity: email } = await sandboxFor(c.env, sub).describe();
    if (!email) return problem("No one with this ID has logged in.", "/__af/admin");
    return saveKey(c, { kind: "user", email }, email, back);
  });

  admin.post("/u/:sub/apply", async (c) => {
    const sub = c.req.param("sub");
    const back = `/__af/admin/u/${encodeURIComponent(sub)}`;
    const { identity: email } = await sandboxFor(c.env, sub).describe();
    if (!email) return problem("No one with this ID has logged in.", "/__af/admin");
    const result = await sandboxFor(c.env, sub).applyByRestart();
    if ("error" in result) {
      console.error(`[admin:apply:${sub}] ${result.error}`);
      await audit(c, "apply.failed", email);
      return problem("The snapshot failed, so the container stays up and nothing changed. Check the logs and try again.", back);
    }
    await audit(c, "apply", email, { result: result.status });
    return seeOther(back);
  });

  admin.get("/roles", async (c) => {
    const roles = await listRoles(c.env.BACKUP_BUCKET);
    const assignments = (await loadAssignments(c.env.BACKUP_BUCKET)) ?? {};
    const rows = await Promise.all(roles.map(async (r) => {
      const definition = await readDefinition(c.env.BACKUP_BUCKET, r);
      const providers = Array.isArray(definition?.providers) ? (definition.providers as GatewayProviderEntry[]) : [];
      const count = providers.reduce((n, p) => n + Object.keys(p.models ?? {}).length, 0);
      const people = Object.entries(assignments.users ?? {}).filter(([, t]) => t === r).map(([u]) => u);
      return `<tr><td><a href="/__af/admin/roles/${encodeURIComponent(r)}">${e(r)}</a></td><td>${count}</td><td>${e(people.join(", ") || "none")}</td></tr>`;
    }));
    return page("Roles", `<p class="muted">A role sets which models people see in the picker, their default and the provider settings. Roles make choosing easy; they don't limit access. The provider key is readable by each user's agent, so anyone can reach what that key allows.</p>
      <div class="scroll"><table><tr><th>Role</th><th>Models</th><th>Assigned people</th></tr>${rows.join("") || `<tr><td colspan="3" class="muted">No roles yet.</td></tr>`}</table></div>
      <p>Everyone else gets: <code>${e(assignments.default ?? "nothing")}</code>.</p>
      <h2>Create a role</h2>
      <form method="get" action="/__af/admin/roles/new"><label for="name">Name</label><input id="name" type="text" name="name"><button>Continue</button></form>
      <h2>Assign someone who hasn't logged in yet</h2>
      <form method="post" action="/__af/admin/assign"><label for="a-email">Email</label><input id="a-email" type="text" name="email">
        <label for="a-role">Role</label><select id="a-role" name="role">${roleOptions(roles, null, "Remove assignment")}</select>
        <br><button>Save</button></form>`);
  });

  admin.post("/assign", async (c) => {
    const body = await c.req.parseBody();
    const email = String(body.email ?? "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return problem("That isn't an email address.", "/__af/admin/roles");
    const error = await assign(c, email, String(body.role ?? ""));
    return error ? problem(error, "/__af/admin/roles") : seeOther("/__af/admin/roles");
  });

  // Registered before /roles/:name would match "new".
  admin.get("/roles/new", (c) => {
    const name = (c.req.query("name") ?? "").trim();
    if (!ROLE_RE.test(name)) return problem("Role names are letters, digits, dashes and underscores.", "/__af/admin/roles");
    return seeOther(`/__af/admin/roles/${encodeURIComponent(name)}`);
  });

  admin.get("/roles/:name", async (c) => {
    const role = c.req.param("name");
    if (!ROLE_RE.test(role)) return page("Unknown role", `<p>That isn't a role name.</p>`, 404);
    const definition = await readDefinition(c.env.BACKUP_BUCKET, role);
    const providers = Array.isArray(definition?.providers) ? (definition.providers as GatewayProviderEntry[]) : [];
    const provider = providers[0];
    const statuses = provider ? await keyStatuses(c.env, "", role, [provider]) : {};
    const tiers = await loadTiers(c.env.BACKUP_BUCKET);
    const lines = provider ? Object.entries(provider.models ?? {}).map(([m, i]) => `${mark(tiers, m)}${m}${i.context_length ? ` ${i.context_length}` : ""}`).join("\n") : "";
    const base = `/__af/admin/roles/${encodeURIComponent(role)}`;
    return page(`Role: ${role}`, `
      ${definition ? "" : `<p class="muted">New role. It's created when you save.</p>`}
      ${providers.length > 1 ? `<p class="warn">This role has ${providers.length} providers. This screen edits only the first.</p>` : ""}
      <form method="post" action="${base}">
        <label for="p-name">Provider name</label><input id="p-name" type="text" name="name" value="${e(provider?.name ?? "")}">
        <label for="p-url">Endpoint URL</label><input id="p-url" type="text" name="base_url" value="${e(provider?.base_url ?? "")}">
        <label for="p-gw">Gateway name</label><input id="p-gw" type="text" name="gateway_id" value="${e(provider?.gateway_id ?? "")}">
        <label for="p-mode">Key comes from</label><select id="p-mode" name="mode">
          <option value="api_token"${provider?.mode !== "user_env" ? " selected" : ""}>A shared key: set below, or a Worker secret</option>
          <option value="user_env"${provider?.mode === "user_env" ? " selected" : ""}>Each user: set on their page, or by them</option></select>
        <label for="p-cred">Worker secret to use if no key is set below</label>
        <input id="p-cred" type="text" name="credential" value="${e(provider?.credential ?? "")}" placeholder="CLOUDFLARE_AI_API_TOKEN">
        <label for="p-env">Variable name in the user's .env</label><input id="p-env" type="text" name="key_env" value="${e(provider?.key_env ?? "")}">
        <label for="p-models">Models in the picker, one per line, as <code>mark model-id context-length</code>. The mark and context length are optional.</label>
        <textarea id="p-models" name="models" rows="12">${e(lines)}</textarea>
        <label for="p-default">Default model</label><input id="p-default" type="text" name="model" value="${e(provider?.model ?? "")}">
        <p class="muted">Marks: <code>${e(TIER_MARKS.low)}</code> low, <code>${e(TIER_MARKS.medium)}</code> medium, <code>${e(TIER_MARKS.high)}</code> high, <code>${e(TIER_MARKS.premium)}</code> far above the rest. They show the model's cost, at the start of its name in the picker. A model has one mark across all roles, so changing it here changes it everywhere.</p>
        <button>Save role</button></form>
      ${provider ? `<h2>Key for this role</h2><p>${keyText(statuses[provider.name])}</p>
      <form method="post" action="${base}/key"><input type="hidden" name="provider" value="${e(provider.name)}">
        <label for="r-key">New key</label><input id="r-key" type="password" name="value" autocomplete="off">
        <button name="action" value="set">Save key</button><button name="action" value="clear">Remove this role's key</button></form>` : ""}
      <h2>When changes take effect</h2>
      <p>At each assigned user's next boot. The Users screen shows who is waiting, and their page can apply it now. Other settings in this role's template, such as <code>config_managed</code>, stay as they are.</p>`);
  });

  admin.post("/roles/:name", async (c) => {
    const role = c.req.param("name");
    const back = `/__af/admin/roles/${encodeURIComponent(role)}`;
    if (!ROLE_RE.test(role)) return problem("Role names are letters, digits, dashes and underscores.", "/__af/admin/roles");
    const body = await c.req.parseBody();
    const field = (name: string) => String(body[name] ?? "").trim();
    const models: GatewayProviderEntry["models"] = {};
    const marked: ModelTiers = {};
    for (const line of field("models").split("\n").map((l) => l.trim()).filter(Boolean)) {
      const { tier, rest } = splitMark(line);
      const [id, length] = rest.split(/\s+/);
      if (tier) marked[id] = tier;
      if (!MODEL_RE.test(id)) return problem(`That isn't a model ID: ${id}`, back);
      if (length && !/^\d{1,9}$/.test(length)) return problem(`That isn't a context length: ${length}`, back);
      models[id] = length ? { context_length: Number(length) } : {};
    }
    const definition = (await readDefinition(c.env.BACKUP_BUCKET, role)) ?? {};
    const existing = Array.isArray(definition.providers) ? (definition.providers as GatewayProviderEntry[]) : [];
    const previous = existing[0];
    for (const id of Object.keys(models)) {
      const info = previous?.models?.[id];
      if (info) models[id] = { ...info, ...models[id] };
    }
    const entry = {
      ...previous,
      name: field("name"), mode: field("mode"), base_url: field("base_url"), key_env: field("key_env"), models,
      gateway_id: field("gateway_id") || undefined, credential: field("credential") || undefined, model: field("model") || undefined,
      api_mode: previous?.api_mode ?? "chat_completions",
    };
    const parsed = validateProviders([entry, ...existing.slice(1)]);
    if (!parsed.ok) return problem(parsed.error.replace(/^entry\[0\]\./, ""), back);
    if (/YOUR_[A-Z0-9_]+/.test(JSON.stringify(entry))) return problem("Replace the YOUR_ placeholders first.", back);
    await c.env.BACKUP_BUCKET.put(`templates/${role}/template.json`, JSON.stringify({ ...definition, providers: parsed.entries }, null, 2));
    const tiers = await loadTiers(c.env.BACKUP_BUCKET);
    if (Object.entries(marked).some(([id, tier]) => tiers[id] !== tier)) {
      await c.env.BACKUP_BUCKET.put(TIERS_KEY, JSON.stringify({ ...tiers, ...marked }, null, 2));
      await audit(c, "tiers.save", role, { ...marked });
    }
    await audit(c, "role.save", role, {
      provider: entry.name, gateway: entry.gateway_id, models: Object.keys(models), default: entry.model, credential: entry.credential, mode: entry.mode,
    });
    return seeOther(back);
  });

  admin.post("/roles/:name/key", async (c) => {
    const role = c.req.param("name");
    const back = `/__af/admin/roles/${encodeURIComponent(role)}`;
    if (!ROLE_RE.test(role) || !(await readDefinition(c.env.BACKUP_BUCKET, role))) return problem("That role doesn't exist.", "/__af/admin/roles");
    return saveKey(c, { kind: "role", role }, role, back);
  });

  admin.get("/audit", async (c) => {
    const listing = await c.env.BACKUP_BUCKET.list({ prefix: AUDIT_PREFIX, limit: 100 });
    const records = await Promise.all(listing.objects.map(async (o) => (await c.env.BACKUP_BUCKET.get(o.key))?.json<AuditRecord>()));
    const rows = records.filter(Boolean).map((r) => `<tr><td>${when(r!.at)}</td><td>${e(r!.actor)}</td><td>${e(r!.action)}</td><td>${e(r!.target)}</td>
      <td><code>${r!.detail ? e(JSON.stringify(r!.detail)) : ""}</code></td></tr>`).join("");
    return page("Audit", `<p class="muted">The newest 100 changes. Records can't be changed from here, and never include a key.</p>
      <div class="scroll"><table><tr><th>When</th><th>Who</th><th>What</th><th>Target</th><th>Detail</th></tr>${rows || `<tr><td colspan="5" class="muted">Nothing yet.</td></tr>`}</table></div>`);
  });

  async function assign(c: Ctx, email: string, role: string): Promise<string | null> {
    if (role && !(await readDefinition(c.env.BACKUP_BUCKET, role))) return "That role doesn't exist.";
    const assignments: Assignments = (await loadAssignments(c.env.BACKUP_BUCKET)) ?? {};
    const users = Object.fromEntries(Object.entries(assignments.users ?? {}).filter(([u]) => u.toLowerCase() !== email.toLowerCase()));
    if (role) users[email.toLowerCase()] = role;
    await c.env.BACKUP_BUCKET.put("config/assignments.json", JSON.stringify({ ...assignments, users }, null, 2));
    await audit(c, role ? "role.assign" : "role.unassign", email, role ? { role } : undefined);
    return null;
  }

  async function saveKey(c: Ctx, scope: KeyScope, target: string, back: string): Promise<Response> {
    const body = await c.req.parseBody();
    const provider = String(body.provider ?? "");
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(provider)) return problem("That provider name isn't valid.", back);
    if (body.action === "clear") {
      await clearProviderKey(c.env, scope, provider);
      await audit(c, "key.clear", target, { scope: scope.kind, provider });
      return seeOther(back);
    }
    const value = String(body.value ?? "").trim();
    if (!value) return problem("Enter a key, or use remove.", back);
    if (value.length > MAX_KEY_LENGTH || /[\r\n]/.test(value)) return problem("A key is a single line of up to 4096 characters.", back);
    await setProviderKey(c.env, scope, provider, value);
    await audit(c, "key.set", target, { scope: scope.kind, provider });
    return seeOther(back);
  }
}
