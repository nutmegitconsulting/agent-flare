import type { R2Bucket } from "@cloudflare/workers-types";

export interface BackupEntry {
  id: string;
  dir: string;
  createdAt: string;
}

const HANDLE_KEY = "backup-handle.json";
const INDEX_KEY  = "backups-index.json";

function keysFor(userId: string) {
  return {
    handle: `users/${userId}/${HANDLE_KEY}`,
    index:  `users/${userId}/${INDEX_KEY}`,
  };
}

async function getIndex(bucket: R2Bucket, key: string): Promise<BackupEntry[]> {
  const obj = await bucket.get(key);
  if (!obj) return [];
  try { return await obj.json(); } catch { return []; }
}

async function putIndex(bucket: R2Bucket, key: string, entries: BackupEntry[]): Promise<void> {
  await bucket.put(key, JSON.stringify(entries));
}

export async function removeFromIndex(bucket: R2Bucket, userId: string, backupId: string): Promise<boolean> {
  const keys = keysFor(userId);
  const index = await getIndex(bucket, keys.index);
  const next = index.filter((e) => e.id !== backupId);
  if (next.length === index.length) return false;
  await putIndex(bucket, keys.index, next);
  console.log(`[index:${userId}] removed entry ${backupId}`);
  return true;
}

// ---------------------------------------------------------------------------
// Retention tiers — slot-based (newest wins in each slot)
// ---------------------------------------------------------------------------

interface Tier {
  maxAgeMs: number;
  slotMs: number;
}

const TIERS: Tier[] = [
  { maxAgeMs: 2 * 60 * 60 * 1000,        slotMs: 5 * 60 * 1000 },          // 0-2h:     every 5 min
  { maxAgeMs: 1 * 24 * 60 * 60 * 1000,   slotMs: 60 * 60 * 1000 },          // 2h-1d:    hourly
  { maxAgeMs: 5 * 24 * 60 * 60 * 1000,   slotMs: 24 * 60 * 60 * 1000 },     // 1d-5d:    daily  ← 5 daily backups
  { maxAgeMs: 33 * 24 * 60 * 60 * 1000,  slotMs: 7 * 24 * 60 * 60 * 1000 }, // 5d-33d:   weekly (4 copies)
];

function getSlotSize(ageMs: number): number | null {
  for (const tier of TIERS) if (ageMs <= tier.maxAgeMs) return tier.slotMs;
  return null; // older than 33d → delete
}

// ---------------------------------------------------------------------------
// Prune
// ---------------------------------------------------------------------------

export async function pruneSnapshots(
  bucket: R2Bucket,
  userId: string,
): Promise<{ kept: number; deleted: number }> {
  const keys = keysFor(userId);
  const index = await getIndex(bucket, keys.index);
  if (index.length === 0) return { kept: 0, deleted: 0 };

  const now = Date.now();
  // Sort newest-first so the first backup in each time slot wins
  const sorted = [...index].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
  const seen = new Set<number>();
  const toKeep: BackupEntry[] = [];

  for (const entry of sorted) {
    const age = now - new Date(entry.createdAt).getTime();
    const slotSize = getSlotSize(age);
    if (slotSize === null) continue; // too old — delete

    const slot = Math.floor(age / slotSize);
    if (seen.has(slot)) continue; // newer backup already in this slot

    seen.add(slot);
    toKeep.push(entry);
  }

  const keepIds = new Set(toKeep.map((e) => e.id));
  let toDelete = sorted.filter((e) => !keepIds.has(e.id));

  // Safety: never delete the absolute newest backup
  const newest = sorted[0];
  if (toDelete.some((d) => d.id === newest.id)) {
    toDelete = toDelete.filter((d) => d.id !== newest.id);
    if (!keepIds.has(newest.id)) toKeep.push(newest);
  }

  for (const entry of toDelete) {
    console.log(`[prune:${userId}] deleting backup ${entry.id}`);
    await bucket.delete(`backups/${entry.id}/data.sqsh`);
    await bucket.delete(`backups/${entry.id}/meta.json`);
  }

  const keptAsc = [...toKeep].sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt));
  await putIndex(bucket, keys.index, keptAsc);
  return { kept: toKeep.length, deleted: toDelete.length };
}
