import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PublicHomepageResponse } from '../src/schemas/public-homepage';
import { UPSERT_FRAGMENT_SQL } from '../src/snapshots/public-fragments';
import {
  buildHomepageArtifactMonitorFragmentWrites,
  buildHomepageRenderArtifactFromMonitorFragments,
} from '../src/snapshots/public-homepage';
import {
  HOMEPAGE_ENVELOPE_FRAGMENT_KEY,
  HOMEPAGE_MONITOR_FRAGMENTS_KEY,
  buildHomepageEnvelopeFragmentWrite,
  buildHomepageMonitorFragmentWrites,
  readHomepageSnapshotBodyJsonFromFragments,
  type PublicSnapshotFragmentRow,
} from '../src/snapshots/public-monitor-fragments';
import { createFakeD1Database } from './helpers/fake-d1';

// ---------------------------------------------------------------------------
// Real-SQL coverage for the fragment UPSERT content guard.
//
// The UPSERT only rewrites a fragment row when the payload actually differs:
//   - generation advanced AND body unchanged -> skipped (0 rows written)
//   - same generation AND body unchanged     -> skipped (0 rows written)
//   - same generation AND body changed       -> written
//   - generation regressed                   -> skipped (0 rows written)
// Skipping same-content rewrites removes the ~26 fragment upserts per minute
// the sharded seed path issues even when nothing changed.
//
// Because same-content writes are skipped, a stored fragment can legitimately
// trail the envelope generation while still holding the latest body; the
// read-side tests below assert exactly that relaxed invariant.
// ---------------------------------------------------------------------------

function homepageMonitor(id: number) {
  return {
    id,
    name: `Monitor ${id}`,
    type: 'http' as const,
    display_url: null,
    group_name: 'Core',
    status: 'up' as const,
    is_stale: false,
    last_checked_at: 1_700_000_000,
    heartbeat_strip: {
      checked_at: [1_700_000_000],
      status_codes: 'u',
      latency_ms: [42],
    },
    uptime_30d: {
      uptime_pct: 100,
    },
    uptime_day_strip: {
      day_start_at: [1_699_920_000],
      downtime_sec: [0],
      unknown_sec: [0],
      uptime_pct_milli: [100_000],
    },
  };
}

function homepagePayload(): PublicHomepageResponse {
  return {
    generated_at: 1_700_000_000,
    bootstrap_mode: 'full',
    monitor_count_total: 2,
    site_title: 'Uptimer',
    site_description: '',
    site_locale: 'auto',
    site_timezone: 'UTC',
    uptime_rating_level: 4,
    overall_status: 'up',
    banner: {
      source: 'monitors',
      status: 'operational',
      title: 'All Systems Operational',
      down_ratio: null,
    },
    summary: { up: 2, down: 0, maintenance: 0, paused: 0, unknown: 0 },
    monitors: [homepageMonitor(1), homepageMonitor(2)],
    active_incidents: [],
    maintenance_windows: {
      active: [],
      upcoming: [],
    },
    resolved_incident_preview: null,
    maintenance_history_preview: null,
  } as unknown as PublicHomepageResponse;
}

function fragmentRow(row: {
  fragment_key: string;
  generated_at: number;
  body_json: string;
  updated_at: number;
}): PublicSnapshotFragmentRow {
  return row;
}

// node:sqlite cannot be a static import under vite transform; load it via
// createRequire so the module resolves at runtime against the real Node API.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): {
      run(...args: unknown[]): { changes: number | bigint };
      get(...args: unknown[]): unknown;
    };
    close(): void;
  };
};

describe('snapshots/public-fragments content guard (real SQLite)', () => {
  let db: InstanceType<typeof DatabaseSync>;

  beforeAll(() => {
    db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE public_snapshot_fragments (
        snapshot_key TEXT NOT NULL,
        fragment_key TEXT NOT NULL,
        generated_at INTEGER NOT NULL,
        body_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (snapshot_key, fragment_key)
      );
    `);
  });

  afterAll(() => {
    db.close();
  });

  function upsert(
    snapshotKey: string,
    fragmentKey: string,
    generatedAt: number,
    bodyJson: string,
    updatedAt: number,
  ): number {
    const result = db
      .prepare(UPSERT_FRAGMENT_SQL)
      .run(snapshotKey, fragmentKey, generatedAt, bodyJson, updatedAt);
    return Number(result.changes);
  }

  function row(snapshotKey: string, fragmentKey: string): PublicSnapshotFragmentRow | null {
    return (
      (db
        .prepare(
          'SELECT fragment_key, generated_at, body_json, updated_at FROM public_snapshot_fragments WHERE snapshot_key = ? AND fragment_key = ?',
        )
        .get(snapshotKey, fragmentKey) as PublicSnapshotFragmentRow | undefined) ?? null
    );
  }

  it('inserts a missing fragment on first write', () => {
    const changed = upsert('status:monitors', 'monitor:1', 100, '{"id":1}', 105);
    expect(changed).toBe(1);
    expect(row('status:monitors', 'monitor:1')).toMatchObject({
      generated_at: 100,
      body_json: '{"id":1}',
      updated_at: 105,
    });
  });

  it('skips same-generation same-body rewrites (zero rows written)', () => {
    const before = row('status:monitors', 'monitor:1');
    expect(before).not.toBeNull();
    const changed = upsert('status:monitors', 'monitor:1', 100, '{"id":1}', 999);
    expect(changed).toBe(0);
    // updated_at must not move either: the whole row stays untouched.
    expect(row('status:monitors', 'monitor:1')).toEqual(before);
  });

  it('skips advanced-generation same-body rewrites (zero rows written)', () => {
    upsert('status:monitors', 'monitor:2', 100, '{"id":2}', 105);
    const before = row('status:monitors', 'monitor:2');
    const changed = upsert('status:monitors', 'monitor:2', 200, '{"id":2}', 999);
    expect(changed).toBe(0);
    expect(row('status:monitors', 'monitor:2')).toEqual(before);
  });

  it('writes same-generation changed-body updates', () => {
    upsert('status:monitors', 'monitor:3', 100, '{"id":3}', 105);
    const changed = upsert('status:monitors', 'monitor:3', 100, '{"id":3,"r":"up"}', 110);
    expect(changed).toBe(1);
    expect(row('status:monitors', 'monitor:3')).toMatchObject({
      generated_at: 100,
      body_json: '{"id":3,"r":"up"}',
      updated_at: 110,
    });
  });

  it('writes advanced-generation changed-body updates', () => {
    upsert('status:monitors', 'monitor:5', 100, '{"id":5}', 105);
    const changed = upsert('status:monitors', 'monitor:5', 200, '{"id":5,"r":"up"}', 210);
    expect(changed).toBe(1);
    expect(row('status:monitors', 'monitor:5')).toMatchObject({
      generated_at: 200,
      body_json: '{"id":5,"r":"up"}',
      updated_at: 210,
    });
  });

  it('skips generation-regressed writes', () => {
    upsert('status:monitors', 'monitor:4', 200, '{"id":4}', 205);
    const before = row('status:monitors', 'monitor:4');
    const changed = upsert('status:monitors', 'monitor:4', 100, '{"id":4,"old":true}', 210);
    expect(changed).toBe(0);
    expect(row('status:monitors', 'monitor:4')).toEqual(before);
  });
});

describe('fragment reads accept generation-trailing monitor fragments', () => {
  const basePayload = homepagePayload();

  function buildDbRows(
    envelopeGeneratedAt: number,
    monitorGeneratedAt: number,
  ): {
    envelopeRows: PublicSnapshotFragmentRow[];
    monitorRows: PublicSnapshotFragmentRow[];
  } {
    const envelope = buildHomepageEnvelopeFragmentWrite(
      { ...basePayload, generated_at: envelopeGeneratedAt },
      envelopeGeneratedAt,
    );
    const monitorWrites = buildHomepageMonitorFragmentWrites(
      { ...basePayload, generated_at: envelopeGeneratedAt },
      monitorGeneratedAt,
    );
    return {
      envelopeRows: [
        fragmentRow({
          fragment_key: envelope.fragmentKey,
          generated_at: envelope.generatedAt,
          body_json: envelope.bodyJson,
          updated_at: envelope.updatedAt,
        }),
      ],
      monitorRows: monitorWrites.map((write) =>
        fragmentRow({
          fragment_key: write.fragmentKey,
          generated_at: monitorGeneratedAt,
          body_json: write.bodyJson,
          updated_at: write.updatedAt,
        }),
      ),
    };
  }

  function createDb(rows: {
    envelopeRows: PublicSnapshotFragmentRow[];
    monitorRows: PublicSnapshotFragmentRow[];
  }) {
    return createFakeD1Database([
      {
        match: 'from public_snapshot_fragments',
        all: (args: unknown[]) => {
          if (args[0] === HOMEPAGE_ENVELOPE_FRAGMENT_KEY) {
            return rows.envelopeRows;
          }
          if (args[0] === HOMEPAGE_MONITOR_FRAGMENTS_KEY) {
            return rows.monitorRows;
          }
          return [];
        },
      },
    ]);
  }

  it('still assembles when monitor fragments trail the envelope generation', async () => {
    // Envelope advanced (e.g. to 200) while monitor bodies were unchanged, so
    // the content guard skipped their rewrites at generation 100. The stored
    // bodies are still the latest content, so assembly must succeed with no
    // stale rows.
    const db = createDb(buildDbRows(200, 100));
    const result = await readHomepageSnapshotBodyJsonFromFragments(db);
    expect(result).not.toBeNull();
    expect(result?.staleCount).toBe(0);
    expect(result?.invalidCount).toBe(0);
    expect(result?.monitorCount).toBe(basePayload.monitors.length);
  });

  it('reports stale when a monitor fragment is newer than the envelope', async () => {
    // A monitor fragment newer than the envelope cannot be reconciled: the
    // envelope does not know about that later generation, so assembly must
    // fail so the caller falls back to a fresh compute.
    const db = createDb(buildDbRows(100, 200));
    const result = await readHomepageSnapshotBodyJsonFromFragments(db);
    expect(result).toBeNull();
  });
});

describe('homepage artifact fragments accept generation-trailing rows', () => {
  const basePayload = homepagePayload();

  function buildRows(monitorGeneratedAt: number): PublicSnapshotFragmentRow[] {
    return buildHomepageArtifactMonitorFragmentWrites(basePayload, monitorGeneratedAt).map(
      (write) =>
        fragmentRow({
          fragment_key: write.fragmentKey,
          generated_at: monitorGeneratedAt,
          body_json: write.bodyJson,
          updated_at: write.updatedAt,
        }),
    );
  }

  it('builds the artifact from fragments that trail the payload generation', () => {
    // Payload generation advanced (190 -> 200) but the artifact monitor bodies
    // were unchanged, so their rewrites were skipped by the content guard.
    // The stored pre-rendered cards are still valid for the new payload.
    const rows = buildRows(190);
    const result = buildHomepageRenderArtifactFromMonitorFragments(
      { ...basePayload, generated_at: 200 },
      rows,
    );
    expect(result.missingCount).toBe(0);
    expect(result.staleCount).toBe(0);
    expect(result.invalidCount).toBe(0);
    expect(result.artifact?.snapshot.generated_at).toBe(200);
  });

  it('still reports stale for fragments newer than the payload', () => {
    const rows = buildRows(300);
    const result = buildHomepageRenderArtifactFromMonitorFragments(
      { ...basePayload, generated_at: 200 },
      rows,
    );
    expect(result.staleCount).toBeGreaterThan(0);
    expect(result.artifact).toBeNull();
  });
});
