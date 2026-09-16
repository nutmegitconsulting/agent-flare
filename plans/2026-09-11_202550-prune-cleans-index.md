Goal
Ensure every backup deletion path (pruning, expiration, manual cleanup) removes the corresponding entry from the per-user `backups-index.json` so the index never references deleted backups.

Current context / assumptions
- `backups-index.json` is stored at `users/<userId>/backups-index.yesjson` in the bound `BACKUP_BUCKET`.
- `createSnapshot()` appends to this index and writes it back.
- There is no inverse function. When R2 objects `backups/<id>/data.sqsh` and `meta.json` are deleted, the index entry with `{ id, dir, createdAt }` stays forever.
- A stale index causes two problems:
  1. `pruneSnapshots()` iterates phantom entries, wasting time and logging confusing “deleting backup X” messages for objects already gone.
  2. `backups-index.json` grows without bound (unbounded storage cost, unbounded read time).

Architecture / proposed approach
- Every deletion of a backup ID writes a secondary function `removeFromIndex(bucket, userId, backupId)`.
- The prune loop calls this immediately after deleting the R2 objects.
- `restoreLatest()` already clears the handle on `BACKUP_NOT_FOUND`; it should also call `removeFromIndex()` if the backup it attempted to restore is gone.
- No new endpoints required; this is purely a housekeeping correction inside existing paths.

Step-by-step tasks

Task 1: Add `removeFromIndex()` to `src/persistence.ts`
Insert after `putIndex()` (after line 102):

```typescript
/** Remove a single backup id from the per-user index, returning true if found. */
async function removeFromIndex(bucket: R2Bucket, userId: string, backupId: string): Promise<boolean> {
  const keys = keysFor(userId);
  const index = await getIndex(bucket, keys.index);
  const next = index.filter((e) => e.id !== backupId);
  if (next.length === index.length) return false;
  await putIndex(bucket, keys.index, next);
  console.log(`[index:${userId}] removed entry ${backupId}`);
  return true;
}
```

Task 2: Update `restoreLatest()` to purge stale entries
File: `src/persistence.ts`, lines 138-144.
After `deleteStoredHandle()`, also purge the index:

```typescript
    if (/BACKUP_EXPIRED|BACKUP_NOT_FOUND|.../i.test(msg)) {
      console.log(`[persistence:${userId}] backup ${handle.id} gone, clearing handle`);
      await deleteStoredHandle(bucket, keys.handle);
      await removeFromIndex(bucket, userId, handle.id); // <-- ADD THIS LINE
      return false;
    }
```

Task 3: Wire `pruneSnapshots()` into `src/persistence.ts`
Insert after `snapshotIfDue()` (after line 205). This is new code — the file currently has no prune logic.

```typescript
interface RetentionTier {
  maxAgeMs: number;
  intervalMs: number;
}

const TIERS: RetentionTier[] = [
  { maxAgeMs: 2 * 60 * 60 * 1000,        intervalMs: 5 * 60 * 1000 },
  { maxAgeMs: 2 * 24 * 60 * 60 * 1000,   intervalMs: 60 * 60 * 1000 },
  { maxAgeMs: 7 * 24 * 60 * 60 * 1000,   intervalMs: 8 * 60 * 60 * 1000 },
  { maxAgeMs: 30 * 24 * 60 * 60 * 1000,  intervalMs: 24 * 60 * 60 * 1000 },
  { maxAgeMs: 365 * 24 * 60 * 60 * 1000, intervalMs: 7 * 24 * 60 * 60 * 1000 },
];

function getTier(ageMs: number): RetentionTier | null {
  for (const tier of TIERS) if (ageMs <= tier.maxAgeMs) return tier;
  return null;
}

function shouldKeep(backup: BackupEntry, nextNewerMs: number | null, now: number): boolean {
  const ts = new Date(backup.createdAt).getTime();
  const age = now - ts;
  const tier = getTier(age);
  if (!tier) return false;
  if (nextNewerMs === null) return true;
  return nextNewerMs - ts >= tier.intervalMs;
}

/** Prune stale backups and rewrite the per-user index atomically. */
export async function pruneSnapshots(bucket: R2Bucket, userId: string): Promise<{ kept: number; deleted: number }> {
  const keys = keysFor(userId);
  let index = await getIndex(bucket, keys.index);
  if (index.length === 0) return { kept: 0, deleted: 0 };

  const now = Date.now();
  const sorted = [...index].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
  const toKeep: BackupEntry[] = [];
  let nextNewerMs: number | null = null;

  for (const entry of sorted) {
    if (shouldKeep(entry, nextNewerMs, now)) {
      toKeep.push(entry);
      nextNewerMs = new Date(entry.createdAt).getTime();
    }
  }

  const keepIds = new Set(toKeep.map((e) => e.id));
  let toDelete = sorted.filter((e) => !keepIds.has(e.id));

  // Safety: never delete the newest backup
  const newest = sorted[0];
  if (toDelete.some((d) => d.id === newest.id)) {
    toDelete = toDelete.filter((d) => d.id !== newest.id);
    if (!keepIds.has(newest.id)) toKeep.unshift(newest);
  }

  // Delete R2 objects AND clean the index in one atomic rewrite
  for (const entry of toDelete) {
    console.log(`[prune:${userId}] deleting backup ${entry.id}`);
    await bucket.delete(`backups/${entry.id}/data.sqsh`);
    await bucket.delete(`backups/${entry.id}/meta.json`);
  }

  const keptAsc = [...toKeep].sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt));
  await putIndex(bucket, keys.index, keptAsc);
  return { kept: toKeep.length, deleted: toDelete.length };
}
```

Task 4: Add admin prune endpoint to `src/index.ts`
Insert before `// Admin: check container state` (around line 489):

```typescript
app.post("/api/admin/prune", async (c) => {
  const userId = c.req.query("userId");
  if (!userId) return c.json({ error: "Missing userId" }, 400);
  const t0 = Date.now();
  try {
    const { kept, deleted } = await pruneSnapshots(c.env.BACKUP_BUCKET, userId);
    return c.json({ userId, kept, deleted, duration_ms: Date.now() - t0 });
  } catch (e: any) {
    return c.json({ userId, error: e?.message || String(e), duration_ms: Date.now() - t0 }, 500);
  }
});
```

Also add `pruneSnapshots` to the import at the top of `src/index.ts`:
```typescript
import { createSnapshot, restoreLatest, snapshotIfDue, pruneSnapshots } from "./persistence";
```

Task 5: Run a manual prune test via curl
```bash
curl -s -X POST "https://hermes-agent.hermes-test.app/api/admin/prune?userId=<user-id>" \
  -H "Authorization: Bearer ***"
```

Expected JSON:
```json
{ "userId": "<user-id>", "kept": 7, "deleted": 3 }
```

Then verify the index shrank:
```bash
curl -s "https://hermes-agent.hermes-test.app/api/admin/providers?userId=<user-id>" \
  -H "Authorization: Bearer ***"
```
No, there is no GET for the raw index. Use the R2 binding directly in a debug script, or read the Worker logs (wrangler tail) for the `[prune:<user-id>] deleting backup X` and `[index:<user-id>] removed entry Y` lines.

Task 6: Deploy
```bash
cd ~/projects/hermes-cloudflare-v6 && npx wrangler deploy --containers-rollout=none
```

Tests / validation
- Trigger a backup restore with a stale handle (e.g., manually delete R2 objects for the newest backup, then wake). The `removeFromIndex()` path should log `[index:<user-id>] removed entry <id>` in wrangler tail.
- Trigger the prune endpoint after taking 5+ snapshots in quick succession. Verify `backups-index.json` shrinks to the expected count.

Risks, tradeoffs, and open questions
- If `removeFromIndex()` is called concurrently with `createSnapshot()` appending a new entry, the new entry could be lost because both read the index and the second write overwrites the first. However, DO single-threading prevents concurrent snapshot + prune for the same user. If both are on the same clock tick, schedule snapshot first, then prune immediately after it returns.
- `restoreLatest()` calling `removeFromIndex()` during a wake adds latency. If the index is very large (thousands of entries), the filter rewrite is O(n). In practice this is milliseconds for <1000 entries.
