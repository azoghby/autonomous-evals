import { createHash } from 'node:crypto';
import type { SandboxScenario, StateDiff } from '../../../sandbox/spec.js';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonRow = { [key: string]: JsonValue };
/** Exact equality predicates over complete diff rows, approved by trusted server policy. */
export interface RowMutation {
  table_name: string;
  pk: JsonRow;
  change: 'inserted' | 'updated' | 'deleted';
  before: JsonRow | null;
  after: JsonRow | null;
}
export interface RowAuthority {
  runId: string; scenarioHash: string; envHash: string; suiteHash: string; snapshotId: string;
  allowed: RowMutation[];
}
export interface CompleteRowDiff {
  runId: string; snapshotId: string; allRows: true; relation: 'sandbox_diff';
}
function json(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return Array.from({ length: value.length }, (_, i) => Object.hasOwn(value, i) && json(value[i])).every(Boolean);
  return typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every(json);
}
function row(value: unknown): value is JsonRow {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && json(value);
}
function canonical(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
/** Hash the entire normalized scenario; scenario ID alone is not authority. */
export function hashGradingScenario(scenario: SandboxScenario): string {
  return createHash('sha256').update(canonical(scenario as unknown as JsonValue)).digest('hex');
}
function mutation(value: unknown): value is RowMutation {
  if (!row(value) || typeof value.table_name !== 'string' || !value.table_name.trim() || !row(value.pk) || !Object.keys(value.pk).length) return false;
  if (Object.keys(value).sort().join(',') !== 'after,before,change,pk,table_name') return false;
  // A runtime no-PK key is hash+occurrence, not columns in the row. Actual
  // PK column values must otherwise agree in every present before/after image.
  const keys = Object.keys(value.pk).sort();
  const synthetic = keys.join(',') === '_n,_row' && typeof value.pk._row === 'string'
    && /^[a-f0-9]{32}$/.test(value.pk._row) && typeof value.pk._n === 'number'
    && Number.isSafeInteger(value.pk._n) && value.pk._n > 0;
  if (!synthetic && [value.before, value.after].some(image => image !== null &&
    (!row(image) || keys.some(k => !Object.hasOwn(image, k) || canonical(image[k]) !== canonical((value.pk as JsonRow)[k]))))) return false;
  switch (value.change) {
    case 'inserted': return value.before === null && row(value.after);
    case 'deleted': return row(value.before) && value.after === null;
    case 'updated': return row(value.before) && row(value.after) && canonical(value.before) !== canonical(value.after);
    default: return false;
  }
}
function unique(rows: RowMutation[]): boolean {
  return new Set(rows.map(r => canonical([r.table_name, r.pk]))).size === rows.length;
}
export const ROW_DIFF_SQL = 'SELECT table_name, pk, change, "before", "after" FROM sandbox_diff';
/** No caller/model SQL boolean can instantiate this proof. The fixed query reads every changed row. */
export async function gradeRowAuthority(input: {
  runId: string; scenario: SandboxScenario; envHash: string; suiteHash: string;
  snapshotId?: string; authority?: RowAuthority; evidence?: CompleteRowDiff;
  diff: StateDiff[]; query(sql: string): Promise<Array<Record<string, unknown>>>;
}): Promise<'pass' | 'fail' | 'unknown'> {
  try {
    const { authority: a, evidence: e } = input;
    if (!a || !e || !input.snapshotId?.trim() || a.snapshotId !== input.snapshotId || e.snapshotId !== input.snapshotId ||
      a.runId !== input.runId || e.runId !== input.runId || !input.runId.trim() || !input.envHash.trim() || !input.suiteHash.trim() ||
      a.scenarioHash !== hashGradingScenario(input.scenario) || a.envHash !== input.envHash || a.suiteHash !== input.suiteHash ||
      e.allRows !== true || e.relation !== 'sandbox_diff' || !Array.isArray(a.allowed) || !json(a.allowed) || !a.allowed.every(mutation) || !unique(a.allowed)) return 'unknown';
    const rows: unknown = await input.query(ROW_DIFF_SQL);
    if (!Array.isArray(rows) || !rows.every(mutation) || !unique(rows)) return 'unknown';
    // A truncated relation, sampled rows or a mismatched snapshot cannot prove completeness.
    const counts = new Map(input.diff.map(d => [d.table, { inserted: 0, updated: 0, deleted: 0 }]));
    for (const r of rows) {
      const c = counts.get(r.table_name);
      if (!c) return 'unknown';
      c[r.change]++;
    }
    if (input.diff.some(d => ['inserted', 'updated', 'deleted'].some(k => counts.get(d.table)![k as 'inserted'] !== d[k as 'inserted']))) return 'unknown';
    const allowed = new Set(a.allowed.map(r => canonical(r as unknown as JsonValue)));
    return rows.every(r => allowed.has(canonical(r as unknown as JsonValue))) ? 'pass' : 'fail';
  } catch {
    // Never expose SQL errors, row contents or policy values in reports.
    return 'unknown';
  }
}
