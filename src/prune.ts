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
// Retention — slot-filling, newest-first, high-res to low-res
// ---------------------------------------------------------------------------

function getISOWeek(d: Date): string {
  const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = tmp.getUTCDay() || 7;
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const weekNo = String(Math.ceil((((tmp.getTime() - yearStart.getTime()) / 86400000) + 1) / 7)).padStart(2, "0");
  return `${tmp.getUTCFullYear()}-W${weekNo}`;
}

interface SlotInfo {
  fiveMinSlot: number;
  hourSlot: number;
  daySlot: string;   // YYYY-MM-DD
  weekSlot: string;  // YYYY-WNN
  age: number;
}

function getSlots(entry: BackupEntry, now: number): SlotInfo {
  const ts = new Date(entry.createdAt).getTime();
  const date = new Date(entry.createdAt);
  return {
    fiveMinSlot: Math.floor(ts / (5 * 60 * 1000)),
    hourSlot:    Math.floor(ts / (60 * 60 * 1000)),
    daySlot:     `${date.getUTCFullYear()}-${String(date.getUTCMonth()+1).padStart(2,'0')}-${String(date.getUTCDate()).padStart(2,'0')}`,
    weekSlot:    getISOWeek(date),
    age:         now - ts,
  };
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
  // Sort newest-first so the first backup encountered fills its slot
  const sorted = [...index].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));

  const seenFiveMin = new Set<number>();
  const seenHour    = new Set<number>();
  const seenDay     = new Set<string>();
  const seenWeek    = new Set<string>();
  const seenAny     = new Set<string>(); // dedupe across all tiers for same backup

  const toKeep: BackupEntry[] = [];

  for (const entry of sorted) {
    const s = getSlots(entry, now);
    let kept = false;

    // Tier 1: 5-minute slots for < 2h
    if (s.age < 2 * 60 * 60 * 1000 && !seenFiveMin.has(s.fiveMinSlot)) {
      seenFiveMin.add(s.fiveMinSlot);
      seenAny.add(entry.id);
      kept = true;
    }

    // Tier 2: hour slots for < 1d (only if not already kept)
    if (!kept && s.age < 1 * 24 * 60 * 60 * 1000 && !seenHour.has(s.hourSlot)) {
      seenHour.add(s.hourSlot);
      seenAny.add(entry.id);
      kept = true;
    }

    // Tier 3: daily slots, max 5, across ALL time
    if (!kept && seenDay.size < 5 && !seenDay.has(s.daySlot)) {
      seenDay.add(s.daySlot);
      seenAny.add(entry.id);
      kept = true;
    }

    // Tier 4: weekly slots, max 5, across ALL time, only weeks not represented by a kept daily
    if (!kept && seenWeek.size < 5 && !seenWeek.has(s.weekSlot)) {
      seenWeek.add(s.weekSlot);
      seenAny.add(entry.id);
      kept = true;
    }

    if (kept) toKeep.push(entry);
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
