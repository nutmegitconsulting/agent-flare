Goal
Run filesystem snapshots every 5 minutes and prune stale snapshots every 2 hours, using separate Wrangler cron triggers, while keeping a 30-day live retention window with a 1-year drift window.

Current context / assumptions
- Single cron trigger exists: `*/5 * * * *` in `wrangler.jsonc`.
- `snapshotIfDue()` is gated on handle age (`SNAPSHOT_INTERVAL_MINUTES`).
- No pruning exists; `backups-index.json` grows forever.
- `BACKUP_TTL_SECONDS` is currently 365 days.
- DO single-threading prevents concurrent snapshot+prune for the same user.

Architecture / proposed approach
Two cron triggers fire independently: `*/5` runs `createSnapshot()` for every active running user; `0 */2` runs `pruneSnapshots()` for every active user. Each uses a separate handler path in `src/index.ts` dispatched by event.cron. Retention rules are declared as `maxAgeMs`/`intervalMs` tuples and evaluated newest-first.

Step-by-step tasks

Task 1: Add the second cron trigger to wrangler.jsonc
File: wrangler.jsonc
Replace lines 42-44:
```json
"triggers": {
  "crons": ["*/5 * * * *"]
}
```
With:
```json
"triggers": {
  "crons": ["*/5 * * * *", "0 */2 * * *"]
}
```
Drop SNAPSHOT_INTERVAL_MINUTES entirely (lines 39-41) — it is no longer read:
```json
"vars": {}
```

Task 2: Remove the obsolete snapshotIntervalMs helper and scheduled gate
File: src/index.ts
Delete lines 22-30:
```typescript
// Minimum age of the latest backup before the cron takes a fresh snapshot.
// Default 60 min; override via SNAPSHOT_INTERVAL_MINUTES env var.
function snapshotIntervalMs(env: Env): number {
  const parsed = parseInt(env.SNAPSHOT_INTERVAL_MINUTES || "60", 10);
  if (!Number.isNaN(parsed) && parsed > 0) return parsed * 60_000;
  return 60 * 60_000;
}
```

Task 3: Write prune logic in src/persistence.ts
Insert after snapshotIfDue() (after line 204):

```typescript
interface RetentionRule {
  maxAgeMs: number;
  intervalMs: number;
}

/** Retention policy evaluated newest-first. */
const RETENTION_RULES: RetentionRule[] = [
  { maxAgeMs: 2 * 60 * 60 * 1000,        intervalMs: 5 * 60 * 1000 },        // 2h window, keep 5-min apart
  { maxAgeMs: 2 * 24 * 60 * 60 * 1000,   intervalMs: 60 * 60 * 1000 },       // 2d window, keep hourly
  { maxAgeMs: 7 * 24 * 60 * 60 * 1000,   intervalMs: 8 * 60 * 60 * 1000 },  // 7d window, keep 8h apart
  { maxAgeMs: 30 * 24 * 60 * 60 * 1000,  intervalMs: 24 * 60 * 60 * 1000 }, // 30d window, keep daily
  { maxAgeMs: 365 * 24 * 60 * 60 * 1000, intervalMs: 7 * 24 * 60 * 60 * 1000 }, // 365d window, keep weekly
];

function shouldKeep(backup: BackupEntry, nextNewerMs: number | null): boolean {
  const age = Date.now() - new Date(backup.createdAt).getTime();
  if (age > RETENTION_RULES[RETENTION_RULES.length - 1].maxAgeMs) return false;
  const prevBoundary = nextNewerMs ?? Date.now();
  for (const rule of RETENTION_RULES) {
    if (age <= rule.maxAgeMs) {
      const slot = Math.floor(prevBoundary / rule.intervalMs) * rule.intervalMs;
      const backupMs = new Date(backup.createdAt).getTime();
      return backupMs >= slot;
    }
  }
  return false;
}

export async function pruneSnapshots(
  bucket: R2Bucket,
  userId: string,
): Promise<{ kept: number; deleted: number }> {
  const keys = keysFor(userId);
  const index = await getIndex(bucket, keys.index);
  if (index.length === 0) return { kept: 0, deleted: 0 };
  const sorted = [...index].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
  const toKeep: BackupEntry[] = [];
  let nextNewerMs: number | null = null;
  for (const entry of sorted) {
    if (shouldKeep(entry, nextNewerMs)) {
      toKeep.push(entry);
      nextNewerMs = new Date(entry.createdAt).getTime();
    }
  }
  const keepIds = new Set(toKeep.map((e) => e.id));
  const toDelete = sorted.filter((e) => !keepIds.has(e.id));
  // Safety: never delete the absolute newest backup.
  const newest = sorted[0];
  if (toDelete.some((d) => d.id === newest.id)) {
    toDelete.splice(
      toDelete.findIndex((d) => d.id === newest.id),
      1,
    );
    toKeep.push(newest);
  }
  for (const entry of toDelete) {
    await bucket.delete(`backups/${entry.id}/data.sqsh`);
    await bucket.delete(`backups/${entry.id}/meta.json`);
  }
  const keptAsc = [...toKeep].sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt));
  await putIndex(bucket, keys.index, keptAsc);
  return { kept: toKeep.length, deleted: toDelete.length };
}
```

Task 4: Rewrite snapshotIfDue() to snapshot unconditionally
File: src/persistence.ts
Replace snapshotIfDue() (lines 195-204):

```typescript
export async function snapshotIfDue(
  sandbox: Sandbox,
  bucket: R2Bucket,
  userId: string,
  _maxAgeMs: number,
): Promise<boolean> {
  void _maxAgeMs;
  await createSnapshot(sandbox, bucket, userId);
  return true;
}
```

Task 5: Rewrite the scheduled() handler to dispatch by cron pattern
Current scheduled() handler lines 585-605:

Replace with:

```typescript
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx);
  },

  async scheduled(
    event: ScheduledEvent,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    const snapshotUsers = await listActiveUsers(env.BACKUP_BUCKET);
    if (event.cron === "0 */2 * * *") {
      // Prune pass
      for (const userId of snapshotUsers) {
        try {
          const { kept, deleted } = await pruneSnapshots(env.BACKUP_BUCKET, userId);
          if (deleted > 0) console.log(`[prune:${userId}] deleted=${deleted}, kept=${kept}`);
        } catch (e: any) {
          console.error(`[prune:${userId}] failed: ${e?.message || e}`);
        }
      }
      return;
    }
    // Snapshot pass (*/5 * * * *)
    for (const userId of snapshotUsers) {
      const sandbox: any = getSandboxAny(env.Sandbox, userId);
      const state = await sandbox.getState();
      if (state !== "running") continue;
      try {
        await createSnapshot(sandbox, env.BACKUP_BUCKET, userId);
      } catch (e: any) {
        console.error(`[cron:${userId}] snapshot failed: ${e?.message || e}`);
      }
    }
  },
};
```

Add import at top of src/index.ts:
```typescript
import { createSnapshot, restoreLatest, snapshotIfDue, pruneSnapshots } from "./persistence";
```

Task 6: Add admin prune endpoint
Insert before line 489 (before // Admin: check container state):

```typescript
// Admin: manual prune trigger (ops / validation)
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

Task 7: Deploy and verify
Command:
```bash
cd ~/projects/hermes-cloudflare-v6 && npx wrangler deploy --containers-rollout=none
```
Expected output: two cron triggers deployed.

Verify snapshot:
```bash
npx wrangler tail | grep "snapshot.*created"
```

Verify prune:
```bash
curl -s -X POST "https://hermes-agent.hermes-test.app/api/admin/prune?userId=user" \
  -H "Authorization: Bearer $(cat ~/.hermes/.env | grep SESSION_TOKEN | head -1 | cut -d= -f2)"
```
Expected JSON: `{ "userId": "user", "kept": N, "deleted": M }`.

Tests / validation
- Unit test for `shouldKeep`: construct 72 entries over 3 days with 5-min spacing; assert the correct number survive after pruning.
- Integration: run a manual prune via endpoint and verify R2 object count drops (check with `wrangler r2 object list hermes-agent-state --prefix backups/` before and after).

Risks, tradeoffs, and open questions
- R2 cost: 5-min snapshots for 50MB = ~14,400/year, but pruning caps live storage at ~500 objects (~25GB). Monitor.
- TTL: Keep at 365 days so the SDK never rejects a restore even for weekly backups. TTL is free; storage is what costs.
- Overlap: The 5-min and 2-h cron may overlap. DO single-threading means they serialize per userID. If a prune runs while a snapshot is in progress, the index read/write is safe because the DO holds the lock.
