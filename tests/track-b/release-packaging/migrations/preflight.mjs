import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
export const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
export const manifest = JSON.parse(readFileSync(resolve(root, 'docs/release-packaging-integration/migrations/manifest.json')));
const hash = s => createHash('sha256').update(s).digest('hex');
export function baselineSQL() {
  return manifest.applicationBaseline.migrations.map(entry => {
    const sql = execFileSync('git', ['show', `${manifest.applicationBaseline.commit}:${entry.path}`], { cwd: root });
    assert.equal(hash(sql), entry.sha256, `Baseline hash changed: ${entry.path}`);
    return sql.toString();
  });
}
export function source(entry) {
  const bytes = readFileSync(resolve(root, entry.path));
  assert.equal(hash(bytes), entry.sha256, `Artifact hash changed: ${entry.path}`);
  if (!entry.patchTarget) return bytes.toString();
  // Extract only the existing new-file SQL hunk; never copy or apply the patch.
  const block = bytes.toString().split(`+++ b/${entry.patchTarget}\n`);
  assert.equal(block.length, 2, 'Expected exactly one Workflow migration target');
  const lines = block[1].split('\n');
  const header = lines.shift().match(/^@@ -0,0 \+1,(\d+) @@$/);
  assert.ok(header, 'Expected new-file SQL hunk');
  const added = lines.slice(0, Number(header[1]));
  assert.ok(added.every(l => l.startsWith('+')), 'Unexpected patch content');
  return added.map(l => l.slice(1)).join('\n') + '\n';
}
export function validateManifest() {
  const seen = new Set();
  assert.equal(manifest.application.filter(e => e.id === 'chat').length, 1);
  assert.equal(manifest.application.find(e => e.id === 'chat').path, manifest.chatSelection);
  assert.ok(!manifest.application.some(e => e.path === manifest.excludedChat));
  for (const e of manifest.application) {
    assert.ok(!seen.has(e.id));
    assert.ok(e.after.every(id => seen.has(id)), `Out of order: ${e.id}`);
    assert.ok(['runner', 'artifact'].includes(e.transactionOwner));
    source(e); seen.add(e.id);
  }
  source(manifest.simulatorSeed); baselineSQL();
}
export async function pinSession(db) {
  // Dedicated, idle session only. Never call this on a request/pool.query executor.
  await db.exec(`SET search_path TO public, pg_catalog; SET default_transaction_isolation TO 'read committed'`);
}
export async function sessionCheck(db) {
  const r = (await db.query(`SELECT current_setting('search_path') AS path,
    current_setting('transaction_isolation') AS isolation,
    EXISTS(SELECT 1 FROM pg_class WHERE relnamespace=pg_my_temp_schema()) AS temp`)).rows[0];
  assert.deepEqual(r, { path: manifest.searchPath, isolation: 'read committed', temp: false }, 'Unsafe session');
  const publicCreate = (await db.query(`SELECT n.nspname FROM pg_namespace n,
    LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a
    WHERE n.nspname = ANY($1::text[]) AND a.grantee=0 AND a.privilege_type='CREATE'`,
    [['public','agent_persistence','evaluation_data_persistence','text_integration','structured_progress','workflow_integration']])).rows;
  assert.equal(publicCreate.length, 0, 'Unsafe schema: PUBLIC has CREATE; owner must harden before preflight');
}
// PostgreSQL supplies canonical definitions. No regex-based schema acceptance.
export async function tableCatalog(db, name) {
  const rel = (await db.query(`SELECT c.relkind,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity,
      c.relacl::text AS acl, c.reloptions, c.relispartition
    FROM pg_class c WHERE c.oid=to_regclass($1)`, [name])).rows;
  if (!rel.length) return null;
  const columns = (await db.query(`SELECT a.attname,format_type(a.atttypid,a.atttypmod) AS type,
    a.attnotnull,a.attidentity,a.attgenerated,pg_get_expr(d.adbin,d.adrelid) AS default_expr,
    co.collname AS collation,a.attacl::text AS acl
    FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    LEFT JOIN pg_collation co ON co.oid=a.attcollation
    WHERE a.attrelid=to_regclass($1) AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`, [name])).rows;
  const constraints = (await db.query(`SELECT conname,contype,convalidated,condeferrable,condeferred,
    pg_get_constraintdef(oid,false) AS definition FROM pg_constraint
    WHERE conrelid=to_regclass($1) ORDER BY conname`, [name])).rows;
  const indexes = (await db.query(`SELECT pg_get_indexdef(indexrelid) AS definition,indisvalid,indisready
    FROM pg_index WHERE indrelid=to_regclass($1) ORDER BY definition`, [name])).rows;
  const triggers = (await db.query(`SELECT t.tgname,t.tgenabled,pg_get_triggerdef(t.oid,false) AS definition,
    pg_get_functiondef(p.oid) AS function_definition,p.proconfig,p.proacl::text AS acl
    FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
    WHERE t.tgrelid=to_regclass($1) AND NOT t.tgisinternal ORDER BY t.tgname`, [name])).rows;
  const policies = (await db.query(`SELECT polname,polcmd,polpermissive,polroles::text,
    pg_get_expr(polqual,polrelid) AS qual,pg_get_expr(polwithcheck,polrelid) AS withcheck
    FROM pg_policy WHERE polrelid=to_regclass($1) ORDER BY polname`, [name])).rows;
  const inheritance = (await db.query(`SELECT inhparent::regclass::text FROM pg_inherits
    WHERE inhrelid=to_regclass($1) ORDER BY inhseqno`, [name])).rows;
  return { rel, columns, constraints, indexes, triggers, policies, inheritance };
}
export async function schemaCatalog(db, schema) {
  return (await db.query(`SELECT nspacl::text AS acl FROM pg_namespace WHERE nspname=$1`, [schema])).rows[0] ?? null;
}
export async function capture(db, entries) {
  const tables = {}, schemas = {};
  for (const e of entries) for (const t of e.tables) {
    tables[t] = await tableCatalog(db, t);
    schemas[t.split('.')[0]] = await schemaCatalog(db, t.split('.')[0]);
  }
  return { tables, schemas };
}
export async function plan(db, expected, entries = manifest.application) {
  await sessionCheck(db);
  if (entries.some(e => e.id === 'workflow001')) {
    assert.ok(expected.prerequisites, 'Reference baseline catalog required');
    for (const [name, shape] of Object.entries(expected.prerequisites.tables)) {
      assert.deepEqual(await tableCatalog(db, name), shape, `Incompatible/missing owner baseline: ${name}`);
    }
    const duplicates = (await db.query(`SELECT meta->>'idempotencyKey' AS key FROM public.costs
      WHERE job_id IS NOT NULL AND jsonb_typeof(meta->'idempotencyKey')='string'
      GROUP BY meta->>'idempotencyKey' HAVING count(*)>1`)).rows;
    assert.equal(duplicates.length, 0, 'Historical cost key collision: owner reconciliation required');
  }
  // Inspect the entire batch before the first write, including once-only artifacts.
  const result = [];
  for (const e of entries) {
    const present = [];
    for (const name of e.tables) {
      assert.ok(expected.tables[name], `Missing reference catalog: ${name}`);
      const actual = await tableCatalog(db, name);
      if (actual) assert.deepEqual(actual, expected.tables[name], `Incompatible existing table: ${name}`);
      present.push(Boolean(actual));
    }
    assert.ok(present.every(Boolean) || present.every(v => !v), `Partial migration: ${e.id}`);
    result.push({ id: e.id, action: present.every(Boolean) ? 'reuse-compatible' : 'apply', transactionOwner: e.transactionOwner });
  }
  for (const [schema, shape] of Object.entries(expected.schemas)) {
    const actual = await schemaCatalog(db, schema);
    if (actual) assert.deepEqual(actual, shape, `Incompatible schema ACL: ${schema}`);
  }
  // Agent SQL uses CREATE SCHEMA without IF NOT EXISTS.
  if (result.some(e => e.id === 'agent' && e.action === 'apply')) {
    assert.equal(await schemaCatalog(db, 'agent_persistence'), null, 'Preexisting agent schema requires owner reconciliation');
  }
  return result;
}
export async function executeDisposable(db, decisions, entries = manifest.application) {
  // TEST ONLY. Production owner must use its audited migration registry and lock.
  for (const d of decisions) {
    if (d.action !== 'apply') continue;
    const e = entries.find(e => e.id === d.id);
    if (e.transactionOwner === 'artifact') {
      try { await db.exec(source(e)); } catch (error) { await db.exec('ROLLBACK'); throw error; }
    } else {
      await db.exec('BEGIN');
      try { await db.exec(source(e)); await db.exec('COMMIT'); }
      catch (error) { await db.exec('ROLLBACK'); throw error; }
    }
  }
}
