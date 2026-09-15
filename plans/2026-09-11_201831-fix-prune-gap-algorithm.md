Goal
Fix the retention pruning algorithm so overlapping age intervals do not collapse all backups into the shortest interval. The correct logic is: keep a backup if it is the newest one in its retention tier, or if the gap to the next newer kept backup exceeds that tier's interval.

Current context / assumptions
- The `shouldKeep()` function in `src/persistence.ts` uses a slot-floor algorithm: `slot = (prevBoundary // interval) * interval`. For the 5-min interval in the 2h window, this floor is always within 5 minutes of `prevBoundary` (which starts as `now`), so every backup older than ~5 minutes is discarded regardless of its actual tier.
- The correct behavior: within each tier, keep at most one backup per `intervalMs`, keeping the newest one in each slot. The gap between a kept backup and the next newer kept backup should be >= the interval of the younger backup's tier.
- `pruneSnapshots()` walks backups newest-first. The algorithm must evaluate each backup against the retention rules in priority order (tightest time window first) and decide keep/delete based on whether a newer backup already exists within its tier's interval.

Architecture / proposed approach
Replace the slot-floor `shouldKeep()` with a gap-based evaluation. Walk the sorted backups newest-first. For each backup, determine its retention tier from its age. If the gap between this backup and the nearest newer kept backup is >= this backup's tier interval, keep it. Otherwise the next newer backup already satisfies this tier's spacing requirement, so delete this one.

Step-by-step tasks

Task 1: Replace the retention rules definition
File: src/persistence.ts
Replace lines 195-208 (the current `RetentionRule` interface and `RETENTION_RULES` constant) with:

```typescript
/** Retention tier: keep one backup per interval within the maxAge window. */
interface RetentionTier {
  maxAgeMs: number;
  intervalMs: number;
}

const TIERS: RetentionTier[] = [
  { maxAgeMs: 2 * 60 * 60 * 1000,        intervalMs: 5 * 60 * 1000 },        // 0-2h: every 5 min
  { maxAgeMs: 2 * 24 * 60 * 60 * 1000,   intervalMs: 60 * 60 * 1000 },       // 2h-2d: hourly
  { maxAgeMs: 7 * 24 * 60 * 60 * 1000,   intervalMs: 8 * 60 * 60 * 1000 },  // 2d-7d: every 8h
  { maxAgeMs: 30 * 24 * 60 * 60 * 1000,  intervalMs: 24 * 60 * 60 * 1000 }, // 7d-30d: daily
  { maxAgeMs: 365 * 24 * 60 * 60 * 1000, intervalMs: 7 * 24 * 60 * 60 * 1000 }, // 30d-1y: weekly
];

function getTier(ageMs: number): RetentionTier | null {
  for (const tier of TIERS) {
    if (ageMs <= tier.maxAgeMs) return tier;
  }
  return null;
}
```

Task 2: Replace shouldKeep() with the gap-based algorithm
Replace lines 210-224 (the old `shouldKeep()` function) with:

```typescript
/**
 * Decide whether to keep a backup. Walks newest-first; `nextNewerMs` is the
 * timestamp of the most recent backup already decided as KEPT (or null for
 * the absolute newest backup).
 *
 * Rule: this backup is kept if:
 *   - There is no newer kept backup (it is the newest overall), OR
 *   - The gap between this backup and the next newer kept backup is >= this
 *     backup's tier interval.
 *
 * This ensures each tier satisfies its spacing requirement without the
 * slot-floor bug where all backups collapse into the tightest interval.
 */
function shouldKeep(backup: BackupEntry, nextNewerMs: number | null, now: number): boolean {
  const backupMs = new Date(backup.createdAt).getTime();
  const age = now - backupMs;
  const tier = getTier(age);
  if (!tier) return false; // older than maximum retention
  if (nextNewerMs === null) return true; // newest backup is always kept
  const gap = nextNewerMs - backupMs;
  return gap >= tier.intervalMs;
}
```

Task 3: Update pruneSnapshots() to pass `Date.now()` through
Replace the existing `pruneSnapshots()` function body (lines 226-264 approximately) with:

```typescript
export async function pruneSnapshots(
  bucket: R2Bucket,
  userId: string,
): Promise<{ kept: number; deleted: number }> {
  const keys = keysFor(userId);
  const index = await getIndex(bucket, keys.index);
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
  const toDelete = sorted.filter((e) => !keepIds.has(e.id));

  // Safety: never delete the absolute newest backup regardless of algorithm edge cases.
  const newest = sorted[0];
  if (toDelete.some((d) => d.id === newest.id)) {
    toDelete.splice(
      toDelete.findIndex((d) => d.id === newest.id),
      1,
    );
    if (!keepIds.has(newest.id)) {
      toKeep.unshift(newest);
    }
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
```

Task 4: Verify with a manual test
Command:
```bash
cd ~/projects/hermes-cloudflare-v6 && npx tsx -e "
const { TIERS, getTier, shouldKeep } = require('./src/persistence.ts');
// Cannot require .ts directly — run via the deployed endpoint instead
"
```

Better: trigger a manual prune via the existing admin endpoint after deploy:
```bash
curl -s -X POST "https://hermes-agent.hermes-test.app/api/admin/prune?userId=user" \
  -H "Authorization: Bearer ***"
```

Expected: if you have 5+ backups taken in the last 2 hours, ALL of them should be kept (one per 5-min slot). Before the fix, only the newest would survive.

Task 5: Deploy
Command:
```bash
cd ~/projects/hermes-cloudflare-v6 && npx wrangler deploy --containers-rollout=none
```

Tests / validation
Write a standalone unit test in `tests/prune.test.ts`:

```typescript
import { describe, it, expect } from "vitest";

// Copy TIERS, getTier, shouldKeep from src/persistence.ts for testing
const TIERS = [
  { maxAgeMs: 2 * 60 * 60 * 1000, intervalMs: 5 * 60 * 1000 },
];

function getTier(ageMs: number) {
  for (const t of TIERS) if (ageMs <= t.maxAgeMs) return t;
  return null;
}

function shouldKeep(createdAt: string, nextNewerMs: number | null, now: number) {
  const ts = new Date(createdAt).getTime();
  const age = now - ts;
  const tier = getTier(age);
  if (!tier) return false;
  if (nextNewerMs === null) return true;
  const gap = nextNewerMs - ts;
  return gap >= tier.intervalMs;
}

describe("retention algorithm", () => {
  it("keeps all 5-min backups in 2h window", () => {
    const now = Date.now();
    const backups = [0, 5, 10, 15, 20].map((m) => ({
      id: `b-${m}`,
      createdAt: new Date(now - m * 60000).toISOString(),
      dir: "/home/hermes/.hermes",
    }));
    const kept: typeof backups = [];
    let nextNewer: number | null = null;
    for (const b of backups) {
      if (shouldKeep(b.createdAt, nextNewer, now)) {
        kept.push(b);
        nextNewer = new Date(b.createdAt).getTime();
      }
    }
    expect(kept.length).toBe(5);
  });

  it("drops 6th backup if within 5min of 5th", () => {
    const now = Date.now();
    const backups = [0, 4, 8, 12, 16, 20].map((m) => ({
      id: `b-${m}`,
      createdAt: new Date(now - m * 60000).toISOString(),
      dir: "/home/hermes/.hermes",
    }));
    // 0 and 4 are 4 min apart (0-4 gap=4 < 5min interval) → 4 dropped
    const kept: typeof backups = [];
    let nextNewer: number | null = null;
    for (const b of backups) {
      if (shouldKeep(b.createdAt, nextNewer, now)) {
        kept.push(b);
        nextNewer = new Date(b.createdAt).getTime();
      }
    }
    expect(kept.map((k) => k.id)).toEqual(["b-0", "b-8", "b-16"]);
  });
});
```

Commands:
```bash
cd ~/projects/hermes-cloudflare-v6
npm install -D vitest
npx vitest run tests/prune.test.ts
```
Expected: 2 passed.

Risks, tradeoffs, and open questions
- The old index is partially corrupt: some entries may be missing from the index (Sync race condition not yet diagnosed). After this fix, prune will only operate on backups present in the index. Orphans outside the index will never be pruned.
- R2 costs: 5-min snapshots = ~14,400 objects/year * 50MB = 720GB written. Pruned live set ~500 objects = 25GB. Monitor R2 bill.
- TTL: Keep at 365 days. The SDK enforces TTL only at restore time; lowering TTL would break restoring weekly backups from six months ago. TTL is free; storage costs money.
