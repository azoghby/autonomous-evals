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

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
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
  for (const file of ['evals/data/postgres-operations', 'evals/data/binding', 'evals/data/quality', 'agents/redact', 'simulator/pool']) {
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
  const { createPostgresDataOperationLedger: factory } = await import(pathToFileURL(join(stage, 'evals/data/postgres-operations.js')));
  const { pooledCalendarDatabase } = await import(pathToFileURL(join(stage, 'simulator/pool.js')));
  const makeDb = () => { const pool = new Pool({ ...config, max: 1 }); pools.push(pool); return pooledCalendarDatabase(pool); };
  const db = makeDb();
  const migration = await readFile(new URL('../../../packages/core/src/evals/data/persistence-migrations/002-data-operations.sql', import.meta.url), 'utf8');
  await db.query(migration);
  const scope = { tenantId: 'tenant', jobId: 'job', ownerId: 'data_service', authenticateOwner: async () => ({ ownerId: 'data_service' }) };
  const store = factory(db, scope);
  const digest = 'a'.repeat(64);
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
  await check('native 8-session concurrent claim has one winner and no redispatch', async () => {
    let dispatches = 0;
    const results = await race(async s => { const claim = await s.claim('generation', digest); if (claim.claimed) dispatches++; return claim; });
    assert.equal(results.filter(r => r.claimed).length, 1); assert.equal(dispatches, 1);
    assert.equal((await store.claim('generation', digest)).claimed, false);
  });
  await check('native concurrent completion preserves one immutable result', async () => {
    const results = await Promise.allSettled(participants.map((d, i) => factory(d, scope).complete('generation', digest, { winner: i })));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal((await store.get('generation')).state, 'complete');
  });
  await check('lost commit acknowledgements replay without reclaim or generation dispatch', async () => {
    const unreliable = factory({ query: db.query, transaction: async fn => { await db.transaction(fn); throw new Error('lost commit ack'); } }, scope);
    await assert.rejects(() => unreliable.claim('lost_ack', digest), /data_operation_failed/);
    assert.equal((await store.claim('lost_ack', digest)).claimed, false);
    await assert.rejects(() => unreliable.complete('lost_ack', digest, { durable: true }), /data_operation_failed/);
    assert.deepEqual((await store.get('lost_ack')).result, { durable: true });
  });
  await check('foreign owner requires authenticated bound immutable reconciliation', async () => {
    await store.claim('reconciliation', digest);
    const foreignScope = { ...scope, ownerId: 'operator_service', authenticateOwner: async () => ({ ownerId: 'operator_service' }) };
    const denied = factory(db, foreignScope);
    await assert.rejects(() => denied.complete('reconciliation', digest, {}, 'fabricated'), /unauthorized/);
    const authorized = factory(db, { ...foreignScope, authorizeReconciliation: async input => input.receiptId === 'verified_receipt' && input.key === 'reconciliation' && input.claimOwnerId === 'data_service' });
    await authorized.complete('reconciliation', digest, { resolved: true }, 'verified_receipt');
    await assert.rejects(() => store.complete('reconciliation', digest, { resolved: true }), /immutable/);
    await assert.rejects(() => db.query("DELETE FROM evaluation_data_persistence.operations WHERE operation_key = 'reconciliation'"), /immutable/);
  });
  await check('durable cost and independent review survive native server restart', async () => {
    await store.claim('generation:cost', digest); await store.complete('generation:cost', digest, { measured: true, microUsd: 17, externalId: 'provider_receipt' });
    await store.claim('authenticated_review', digest); await store.complete('authenticated_review', digest, { authority: 'authenticated_human', principalId: 'human_fixture', requestDigest: digest });
    const keys = ['generation', 'generation:cost', 'authenticated_review', 'reconciliation', 'lost_ack'];
    const expected = await Promise.all(keys.map(k => store.get(k)));
    await Promise.all(pools.map(p => p.end())); pools.length = 0;
    await server.stop(); await server.start();
    const restarted = factory(makeDb(), scope);
    assert.deepEqual(await Promise.all(keys.map(k => restarted.get(k))), expected);
    assert.equal((await restarted.claim('generation', digest)).claimed, false);
  });
  console.log(JSON.stringify({ tests, skipped: 0, independentSessions: 8, postgresRuntime: JSON.parse(await readFile(join(dirname(runtimeRequire.resolve('embedded-postgres')), '../package.json'), 'utf8')).version,
    pg: runtimeRequire('pg/package.json').version, sourceHashes: hashes, migrationSha256: createHash('sha256').update(migration).digest('hex') }, null, 2));
} finally {
  await Promise.all(pools.map(p => p.end()));
  if (server?.process) await server.stop();
  if (!server?.process) await rm(work, { recursive: true, force: true });
}
