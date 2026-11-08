import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { manifest, root, source, baselineSQL, validateManifest, pinSession, sessionCheck,
  capture, tableCatalog, plan, executeDisposable } from './preflight.mjs';
assert.equal(process.env.TRACK_B_MIGRATION_LOCK_HELD, '1', 'Use verify.sh to acquire shared heavy lock');
assert.ok(existsSync('/tmp/track-b-release-heavy.lock'));
validateManifest();
const cache = [process.env.TRACK_B_SQL_NODE_MODULES, '/tmp/track-b-harness/node_modules',
  '/tmp/autonomous-evals-checks.m10du4/node_modules'].filter(Boolean)
  .map(p => resolve(p)).find(p => existsSync(join(p, '@electric-sql/pglite/dist/index.js')));
assert.ok(cache, 'Existing local PGlite cache required; no install fallback');
const { PGlite } = await import(pathToFileURL(join(cache, '@electric-sql/pglite/dist/index.js')));
console.log(`HEAD ${execFileSync('git', ['rev-parse','HEAD'], {cwd:root,encoding:'utf8'}).trim()}`);
console.log(`PGlite cache ${cache}; baseline ${manifest.applicationBaseline.commit}; in-memory databases only`);
let passed = 0;
async function test(name, fn) { await fn(); console.log(`PASS ${++passed} ${name}`); }
async function disposable(fn, baseline=true) {
  const db = new PGlite();
  try { await db.exec('REVOKE CREATE ON SCHEMA public FROM PUBLIC'); await pinSession(db); if (baseline) for (const sql of baselineSQL()) await db.exec(sql); await fn(db); }
  finally { await db.close(); }
}
let expected;
await test('actual 15 owner migrations + ten canonical application artifacts execute; catalog reference captured', () => disposable(async db => {
  const names = (await db.query(`SELECT schemaname||'.'||tablename AS name FROM pg_tables WHERE schemaname='public' ORDER BY tablename`)).rows.map(r => r.name);
  const prerequisites = await capture(db, [{tables:names}]);
  await executeDisposable(db, manifest.application.map(e => ({id:e.id,action:'apply'})));
  expected = {...await capture(db, manifest.application), prerequisites};
  assert.equal(Object.keys(expected.tables).length, 14);
  assert.equal(expected.tables['public.reporting_chat_exchanges'].constraints.filter(c => c.contype==='f').length,1);
  assert.equal(expected.tables['evaluation_data_persistence.operations'].triggers.length,1);
  console.log(`  catalog tables=${Object.keys(expected.tables).length}; constraints=${Object.values(expected.tables).reduce((n,t)=>n+t.constraints.length,0)}`);
}));
await test('preflight whole batch, apply with declared transaction owners, repeat without replaying once-only SQL', () => disposable(async db => {
  const first = await plan(db, expected); assert.ok(first.every(d=>d.action==='apply'));
  await executeDisposable(db, first);
  const second = await plan(db, expected); assert.ok(second.every(d=>d.action==='reuse-compatible'));
  await executeDisposable(db, second);
  assert.deepEqual(await capture(db,manifest.application), {tables:expected.tables,schemas:expected.schemas});
  assert.equal((await db.query("SELECT to_regclass('public.sim_runs') AS t")).rows[0].t,null);
}));
await test('all IF NOT EXISTS application artifacts replay actual SQL and retain exact catalogs', () => disposable(async db => {
  await executeDisposable(db, manifest.application.map(e=>({id:e.id,action:'apply'})));
  for (const id of ['data001','data002','checkpoint','journal','inventory','workflow002']) await db.exec(source(manifest.application.find(e=>e.id===id)));
  assert.ok((await plan(db, expected)).every(d=>d.action==='reuse-compatible'));
}));
await test('same columns but missing CHECK refuses before any write; no regex-only acceptance', () => disposable(async db => {
  await executeDisposable(db, manifest.application.map(e=>({id:e.id,action:'apply'})));
  const name = expected.tables['text_integration.checkpoints'].constraints.find(c=>c.contype==='c').conname;
  await db.exec(`ALTER TABLE text_integration.checkpoints DROP CONSTRAINT "${name}"`);
  await assert.rejects(plan(db,expected), /Incompatible existing table/);
}));
await test('bogus preexisting table refuses and leaves absent agent schema untouched', () => disposable(async db => {
  await db.exec('CREATE SCHEMA text_integration; CREATE TABLE text_integration.checkpoints(bogus text)');
  await assert.rejects(plan(db,expected), /Incompatible existing table/);
  assert.equal((await db.query("SELECT to_regnamespace('agent_persistence') AS n")).rows[0].n,null);
}));
await test('trigger definition/enable state drift refuses data002 reuse', () => disposable(async db => {
  await executeDisposable(db, manifest.application.map(e=>({id:e.id,action:'apply'})));
  await db.exec('ALTER TABLE evaluation_data_persistence.operations DISABLE TRIGGER operation_immutability');
  await assert.rejects(plan(db,expected), /Incompatible existing table/);
}));
await test('partial chat, missing owner baseline and unsafe search_path refuse', async () => {
  await disposable(async db => {
    await db.exec(source(manifest.application.find(e=>e.id==='chat')));
    await db.exec('DROP TABLE reporting_chat_exchanges');
    await assert.rejects(plan(db,expected), /Partial migration/);
  });
  await disposable(async db => { await assert.rejects(plan(db,expected), /Incompatible\/missing owner baseline/); },false);
  await disposable(async db => { await db.exec('SET search_path=pg_catalog,public'); await assert.rejects(sessionCheck(db), /Unsafe session/); });
});
await test('changed CHECK text, PUBLIC CREATE and temporary-table shadowing refuse', async () => {
  await disposable(async db => {
    await executeDisposable(db, manifest.application.map(e=>({id:e.id,action:'apply'})));
    const name = expected.tables['text_integration.checkpoints'].constraints.find(c=>c.contype==='c').conname;
    await db.exec(`ALTER TABLE text_integration.checkpoints DROP CONSTRAINT "${name}";
      ALTER TABLE text_integration.checkpoints ADD CONSTRAINT "${name}" CHECK (true)`);
    await assert.rejects(plan(db,expected), /Incompatible existing table/);
  });
  await disposable(async db => {
    await db.exec('GRANT CREATE ON SCHEMA public TO PUBLIC');
    await assert.rejects(plan(db,expected), /Unsafe schema/);
  });
  await disposable(async db => {
    await db.exec('CREATE TEMP TABLE reporting_chat_scopes(bogus text)');
    await assert.rejects(plan(db,expected), /Unsafe session/);
  });
});
await test('historical duplicate cost identities refuse before migration writes', () => disposable(async db => {
  // Deliberately inconsistent fixture uses local superuser replication mode, never production SQL.
  await db.exec(`SET session_replication_role=replica;
    INSERT INTO costs(job_id,source,micro_usd,meta) VALUES
    ('00000000-0000-0000-0000-000000000001','fixture',1,'{"idempotencyKey":"same"}'),
    ('00000000-0000-0000-0000-000000000001','fixture',1,'{"idempotencyKey":"same"}');
    SET session_replication_role=origin`);
  await assert.rejects(plan(db,expected), /Historical cost key collision/);
  assert.equal((await db.query("SELECT to_regnamespace('agent_persistence') AS n")).rows[0].n,null);
}));
await test('data002 CHECK and actual trigger enforce immutable completion/delete', () => disposable(async db => {
  await db.exec(source(manifest.application.find(e=>e.id==='data002')));
  await db.exec(`INSERT INTO evaluation_data_persistence.operations(tenant_id,job_id,operation_key,digest,owner_id)
    VALUES ('t','j','k','${'a'.repeat(64)}','owner')`);
  await assert.rejects(db.exec("UPDATE evaluation_data_persistence.operations SET state='complete'"), e=>e.code==='23514');
  await db.exec(`UPDATE evaluation_data_persistence.operations SET state='complete',result='{}',result_digest='${'b'.repeat(64)}'`);
  await assert.rejects(db.exec("UPDATE evaluation_data_persistence.operations SET result='[]'"), /data_operation_immutable/);
  await assert.rejects(db.exec('DELETE FROM evaluation_data_persistence.operations'), /data_operation_immutable/);
}));
await test('runner-owned artifacts roll back; artifact-owned Workflow failure rolls back its schema', () => disposable(async db => {
  for (const e of manifest.application.filter(e=>e.transactionOwner==='runner')) {
    await db.exec('BEGIN'); await db.exec(source(e)); await db.exec('ROLLBACK');
    for (const t of e.tables) assert.equal(await tableCatalog(db,t),null);
  }
  await db.exec('DROP TABLE costs');
  await assert.rejects(executeDisposable(db,[{id:'workflow001',action:'apply'}]));
  assert.equal((await db.query("SELECT to_regnamespace('workflow_integration') AS n")).rows[0].n,null);
}));
await test('simulator seed is separate; actual SQL replays with exact FK/index catalog', () => disposable(async db => {
  const entry = {...manifest.simulatorSeed,id:'seed'};
  await executeDisposable(db,[{id:'seed',action:'apply'}],[entry]);
  const ref = await capture(db,[entry]);
  await db.exec(source(entry));
  assert.deepEqual(await capture(db,[entry]),ref);
  assert.ok((await plan(db,ref,[entry])).every(d=>d.action==='reuse-compatible'));
  assert.equal((await db.query("SELECT to_regclass('reporting_chat_scopes') AS t")).rows[0].t,null);
},false));
console.log(`${passed} groups passed. Local PostgreSQL WASM/catalog proof only; deployment acceptance remains blocked on owner integration/session/role/native concurrency gates.`);
