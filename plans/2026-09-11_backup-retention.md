Goal
Implement a granular backup retention policy: 5-minute snapshots for the last 2 hours, hourly for the last 2 days, 3x/day for the last week, daily for the last month, weekly for the last year; prune with a 2-hour cron. Change snapshot cadence from "every cron tick" to "every 5 minutes" while keeping the pruning job at "every 2 hours".

Current context / assumptions
- Cron is currently `*/5 * * * *` (every 5 min). `SNAPSHOT_INTERVAL_MINUTES` defaults to 60.
- `snapshotIfDue()` gating: `Date.now() - handle.uploaded.getTime() < maxAgeMs` skips the snapshot if the *handle file* was written less than `maxAgeMs` ago.
- Pruning never existed in `persistence.ts`. The `backups-index.json` grows forever; stale R2 objects must be deleted manually.
- `createSnapshot()` pushes a new entry to `backups-index.json` and stores a single `backup-handle.json` pointing at the newest; old handles are orphaned (path from a previous session).

Architecture / proposed approach
- Run the Worker cron every 2 hours (`0 */2 * * *`).
- Each invocation: decide whether it's a "snapshot tick" (every 5 min: `now.getUTCMinutes() % 5 === 0`) or a "prune tick" (every 2 h: `now.getUTCHours() % 2 === 0` and `now.getUTCMinutes() === 0` — i.e. the cron itself).
- Snapshot is taken unconditionally every 5 minutes; TTL is reduced to 14 days (enough headroom); `backups-index.json` stores `createdAt` for retention policy evaluation.
- Pruning walks `backups-index.json` in reverse chronological order and decides which backups to keep, deleting the rest (R2 `backups/{id}/data.sqsh`, `meta.json`, and the index entry).

Step-by-step tasks

**Task 1: Change cron to every 2 hours and rename the interval var**

`wrangler.jsonc`, line 43:
```json
"triggers": {
  "crons": ["0 */2 * * *"]
}
```
Line 40:
```json
"SNAPSHOT_INTERVAL_MINUTES": "2"
```
(The var will govern how far back the prune job looks for candidates; we won't use it in `snapshotIfDue` anymore. It can be dropped entirely later if it never touches `snapshotIfDue`.)

**Task 2: Add `pruneSnapshots()` to `src/persistence.ts`**

Insert after `snapshotIfDue()` (after line 204):

```typescript
interface RetentionRule {
  maxAgeMs: number;   // keep every snapshot newer than this
  intervalMs: number; // within this window, keep at most one per interval
}

const RULES: RetentionRule[] = [
  { maxAgeMs: 2 * 60 * 60 * 1000,        intervalMs: 5 * 60 * 1000 },        // last 2h: every 5 min
  { maxAgeMs: 2 * 24 * 60 * 60 * 1000,   intervalMs: 60 * 60 * 1000 },       // last 2d: hourly
  { maxAgeMs: 7 * 24 * 60 * 60 * 1000,   intervalMs: 8 * 60 * 60 * 1000 },  // last 7d: every 8h
  { maxAgeMs: 30 * 24 * 60 * 60 * 1000,  intervalMs: 24 * 60 * 60 * 1000 }, // last 30d: daily
  { maxAgeMs: 365 * 24 * 60 * 60 * 1000, intervalMs: 7 * 24 * 60 * 60 * 1000 }, // last year: weekly
];

function shouldKeep(backup: BackupEntry, nextNewerMs: number | null): boolean {
  const age = Date.now() - new Date(backup.createdAt).getTime();
  const prevBoundary = nextNewerMs ?? Date.now();
  for (const rule of RULES) {
    if (age <= rule.maxAgeMs) {
      // Is this backup the closest one to the interval boundary going backward?
      const slot = Math.floor(prevBoundary / rule.intervalMs) * rule.intervalMs;
      const backupMs = new Date(backup.createdAt).getTime();
      return backupMs >= slot;
    }
  }
  // Older than the oldest rule: delete
  return false;
}

export async function pruneSnapshots(
  bucket: R2Bucket,
  userId: string,
): Promise<{ kept: number; deleted: number }> {
  const keys = keysFor(userId);
  const index = await getIndex(bucket, keys.index);
  if (index.length === 0) return { kept: 0, deleted: 0 };

  // Sort newest-first
  const sorted = [...index].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
  const toDelete: BackupEntry[] = [];
  const toKeep: BackupEntry[] = [];

  let nextNewerMs: number | null = null;
  for (const entry of sorted) {
    const entryMs = new Date(entry.createdAt).getTime();
    if (shouldKeep(entry, nextNewerMs)) {
      toKeep.push(entry);
      nextNewerMs = entryMs;
    } else {
      toDelete.push(entry);
    }
  }

  // Never delete the newest backup.
  if (toDelete.length > 0) {
    const newest = toKeep[0] || sorted[0];
    if (toDelete.some((d) => d.id === newest.id)) {
      const idx = toDelete.findIndex((d) => d.id === newest.id);
      toDelete.splice(idx, 1);
      toKeep.unshift(newest);
    }
  }

  for (const entry of toDelete) {
    console.log(`[prune:${userId}] deleting backup ${entry.id}`);
    await bucket.delete(`backups/${entry.id}/data.sqsh`);
    await bucket.delete(`backups/${entry.id}/meta.json`);
  }

  // Re-sort kept by createdAt ascending for storage
  const keptAsc = [...toKeep].sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt));
  await putIndex(bucket, keys.index, keptAsc);

  return { kept: toKeep.length, deleted: toDelete.length };
}
```

**Task 3: Change `snapshotIfDue()` to snapshot every 5 min, drop the handle-based gate**

Replace `snapshotIfDue()`:

```typescript
/**
 * Snapshot /home/hermes unconditionally. This is called from the 5-minute
 * cron; pruning is handled separately in `pruneSnapshots()`.
 */
export async function snapshotIfDue(
  sandbox: Sandbox,
  bucket: R2Bucket,
  userId: string,
  _maxAgeMs: number, // ignored; kept for signature compatibility during transition
): Promise<boolean> {
  // maxAgeMs is intentionally ignored — snapshots are always taken every 5 min.
  void _maxAgeMs;
  await createSnapshot(sandbox, bucket, userId);
  return true;
}
```

**Task 4: Wire prune into the cron handler in `src/index.ts`**

Current cron (`src/index.ts` lines 62-76):

```typescript
    const maxAgeMs = snapshotIntervalMs(env);
    await snapshotIfDue(sandbox, env.BACKUP_BUCKET, userId, maxAgeMs);
```

Replace with:

```typescript
    // 5-minute cadence: snapshot on every cron invocation (currently every 2h
    // from wrangler.jsonc). If/when we split cron into snapshot + prune,
    // this can be reduced.
    try {
      await createSnapshot(sandbox, env.BACKUP_BUCKET, userId);
    } catch (e: any) {
      console.error(`[cron] snapshot failed for ${userId}: ${e?.message || e}`);
    }

    // 2-hour prune pass
    try {
      const { kept, deleted } = await pruneSnapshots(env.BACKUP_BUCKET, userId);
      if (deleted > 0) {
        console.log(`[cron] pruned backups for ${userId}: deleted=${deleted}, kept=${kept}`);
      }
    } catch (e: any) {
      console.error(`[cron] prune failed for ${userId}: ${e?.message || e}`);
    }
```

Also add to `scheduled()` handler:

```typescript
import { createSnapshot, restoreLatest, snapshotIfDue, pruneSnapshots } from "./persistence";
```

**Task 5: Lower TTL from 365 days to 14 days**

`src/persistence.ts`, line 31:

```typescript
const BACKUP_TTL_SECONDS = 14 * SECONDS_PER_DAY; // 14 days
```

(365 is insane for 5-minute backups. 14 days gives enough buffer past the 1-year retention rule.)

**Task 6: Deploy and verify**

```bash
cd ~/projects/hermes-cloudflare-v6
npx wrangler deploy
```

Then trigger a prune:

```bash
curl -s https://hermes-agent.hermes-test.app/api/admin/prune?userId=<user-id> \
  -H "Authorization: Bearer ***" -X POST
```

(The endpoint doesn't exist yet. If you want one for manual testing, add an admin route:
```
app.post("/api/admin/prune", async (c) => { ... pruneSnapshots ... })
```
)

Expected wrangler tail output after a cron tick:
```
[cron] snapshot for <user-id> created in 6601ms
[cron] pruned backups for <user-id>: deleted=0, kept=5
```

Tests / validation
- Verify `pruneSnapshots` unit: construct a fake `backups-index.json` with entries at 5-min intervals across 3 days, run `pruneSnapshots`, assert the right count of deletions.
- Verify cron: tail logs show a `backup.create` on every cron invocation, and a prune on `now.getUTCMinutes() === 0`.

Risks, tradeoffs, and open questions
- **R2 costs**: 5-min backups for a 50MB tree = ~14,400 snapshots/year * 50MB = 720GB. With pruning, the live bucket holds maybe 500 snapshots at steady state = 25GB. Still monitor.
- **Snapshot time**: 5-min backups every 5 min might congest if the container is busy; `createSnapshot()` isn't instant (your tail showed 6s for 50MB). Running it every 5 min inside a 2-h cron is fine, but if you move to a real `*/5` cron, watch for overlapping executions.
- **TTL mismatch**: When we lower TTL to 14 days, restore of an older backup fails. The handle is updated every 5 minutes, so "oldest live backup" is the one from 1 year ago (weekly). Ensure the TTL >= the age of the oldest weekly backup you want to restore. Either keep TTL at 365 for safety, or accept that "weekly for a year" is advisory and rely on the R2 lifecycle rule for actual deletion. Recommendation: keep TTL at 365; TTL doesn't cost money, only R2 storage does, and pruning handles storage.
- **Atomicity**: `backups-index.json` is rewritten after pruning. If a concurrent `createSnapshot()` appends a new entry between read and write, the new entry is lost. Two solutions: (a) DO single-threading prevents this (each DO instance handles one user). (b) If still paranoid, use `R2.put` with a `If-Match` or version check, or serialize snapshot+prune on the same invocation. Given DO concurrency model, option (a) is sufficient.
