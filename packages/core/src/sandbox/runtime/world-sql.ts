/**
 * SQL preamble installed into every job "world" database BEFORE the customer's DDL, plus helpers for
 * the frozen clock, the tool outbox and row-level state diffing. Everything sandbox-owned is named
 * `sandbox_*` and is excluded from snapshots/diffs.
 *
 * Diff model: `sandbox_snapshot_baseline()` records every tracked row (pk + md5 of its jsonb form);
 * `sandbox_refresh_diff()` full-joins current rows against that baseline into `sandbox_diff`.
 * Tables without a primary key get a synthetic pk (row hash + ordinal among identical rows).
 */
import type { SqlConn } from "./types";
import type { StateDiff } from "../spec";

export const WORLD_PREAMBLE_SQL: string = String.raw`
CREATE TABLE IF NOT EXISTS sandbox_clock (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  frozen_now timestamptz NOT NULL
);

-- Returns the frozen time (NULL when the clock row was never set: tools must set it via sandbox_clock).
CREATE OR REPLACE FUNCTION sandbox_now() RETURNS timestamptz
LANGUAGE sql STABLE AS $$ SELECT frozen_now FROM sandbox_clock WHERE id = 1 $$;

CREATE TABLE IF NOT EXISTS sandbox_outbox (
  id bigserial PRIMARY KEY,
  tool text NOT NULL,
  args jsonb,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT sandbox_now()
);

CREATE TABLE IF NOT EXISTS sandbox_baseline (
  table_name text,
  pk jsonb,
  row_hash text,
  row_data jsonb
);
CREATE INDEX IF NOT EXISTS sandbox_baseline_table_pk_idx ON sandbox_baseline (table_name, pk);

CREATE TABLE IF NOT EXISTS sandbox_diff (
  table_name text,
  pk jsonb,
  change text CHECK (change IN ('inserted','updated','deleted')),
  before jsonb,
  after jsonb
);

CREATE OR REPLACE VIEW sandbox_diff_summary AS
SELECT table_name,
       (count(*) FILTER (WHERE change = 'inserted'))::int AS inserted,
       (count(*) FILTER (WHERE change = 'updated'))::int AS updated,
       (count(*) FILTER (WHERE change = 'deleted'))::int AS deleted
FROM sandbox_diff
GROUP BY table_name;

-- Tracked tables: ordinary/partitioned, non-partition, non-system, non-sandbox. pk_expr = '' when no PK.
CREATE OR REPLACE FUNCTION sandbox_tracked_tables()
RETURNS TABLE (t_name text, t_qname text, t_pk_expr text)
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN n.nspname = 'public' THEN c.relname::text ELSE n.nspname::text || '.' || c.relname::text END,
         format('%I.%I', n.nspname, c.relname),
         coalesce((
           SELECT string_agg(format('%L::text, x.%I', a.attname, a.attname), ', ' ORDER BY k.ord)
           FROM pg_index i
           CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
           WHERE i.indrelid = c.oid AND i.indisprimary
         ), '')
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p')
    AND NOT c.relispartition
    AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND n.nspname NOT LIKE 'pg\_%'
    AND c.relname NOT LIKE 'sandbox\_%'
  ORDER BY 1
$$;

-- SELECT producing (pk jsonb, h text, d jsonb) for one table.
CREATE OR REPLACE FUNCTION sandbox_rows_sql(qname text, pk_expr text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT format(
    'SELECT %s AS pk, md5(to_jsonb(x)::text) AS h, to_jsonb(x) AS d FROM %s x',
    CASE WHEN pk_expr = ''
      THEN 'jsonb_build_object(''_row'', md5(to_jsonb(x)::text), ''_n'', row_number() OVER (PARTITION BY md5(to_jsonb(x)::text)))'
      ELSE 'jsonb_build_object(' || pk_expr || ')' END,
    qname)
$$;

CREATE OR REPLACE FUNCTION sandbox_snapshot_baseline() RETURNS void
LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  TRUNCATE sandbox_baseline;
  FOR r IN SELECT * FROM sandbox_tracked_tables() LOOP
    EXECUTE format(
      'INSERT INTO sandbox_baseline (table_name, pk, row_hash, row_data) SELECT %L, q.pk, q.h, q.d FROM (%s) q',
      r.t_name, sandbox_rows_sql(r.t_qname, r.t_pk_expr));
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION sandbox_refresh_diff() RETURNS void
LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  TRUNCATE sandbox_diff;
  FOR r IN SELECT * FROM sandbox_tracked_tables() LOOP
    EXECUTE format(
      $f$INSERT INTO sandbox_diff (table_name, pk, change, before, after)
         SELECT %L, coalesce(c.pk, b.pk),
                CASE WHEN b.pk IS NULL THEN 'inserted' WHEN c.pk IS NULL THEN 'deleted' ELSE 'updated' END,
                b.row_data, c.d
         FROM (%s) c
         FULL JOIN (SELECT pk, row_hash, row_data FROM sandbox_baseline WHERE table_name = %L) b ON c.pk = b.pk
         WHERE b.pk IS NULL OR c.pk IS NULL OR c.h <> b.row_hash$f$,
      r.t_name, sandbox_rows_sql(r.t_qname, r.t_pk_expr), r.t_name);
  END LOOP;
  -- tables that existed at baseline time but are gone now: every baseline row is deleted
  INSERT INTO sandbox_diff (table_name, pk, change, before, after)
  SELECT b.table_name, b.pk, 'deleted', b.row_data, NULL
  FROM sandbox_baseline b
  WHERE b.table_name NOT IN (SELECT t_name FROM sandbox_tracked_tables());
END $$;
`;

/** Parameterized upsert of the single clock row. */
export function clockSql(frozenNow: string): { text: string; values: unknown[] } {
  return {
    text:
      "INSERT INTO sandbox_clock (id, frozen_now) VALUES (1, $1::timestamptz) " +
      "ON CONFLICT (id) DO UPDATE SET frozen_now = EXCLUDED.frozen_now",
    values: [frozenNow],
  };
}

export async function snapshotBaseline(conn: SqlConn): Promise<void> {
  await conn.query("SELECT sandbox_snapshot_baseline()");
}

export async function refreshDiff(conn: SqlConn): Promise<void> {
  await conn.query("SELECT sandbox_refresh_diff()");
}

const DEFAULT_SAMPLE_SIZE = 5;

/** Reads sandbox_diff (call refreshDiff first). Only tables with changes, sorted by table name. */
export async function readDiff(conn: SqlConn, opts: { sampleSize?: number } = {}): Promise<StateDiff[]> {
  const sampleSize = Math.max(0, Math.floor(opts.sampleSize ?? DEFAULT_SAMPLE_SIZE));
  const counts = await conn.query<{ table_name: string; inserted: number | string; updated: number | string; deleted: number | string }>(
    "SELECT table_name, inserted, updated, deleted FROM sandbox_diff_summary ORDER BY table_name",
  );
  const samples = await conn.query<{ table_name: string; change: string; pk: unknown; before: unknown; after: unknown }>(
    `SELECT table_name, change, pk, "before", "after" FROM (
       SELECT d.*, row_number() OVER (PARTITION BY table_name ORDER BY change, pk::text) AS rn FROM sandbox_diff d
     ) s WHERE rn <= $1 ORDER BY table_name, rn`,
    [sampleSize],
  );
  const byTable = new Map<string, Array<Record<string, unknown>>>();
  for (const s of samples.rows) {
    const list = byTable.get(s.table_name) ?? [];
    list.push({ change: s.change, pk: s.pk, before: s.before, after: s.after });
    byTable.set(s.table_name, list);
  }
  return counts.rows.map((c) => ({
    table: c.table_name,
    inserted: Number(c.inserted),
    updated: Number(c.updated),
    deleted: Number(c.deleted),
    sample: byTable.get(c.table_name) ?? [],
  }));
}

export async function readOutbox(conn: SqlConn): Promise<Array<Record<string, unknown>>> {
  const res = await conn.query<Record<string, unknown>>("SELECT * FROM sandbox_outbox ORDER BY id");
  return res.rows;
}
