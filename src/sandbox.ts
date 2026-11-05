/**
 * One Durable Object per Access user, owning that user's container and state.
 *
 * Lifecycle rules this class enforces:
 * - Hydration runs once per container, however many requests arrive at once.
 * - READY_FILE exists only after hydration completes. It releases Hermes from its boot gate
 *   and also gates snapshots, so a home that was never hydrated can't be snapshotted over a
 *   user's history. It lives in the container, so it dies with the container.
 * - A container that idles out gets a final snapshot before it stops.
 */
import { Sandbox } from "@cloudflare/sandbox";
import type { AccessIdentity } from "./access";
import type { Env } from "./env";
import { AF_STATE, createSnapshot, HERMES_HOME, restoreNewest } from "./persistence";
import { renderProviders } from "./providers";
import { pruneSnapshots } from "./prune";
import { deriveUserSecret, getSealed, prefillKey, seal, sealedFilesKey, unseal } from "./secrets";
import { fetchAccessGroups, loadAssignments, loadTemplate, pickTemplate } from "./templates";

export const WEBAPP_PORT = 443;
const RUN_DIR = "/run/agent-flare";
const READY_FILE = `${RUN_DIR}/ready`;
const IDENTITY_KEY = "identity";
const SEALED_COPY_KEY = "sealed-files";
const ACTIVE_PREFIX = "active/";
const WEBAPP_START_TIMEOUT_MS = 120_000;
/** After a failed hydration, keep reporting it for this long before trying again. */
const HYDRATION_RETRY_MS = 30_000;

export type ReadyState =
  | { state: "ready" }
  | { state: "starting"; step: string }
  | { state: "failed"; error: string };

interface StoredIdentity extends AccessIdentity {
  publicUrl: string;
}

export class HermesSandbox extends Sandbox<Env> {
  private hydration: Promise<void> | null = null;
  private status: ReadyState = { state: "starting", step: "waiting" };
  private ready = false;
  private lastUserActivity = 0;
  private lastSnapshotAt = 0;
  private finalSnapshotRunning = false;
  private lastFailureAt = 0;

  /** Current state. Starts hydration if needed and returns without waiting for it. */
  async ensureReady(identity: AccessIdentity, publicUrl: string, accessJwt: string): Promise<ReadyState> {
    this.lastUserActivity = Date.now();
    if (this.ready && (await this.isRunning())) return { state: "ready" };
    this.ready = false;
    if (this.status.state === "failed" && Date.now() - this.lastFailureAt < HYDRATION_RETRY_MS) {
      return this.status;
    }
    if (!this.hydration) {
      this.status = { state: "starting", step: "starting container" };
      const run = this.hydrate({ ...identity, publicUrl }, accessJwt)
        .then(() => {
          this.ready = true;
          this.status = { state: "ready" };
        })
        .catch((err) => {
          const error = err instanceof Error ? err.message : String(err);
          console.error(`[hydrate:${identity.sub}] ${error}`);
          this.lastFailureAt = Date.now();
          this.status = { state: "failed", error };
        })
        .finally(() => {
          this.hydration = null;
        });
      this.hydration = run;
      this.ctx.waitUntil(run);
    }
    return this.status;
  }

  private async isRunning(): Promise<boolean> {
    const state = await this.getState();
    return state.status === "healthy" || state.status === "running";
  }

  private async hasReadyFile(): Promise<boolean> {
    const result = await this.exec(`test -f ${READY_FILE}`);
    return result.exitCode === 0;
  }

  private async hydrate(identity: StoredIdentity, accessJwt: string): Promise<void> {
    await this.ctx.storage.put(IDENTITY_KEY, identity);
    await this.env.BACKUP_BUCKET.put(`${ACTIVE_PREFIX}${identity.sub}`, identity.email);

    // Durable Objects can be evicted while their container keeps running.
    if (await this.hasReadyFile()) {
      await this.waitForWebapp();
      return;
    }

    this.status = { state: "starting", step: "restoring your state" };
    const outcome = await restoreNewest(this, this.env.BACKUP_BUCKET, identity.sub);
    console.log(`[hydrate:${identity.sub}] ${JSON.stringify(outcome)}`);

    this.status = { state: "starting", step: "applying configuration" };
    await this.applyConfiguration(identity, accessJwt);

    // Only now can Hermes start, and only now can snapshots run.
    await this.exec(`mkdir -p ${RUN_DIR} && touch ${READY_FILE}`);
    this.status = { state: "starting", step: "starting Hermes" };
    await this.waitForWebapp();
  }

  private async applyConfiguration(identity: StoredIdentity, accessJwt: string): Promise<void> {
    const env = this.env;
    const warnings: string[] = [];

    const assignments = await loadAssignments(env.BACKUP_BUCKET);
    const groups = assignments?.groups && Object.keys(assignments.groups).length
      ? await fetchAccessGroups(identity.issuer, accessJwt)
      : [];
    const templateName = pickTemplate(assignments, identity.email, groups);
    const template = templateName
      ? await loadTemplate(env.BACKUP_BUCKET, templateName, env as unknown as Record<string, unknown>)
      : null;
    if (templateName && !template) warnings.push(`template ${templateName} is not in R2`);
    warnings.push(...(template?.warnings ?? []));

    const providers = renderProviders(template?.providers ?? [], env.CLOUDFLARE_AI_API_TOKEN ?? "", identity.email);
    warnings.push(...providers.warnings);

    // The Durable Object's copy first: KV can serve a value up to a minute stale, which would undo a
    // secret changed just before a stop. KV stays the durable home for the value.
    const filesKey = sealedFilesKey(identity.sub);
    const sealedRaw = (await this.ctx.storage.get<string>(SEALED_COPY_KEY)) ?? (await env.CREDENTIALS_KV.get(filesKey));
    const sealed = sealedRaw
      ? (JSON.parse(await unseal(env.MASTER_KEY, filesKey, sealedRaw)) as Record<string, string>)
      : null;
    const prefill = await getSealed<Record<string, string>>(
      env.CREDENTIALS_KV, env.MASTER_KEY, prefillKey(identity.email));

    // Platform keys come last so a template can never turn the sign-in gate off or move the port.
    const platformConfig = {
      webapp: { enabled: true, host: "0.0.0.0", port: WEBAPP_PORT, public_url: identity.publicUrl },
      dashboard: { trusted_proxies: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.1"] },
    };
    const bundle = {
      sealed: sealed ?? {},
      template: template ? { name: template.name, files: template.files } : null,
      config_defaults: {
        ...(providers.defaultModel ? { model: providers.defaultModel } : {}),
        ...template?.configDefaults,
      },
      config_managed: {
        ...template?.configManaged,
        ...(providers.customProviders.length ? { custom_providers: providers.customProviders } : {}),
        ...platformConfig,
      },
      // A prefill is the user's own value: it applies only while they haven't set one. Template and
      // provider values are managed and apply on every boot.
      env_defaults: prefill ?? {},
      env: { ...template?.env, ...providers.env },
      session_token: await this.browserToken(identity.sub),
    };

    await this.exec(`mkdir -p ${RUN_DIR} && chmod 700 ${RUN_DIR}`);
    await this.writeFile(`${RUN_DIR}/auth.json`, JSON.stringify({
      secret: await deriveUserSecret(env.MASTER_KEY, "webapp-auth", identity.sub),
      sub: identity.sub, email: identity.email, name: identity.name ?? "", issuer: identity.issuer,
    }));
    await this.exec(`chmod 600 ${RUN_DIR}/auth.json`);
    await this.writeFile(`${RUN_DIR}/bundle.json`, JSON.stringify(bundle));
    const result = await this.exec(`${AF_STATE} apply ${HERMES_HOME} ${RUN_DIR}/bundle.json`);
    await this.exec(`rm -f ${RUN_DIR}/bundle.json`);
    if (result.exitCode !== 0) {
      throw new Error(`applying configuration failed: ${(result.stderr || result.stdout).slice(0, 500)}`);
    }
    if (warnings.length) console.warn(`[config:${identity.sub}] ${warnings.join("; ")}`);
    console.log(`[config:${identity.sub}] ${result.stdout}`);
  }

  /** The webapp's browser credential, 43 url-safe characters. Derived, so it's stable across restores. */
  private browserToken(sub: string): Promise<string> {
    return deriveUserSecret(this.env.MASTER_KEY, "webapp-browser", sub);
  }

  private async waitForWebapp(): Promise<void> {
    const deadline = Date.now() + WEBAPP_START_TIMEOUT_MS;
    let lastError = "";
    while (Date.now() < deadline) {
      try {
        const response = await this.containerFetch(
          new Request("http://localhost/api/health"), WEBAPP_PORT);
        // Unread bodies count as in-flight requests, which would keep the container awake forever.
        await response.body?.cancel();
        if (response.ok) return;
        lastError = `status ${response.status}`;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`Hermes webapp did not come up on port ${WEBAPP_PORT}: ${lastError}`);
  }

  // ---------------------------------------------------------------------------
  // Snapshots
  // ---------------------------------------------------------------------------

  /** Snapshot a hydrated container and seal its secrets. Refuses when not hydrated. */
  async snapshotNow(): Promise<{ id: string } | { skipped: string }> {
    const identity = await this.ctx.storage.get<StoredIdentity>(IDENTITY_KEY);
    if (!identity) return { skipped: "no user bound to this sandbox" };
    if (!(await this.isRunning())) return { skipped: "container not running" };
    if (!(await this.hasReadyFile())) return { skipped: "container not hydrated" };

    const secrets = await this.exec(`${AF_STATE} seal-read ${HERMES_HOME}`);
    if (secrets.exitCode !== 0) throw new Error(`reading secret files failed: ${secrets.stderr.slice(0, 500)}`);
    const filesKey = sealedFilesKey(identity.sub);
    const sealedValue = await seal(this.env.MASTER_KEY, filesKey, secrets.stdout);
    await this.env.CREDENTIALS_KV.put(filesKey, sealedValue);
    await this.ctx.storage.put(SEALED_COPY_KEY, sealedValue);

    const entry = await createSnapshot(this, this.env.BACKUP_BUCKET, identity.sub);
    this.lastSnapshotAt = Date.now();
    return { id: entry.id };
  }

  /**
   * Cron tick. Skips quietly when there's been no activity since the last snapshot: every exec
   * renews the container's idle timer, so snapshotting on a timer alone would keep it awake forever.
   */
  async snapshotIfDue(intervalMs: number): Promise<{ id: string } | { skipped: string }> {
    if (!(await this.isRunning())) {
      const identity = await this.ctx.storage.get<StoredIdentity>(IDENTITY_KEY);
      if (identity) await this.env.BACKUP_BUCKET.delete(`${ACTIVE_PREFIX}${identity.sub}`);
      return { skipped: "container not running" };
    }
    const now = Date.now();
    if (now - this.lastSnapshotAt < intervalMs) return { skipped: "interval not reached" };
    const inflight = (this as unknown as { inflightRequests?: number }).inflightRequests ?? 0;
    if (this.lastSnapshotAt && this.lastUserActivity <= this.lastSnapshotAt && inflight === 0) {
      return { skipped: "no activity since last snapshot" };
    }
    return this.snapshotNow();
  }

  async prune(): Promise<{ kept: number; deleted: number } | null> {
    const identity = await this.ctx.storage.get<StoredIdentity>(IDENTITY_KEY);
    return identity ? pruneSnapshots(this.env.BACKUP_BUCKET, identity.sub) : null;
  }

  async describe(): Promise<{ identity: string | null; status: ReadyState; lastSnapshotAt: number; lastUserActivity: number; inflight: number }> {
    const identity = await this.ctx.storage.get<StoredIdentity>(IDENTITY_KEY);
    return {
      identity: identity?.email ?? null, status: this.status,
      lastSnapshotAt: this.lastSnapshotAt, lastUserActivity: this.lastUserActivity,
      inflight: (this as unknown as { inflightRequests?: number }).inflightRequests ?? 0,
    };
  }

  /** Stop now, taking a final snapshot first. A failed snapshot is logged and doesn't block the stop. */
  async stopWithSnapshot(): Promise<void> {
    await this.finalSnapshot("stop");
    await this.stop();
  }

  private async finalSnapshot(reason: string): Promise<void> {
    if (this.finalSnapshotRunning) return;
    this.finalSnapshotRunning = true;
    try {
      const result = await this.snapshotNow();
      console.log(`[final-snapshot:${reason}] ${JSON.stringify(result)}`);
    } catch (err) {
      console.error(`[final-snapshot:${reason}] failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.finalSnapshotRunning = false;
    }
    const identity = await this.ctx.storage.get<StoredIdentity>(IDENTITY_KEY);
    if (identity) await this.env.BACKUP_BUCKET.delete(`${ACTIVE_PREFIX}${identity.sub}`);
  }

  override async onActivityExpired(): Promise<void> {
    await this.finalSnapshot("idle");
    await super.onActivityExpired();
  }

  override async onStop(params?: Parameters<Sandbox<Env>["onStop"]>[0]): Promise<void> {
    this.ready = false;
    this.hydration = null;
    this.status = { state: "starting", step: "waiting" };
    await super.onStop(params);
  }
}
