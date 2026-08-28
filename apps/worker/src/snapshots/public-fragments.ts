export const UPSERT_FRAGMENT_SQL = `
  INSERT INTO public_snapshot_fragments (
    snapshot_key,
    fragment_key,
    generated_at,
    body_json,
    updated_at
  )
  VALUES (?1, ?2, ?3, ?4, ?5)
  ON CONFLICT(snapshot_key, fragment_key) DO UPDATE SET
    generated_at = excluded.generated_at,
    body_json = excluded.body_json,
    updated_at = excluded.updated_at
  WHERE excluded.generated_at >= public_snapshot_fragments.generated_at
    AND excluded.body_json IS NOT public_snapshot_fragments.body_json
`;

const READ_FRAGMENTS_SQL = `
  SELECT fragment_key, generated_at, body_json, updated_at
  FROM public_snapshot_fragments
  WHERE snapshot_key = ?1
  ORDER BY fragment_key
`;

const READ_FRAGMENTS_PAGE_SQL = `
  SELECT fragment_key, generated_at, body_json, updated_at
  FROM public_snapshot_fragments
  WHERE snapshot_key = ?1
  ORDER BY fragment_key
  LIMIT ?2 OFFSET ?3
`;

const upsertFragmentStatementByDb = new WeakMap<D1Database, D1PreparedStatement>();
const readFragmentsStatementByDb = new WeakMap<D1Database, D1PreparedStatement>();
const readFragmentsPageStatementByDb = new WeakMap<D1Database, D1PreparedStatement>();

export type PublicSnapshotFragmentWrite = {
  snapshotKey: string;
  fragmentKey: string;
  generatedAt: number;
  bodyJson: string;
  updatedAt: number;
};

export type PublicSnapshotFragmentRow = {
  fragment_key: string;
  generated_at: number;
  body_json: string;
  updated_at: number | null;
};

function assertFragmentText(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new Error(`public snapshot fragment ${label} must not be empty`);
  }
}

function assertFiniteTimestamp(value: number, label: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(`public snapshot fragment ${label} must be a non-negative integer`);
  }
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(`public snapshot fragment ${label} must be a non-negative integer`);
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`public snapshot fragment ${label} must be a positive integer`);
  }
}

export function preparePublicSnapshotFragmentWrite(
  db: D1Database,
  fragment: PublicSnapshotFragmentWrite,
): D1PreparedStatement {
  assertFragmentText(fragment.snapshotKey, 'snapshotKey');
  assertFragmentText(fragment.fragmentKey, 'fragmentKey');
  assertFragmentText(fragment.bodyJson, 'bodyJson');
  assertFiniteTimestamp(fragment.generatedAt, 'generatedAt');
  assertFiniteTimestamp(fragment.updatedAt, 'updatedAt');

  const cached = upsertFragmentStatementByDb.get(db);
  const statement = cached ?? db.prepare(UPSERT_FRAGMENT_SQL);
  if (!cached) {
    upsertFragmentStatementByDb.set(db, statement);
  }

  return statement.bind(
    fragment.snapshotKey,
    fragment.fragmentKey,
    fragment.generatedAt,
    fragment.bodyJson,
    fragment.updatedAt,
  );
}

export async function writePublicSnapshotFragments(
  db: D1Database,
  fragments: PublicSnapshotFragmentWrite[],
): Promise<D1Result[]> {
  if (fragments.length === 0) {
    return [];
  }

  const statements = fragments.map((fragment) => preparePublicSnapshotFragmentWrite(db, fragment));
  return await db.batch(statements);
}

export async function readPublicSnapshotFragments(
  db: D1Database,
  snapshotKey: string,
): Promise<PublicSnapshotFragmentRow[]> {
  assertFragmentText(snapshotKey, 'snapshotKey');

  const cached = readFragmentsStatementByDb.get(db);
  const statement = cached ?? db.prepare(READ_FRAGMENTS_SQL);
  if (!cached) {
    readFragmentsStatementByDb.set(db, statement);
  }

  const { results } = await statement.bind(snapshotKey).all<PublicSnapshotFragmentRow>();
  return results ?? [];
}

export async function readPublicSnapshotFragmentsPage(
  db: D1Database,
  snapshotKey: string,
  opts: { offset: number; limit: number },
): Promise<PublicSnapshotFragmentRow[]> {
  assertFragmentText(snapshotKey, 'snapshotKey');
  assertNonNegativeInteger(opts.offset, 'offset');
  assertPositiveInteger(opts.limit, 'limit');

  const cached = readFragmentsPageStatementByDb.get(db);
  const statement = cached ?? db.prepare(READ_FRAGMENTS_PAGE_SQL);
  if (!cached) {
    readFragmentsPageStatementByDb.set(db, statement);
  }

  const { results } = await statement
    .bind(snapshotKey, opts.limit, opts.offset)
    .all<PublicSnapshotFragmentRow>();
  return results ?? [];
}
