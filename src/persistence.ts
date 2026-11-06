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
 * Callers run these inside the user's Durable Object, through its serial queue. Durable Object
 * input gates don't cover R2 or container calls, so nothing else keeps these from interleaving.
 */
import type { DirectoryBackup, Sandbox } from "@cloudflare/sandbox";
import { removeFromIndex } from "./prune";

export const HERMES_HOME = "/home/hermes/.hermes";
const STAGE_DIR = "/home/.agent-flare-stage";
export const AF_STATE = "/usr/local/bin/af-python /usr/local/lib/af_state.py";
const RESTORE_DIR = "/home/hermes/.hermes-restore";
/** The SDK refuses to restore past this age. Retention decides when a backup goes, not this. */
const BACKUP_TTL_SECONDS = 10 * 365 * 86_400;

export interface BackupEntry {
  id: string;
  dir: string;
  createdAt: string;
  /** Size of the staged tree, for observability. */
  stagedBytes?: number;
  stagedFiles?: number;
  handle: DirectoryBackup;
}

/** The one archive of a backup. */
export const backupKey = (id: string) => `backups/${id}/data.sqsh`;

const indexKey = (sub: string) => `users/${sub}/backups-index.json`;

export async function getIndex(bucket: R2Bucket, sub: string): Promise<BackupEntry[]> {
  const object = await bucket.get(indexKey(sub));
  if (!object) return [];
  // A corrupt index must not read as "no backups": that would start the user fresh over real data.
  // Backups from SDK 1.0 are tar+zstd, which this SDK can't restore. They're kept under hold/ in R2.
  return ((await object.json()) as (BackupEntry & { handle: { format?: string } })[]).filter((entry) => !entry.handle.format);
}

async function run(sandbox: Sandbox, command: string, label: string): Promise<string> {
  const result = await sandbox.exec(command);
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed (exit ${result.exitCode}): ${(result.stderr || result.stdout || "").slice(0, 500)}`);
  }
  return result.stdout ?? "";
}

export type RestoreOutcome =
  | { kind: "fresh"; skipped: string[] }
  | { kind: "restored"; id: string; skipped: string[] };

/** Proof the archive itself is bad, as opposed to the container or network failing while reading it. */
function isCorruptArchive(message: string): boolean {
  return /unsquashfs extraction failed/i.test(message) && !/no space left/i.test(message);
}

/**
 * Restore the newest good backup into a scratch directory, verify it, then swap it into place.
 *
 * Falls back to an older backup only on proof of corruption. A transient failure must not: the older
 * restore would succeed, a new snapshot would soon outrank the newest backup, and that good backup
 * would never be chosen again. So transient failures throw, and hydration retries from the top.
 * Throws too when backups exist but none can be trusted: starting empty would soon snapshot an
 * empty home over the user's history.
 *
 * `assertCurrent` throws if the container this hydration started on has gone.
 */
export async function restoreNewest(
  sandbox: Sandbox, bucket: R2Bucket, sub: string, readyFile: string, assertCurrent: () => void,
): Promise<RestoreOutcome> {
  const index = await getIndex(bucket, sub);
  const newestFirst = [...index].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
  const skipped: string[] = [];
  let anyCorrupt = false;

  // The READY check makes this refuse, in the shell, to touch a live home.
  const swapIn = (from: string | null) => run(
    sandbox,
    `test ! -f ${readyFile} && rm -rf ${HERMES_HOME} && ` +
      (from ? `mv ${from} ${HERMES_HOME}` : `mkdir -p ${HERMES_HOME}`),
    "swap home",
  );

  for (const entry of newestFirst) {
    assertCurrent();
    const t0 = Date.now();
    await run(sandbox, `rm -rf ${RESTORE_DIR} && mkdir -p ${RESTORE_DIR}`, "clear restore dir");
    try {
      await sandbox.restoreBackup({ ...entry.handle, dir: RESTORE_DIR });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/BACKUP_NOT_FOUND|BackupNotFound|Backup not found|archive not found/i.test(message)) {
        console.warn(`[restore:${sub}] ${entry.id} is gone from R2; removing from index`);
        await removeFromIndex(bucket, sub, entry.id);
        skipped.push(entry.id);
        continue;
      }
      if (isCorruptArchive(message)) {
        console.error(`[restore:${sub}] ${entry.id} is corrupt: ${message.slice(0, 300)}`);
        anyCorrupt = true;
        skipped.push(entry.id);
        continue;
      }
      throw err;
    }
    assertCurrent();
    const check = await sandbox.exec(`${AF_STATE} verify ${RESTORE_DIR}`);
    if (check.exitCode === 1) {
      console.error(`[restore:${sub}] ${entry.id} failed verification: ${check.stdout}`);
      anyCorrupt = true;
      skipped.push(entry.id);
      continue;
    }
    if (check.exitCode !== 0) throw new Error(`verify could not run (exit ${check.exitCode}): ${check.stderr.slice(0, 300)}`);
    assertCurrent();
    await swapIn(RESTORE_DIR);
    console.log(`[restore:${sub}] restored ${entry.id} in ${Date.now() - t0}ms: ${check.stdout}`);
    return { kind: "restored", id: entry.id, skipped };
  }

  if (anyCorrupt) {
    throw new Error(`${skipped.length} backup(s) exist but none could be restored and verified`);
  }
  assertCurrent();
  await swapIn(null);
  return { kind: "fresh", skipped };
}

/** Stage, archive to R2, and only then record in the index. */
export async function createSnapshot(sandbox: Sandbox, bucket: R2Bucket, sub: string): Promise<BackupEntry> {
  const t0 = Date.now();
  const stdout = await run(sandbox, `${AF_STATE} stage ${HERMES_HOME} ${STAGE_DIR}`, "stage");
  const staged = JSON.parse(stdout) as { files: number; bytes: number; databases: string[] };
  const handle = await sandbox.createBackup({ dir: STAGE_DIR, ttl: BACKUP_TTL_SECONDS, localBucket: true });
  // Names and sizes of the top level only, to show where the size goes.
  const largest = await sandbox.exec(`cd ${STAGE_DIR} && du -sk -- * .[!.]* 2>/dev/null | sort -rn | head -8 | awk '{print $2"="$1"k"}' | paste -sd' '`).then((r) => r.stdout.trim(), () => "");
  await sandbox.exec(`rm -rf ${STAGE_DIR}`);

  const entry: BackupEntry = {
    id: handle.id, dir: handle.dir, createdAt: new Date().toISOString(), stagedBytes: staged.bytes, stagedFiles: staged.files, handle,
  };
  const index = await getIndex(bucket, sub);
  index.push(entry);
  await bucket.put(indexKey(sub), JSON.stringify(index));
  console.log(`[snapshot:${sub}] ${handle.id}: ${staged.files} files, ${staged.bytes} bytes, ${(await bucket.head(backupKey(handle.id)))?.size ?? "?"} compressed, ${Date.now() - t0}ms, largest: ${largest}`);
  return entry;
}
