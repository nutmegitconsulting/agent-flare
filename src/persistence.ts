/**
 * Snapshots of a user's Hermes home, stored in R2 as squashfs through the Sandbox SDK.
 *
 * The container's af_state.py builds a staged copy first: SQLite through its backup API,
 * caches and logs left out, secrets left out (they're sealed into KV separately). The SDK
 * archives the staged copy, which nothing is writing to, so the archive is consistent.
 *
 * R2 layout:
 *   users/<sub>/backups-index.json   array of {id, dir, createdAt, handle}. Restore source of truth.
 *   backups/<id>/data.sqsh           SDK-written archive
 *   backups/<id>/meta.json           SDK-written metadata
 *
 * Callers run these inside the user's Durable Object, which serializes access to the index.
 */
import type { DirectoryBackup, Sandbox } from "@cloudflare/sandbox";
import { removeFromIndex } from "./prune";

export const HERMES_HOME = "/home/hermes/.hermes";
const STAGE_DIR = "/home/.agent-flare-stage";
export const AF_STATE = "/usr/local/bin/af-python /usr/local/lib/af_state.py";
const BACKUP_TTL_SECONDS = 365 * 86_400;

export interface BackupEntry {
  id: string;
  dir: string;
  createdAt: string;
  /** Size of the staged tree, for observability. */
  stagedBytes?: number;
  handle: DirectoryBackup;
}

const indexKey = (sub: string) => `users/${sub}/backups-index.json`;

export async function getIndex(bucket: R2Bucket, sub: string): Promise<BackupEntry[]> {
  const object = await bucket.get(indexKey(sub));
  if (!object) return [];
  // A corrupt index must not read as "no backups": that would start the user fresh over real data.
  return (await object.json()) as BackupEntry[];
}

async function run(sandbox: Sandbox, command: string, label: string): Promise<string> {
  const result = await sandbox.exec(command);
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed (exit ${result.exitCode}): ${(result.stderr || result.stdout || "").slice(0, 500)}`);
  }
  return result.stdout ?? "";
}

export type RestoreOutcome =
  | { kind: "fresh" }
  | { kind: "restored"; id: string; skipped: string[] };

/**
 * Restore the newest backup that passes verification, into an empty home. Only blobs that are
 * truly gone are dropped from the index. Throws when backups exist but none can be trusted: the
 * caller must not start Hermes then, because an empty home would soon be snapshotted over the
 * user's history. That's the failure this design exists to prevent.
 */
export async function restoreNewest(sandbox: Sandbox, bucket: R2Bucket, sub: string): Promise<RestoreOutcome> {
  const index = await getIndex(bucket, sub);
  const newestFirst = [...index].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
  const skipped: string[] = [];
  let anyUntrusted = false;

  for (const entry of newestFirst) {
    const t0 = Date.now();
    try {
      await run(sandbox, `rm -rf ${HERMES_HOME} && mkdir -p ${HERMES_HOME}`, "clear home");
      await sandbox.restoreBackup({ ...entry.handle, dir: HERMES_HOME });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/BACKUP_NOT_FOUND|BackupNotFound|Backup not found|archive not found/i.test(message)) {
        console.warn(`[restore:${sub}] ${entry.id} is gone from R2; removing from index`);
        await removeFromIndex(bucket, sub, entry.id);
      } else {
        console.error(`[restore:${sub}] ${entry.id} failed: ${message}`);
        anyUntrusted = true;
      }
      skipped.push(entry.id);
      continue;
    }
    const check = await sandbox.exec(`${AF_STATE} verify ${HERMES_HOME}`);
    if (check.exitCode !== 0) {
      console.error(`[restore:${sub}] ${entry.id} failed verification: ${check.stdout || check.stderr}`);
      anyUntrusted = true;
      skipped.push(entry.id);
      continue;
    }
    console.log(`[restore:${sub}] restored ${entry.id} in ${Date.now() - t0}ms: ${check.stdout}`);
    return { kind: "restored", id: entry.id, skipped };
  }

  if (anyUntrusted) {
    throw new Error(`${skipped.length} backup(s) exist but none could be restored and verified`);
  }
  await run(sandbox, `rm -rf ${HERMES_HOME} && mkdir -p ${HERMES_HOME}`, "clear home");
  return { kind: "fresh" };
}

/** Stage, archive to R2, and only then record in the index. */
export async function createSnapshot(sandbox: Sandbox, bucket: R2Bucket, sub: string): Promise<BackupEntry> {
  const t0 = Date.now();
  const stdout = await run(sandbox, `${AF_STATE} stage ${HERMES_HOME} ${STAGE_DIR}`, "stage");
  const staged = JSON.parse(stdout) as { files: number; bytes: number; databases: string[] };
  const handle = await sandbox.createBackup({ dir: STAGE_DIR, ttl: BACKUP_TTL_SECONDS, localBucket: true });
  await sandbox.exec(`rm -rf ${STAGE_DIR}`);

  const entry: BackupEntry = {
    id: handle.id, dir: handle.dir, createdAt: new Date().toISOString(), stagedBytes: staged.bytes, handle,
  };
  const index = await getIndex(bucket, sub);
  index.push(entry);
  await bucket.put(indexKey(sub), JSON.stringify(index));
  console.log(`[snapshot:${sub}] ${handle.id}: ${staged.files} files, ${staged.bytes} bytes, ${Date.now() - t0}ms`);
  return entry;
}
