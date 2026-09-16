Goal
Make the pruning system the single source of truth for backup retention by adding a reconcile step that scrubs both orphaned R2 objects and phantom index entries before applying retention rules.

Current context / assumptions
- `backups-index.json` is an index of all backups the Worker knows about.
- R2 blobs (backups/<id>/data.sqsh and meta.json) can be orphaned if:
  a) Worker crash between `createSnapshot()` and index write
  b) Manual deletion outside the Worker
  c) R2 object deletion with stale index
- `pruneSnapshots()` only deletes entries present in the index. Orphaned R2 objects outside the index are never cleaned.
- The index can also contain phantom entries where the R2 objects are already gone (user manually deleted).

Architecture / proposed approach
Every prune pass (every 2-hour cron tick) runs three phases in order:
1. **Reconcile**: scan R2 `backups/` prefix and compare with `backups-index.json`. Remove phantom index entries and delete orphaned R2 objects not in the index.
2. **Retention**: run the gap-based `shouldKeep()` against the cleaned index.
3. **Cleanup**: delete R2 objects and rewrite `backups-index.json`.

Step-by-step tasks

Task 1: Add reconcile helper to `src/persistence.ts`
Insert after `getIndex()` / `putIndex()` and before `restoreLatest()`:

```typescript
/**
 * Reconcile the index against actual R2 objects.
 * Fixes two drift scenarios:
 *   1. Index has an entry but R2 objects are gone → remove from index.
 *   2. R2 has objects for a backup ID not in the index → delete R2 objects.
 */
export async function reconcileBackups(
  bucket: R2Bucket,
  userId: string,
): Promise<{ indexRemoved: number; r2Deleted: number }> {
  const keys = keysFor(userId);
  const index = await getIndex(bucket, keys.index);
  const indexIds = new Set(index.map((e) => e.id));

  // Phase 1: Remove phantom index entries (R2 objects missing)
  const r2Objects = await bucket.list({ prefix: "backups/" });
  const r2Ids = new Set<string>();
  for (const obj of r2Objects.objects || []) {
    const match = obj.key.match(/^backups\/([a-f0-9-]+)\//);
    if (match) r2Ids.add(match[1]);
  }

  const presentInR2 = new Set<string>();
  for (const id of indexIds) {
    if (r2Ids.has(id)) {
      presentInR2.add(id);
    }
  }
  const phantomEntries = index.filter((e) => !presentInR2.has(e.id));
  const cleanedIndex = index.filter((e) => presentInR2.has(e.id));
  if (phantomEntries.length > 0) {
    console.log(`[reconcile:${userId}] dropping ${phantomEntries.length} phantom entries`);
    await putIndex(bucket, keys.index, cleanedIndex);
  }

  // Phase 2: Delete orphaned R2 objects (not referenced by any index entry)
  const orphanedIds = [...r2Ids].filter((id) => !indexIds.has(id));
  for (const id of orphanedIds) {
    console.log(`[reconcile:${userId}] deleting orphaned R2 objects for ${id}`);
    await bucket.delete(`backups/${id}/data.sqsh`);
    await bucket.delete(`backups/${id}/meta.json`);
  }

  return { indexRemoved: phantomEntries.length, r2Deleted: orphanedIds.length };
}
```

Task 2: Call reconcile from `pruneSnapshots()`
Replace the top of `pruneSnapshots()`:

```typescript
export async function pruneSnapshots(
  bucket: R2Bucket,
  userId: string,
): Promise<{ kept: number; deleted: number; indexRemoved: number; r2Deleted: number }> {
  const keys = keysFor(userId);
  const { indexRemoved, r2Deleted } = await reconcileBackups(bucket, userId);

  const index = await getIndex(bucket, keys.index);
  if (index.length === 0) return { kept: 0, deleted: 0, indexRemoved, r2Deleted };

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

  const newest = sorted[0];
  if (toDelete.some((d) => d.id === newest.id)) {
    toDelete.splice(toDelete.findIndex((d) => d.id === newest.id), 1);
    if (!keepIds.has(newest.id)) toKeep.unshift(newest);
  }

  for (const entry of toDelete) {
    console.log(`[prune:${userId}] deleting backup ${entry.id}`);
    await bucket.delete(`backups/${entry.id}/data.sqsh`);
    await bucket.delete(`backups/${entry.id}/meta.json`);
  }

  const keptAsc = [...toKeep].sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt));
  await putIndex(bucket, keys.index, keptAsc);
  return { kept: toKeep.length, deleted: toDelete.length, indexRemoved, r2Deleted };
}
```

Task 3: Add admin reconcile endpoint (optional, ops)
File: `src/index.ts`, insert before `// Admin: check container state` (around line 489):

```typescript
// Admin: manual reconcile pass (ops / validation)
app.post("/api/admin/reconcile", async (c) => {
  const userId = c.req.query("userId");
  if (!userId) return c.json({ error: "Missing userId" }, 400);
  const t0 = Date.now();
  try {
    const { indexRemoved, r2Deleted } = await reconcileBackups(c.env.BACKUP_BUCKET, userId);
    return c.json({ userId, indexRemoved, r2Deleted, duration_ms: Date.now() - t0 });
  } catch (e: any) {
    return c.json({ userId, error: e?.message || String(e), duration_ms: Date.now() - t0 }, 500);
  }
});
```

Task 4: Wire dual-cron schedule if not already done
File: `wrangler.jsonc`
Ensure triggers block reads:
```json
"triggers": {
  "crons": ["*/5 * * * *", "0 */2 * * *"]
}
```

Task 5: Update scheduled() handler to run prune on the 2h cron
File: `src/index.ts`
Dispatch by cron string:
```typescript
  async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    const users = await listActiveUsers(env.BACKUP_BUCKET);
    if (event.cron === "0 */2 * * *") {
      for (const userId of users) {
        const sandbox: any = getSandboxAny(env.Sandbox, userId);
        try {
          await createSnapshot(sandbox, env.BACKUP_BUCKET, userId);
        } catch (e: any) {
          console.error(`[cron:snapshot] ${userId}: ${e.message}`);
        }
      }
    } else if (event.cron === "0 */2 * * *") {
      // This is the prune cron
      for (const userId of users) {
        try {
          const { kept, deleted, indexRemoved, r2Deleted } = await pruneSnapshots(env.BACKUP_BUCKET, userId);
          console.log(`[cron:prune] ${userId}: deleted=${deleted}, kept=${kept}, indexRemoved=${indexRemoved}, r2Deleted=${r2Deleted}`);
        } catch (e: any) {
          console.error(`[cron:prune] ${userId}: ${e.message}`);
        }
      }
    }
  }
```

(Note: if both crons use the same pattern string, disambiguate with a second ScheduledEvent handler or a single handler that checks `event.scheduledTime`. The plan above assumes separate cron strings; if they're the same, use a persistent counter in DO storage to decide snapshot-vs-prune.)

Task 6: Deploy and verify
```bash
cd ~/projects/hermes-cloudflare-v6 && npx wrangler deploy --containers-rollout=none
```

Verify reconcile endpoint:
```bash
curl -s -X POST "https://hermes-agent.hermes-test.app/api/admin/reconcile?userId=<user-id>" \
  -H "Authorization: Bearer ***"
```
Expected: `{ "userId": "<user-id>", "indexRemoved": 0, "r2Deleted": 0 }` if no drift.

Tests / validation
- Manual drift test: delete one R2 object via `wrangler r2 object delete` directly, then call reconcile endpoint. Expect `indexRemoved: 1`.
- Manual orphan test: upload a fake `backups/fake-id/data.sqsh` via `wrangler r2 object put`, then call reconcile. Expect `r2Deleted: 1`.

Risks, tradeoffs, and open questions
- `bucket.list({ prefix: "backups/" })` is not user-scoped. A user with thousands of backups across many users could see slow listings. If R2 doesn't support filtering by user inside the prefix, gardener needs paging or a per-user object prefix redesign.
- Concurrent snapshot + prune: DO single-threading handles serialization per user, but a long reconcile+prune pass could delay a wake response by seconds. If this becomes a problem, move pruning to a background alarm instead of the fetch path.
