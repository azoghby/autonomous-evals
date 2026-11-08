import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

// Resolve the checkout from cwd, never a source copy or mutable remote ref.
function git(...args) {
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
}
const repo = git('rev-parse', '--show-toplevel');
process.chdir(repo);
const mode = process.argv[2] ?? '--strict';
assert.ok(['--strict', '--acceptance', '--characterize'].includes(mode) && process.argv.length <= 3,
  'Usage: node tests/track-b/release-contracts/sql/run.mjs [--strict|--acceptance|--characterize]');
const trackA = '8634ceb30f3d98de7ec24b240a4f7549dce80033';
assert.equal(git('rev-parse', `${trackA}^{commit}`), trackA);
const modules = [process.env.TRACK_B_SQL_NODE_MODULES, join(repo, 'tests/track-b/node_modules'),
  '/tmp/autonomous-evals-checks.m10du4/node_modules'].filter(Boolean).map(p => resolve(p))
  .find(p => existsSync(join(p, '@electric-sql/pglite/dist/index.js')));
assert.ok(modules, 'Existing PGlite required; set TRACK_B_SQL_NODE_MODULES (no install/fetch fallback)');
const { PGlite } = await import(pathToFileURL(join(modules, '@electric-sql/pglite/dist/index.js')).href);
console.log(`HEAD ${git('rev-parse', 'HEAD')}; Track A ${trackA}; PGlite ${modules}; mode ${mode}`);
const paths = {
  agent: 'packages/core/src/agents/persistence-migrations/001-agent-persistence.sql',
  data: 'packages/core/src/evals/data/persistence-migrations/001-evaluation-data.sql',
  text: 'packages/core/src/evals/integration/migrations/001-text-integration.sql',
  chat: 'packages/core/src/reporting/chat/persistence-migrations/001-conversations.sql',
  ledger: 'packages/core/src/simulator/ledger-migrations/001_branch_ownership.sql',
  calendar: 'packages/core/src/simulator/migrations/001_calendar.sql',
  journal: 'packages/core/src/simulator/workflow/persistence-migrations/001-workflow-investigation-journals.sql',
  chatCopy: 'docs/progress-chat-integration/server/001-private-conversations.sql',
  inventory: 'docs/structured-progress-integration/backend/001-structured-progress.sql',
};
const sql = Object.fromEntries(Object.entries(paths).map(([k, p]) => [k, readFileSync(p, 'utf8')]));
let passed = 0;
async function check(name, fn) {
  await fn(); passed++; console.log(`PASS ${name}`);
}
async function disposable(fn) {
  const db = new PGlite(); try { await fn(db); } finally { await db.close(); }
}
async function rejectsCode(db, statement, code) {
  await assert.rejects(db.exec(statement), e => e.code === code);
}
const app = ['agent', 'data', 'text', 'chat', 'ledger', 'journal', 'inventory'];
async function applyA(db) {
  const files = git('ls-tree', '-r', '--name-only', trackA, '--', 'packages/core/src/db/migrations')
    .split('\n').filter(p => p.endsWith('.sql')).sort();
  assert.equal(files.length, 15);
  for (const p of files) await db.exec(git('show', `${trackA}:${p}`));
}
async function catalog(db) {
  return (await db.query(`SELECT n.nspname, c.relname, c.relkind, a.attname,
    pg_catalog.format_type(a.atttypid,a.atttypmod) AS type, a.attnotnull
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
    ORDER BY 1,2,4`)).rows;
}
await check('complete tracked SQL inventory (9 files, no unreviewed migration)', async () => {
  const actual = git('ls-files').split('\n').filter(p => p.endsWith('.sql')).sort();
  assert.deepEqual(actual, Object.values(paths).sort());
});
for (const [name, statement] of Object.entries(sql)) {
  await check(`standalone migration ${name}`, () => disposable(db => db.exec(statement)));
}
await check('Track A 15 migrations + application migrations coexist in forward/reverse order', async () => {
  let expected;
  for (const order of [app, [...app].reverse()]) await disposable(async db => {
    await applyA(db);
    const before = await catalog(db);
    for (const k of order) await db.exec(sql[k]);
    const after = await catalog(db);
    for (const row of before) assert.ok(after.some(r => JSON.stringify(r) === JSON.stringify(row)), 'Track A column changed');
    if (expected) assert.deepEqual(after, expected); else expected = after;
    assert.equal((await db.query("SELECT to_regclass('sim_runs') AS t")).rows[0].t, null);
  });
});
await check('simulator seed stays separate and calendar FKs cascade', () => disposable(async db => {
  await db.exec(sql.calendar);
  await db.exec(`INSERT INTO sim_runs(job_id,run_id,version) VALUES ('j','r','v');
    INSERT INTO sim_calendars VALUES ('j','r','v','c','owner');
    INSERT INTO sim_events VALUES ('j','r','v','e','c','owner','title','2026-01-01','2026-01-02','UTC','active');`);
  await rejectsCode(db, `INSERT INTO sim_events VALUES ('j','r','v','bad','c','owner','title','2026-01-02','2026-01-01','UTC','active')`, '23514');
  await db.exec("DELETE FROM sim_runs WHERE job_id='j'");
  assert.equal((await db.query('SELECT count(*)::int AS n FROM sim_events')).rows[0].n, 0);
  assert.equal((await db.query("SELECT to_regclass('agent_persistence.tasks') AS t")).rows[0].t, null);
}));
await check('outer rollback removes every canonical migration (including schemas)', () => disposable(async db => {
  for (const k of [...app, 'calendar']) {
    await db.exec('BEGIN'); await db.exec(sql[k]); await db.exec('ROLLBACK');
    assert.deepEqual(await catalog(db), []);
  }
}));
await check('chat FK, scoped sequence uniqueness and rollback preserve committed scope', () => disposable(async db => {
  await db.exec(sql.chat);
  const insert = (subject, id, seq) => `INSERT INTO reporting_chat_exchanges VALUES ('${subject}','job','${id}','${'a'.repeat(64)}','{}',${seq})`;
  await rejectsCode(db, insert('missing','m',1), '23503');
  await db.exec("INSERT INTO reporting_chat_scopes(subject_id,job_id) VALUES ('s','job'),('other','job')");
  await db.exec(insert('s','m',1)); await db.exec(insert('other','m',1));
  await rejectsCode(db, insert('s','m2',1), '23505');
  await db.exec('BEGIN'); await db.exec("UPDATE reporting_chat_scopes SET last_sequence=2 WHERE subject_id='s'");
  await rejectsCode(db, insert('s','m3',1), '23505'); await db.exec('ROLLBACK');
  assert.equal((await db.query("SELECT last_sequence FROM reporting_chat_scopes WHERE subject_id='s'")).rows[0].last_sequence, 0);
}));
await check('checkpoint completion and journal shape reject invalid SQL writes', () => disposable(async db => {
  await db.exec(sql.text); await db.exec(sql.journal);
  await rejectsCode(db, "INSERT INTO text_integration.checkpoints VALUES ('j','k','i','d','t','completed',NULL)", '23514');
  await db.exec("INSERT INTO text_integration.checkpoints VALUES ('j','k','i','d','t','pending',NULL)");
  await rejectsCode(db, "UPDATE text_integration.checkpoints SET value='{}'", '23514');
  await rejectsCode(db, "INSERT INTO app_workflow_investigation_journals VALUES ('tenant','key','{}')", '23514');
}));
await check('idempotent artifacts replay; once-only artifacts require migration ledger', () => disposable(async db => {
  for (const k of ['data','text','journal','inventory','calendar']) { await db.exec(sql[k]); await db.exec(sql[k]); }
  for (const k of ['agent','chat','ledger']) {
    await db.exec(sql[k]); await rejectsCode(db, sql[k], k === 'agent' ? '42P06' : '42P07');
  }
}));

await check('agent/data integer bounds, ledger lifecycle and private inventory constraints', () => disposable(async db => {
  for (const k of ['agent','data','ledger','inventory']) await db.exec(sql[k]);
  await rejectsCode(db, "INSERT INTO agent_persistence.scopes VALUES ('s',9007199254740992)", '23514');
  await rejectsCode(db, "INSERT INTO agent_persistence.reservations(id,job_id,amount_micro_usd,scopes) VALUES ('r','j',0,'[]')", '23514');
  await db.exec(`INSERT INTO evaluation_data_persistence.tasks VALUES ('tenant','job','task',0,
    '{"taskId":"task","spec":{"taskId":"task","jobId":"job"},"revision":0}')`);
  await rejectsCode(db, "UPDATE evaluation_data_persistence.tasks SET revision=1", '23514');
  await rejectsCode(db, "UPDATE evaluation_data_persistence.tasks SET revision=9007199254740992", '23514');
  await db.exec(`INSERT INTO app_branch_ownership(job_id,project_id,parent_id,name,state,create_attempts)
    VALUES ('job','project','br-parent','eval-job-00000000-0000-0000-0000-000000000000','creating',1)`);
  await rejectsCode(db, "UPDATE app_branch_ownership SET state='ready'", '23514');
  await db.exec("UPDATE app_branch_ownership SET state='ready',branch_id='br-child'");
  await rejectsCode(db, "UPDATE app_branch_ownership SET branch_id='br-parent'", '23514');
  await rejectsCode(db, "INSERT INTO structured_progress.inventory VALUES ('t','j','production',0,'{}',now())", '23514');
  const acl = (await db.query(`SELECT relacl::text AS acl FROM pg_class
    WHERE oid='structured_progress.inventory'::regclass`)).rows[0].acl;
  assert.ok(acl && !acl.includes(',='), 'PUBLIC must have no inventory grant');
}));

const blockers = [];
if (mode !== '--acceptance') {
  await check('CHARACTERIZATION: duplicate chat artifacts fail in either order (42P07)', async () => {
    for (const order of [['chat','chatCopy'],['chatCopy','chat']]) await disposable(async db => {
      await db.exec(sql[order[0]]); await rejectsCode(db, sql[order[1]], '42P07'); await db.exec('ROLLBACK');
    });
    blockers.push('Both chat artifacts cannot be applied: duplicate reporting_chat_scopes (42P07). Choose one.');
  });
  await check('CHARACTERIZATION: chat copy COMMIT escapes caller transaction', () => disposable(async db => {
    await db.exec('BEGIN'); await db.exec(sql.chatCopy); await db.exec('ROLLBACK');
    assert.equal((await db.query("SELECT to_regclass('reporting_chat_scopes') AS t")).rows[0].t, 'reporting_chat_scopes');
    blockers.push('chatCopy commits an outer migration transaction; rollback leaves its tables committed.');
  }));
  await check('CHARACTERIZATION: IF NOT EXISTS silently preserves incompatible existing schema', () => disposable(async db => {
    await db.exec('CREATE SCHEMA text_integration; CREATE TABLE text_integration.checkpoints(bogus text)');
    await db.exec(sql.text);
    await rejectsCode(db, 'SELECT job_id FROM text_integration.checkpoints', '42703');
    blockers.push('IF NOT EXISTS is replay convenience, not schema validation (checkpoint missing column 42703).');
  }));
  await check('CHARACTERIZATION: unqualified application tables follow session search_path', () => disposable(async db => {
    await db.exec('CREATE SCHEMA alternate; SET search_path=alternate,public');
    await db.exec(sql.chat); await db.exec('SET search_path=public');
    assert.equal((await db.query("SELECT to_regclass('reporting_chat_scopes') AS t")).rows[0].t, null);
    assert.equal((await db.query("SELECT to_regclass('alternate.reporting_chat_scopes') AS t")).rows[0].t, 'alternate.reporting_chat_scopes');
    blockers.push('Pin trusted matching search_path for migrations/runtime: chat, ledger, journal, simulator use unqualified tables.');
  }));
}
console.log(`${passed} checks passed; no skipped tests. Single-session disposable PGlite only; no advisory lock/concurrency/cloud acceptance.`);
for (const b of blockers) console.log(`RELEASE CONDITION: ${b}`);
if (mode === '--strict' && blockers.length) { console.error('STRICT RELEASE GATE FAILED: unresolved deployment selection/session/schema conditions.'); process.exitCode = 1; }
