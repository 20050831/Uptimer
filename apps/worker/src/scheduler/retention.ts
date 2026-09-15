import type { Env } from '../env';

import { readSettings } from '../settings';
import { acquireLease } from './lock';

const LOCK_NAME = 'retention:check_results';
const LOCK_LEASE_SECONDS = 10 * 60;

// Harvest ids in bounded batches so each SQLite statement stays small.
// 1000 keeps a single SELECT + group DELETE under D1's 100-bound-parameter
// ceiling without splitting (1000 ids / 100 params = 10 statements/batch).
const SELECT_BATCH_SIZE = 1_000;
// D1 allows at most 100 bound parameters per statement.
const DELETE_PARAM_LIMIT = 100;

// Hard ceiling per scheduled run. Retention fires once per day (00:30 UTC via
// the consolidated minute cron), so this is also the per-day ceiling.
// Budget: Free Plan grants 100K rows written/day; the steady-state inflow is
// ~11.5K check rows/day (8 monitors x 1 check/min), so deleting 15K rows/day
// always outpaces inflow and drains any backlog across multiple days while
// never spending more than ~30% of the daily write budget on retention.
const MAX_ROWS_PER_RUN = 15_000;

export async function runRetention(env: Env, controller: ScheduledController): Promise<void> {
  const now = Math.floor((controller.scheduledTime ?? Date.now()) / 1000);

  const acquired = await acquireLease(env.DB, LOCK_NAME, now, LOCK_LEASE_SECONDS);
  if (!acquired) return;

  const settings = await readSettings(env.DB);
  const retentionDays = settings.retention_check_results_days;

  const cutoff = now - retentionDays * 86400;
  if (!Number.isFinite(cutoff) || cutoff <= 0) return;

  let totalDeleted = 0;

  // Two-step delete: (1) harvest the oldest ids for this batch via the covering
  // index (reads only the returned rows), (2) delete them grouped into
  // statements of <= 100 bound parameters. Two steps instead of a single
  // `DELETE ... WHERE id IN (subquery)` keeps the harvest covered by
  // idx_check_results_checked_at_id and the delete a pure rowid lookup.
  while (totalDeleted < MAX_ROWS_PER_RUN) {
    const remainingBudget = Math.min(SELECT_BATCH_SIZE, MAX_ROWS_PER_RUN - totalDeleted);
    if (remainingBudget <= 0) break;

    const { results } = await env.DB.prepare(
      `
        SELECT id
        FROM check_results
        WHERE checked_at < ?1
        ORDER BY checked_at
        LIMIT ?2
      `,
    )
      .bind(cutoff, remainingBudget)
      .all<{ id: number }>();

    const ids = (results ?? []).map((row) => row.id);
    if (ids.length === 0) break;

    for (let offset = 0; offset < ids.length; offset += DELETE_PARAM_LIMIT) {
      const chunk = ids.slice(offset, offset + DELETE_PARAM_LIMIT);
      if (chunk.length === 0) continue;

      const placeholders = chunk.map(() => '?').join(', ');
      await env.DB.prepare(`DELETE FROM check_results WHERE id IN (${placeholders})`)
        .bind(...chunk)
        .run();
    }

    totalDeleted += ids.length;

    // Last harvest underfilled the batch: nothing older than the cutoff is
    // left, so stop instead of issuing another SELECT.
    if (ids.length < remainingBudget) break;
  }

  console.log(`retention: deleted=${totalDeleted} cutoff=${cutoff} days=${retentionDays}`);
}
