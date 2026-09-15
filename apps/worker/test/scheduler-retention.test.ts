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

function createEnv(handlers: FakeD1QueryHandler[]): Env {
  return { DB: createFakeD1Database(handlers) } as unknown as Env;
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

describe('scheduler/retention', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-18T00:00:00.000Z'));
    vi.mocked(acquireLease).mockResolvedValue(true);
    vi.mocked(readSettings).mockResolvedValue(baseSettings() as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('skips deletion when lease is not acquired', async () => {
    vi.mocked(acquireLease).mockResolvedValue(false);
    const runCalls: unknown[][] = [];
    const env = createEnv([
      {
        match: 'delete from check_results',
        run: (args) => {
          runCalls.push(args);
          return { meta: { changes: 0 } };
        },
      },
    ]);

    await runRetention(env, { scheduledTime: Date.now() } as ScheduledController);

    expect(readSettings).not.toHaveBeenCalled();
    expect(runCalls).toHaveLength(0);
  });

  it('harvests ids in batches and deletes them in <=100-param statements until drained', async () => {
    const harvestSizes = [1000, 1000, 120];
    const selects: unknown[][] = [];
    const deletes: Array<{ args: unknown[]; sql: string }> = [];
    let idCounter = 0;

    const env = createEnv([
      {
        match: 'select id',
        all: (args) => {
          selects.push(args);
          const size = harvestSizes.shift() ?? 0;
          const rows: Array<{ id: number }> = [];
          for (let i = 0; i < size; i++) {
            rows.push({ id: ++idCounter });
          }
          return rows;
        },
      },
      {
        match: 'delete from check_results',
        run: (args, sql) => {
          deletes.push({ args: [...args], sql });
          return { meta: { changes: args.length } };
        },
      },
    ]);

    const scheduledTime = Date.UTC(2026, 1, 18, 0, 30, 0);
    await runRetention(env, { scheduledTime } as ScheduledController);

    expect(acquireLease).toHaveBeenCalledWith(
      env.DB,
      'retention:check_results',
      Math.floor(scheduledTime / 1000),
      600,
    );
    expect(readSettings).toHaveBeenCalledTimes(1);

    // 2120 stale ids harvested over three SELECTs (third underfilled => stop).
    expect(selects).toHaveLength(3);
    // Batch size is always SELECT_BATCH_SIZE (1000).
    expect(selects[0]?.[1]).toBe(1000);
    expect(selects[1]?.[1]).toBe(1000);
    expect(selects[2]?.[1]).toBe(1000);

    // Deletes are grouped into statements of at most 100 bound parameters.
    expect(deletes.length).toBe(22); // 1000 => 10, 1000 => 10, 120 => 2
    for (const del of deletes) {
      expect(del.args.length).toBeGreaterThan(0);
      expect(del.args.length).toBeLessThanOrEqual(100);
    }
    const deletedTotal = deletes.reduce((sum, del) => sum + del.args.length, 0);
    expect(deletedTotal).toBe(2120);
  });

  it('stops at the per-run hard cap even when more stale rows remain', async () => {
    const selects: unknown[][] = [];
    const deletes: Array<{ args: unknown[] }> = [];
    let idCounter = 0;
    // Always-full harvests: the run must stop after MAX_ROWS_PER_RUN (15000)
    // instead of draining indefinitely.
    const harvest = () => {
      const rows: Array<{ id: number }> = [];
      for (let i = 0; i < 1000; i++) {
        rows.push({ id: ++idCounter });
      }
      return rows;
    };

    const env = createEnv([
      {
        match: 'select id',
        all: (args) => {
          selects.push(args);
          return harvest();
        },
      },
      {
        match: 'delete from check_results',
        run: (args) => {
          deletes.push({ args: [...args] });
          return { meta: { changes: args.length } };
        },
      },
    ]);

    await runRetention(env, {
      scheduledTime: Date.UTC(2026, 1, 18, 0, 30, 0),
    } as ScheduledController);

    expect(selects).toHaveLength(15);
    const deletedTotal = deletes.reduce((sum, del) => sum + del.args.length, 0);
    expect(deletedTotal).toBe(15_000);
  });

  it('guards against invalid cutoffs', async () => {
    vi.mocked(readSettings).mockResolvedValue(
      baseSettings({ retention_check_results_days: Number.POSITIVE_INFINITY }) as never,
    );

    const runCalls: unknown[][] = [];
    const env = createEnv([
      {
        match: 'delete from check_results',
        run: (args) => {
          runCalls.push(args);
          return { meta: { changes: 0 } };
        },
      },
    ]);

    await runRetention(env, { scheduledTime: 1 } as ScheduledController);
    expect(runCalls).toHaveLength(0);
  });
});
