import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/scheduler/lock', () => ({
  acquireLease: vi.fn(),
}));
vi.mock('../src/settings', () => ({
  readSettings: vi.fn(),
}));

import type { Env } from '../src/env';
import { readSettings } from '../src/settings';
import { acquireLease } from '../src/scheduler/lock';
import { runRetention } from '../src/scheduler/retention';
import { createFakeD1Database, type FakeD1QueryHandler } from './helpers/fake-d1';

// node:sqlite cannot be a static import under vite transform; load it via
// createRequire so the module resolves at runtime against the real Node API.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

// CI pins Node 22.14, whose node:sqlite positional binding rejects numbered
// "?N" placeholders with "column index out of range". Every parameter in the
// statements below appears exactly once and in order, so rewriting to
// anonymous "?" preserves semantics for testing purposes.
function toAnonymousParameterSql(sql: string): string {
  return sql.replace(/\?(\d+)/g, '?');
}

function baseSettings(overrides: Record<string, unknown> = {}) {
  return {
    site_title: 'Uptimer',
    site_description: '',
    site_locale: 'auto',
    site_timezone: 'UTC',
    retention_check_results_days: 7,
    state_failures_to_down_from_up: 2,
    state_successes_to_up_from_down: 2,
    admin_default_overview_range: '24h',
    admin_default_monitor_range: '24h',
    uptime_rating_level: 3,
    ...overrides,
  };
}

describe('scheduler/retention integration (node:sqlite)', () => {
  let db: InstanceType<typeof DatabaseSync>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-18T00:30:00.000Z'));
    vi.mocked(acquireLease).mockResolvedValue(true);
    vi.mocked(readSettings).mockResolvedValue(baseSettings() as never);

    db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE check_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        monitor_id INTEGER NOT NULL,
        checked_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('up', 'down', 'maintenance', 'unknown')),
        latency_ms INTEGER,
        http_status INTEGER,
        error TEXT,
        location TEXT,
        attempt INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX idx_check_results_monitor_time ON check_results(monitor_id, checked_at);
      CREATE INDEX idx_check_results_checked_at_id ON check_results(checked_at, id);
    `);
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  function seed(checkedAts: number[]): void {
    const insert = db.prepare(
      'INSERT INTO check_results (monitor_id, checked_at, status) VALUES (?, ?, ?)',
    );
    for (const checkedAt of checkedAts) {
      insert.run(1, checkedAt, 'up');
    }
  }

  function remainingCheckedAts(): number[] {
    const rows = db
      .prepare('SELECT checked_at FROM check_results ORDER BY checked_at')
      .all() as Array<{ checked_at: number }>;
    return rows.map((row) => row.checked_at);
  }

  // Routes every D1 statement to the real node:sqlite database while
  // recording the SQL + args so tests can assert on statement shape.
  function createSqliteBackedEnv(): {
    env: Env;
    statements: Array<{ sql: string; args: unknown[] }>;
  } {
    const statements: Array<{ sql: string; args: unknown[] }> = [];

    const handler: FakeD1QueryHandler = {
      match: () => true,
      all: (args, sql) => {
        statements.push({ sql, args: [...args] });
        return db.prepare(toAnonymousParameterSql(sql)).all(...(args as unknown[])) as unknown[];
      },
      run: (args, sql) => {
        statements.push({ sql, args: [...args] });
        const result = db.prepare(toAnonymousParameterSql(sql)).run(...(args as unknown[]));
        return { meta: { changes: result.changes } };
      },
    };

    return {
      env: { DB: createFakeD1Database([handler]) } as unknown as Env,
      statements,
    };
  }

  it('deletes only rows older than the cutoff and keeps newer rows', async () => {
    const scheduledTime = Date.UTC(2026, 1, 18, 0, 30, 0);
    const now = Math.floor(scheduledTime / 1000);
    const cutoff = now - 7 * 86400;

    seed([cutoff - 300, cutoff - 200, cutoff - 100, cutoff, cutoff + 100, cutoff + 200]);

    const { env } = createSqliteBackedEnv();
    await runRetention(env, { scheduledTime } as ScheduledController);

    expect(remainingCheckedAts()).toEqual([cutoff, cutoff + 100, cutoff + 200]);
  });

  it('deletes oldest-first in batches and stops early once the backlog is drained', async () => {
    const scheduledTime = Date.UTC(2026, 1, 18, 0, 30, 0);
    const now = Math.floor(scheduledTime / 1000);
    const cutoff = now - 7 * 86400;

    // 2500 stale rows: first harvest returns 1000, second 1000, third 500
    // (underfilled => stop without a fourth SELECT).
    const stale: number[] = [];
    for (let i = 0; i < 2500; i++) {
      stale.push(cutoff - 5000 + i);
    }
    seed(stale);
    seed([cutoff + 10]);

    const { env, statements } = createSqliteBackedEnv();
    await runRetention(env, { scheduledTime } as ScheduledController);

    expect(remainingCheckedAts()).toEqual([cutoff + 10]);
    const selects = statements.filter((s) => s.sql.includes('select id'));
    expect(selects).toHaveLength(3);
    // All delete statements stay within the 100 bound-parameter ceiling.
    const deletes = statements.filter((s) => s.sql.includes('delete from check_results'));
    expect(deletes.length).toBeGreaterThan(0);
    for (const del of deletes) {
      expect(del.args.length).toBeLessThanOrEqual(100);
    }
  });

  it('enforces the per-run hard cap and leaves the remaining backlog for later runs', async () => {
    const scheduledTime = Date.UTC(2026, 1, 18, 0, 30, 0);
    const now = Math.floor(scheduledTime / 1000);
    const cutoff = now - 7 * 86400;

    // 60_000 stale rows: the run must stop at MAX_ROWS_PER_RUN (15_000) and
    // leave 45_000 behind for subsequent daily runs.
    const stale: number[] = [];
    for (let i = 0; i < 60_000; i++) {
      stale.push(cutoff - 100_000 + i);
    }
    seed(stale);

    const { env } = createSqliteBackedEnv();
    await runRetention(env, { scheduledTime } as ScheduledController);

    const remaining = db.prepare('SELECT COUNT(*) AS c FROM check_results').get() as {
      c: number;
    };
    expect(remaining.c).toBe(45_000);
  });

  it('harvests ids via the (checked_at, id) covering index per EXPLAIN QUERY PLAN', () => {
    // Exact statement shape used by runRetention.
    const sql = `
      SELECT id
      FROM check_results
      WHERE checked_at < ?1
      ORDER BY checked_at
      LIMIT ?2
    `;
    const plan = db.prepare(toAnonymousParameterSql('EXPLAIN QUERY PLAN ' + sql)).all() as Array<{
      detail: string;
    }>;
    const joined = plan.map((row) => row.detail).join(' | ');
    expect(joined).toContain('COVERING INDEX idx_check_results_checked_at_id');
    // The old plan (before this migration) scanned idx_check_results_monitor_time.
    expect(joined).not.toContain('idx_check_results_monitor_time');
  });

  it('skips all queries when the lease is not acquired', async () => {
    vi.mocked(acquireLease).mockResolvedValue(false);
    const { env, statements } = createSqliteBackedEnv();

    await runRetention(env, { scheduledTime: Date.now() } as ScheduledController);

    expect(statements).toHaveLength(0);
    expect(readSettings).not.toHaveBeenCalled();
  });
});
