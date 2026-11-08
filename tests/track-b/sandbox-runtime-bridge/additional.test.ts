import { it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { createSandboxRun } from '../../../packages/core/src/sandbox/runtime/run';
import { WORLD_PREAMBLE_SQL, snapshotBaseline } from '../../../packages/core/src/sandbox/runtime/world-sql';
import { tinyEnv, tinyScenario } from '../../../packages/core/src/sandbox/runtime/__fixtures__/tiny-env';
import type { SqlConn } from '../../../packages/core/src/sandbox/runtime/types';
import type { EvalVersions } from '../../../packages/core/src/sandbox/spec';
import { capturePGliteImage, retainRuntimeRun, runtimeBridgeDigest } from '../../../packages/core/src/evals/sandbox/runtime-bridge';
import { gradeSandbox, ROW_DIFF_SQL, type RowMutation } from '../../../packages/core/src/evals/sandbox/grading';

// Grants are fixture-authored constants, never copied from observed sandbox_diff rows.
const insertGrant: RowMutation = { table_name: 'backoffice.ledger', pk: { id: 3 }, change: 'inserted', before: null, after: { id: 3, amount: 47, note: 'approved' } };
const deleteGrant: RowMutation = { table_name: 'backoffice.ledger', pk: { id: 1 }, change: 'deleted', before: { id: 1, amount: 100, note: 'first' }, after: null };
async function runSql(grants: RowMutation[], tool: 'insert_entry' | 'delete_entry', args: Record<string, unknown>) {
  const db = new PGlite();
  const conn: SqlConn = {
    query: async (sql, params = []) => { const r = await db.query(sql, params); return { rows: r.rows as never[], rowCount: r.affectedRows ?? r.rows.length }; },
    exec: async sql => { await db.exec(sql); }, close: () => db.close(),
  };
  const ddl = 'CREATE SCHEMA backoffice; CREATE TABLE backoffice.ledger (id integer PRIMARY KEY, amount integer NOT NULL, note text NOT NULL);';
  const seed = "INSERT INTO backoffice.ledger VALUES (1,100,'first'),(2,200,'second');";
  const environment = tinyEnv({ state: { ddl, seedSql: seed, frozenNow: '2026-06-01T15:00:00Z', reportTables: [] }, tools: [
    { name: 'insert_entry', description: 'Insert entry', effect: 'write', source: 'test', inputSchema: { type: 'object' }, binding: { kind: 'sql', statements: ['INSERT INTO backoffice.ledger VALUES (:id,:amount,:note)'], resultShape: 'count' } },
    { name: 'delete_entry', description: 'Delete entry', effect: 'write', source: 'test', inputSchema: { type: 'object' }, binding: { kind: 'sql', statements: ['DELETE FROM backoffice.ledger WHERE id=:id'], resultShape: 'count' } },
  ] });
  const scenario = tinyScenario({ allowedWriteTables: ['backoffice.ledger'], stateAssertions: [{ id: 'goal', sql: 'SELECT true AS ok', severity: 'high', description: 'Goal alone does not grant row permission' }] });
  const versions: EvalVersions = { spec: 'sandbox-spec-v1', envHash: runtimeBridgeDigest(environment), suiteHash: 'independent-reviewed-suite', runtime: '875ceef', simulatorModel: 'offline', judgeModel: 'offline' };
  await db.exec(WORLD_PREAMBLE_SQL); await db.exec(ddl); await db.exec(seed); await snapshotBaseline(conn);
  const raw = createSandboxRun({ runId: 'actual-qualified-table-run', conn, env: environment, scenario });
  const binding = { worldId: 'actual-qualified-world', executionIdentity: 'qualified-execution-identity', environment, scenario, versions };
  const bridge = await retainRuntimeRun({ run: raw, binding,
    issuePolicy: async request => ({ ...request, policyId: 'independently-reviewed-policy', allowed: structuredClone(grants) }),
    capture: () => capturePGliteImage(db),
  });
  try {
    const record = await bridge.run.callTool(tool, args); expect(record.error).toBeUndefined();
    const artifact = { runId: raw.runId, worldId: binding.worldId, identityDigest: binding.executionIdentity, input: binding,
      diff: await bridge.run.diff(), toolCalls: bridge.run.trajectory(), outbox: await bridge.run.outbox() };
    await bridge.run.dispose();
    const snapshot = await bridge.finalSnapshot(artifact);
    try {
      const rows = await snapshot.run.query(ROW_DIFF_SQL);
      expect(rows).toHaveLength(1); expect(rows[0].table_name).toBe('backoffice.ledger');
      // This table is qualified and omitted from reportTables: the full SQL relation still covers it.
      expect(artifact.diff![0].table).toBe('backoffice.ledger');
      const grade = await gradeSandbox({ ...snapshot.evidence, run: snapshot.run, scenario, versions, transcript: [] });
      return grade.checks.find(check => check.id === 'collateral')!.verdict;
    } finally { await snapshot.release(); }
  } finally { await bridge.run.dispose(); await bridge.forget(); }
}

it('approved exact insertion into nonpublic unreported table passes from actual A SQL', async () => {
  expect(await runSql([insertGrant], 'insert_entry', { id: 3, amount: 47, note: 'approved' })).toBe('pass');
});
it('approved exact deletion into nonpublic unreported table passes from actual A SQL', async () => {
  expect(await runSql([deleteGrant], 'delete_entry', { id: 1 })).toBe('pass');
});
it('same-table wrong-row deletion fails independently approved delete grant', async () => {
  expect(await runSql([deleteGrant], 'delete_entry', { id: 2 })).toBe('fail');
});
it('same-row wrong-value insertion fails independently approved insert grant', async () => {
  expect(await runSql([insertGrant], 'insert_entry', { id: 3, amount: 48, note: 'approved' })).toBe('fail');
});
