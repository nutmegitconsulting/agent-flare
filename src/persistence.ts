import type { Sandbox, DirectoryBackup } from "@cloudflare/sandbox";
import { removeFromIndex } from "./prune";

/**
 * SDK-native persistence layer for Hermes' data dir.
 *
 * Replaces the hand-rolled mksquashfs/curl path with the Sandbox SDK's
 * createBackup()/restoreBackup(). The container runs mksquashfs; the SDK
 * uploads the squashfs straight to the bound BACKUP_BUCKET R2 binding
 * (localBucket: true) — no presigned URLs, no R2 tokens, no account ID,
 * no curl, no secrets in the container. Restores are a plain unsquashfs
 * extraction (not a FUSE overlay) on this path, so the restored tree is a
 * normal ext4 directory and `hermes serve` + SQLite WAL behave normally.
 *
 * Storage layout (multi-tenant — keys namespaced per user; the SDK-owned
 * blobs are globally unique by backup id, so they take no user prefix):
 *   users/<userId>/backup-handle.json   newest DirectoryBackup handle (restore target)
 *   users/<userId>/backups-index.json   array of {id, dir, createdAt} (observability only)
 *   backups/<id>/data.sqsh              SDK-written squashfs archive
 *   backups/<id>/meta.json              SDK-written metadata
 *
 * Retention: this module NEVER deletes backups. The user manages retention
 * via the R2 bucket's own lifecycle rules (backups/ prefix). The per-backup
 * TTL is therefore set to 365 days so the SDK never refuses to restore a
 * backup that still exists in the bucket — the "most recent available backup"
 * is always restorable regardless of how long the bucket keeps it.
 */
const BACKUP_DIR = "/home/hermes";
const SECONDS_PER_DAY = 86_400;
/** SDK refuses to restore past (createdAt + ttl). Keep it well beyond the
 *  bucket's retention window so any object still present is restorable. */
const BACKUP_TTL_SECONDS = 365 * SECONDS_PER_DAY;
/**
 * Corruption sentinel: a healthy /home/hermes always has a non-empty hermes
 * launcher wrapper at /home/hermes/.local/bin/hermes (baked into the image,
 * pointing at /opt/hermes-install/venv). It is inside the snapshot tree, so
 * every backup carries it; a partial unsquashfs extraction leaves it as a
 * 0-byte regular file. Checked before every snapshot and after every restore.
 */
const SENTINEL_FILE = "/home/hermes/.local/bin/hermes";
const HANDLE_KEY_SUFFIX = "backup-handle.json";
const INDEX_KEY_SUFFIX = "backups-index.json";

async function assertTreeHealthy(sandbox: Sandbox, context: string): Promise<void> {
  const check = await sandbox.exec(`test -s ${SENTINEL_FILE} && echo __ok__ || true`);
  if (!check.stdout.includes("__ok__")) {
    throw new Error(
      `${context}: ${SENTINEL_FILE} is missing or empty — ${BACKUP_DIR} looks corrupt (partial restore?)`,
    );
  }
}

/** Per-user R2 key namespace. */
function keysFor(userId: string) {
  const prefix = `users/${userId}/`;
  return {
    handle: prefix + HANDLE_KEY_SUFFIX,
    index: prefix + INDEX_KEY_SUFFIX,
  };
}

async function getStoredHandle(bucket: R2Bucket, key: string): Promise<DirectoryBackup | null> {
  const obj = await bucket.get(key);
  if (!obj) return null;
  return obj.json();
}

async function storeHandle(
  bucket: R2Bucket,
  key: string,
  handle: DirectoryBackup,
): Promise<void> {
  await bucket.put(key, JSON.stringify(handle));
}

async function deleteStoredHandle(bucket: R2Bucket, key: string): Promise<void> {
  await bucket.delete(key);
}

/** One retained backup. `backups-index.json` is an array of these. */
interface BackupEntry {
  id: string;
  dir: string;
  createdAt: string; // ISO 8601
}

async function getIndex(bucket: R2Bucket, key: string): Promise<BackupEntry[]> {
  const obj = await bucket.get(key);
  if (!obj) return [];
  try {
    return await obj.json();
  } catch {
    return [];
  }
}

async function putIndex(bucket: R2Bucket, key: string, entries: BackupEntry[]): Promise<void> {
  await bucket.put(key, JSON.stringify(entries));
}

/**
 * Restore the latest backup if one exists. Returns true if a restore ran.
 *
 * Called exactly once, from /api/wake, before the boot script unblocks. A
 * failed restore must NOT fail the wake — the caller wraps this and surfaces
 * the error in the response instead of keeping the container down.
 */
export async function restoreLatest(
  sandbox: Sandbox,
  bucket: R2Bucket,
  userId: string,
): Promise<boolean> {
  const keys = keysFor(userId);
  const handle = await getStoredHandle(bucket, keys.handle);
  if (!handle) {
    console.log(`[persistence:${userId}] no prior backup, starting fresh`);
    return false;
  }

  // Clear any stale FUSE overlay before re-restoring (no-op on the localBucket
  // path, which uses unsquashfs extraction rather than a FUSE mount).
  try {
    await sandbox.exec(`umount ${BACKUP_DIR} 2>/dev/null; true`);
  } catch {
    /* may not be mounted */
  }

  console.log(`[persistence:${userId}] restoring backup ${handle.id}`);
  const t0 = Date.now();
  try {
    await sandbox.restoreBackup(handle);
    await assertTreeHealthy(sandbox, `restore ${handle.id}`);
    console.log(`[persistence:${userId}] restored in ${Date.now() - t0}ms`);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/BACKUP_EXPIRED|BACKUP_NOT_FOUND|BackupExpiredError|BackupNotFoundError|Backup not found|has expired/i.test(msg)) {
      console.log(`[persistence:${userId}] backup ${handle.id} gone, clearing handle`);
      await deleteStoredHandle(bucket, keys.handle);
      await removeFromIndex(bucket, userId, handle.id);
      return false;
    }
    throw err;
  }
}

/**
 * Snapshot /home/hermes to R2 and record it as the newest handle.
 *
 * No pruning happens here — the user owns retention via the bucket's
 * lifecycle rules. The index is appended to (for observability / manual
 * reference) and the handle always points at the newest backup.
 */
export async function createSnapshot(
  sandbox: Sandbox,
  bucket: R2Bucket,
  userId: string,
): Promise<DirectoryBackup> {
  const keys = keysFor(userId);
  await assertTreeHealthy(sandbox, "pre-snapshot check");
  // Ensure permissions are readable for mksquashfs.
  await sandbox.exec(`chmod -R a+rX ${BACKUP_DIR} 2>/dev/null; true`);

  console.log(`[persistence:${userId}] creating snapshot`);
  const t0 = Date.now();
  // localBucket: write the squashfs through the bound BACKUP_BUCKET R2 binding
  // instead of presigned URLs. Zero-setup — no R2 API token / account ID /
  // access key secrets needed; the binding is always present. restoreBackup
  // reads this mode off the handle, so restores stay consistent with how the
  // backup was written.
  const handle = await sandbox.createBackup({
    dir: BACKUP_DIR,
    ttl: BACKUP_TTL_SECONDS,
    localBucket: true,
  });
  const createdAt = new Date().toISOString();
  console.log(`[persistence:${userId}] snapshot ${handle.id} created in ${Date.now() - t0}ms`);

  // Append to the index (observability only — we do not prune).
  const index = await getIndex(bucket, keys.index);
  index.push({ id: handle.id, dir: handle.dir, createdAt });
  await putIndex(bucket, keys.index, index);
  await storeHandle(bucket, keys.handle, handle); // newest = restore target
  return handle;
}

/**
 * Snapshot /home/hermes only if the latest backup is older than maxAgeMs (or
 * there is none). Cheap to call on every cron tick — one R2 HEAD on the fast
 * path. Reuses backup-handle.json's own upload time, so there's no extra
 * state to track. Returns true if a snapshot was taken.
 */
export async function snapshotIfDue(
  sandbox: Sandbox,
  bucket: R2Bucket,
  userId: string,
  maxAgeMs: number,
): Promise<boolean> {
  const meta = await bucket.head(keysFor(userId).handle);
  if (meta && Date.now() - meta.uploaded.getTime() < maxAgeMs) return false;
  await createSnapshot(sandbox, bucket, userId);
  return true;
}
