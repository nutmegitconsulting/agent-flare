/**
 * One Durable Object per Access user, owning that user's container and state.
 *
 * Lifecycle rules this class enforces:
 * - Hydration, snapshots and pruning run one at a time, through `serial`. Durable Object input gates
 *   don't cover R2 or container calls, so without this they interleave.
 * - `generation` changes when a container stops. Work started on an old container stops at its next
 *   check instead of acting on the new one.
 * - READY_FILE exists only after hydration completes. It releases Hermes from its boot gate and also
 *   gates snapshots, so a home that was never hydrated can't be snapshotted over a user's history.
 *   It lives in the container, so it dies with the container.
 * - A container that idles out gets a final snapshot before it stops. If that fails, it stays up
 *   and retries, because stopping would lose whatever changed since the last backup.
 */
import { Sandbox } from "@cloudflare/sandbox";
import type { AccessIdentity } from "./access";
import type { Env } from "./env";
import { AF_STATE, createSnapshot, HERMES_HOME, restoreNewest, type RestoreOutcome } from "./persistence";
import { renderProviders } from "./providers";
import { pruneSnapshots } from "./prune";
import { deriveUserSecret, getSealed, prefillKey, seal, sealedFilesKey, unseal } from "./secrets";
import { fetchAccessGroups, loadAssignments, loadTemplate, pickTemplate, templateSecrets } from "./templates";

/**
 * Hermes' default webapp port, inside the container only. Browsers reach it on 443 at Cloudflare; TLS
 * ends there, and nothing but this Worker can address the container. Not 3000: that's the SDK's control port.
 */
export const WEBAPP_PORT = 9120;
const RUN_DIR = "/run/agent-flare";
const READY_FILE = `${RUN_DIR}/ready`;
const IDENTITY_KEY = "identity";
const SEALED_COPY_KEY = "sealed-files";
const LAST_RESTORE_KEY = "last-restore";
const CONFIG_STATUS_KEY = "config-status";
const ACTIVE_PREFIX = "active/";
const WEBAPP_START_TIMEOUT_MS = 120_000;
/** After a failed hydration, keep reporting it for this long before trying again. */
const HYDRATION_RETRY_MS = 30_000;
/** Idle cycles to keep a container up when its final snapshot keeps failing. */
const FINAL_SNAPSHOT_RETRIES = 3;

export type ReadyState =
  | { state: "ready" }
  | { state: "starting"; step: string }
  | { state: "failed"; error: string };

/** Names only: never a credential's value. */
interface InferenceReport {
  selected: string | null;
  missing: string[];
}

export type SnapshotResult = { id: string } | { skipped: string };

interface StoredIdentity extends AccessIdentity {
  publicUrl: string;
}

export class HermesSandbox extends Sandbox<Env> {
  private queue: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private hydration: Promise<void> | null = null;
  private status: ReadyState = { state: "starting", step: "waiting" };
  private ready = false;
  private lastUserActivity = 0;
  private lastSnapshotAt = 0;
  private lastSnapshotError: string | null = null;
  private lastFailureAt = 0;
  private finalSnapshotFailures = 0;

  /** Runs `work` after everything already queued, whether that succeeded or not. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Current state. Starts hydration if needed and returns without waiting for it. */
  async ensureReady(identity: AccessIdentity, publicUrl: string, accessJwt: string): Promise<ReadyState> {
    this.lastUserActivity = Date.now();
    if (this.ready && (await this.isRunning())) return { state: "ready" };
    this.ready = false;
    if (this.status.state === "failed" && Date.now() - this.lastFailureAt < HYDRATION_RETRY_MS) {
      return this.status;
    }
    if (!this.hydration) {
      const generation = this.generation;
      const isCurrent = () => generation === this.generation;
      this.status = { state: "starting", step: "starting container" };
      const run: Promise<void> = this.serial(() => this.hydrate({ ...identity, publicUrl }, accessJwt, generation))
        .then(() => {
          if (!isCurrent()) return;
          this.ready = true;
          this.status = { state: "ready" };
        })
        .catch(async (err) => {
          const error = err instanceof Error ? err.message : String(err);
          console.error(`[hydrate:${identity.sub}] ${error}`);
          if (!isCurrent()) return; // The container went away; the next request starts over.
          this.lastFailureAt = Date.now();
          this.status = { state: "failed", error };
          // A container that can't serve shouldn't hold an instance slot.
          await this.stop().catch(() => undefined);
        })
        .finally(() => {
          if (this.hydration === run) this.hydration = null;
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

  private async hydrate(identity: StoredIdentity, accessJwt: string, generation: number): Promise<void> {
    const assertCurrent = () => {
      if (generation !== this.generation) throw new Error("container restarted during hydration");
    };
    assertCurrent();
    await this.ctx.storage.put(IDENTITY_KEY, identity);
    await this.env.BACKUP_BUCKET.put(`${ACTIVE_PREFIX}${identity.sub}`, identity.email);

    // Durable Objects can be evicted while their container keeps running.
    if (await this.hasReadyFile()) {
      await this.waitForWebapp(assertCurrent);
      return;
    }

    this.status = { state: "starting", step: "restoring your state" };
    const outcome = await restoreNewest(this, this.env.BACKUP_BUCKET, identity.sub, READY_FILE, assertCurrent);
    await this.ctx.storage.put<RestoreOutcome & { at: number }>(LAST_RESTORE_KEY, { ...outcome, at: Date.now() });
    console.log(`[hydrate:${identity.sub}] ${JSON.stringify(outcome)}`);

    assertCurrent();
    this.status = { state: "starting", step: "applying configuration" };
    await this.applyConfiguration(identity, accessJwt);

    // Only now can Hermes start, and only now can snapshots run.
    assertCurrent();
    await this.exec(`mkdir -p ${RUN_DIR} && touch ${READY_FILE}`);
    this.status = { state: "starting", step: "starting Hermes" };
    await this.waitForWebapp(assertCurrent);
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
      ? await loadTemplate(env.BACKUP_BUCKET, templateName, templateSecrets(env))
      : null;
    if (templateName && !template) warnings.push(`template ${templateName} is not in R2`);
    warnings.push(...(template?.warnings ?? []));

    const providers = renderProviders(template?.providers ?? [], env.CLOUDFLARE_AI_API_TOKEN ?? "", identity.email);
    warnings.push(...providers.warnings);
    const providerCount = (template?.providers ?? []).length;

    // The Durable Object's copy first: KV can serve a value up to a minute stale, which would undo a
    // secret changed just before a stop. KV stays the durable home for the value.
    const filesKey = sealedFilesKey(identity.sub);
    const sealedRaw = (await this.ctx.storage.get<string>(SEALED_COPY_KEY)) ?? (await env.CREDENTIALS_KV.get(filesKey));
    const sealed = sealedRaw
      ? (JSON.parse(await unseal(env.MASTER_KEY, filesKey, sealedRaw)) as Record<string, string>)
      : null;
    const prefill = await getSealed<Record<string, string>>(
      env.CREDENTIALS_KV, env.MASTER_KEY, prefillKey(identity.email));

    // Platform keys come last so a template can never move the port or the public URL.
    const platformConfig = {
      webapp: { enabled: true, host: "0.0.0.0", port: WEBAPP_PORT, public_url: identity.publicUrl },
      // Only the Worker can reach this listener, so whatever address it arrives from is the Worker's.
      dashboard: { trusted_proxies: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "127.0.0.1", "::1", "fc00::/7"] },
    };
    const bundle = {
      sealed: sealed ?? {},
      template: template ? { name: template.name, files: template.files } : null,
      // Inside the home, so that what an agent makes is what gets snapshotted.
      platform_defaults: { terminal: { cwd: `${HERMES_HOME}/workspace` } },
      config_defaults: template?.configDefaults ?? {},
      // The container picks from these, because only it can see which credentials are in .env.
      provider_candidates: providers.candidates,
      config_managed: {
        ...template?.configManaged,
        ...(providers.customProviders.length ? { custom_providers: providers.customProviders } : {}),
        ...platformConfig,
      },
      // A prefill is the user's own value: it applies only while they haven't set one. Template and
      // provider values are managed and apply on every boot.
      env_defaults: prefill ?? {},
      env: { ...template?.env, ...providers.env },
      session_token: await deriveUserSecret(env.MASTER_KEY, "webapp-browser", identity.sub),
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
      // The detail can quote the user's files, so it goes to the logs and not to the error page.
      console.error(`[config:${identity.sub}] ${(result.stderr || result.stdout).slice(0, 500)}`);
      throw new Error("applying configuration failed");
    }
    const inference = (JSON.parse(result.stdout) as { inference?: InferenceReport }).inference;
    if (providerCount && !inference?.selected) {
      warnings.push(`no inference provider selected: missing ${inference?.missing?.join(", ") || "provider credentials"}`);
    }
    await this.ctx.storage.put(CONFIG_STATUS_KEY, { template: templateName, inference, warnings, at: Date.now() });
    if (warnings.length) console.warn(`[config:${identity.sub}] ${warnings.join("; ")}`);
    console.log(`[config:${identity.sub}] ${result.stdout}`);
  }

  private async waitForWebapp(assertCurrent: () => void): Promise<void> {
    const deadline = Date.now() + WEBAPP_START_TIMEOUT_MS;
    let lastError = "";
    while (Date.now() < deadline) {
      assertCurrent();
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
  async snapshotNow(): Promise<SnapshotResult> {
    return this.serial(() => this.takeSnapshot());
  }

  private async takeSnapshot(): Promise<SnapshotResult> {
    const identity = await this.ctx.storage.get<StoredIdentity>(IDENTITY_KEY);
    if (!identity) return { skipped: "no user bound to this sandbox" };
    if (!(await this.isRunning())) return { skipped: "container not running" };
    if (!(await this.hasReadyFile())) return { skipped: "container not hydrated" };

    // A failure sealing secrets must not also cost the user their state backup.
    let sealError: unknown = null;
    try {
      await this.sealSecretFiles(identity.sub);
    } catch (err) {
      sealError = err;
    }
    try {
      const entry = await createSnapshot(this, this.env.BACKUP_BUCKET, identity.sub);
      this.lastSnapshotAt = Date.now();
      this.lastSnapshotError = null;
      if (sealError) throw sealError;
      return { id: entry.id };
    } catch (err) {
      this.lastSnapshotError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  private async sealSecretFiles(sub: string): Promise<void> {
    const result = await this.exec(`${AF_STATE} seal-read ${HERMES_HOME}`);
    if (result.exitCode !== 0) throw new Error(`reading secret files failed: ${result.stderr.slice(0, 500)}`);
    const { files, dropped } = JSON.parse(result.stdout) as { files: Record<string, string>; dropped: string[] };
    if (dropped.length) console.warn(`[seal:${sub}] too large to keep: ${dropped.join(", ")}`);
    const filesKey = sealedFilesKey(sub);
    const sealedValue = await seal(this.env.MASTER_KEY, filesKey, JSON.stringify(files));
    await this.env.CREDENTIALS_KV.put(filesKey, sealedValue);
    try {
      await this.ctx.storage.put(SEALED_COPY_KEY, sealedValue);
    } catch {
      // Too large for Durable Object storage. Drop the old copy so reads fall through to KV.
      await this.ctx.storage.delete(SEALED_COPY_KEY);
    }
  }

  /**
   * Cron tick. Skips quietly when there's been no activity since the last snapshot: every exec renews
   * the container's idle timer, so snapshotting on a timer alone would keep it awake forever.
   */
  async snapshotIfDue(intervalMs: number): Promise<SnapshotResult> {
    if (!(await this.isRunning())) {
      const identity = await this.ctx.storage.get<StoredIdentity>(IDENTITY_KEY);
      if (identity) await this.env.BACKUP_BUCKET.delete(`${ACTIVE_PREFIX}${identity.sub}`);
      return { skipped: "container not running" };
    }
    if (this.hydration) return { skipped: "hydrating" };
    if (!this.ready) {
      // Memory is empty after an eviction, so ask the container, once.
      if (!(await this.hasReadyFile())) {
        await this.stop();
        return { skipped: "stopped a container that never hydrated" };
      }
      this.ready = true;
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
    return this.serial(async () => {
      const identity = await this.ctx.storage.get<StoredIdentity>(IDENTITY_KEY);
      return identity ? pruneSnapshots(this.env.BACKUP_BUCKET, identity.sub) : null;
    });
  }

  async describe() {
    const identity = await this.ctx.storage.get<StoredIdentity>(IDENTITY_KEY);
    return {
      identity: identity?.email ?? null,
      status: this.status,
      lastSnapshotAt: this.lastSnapshotAt,
      lastSnapshotError: this.lastSnapshotError,
      lastRestore: (await this.ctx.storage.get<RestoreOutcome & { at: number }>(LAST_RESTORE_KEY)) ?? null,
      config: (await this.ctx.storage.get(CONFIG_STATUS_KEY)) ?? null,
      lastUserActivity: this.lastUserActivity,
      inflight: (this as unknown as { inflightRequests?: number }).inflightRequests ?? 0,
    };
  }

  /** Stop now, taking a final snapshot first. An explicit stop goes ahead even if that fails. */
  async stopWithSnapshot(): Promise<void> {
    await this.serial(async () => {
      await this.finalSnapshot("stop");
      await this.clearActiveMarker();
      await this.stop();
    });
  }

  private async finalSnapshot(reason: string): Promise<boolean> {
    try {
      const result = await this.takeSnapshot();
      console.log(`[final-snapshot:${reason}] ${JSON.stringify(result)}`);
      return true;
    } catch (err) {
      console.error(`[final-snapshot:${reason}] failed: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }

  private async clearActiveMarker(): Promise<void> {
    const identity = await this.ctx.storage.get<StoredIdentity>(IDENTITY_KEY);
    if (identity) await this.env.BACKUP_BUCKET.delete(`${ACTIVE_PREFIX}${identity.sub}`);
  }

  override async onActivityExpired(): Promise<void> {
    await this.serial(async () => {
      const started = Date.now();
      const saved = await this.finalSnapshot("idle");
      // The snapshot takes a while. A user who came back during it must not be cut off.
      if (this.lastUserActivity > started) {
        this.renewActivityTimeout();
        return;
      }
      if (!saved && ++this.finalSnapshotFailures < FINAL_SNAPSHOT_RETRIES) {
        console.warn(`[final-snapshot:idle] staying up to retry (${this.finalSnapshotFailures}/${FINAL_SNAPSHOT_RETRIES})`);
        this.renewActivityTimeout();
        return;
      }
      if (!saved) console.error("[final-snapshot:idle] giving up; stopping without a final snapshot");
      this.finalSnapshotFailures = 0;
      await this.clearActiveMarker();
      await super.onActivityExpired();
    });
  }

  override async onStop(params?: Parameters<Sandbox<Env>["onStop"]>[0]): Promise<void> {
    this.generation++;
    this.ready = false;
    this.hydration = null;
    // A failure stays visible until its retry window passes, even though stopping is what follows it.
    if (this.status.state !== "failed") this.status = { state: "starting", step: "waiting" };
    await super.onStop(params);
  }
}
