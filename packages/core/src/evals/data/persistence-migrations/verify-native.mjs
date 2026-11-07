// Offline, opt-in verification against a disposable native PostgreSQL server.
// Uses existing dependencies only; never installs, downloads or connects to a supplied DB URL.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..');
const harness = resolve(process.env.TRACK_B_HARNESS ?? join(repo, 'tests/track-b'));
const runtime = process.env.TRACK_B_POSTGRES_RUNTIME;
if (!runtime) throw new Error('Set TRACK_B_POSTGRES_RUNTIME to existing embedded-postgres and pg dependencies');
if (userInfo().uid === 0) throw new Error('Run as an ordinary user');
const harnessRequire = createRequire(join(harness, 'package.json'));
const runtimeRequire = createRequire(join(resolve(runtime), 'package.json'));
const ts = harnessRequire('typescript');
const { Pool } = runtimeRequire('pg');
const { default: EmbeddedPostgres } = await import(pathToFileURL(runtimeRequire.resolve('embedded-postgres')));
const work = await mkdtemp('/tmp/evaluation-data-postgres-');
let server;
const pools = [];
let tests = 0;
async function check(label, fn) { await fn(); tests++; console.log(`PASS ${label}`); }
try {
  const stage = join(work, 'stage'); await mkdir(stage);
  await writeFile(join(stage, 'package.json'), JSON.stringify({ type: 'module' }));
  await symlink(join(harness, 'node_modules'), join(stage, 'node_modules'));
  const hashes = {};
  for (const file of ['evals/data/postgres-store', 'evals/data/binding', 'evals/data/quality', 'agents/redact', 'simulator/pool']) {
    const source = await readFile(join(repo, 'packages/core/src', `${file}.ts`), 'utf8');
    hashes[file] = createHash('sha256').update(source).digest('hex');
    const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
      .replace(/from (['"])(\.[^'"]+)(['"])/g, (_all, quote, path, end) => `from ${quote}${path.endsWith('.js') ? path : `${path}.js`}${end}`);
    await mkdir(dirname(join(stage, file)), { recursive: true });
    await writeFile(join(stage, `${file}.js`), output);
  }
  const reservation = createServer();
  await new Promise((ok, fail) => { reservation.once('error', fail); reservation.listen(0, '127.0.0.1', ok); });
  const port = reservation.address().port;
  await new Promise(ok => reservation.close(ok));
  const config = { host: '127.0.0.1', port, user: 'postgres', password: randomBytes(24).toString('hex'), database: 'evaluation_data_test' };
  server = new EmbeddedPostgres({ databaseDir: join(work, 'data'), port, user: config.user, password: config.password, persistent: true,
    createPostgresUser: false, autoRehydrateSymlinks: true, initdbFlags: ['--encoding=UTF8', '--locale=C'],
    postgresFlags: ['-h', '127.0.0.1', '-k', work, '-c', 'fsync=on', '-c', 'synchronous_commit=on', '-c', 'full_page_writes=on'],
    onLog() {}, onError() {},
  });
  await server.initialise(); await server.start(); await server.createDatabase(config.database);
  const { createPostgresEvaluationDataStore: factory } = await import(pathToFileURL(join(stage, 'evals/data/postgres-store.js')));
  const { pooledCalendarDatabase } = await import(pathToFileURL(join(stage, 'simulator/pool.js')));
  const makeDb = () => { const pool = new Pool({ ...config, max: 1 }); pools.push(pool); return pooledCalendarDatabase(pool); };
  const db = makeDb();
  const migration = await readFile(new URL('./001-evaluation-data.sql', import.meta.url), 'utf8');
  await db.query(migration);
  const scope = { tenantId: 'tenant', jobId: 'job' };
  const fixture = () => ({ taskId: 'task', revision: 0, spec: { taskId: 'task', jobId: 'job', description: 'Arithmetic', requirements: [], factualAnswersRequired: false, targetId: 'target' },
    requestHash: 'a'.repeat(64), state: 'acquiring', phase: 'discovery', sources: [], cases: [],
    assessment: { status: 'unassessed', factualCorrectness: 'unassessed', acceptedCaseIds: [], approvedAnswerCaseIds: [], coverage: [], issues: [] },
    decisions: [], updatedAt: '2026-11-07T12:00:00Z' });
  const store = factory(db, scope);
  // Every transaction starts on a different pinned session, then waits at the shared
  // JS barrier. All contenders are open in native PostgreSQL before any claim/CAS SQL.
  const participants = Array.from({ length: 8 }, makeDb);
  const pids = await Promise.all(participants.map(d => d.query('SELECT pg_backend_pid() AS pid')));
  assert.equal(new Set(pids.map(r => r.rows[0].pid)).size, 8);
  async function race(action) {
    let arrived = 0; let release;
    const gate = new Promise(ok => { release = ok; });
    return Promise.all(participants.map(d => {
      const synchronized = { query: d.query, transaction: fn => d.transaction(async tx => { if (++arrived === participants.length) release(); await gate; return fn(tx); }) };
      return action(factory(synchronized, scope));
    }));
  }
  await check('native 8-session insert race has exactly one winner', async () => {
    const results = await race(s => s.insertIfAbsent(fixture()));
    assert.equal(results.filter(r => r.inserted).length, 1);
  });
  await check('native 8-session revision CAS race has exactly one winner', async () => {
    const results = await race(s => s.compareAndSet('task', 0, { ...fixture(), revision: 1 }));
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal((await store.get('task')).revision, 1);
  });
  await check('conflicting insert and CAS preserve original identity', async () => {
    const drift = fixture(); drift.spec.targetId = 'other';
    await assert.rejects(() => store.insertIfAbsent(drift), /identity_conflict/);
    await assert.rejects(() => store.compareAndSet('task', 1, { ...drift, revision: 2 }), /identity_conflict/);
    assert.equal((await store.get('task')).spec.targetId, 'target');
  });
  await check('tenant/job reads and CAS cannot cross scope', async () => {
    for (const other of [{ ...scope, tenantId: 'other' }, { ...scope, jobId: 'other' }]) {
      const s = factory(db, other); const next = fixture(); next.spec.jobId = other.jobId;
      assert.equal(await s.get('task'), null);
      assert.equal(await s.compareAndSet('task', 0, { ...next, revision: 1 }), null);
    }
  });
  await check('post-UPDATE failure rolls back native transaction', async () => {
    const broken = factory({ query: db.query, transaction: fn => db.transaction(tx => fn({ query: async (sql, params) => {
      const result = await tx.query(sql, params);
      if (sql.startsWith('UPDATE')) throw new Error('sensitive-driver-detail');
      return result;
    } })) }, scope);
    await assert.rejects(() => broken.compareAndSet('task', 1, { ...fixture(), revision: 2 }), /^Error: evaluation_data_persistence_failed$/);
    assert.equal((await store.get('task')).revision, 1);
  });
  await check('server restart and fresh pooled service preserve revision and complete record', async () => {
    const expected = await store.get('task');
    await Promise.all(pools.map(p => p.end())); pools.length = 0;
    await server.stop(); await server.start();
    assert.deepEqual(await factory(makeDb(), scope).get('task'), expected);
  });
  console.log(JSON.stringify({ tests, skipped: 0, independentSessions: 8, postgresRuntime: JSON.parse(await readFile(join(dirname(runtimeRequire.resolve('embedded-postgres')), '../package.json'), 'utf8')).version,
    pg: runtimeRequire('pg/package.json').version, sourceHashes: hashes, migrationSha256: createHash('sha256').update(migration).digest('hex') }, null, 2));
} finally {
  await Promise.all(pools.map(p => p.end()));
  if (server?.process) await server.stop();
  if (!server?.process) await rm(work, { recursive: true, force: true });
}
