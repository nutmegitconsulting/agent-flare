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
 *   users/<userId>/backups-index.json   array of {id, dir, createdAt, handle}
 *   backups/<id>/data.sqsh              SDK-written squashfs archive
 *   backups/<id>/meta.json              SDK-written metadata
 *
 * The index is the single source of truth for restores. The newest entry
 * (by createdAt) is the restore target.
 *
 * Retention: this module NEVER deletes backups. The user manages retention
 * via the bucket's own lifecycle rules (backups/ prefix). The per-backup
 * TTL is therefore set to 365 days so the SDK never refuses to restore a
 * backup that still exists in the bucket — the "most recent available backup"
 * is always restorable regardless of how long the bucket keeps it.
 */
const BACKUP_DIR = "/home/hermes/.hermes";
const SECONDS_PER_DAY = 86_400;
/** SDK refuses to restore past (createdAt + ttl). Keep it well beyond the
 *  bucket's retention window so any object still present is restorable. */
const BACKUP_TTL_SECONDS = 365 * SECONDS_PER_DAY;
const INDEX_KEY_SUFFIX = "backups-index.json";
/** H1: an empty-tree squashfs is ~4KB (a fresh-boot container's .hermes holds
 *  only boot artifacts). Real trees are MBs. Candidates below this size are
 *  skipped so an empty snapshot can never shadow real data. */
const MIN_VALID_BACKUP_BYTES = 8192;

/** SDK-written metadata for one backup blob (backups/<id>/meta.json). */
interface BackupMeta {
  sizeBytes?: number;
}

/** H1: read one backup's SDK-written meta.json; null when missing/unparseable. */
async function metaFor(bucket: R2Bucket, backupId: string): Promise<BackupMeta | null> {
  const obj = await bucket.get(`backups/${backupId}/meta.json`);
  if (!obj) return null;
  try {
    return (await obj.json()) as BackupMeta;
  } catch {
    return null;
  }
}

/** Per-user R2 key namespace. */
function keysFor(userId: string) {
  return {
    index: `users/${userId}/${INDEX_KEY_SUFFIX}`,
  };
}

/** One retained backup. `backups-index.json` is an array of these. */
export interface BackupEntry {
  id: string;
  dir: string;
  createdAt: string; // ISO 8601
  /** Full SDK restore handle */
  handle: DirectoryBackup;
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
 * Restore the newest VALID backup if one exists. Returns true if a restore ran.
 *
 * H1: candidates are walked newest-first and validated against their
 * SDK-written meta.json before restoring — entries whose blob is missing or
 * an empty-tree snapshot are skipped, so a poisoned index (e.g. a cron
 * snapshot of a fresh-boot container that never hydrated) cannot shadow real
 * data. Expired/gone entries are removed from the index and the walk
 * continues to older candidates. A failed restore must NOT fail the wake —
 * the caller wraps this and surfaces the error in the response instead of
 * keeping the container down.
 */
export async function restoreLatest(
  sandbox: Sandbox,
  bucket: R2Bucket,
  userId: string,
): Promise<boolean> {
  const keys = keysFor(userId);
  const index = await getIndex(bucket, keys.index);
  if (index.length === 0) {
    console.log(`[persistence:${userId}] no prior backup, starting fresh`);
    return false;
  }

  // Sort newest-first, then walk candidates until one is valid.
  const sorted = [...index].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  // Clear any stale FUSE overlay before re-restoring (no-op on the localBucket
  // path, which uses unsquashfs extraction rather than a FUSE mount).
  try {
    await sandbox.exec(`umount ${BACKUP_DIR} 2>/dev/null; true`);
  } catch {
    /* may not be mounted */
  }

  for (const candidate of sorted) {
    const meta = await metaFor(bucket, candidate.id);
    if (!meta || !meta.sizeBytes || meta.sizeBytes < MIN_VALID_BACKUP_BYTES) {
      console.log(
        `[persistence:${userId}] skipping backup ${candidate.id} (sizeBytes=${meta?.sizeBytes ?? "missing"} < ${MIN_VALID_BACKUP_BYTES}, or blob gone)`,
      );
      continue;
    }

    console.log(`[persistence:${userId}] restoring backup ${candidate.id}`);
    const t0 = Date.now();
    try {
      await sandbox.restoreBackup(candidate.handle);
      console.log(`[persistence:${userId}] restored ${candidate.id} in ${Date.now() - t0}ms`);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/BACKUP_EXPIRED|BACKUP_NOT_FOUND|BackupExpiredError|BackupNotFoundError|Backup not found|has expired/i.test(msg)) {
        console.log(`[persistence:${userId}] backup ${candidate.id} gone, removing from index, trying older`);
        await removeFromIndex(bucket, userId, candidate.id);
        continue;
      }
      throw err;
    }
  }

  console.log(`[persistence:${userId}] no valid backup among ${sorted.length} entries, starting fresh`);
  return false;
}

/**
 * Snapshot /home/hermes/.hermes to R2 and record it in the index.
 *
 * H3: refuses to snapshot an empty tree when history exists. A fresh-boot
 * container's .hermes holds only boot artifacts (.startup-status, .env);
 * snapshotting that would make the empty tree the index's newest entry and
 * poison every future restore. Returns null when skipped. A genuinely fresh
 * user (no index entries) still gets a baseline snapshot.
 *
 * No pruning happens here — the user owns retention via the bucket's
 * lifecycle rules. The index is appended to (for observability / manual
 * reference) and the newest entry is the restore target.
 */
export async function createSnapshot(
  sandbox: Sandbox,
  bucket: R2Bucket,
  userId: string,
): Promise<DirectoryBackup | null> {
  const keys = keysFor(userId);

  // H3 content check: real content = any file besides boot artifacts.
  const [contentCheck, existingIndex] = await Promise.all([
    sandbox.exec(
      `find ${BACKUP_DIR} -type f ! -name '.startup-status' ! -name '.env' 2>/dev/null | head -5`,
    ),
    getIndex(bucket, keys.index),
  ]);
  const hasContent = (contentCheck.stdout || "").trim().length > 0;
  if (!hasContent && existingIndex.length > 0) {
    console.log(
      `[persistence:${userId}] skipping snapshot: .hermes has no real content and ${existingIndex.length} backups exist`,
    );
    return null;
  }

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

  // Append to the index. The full handle is stored so restoreLatest can use
  // the index as the single source of truth.
  const index = await getIndex(bucket, keys.index);
  index.push({ id: handle.id, dir: handle.dir, createdAt, handle });
  await putIndex(bucket, keys.index, index);
  return handle;
}

/**
 * Snapshot /home/hermes/.hermes only if the latest backup is older than
 * maxAgeMs (or there is none). Cheap to call on every cron tick — one R2
 * HEAD on the fast path. Returns true if a snapshot was taken.
 */
export async function snapshotIfDue(
  sandbox: Sandbox,
  bucket: R2Bucket,
  userId: string,
  maxAgeMs: number,
): Promise<boolean> {
  const keys = keysFor(userId);
  const meta = await bucket.head(keys.index);
  if (meta && Date.now() - meta.uploaded.getTime() < maxAgeMs) return false;
  const handle = await createSnapshot(sandbox, bucket, userId);
  return handle !== null;
}
