#!/usr/bin/env node
/** Local native PostgreSQL only. Explicit installed runtime path; never reads .env/DB URLs. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const args = process.argv.slice(2);
assert.equal(args.length, 2, 'Usage: node tests/track-b/migration-registry-adoption/run.mjs --runtime /absolute/installed/runtime');
assert.equal(args[0], '--runtime'); assert.ok(args[1].startsWith('/'));
const runtime = resolve(args[1]);
const cleanEnv = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, LANG: 'C', LC_ALL: 'C' };
// Discard inherited environment before importing pg; its defaults may otherwise consult PG* configuration.
process.env = { ...cleanEnv };
const requireRuntime = createRequire(join(runtime, 'package.json'));
const { Client } = requireRuntime('pg');
const { initdb, pg_ctl } = await import(pathToFileURL(requireRuntime.resolve(`@embedded-postgres/${process.platform}-${process.arch}`)));
const work = await mkdtemp('/private/tmp/mra-');
const data = join(work, 'data'), socket = join(work, 'sock');
await mkdir(socket);
const command = (file, argv) => {
  const result = spawnSync(file, argv, { env: cleanEnv, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, `${file}: ${result.stderr || result.stdout}`); return result.stdout;
};
const port = 20000 + Math.floor(Math.random() * 30000);
const start = () => command(pg_ctl, ['-D', data, '-l', join(work, 'server.log'), '-o', `-h '' -k ${socket} -p ${port} -c fsync=on -c synchronous_commit=on -c full_page_writes=on`, '-w', 'start']);
const stop = mode => command(pg_ctl, ['-D', data, '-m', mode, '-w', 'stop']);
const clients = new Set();
const connect = async name => {
  const client = new Client({ host: socket, port, database: 'postgres', user: 'owner', password: 'unused-local-trust', ssl: false, application_name: name,
    connectionTimeoutMillis: 5000, statement_timeout: 12000 });
  client.on('error', () => {}); await client.connect(); clients.add(client); return client;
};
const close = async client => { clients.delete(client); await client.end().catch(() => {}); };
const digest = value => createHash('sha256').update(value).digest('hex');
const gate = () => { let release; return { promise: new Promise(r => { release = r; }), release: () => release() }; };
const outcome = promise => promise.then(value => ({ value }), error => ({ error }));
let running = false, passed = 0;
const test = async (name, fn) => { await fn(); console.log(`PASS ${++passed}: ${name}`); };
try {
  command(initdb, ['-D', data, '-U', 'owner', '-A', 'trust', '--encoding=UTF8', '--locale=C']);
  start(); running = true;
  const executor = await import('../../../docs/migration-registry-adoption/executor.mjs');
  // API-specific tests follow; all clients above are independently connected PostgreSQL backends.
  let seq = 0;
  const observer = await connect('adoption-observer');
  const a = await connect('adoption-owner-a'), b = await connect('adoption-owner-b');
  assert.notEqual((await a.query('SELECT pg_backend_pid() AS pid')).rows[0].pid, (await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
  const identity = async client => (await client.query(executor.IDENTITY_SQL)).rows[0];
  async function fixture(sqls, { aliases = {}, owners = [], after = [] } = {}) {
    const n = ++seq, root = join(work, `fixture${n}`); await mkdir(root);
    const table = `mra_registry_${n}`; await observer.query(`CREATE TABLE public.${table}(id text, database text, sha256 text, state text)`);
    const application = [];
    for (const [i, sql] of sqls.entries()) {
      const sourcePath = `source${i}.sql`, canonicalPath = `canonical${i}.sql`;
      await writeFile(join(root, sourcePath), sql); await writeFile(join(root, canonicalPath), sql);
      application.push({ id: `app.fixture${n}.${i}`, database: 'application', sourcePath, canonicalPath, sha256: digest(sql), transactionOwner: owners[i] ?? 'runner', after: after[i] ?? [] });
    }
    await writeFile(join(root, 'sim.sql'), 'SELECT 1;');
    const manifest = { format: 1, application, separateSimulator: { id: 'simulator.fixture', database: 'isolated-calendar-only', sourcePath: 'sim.sql', sha256: digest('SELECT 1;'), transactionOwner: 'runner' }, identityAliases: Object.fromEntries(Object.entries(aliases).map(([alias, index]) => [alias, application[index].id])) };
    const manifestPath = join(root, 'manifest.json'), bytes = JSON.stringify(manifest); await writeFile(manifestPath, bytes);
    const options = { client: a, manifestPath, sqlRoot: root, expectedManifestSha256: digest(bytes), database: 'application', expectedIdentity: await identity(a), registryTable: `public.${table}`, lockKey: '4389251741' };
    const insert = async (id, hash = application[0].sha256, state = 'applied') => observer.query(`INSERT INTO public.${table} VALUES ($1,'application',$2,$3)`, [id, hash, state]);
    const rows = async () => (await observer.query(`SELECT * FROM public.${table} ORDER BY id`)).rows;
    const plan = async () => executor.planAdoption(options);
    const apply = async (p, extra = {}) => executor.applyAdoption({ ...options, expectedRegistrySha256: p.registrySha256, expectedContextSha256: p.contextSha256, approvedActions: p.actions, authorize: true, ...extra });
    return { n, root, table, manifest, options, insert, rows, plan, apply };
  }
  const missing = async table => assert.equal((await observer.query('SELECT to_regclass($1) AS t', [`public.${table}`])).rows[0].t, null);
  const blocked = async fn => {
    try { const p = await fn(); assert.ok(p.blockedIssues?.length, 'Expected refusal or blockedIssues'); }
    catch (error) { if (error.code === 'ERR_ASSERTION') throw error; }
  };
  await test('read-only plan is default; explicit owner authorization required before transactional execution', async () => {
    const f = await fixture(['CREATE TABLE public.mra_default (id int);']);
    const p = await f.plan(); assert.equal(p.blockedIssues.length, 0); await missing('mra_default'); assert.deepEqual(await f.rows(), []);
    await assert.rejects(f.apply(p, { authorize: false })); await missing('mra_default');
    await f.apply(p); assert.equal((await f.rows()).length, 1);
    const again = await f.plan(); assert.equal(again.actions.length, 0);
    await f.apply(again); assert.equal((await f.rows()).length, 1);
  });
  await test('alias adoption skips already applied SQL only when exact hash and state match; no duplicate DDL', async () => {
    const f = await fixture(['CREATE TABLE public.mra_alias (id int);'], { aliases: { 'app.historical.alias': 0 } });
    await observer.query('CREATE TABLE public.mra_alias (id int); INSERT INTO public.mra_alias VALUES (41)');
    await f.insert('app.historical.alias'); const p = await f.plan(); assert.equal(p.blockedIssues.length, 0);
    await f.apply(p); assert.deepEqual((await f.rows()).map(x => x.id), [f.manifest.application[0].id]);
    assert.equal((await observer.query('SELECT id FROM public.mra_alias')).rows[0].id, 41);
    const wrong = await fixture(['CREATE TABLE public.mra_wrong_alias (id int);'], { aliases: { 'app.historical.wrong': 0 } });
    await wrong.insert('app.historical.wrong', 'a'.repeat(64)); await blocked(wrong.plan); await missing('mra_wrong_alias');
  });
  await test('canonical plus alias, unknown identities, incomplete rows, and missing historical dependencies refuse', async () => {
    const f = await fixture(['SELECT 1;'], { aliases: { 'app.duplicate.alias': 0 } });
    await f.insert(f.manifest.application[0].id); await f.insert('app.duplicate.alias'); await blocked(f.plan);
    const unknown = await fixture(['SELECT 1;']); await unknown.insert('app.unknown'); await blocked(unknown.plan);
    const incomplete = await fixture(['SELECT 1;']); await incomplete.insert(incomplete.manifest.application[0].id, incomplete.manifest.application[0].sha256, 'inflight'); await blocked(incomplete.plan);
    const deps = await fixture(['SELECT 1;', 'SELECT 2;']);
    deps.manifest.application[1].after = [deps.manifest.application[0].id];
    const bytes = JSON.stringify(deps.manifest); await writeFile(deps.options.manifestPath, bytes); deps.options.expectedManifestSha256 = digest(bytes);
    await deps.insert(deps.manifest.application[1].id, deps.manifest.application[1].sha256); await blocked(deps.plan);
  });
  await test('changed SQL bytes, reviewed manifest digest, current registry digest, DB identity and approved action list refuse', async () => {
    const f = await fixture(['CREATE TABLE public.mra_changed (id int);']); const p = await f.plan();
    await writeFile(join(f.root, 'source0.sql'), 'SELECT 2;'); await assert.rejects(f.apply(p)); await missing('mra_changed');
    await writeFile(join(f.root, 'source0.sql'), 'CREATE TABLE public.mra_changed (id int);');
    await assert.rejects(f.apply(p, { expectedManifestSha256: 'a'.repeat(64) }));
    await assert.rejects(f.apply(p, { expectedRegistrySha256: 'b'.repeat(64) }));
    await assert.rejects(f.apply(p, { expectedIdentity: { ...f.options.expectedIdentity, databaseOid: '-1' } }));
    await assert.rejects(f.apply(p, { approvedActions: [] })); await missing('mra_changed');
    await f.insert('app.new.concurrent'); await assert.rejects(f.apply(p)); await missing('mra_changed');
  });
  await test('SQL error rolls back DDL and registry atomically', async () => {
    const f = await fixture(['CREATE TABLE public.mra_rollback (id int); SELECT * FROM public.mra_deliberately_missing;']);
    const p = await f.plan(); await assert.rejects(f.apply(p)); await missing('mra_rollback'); assert.deepEqual(await f.rows(), []);
  });
  await test('unregistered existing IF NOT EXISTS schema refuses inferred applied evidence', async () => {
    await observer.query('CREATE TABLE public.mra_unregistered (id int)');
    const f = await fixture(['CREATE TABLE IF NOT EXISTS public.mra_unregistered (id int);']);
    await blocked(async () => { const p = await f.plan(); return f.apply(p); }); assert.deepEqual(await f.rows(), []);
  });
  await test('transaction-control SQL cannot escape registry atomicity', async () => {
    const f = await fixture(['CREATE TABLE public.mra_escape (id int); COMMIT; CREATE TABLE public.mra_escape_after (id int);']);
    await blocked(async () => { const p = await f.plan(); if (p.blockedIssues.length) return p; return f.apply(p); });
    await missing('mra_escape'); await missing('mra_escape_after'); assert.deepEqual(await f.rows(), []);
  });
  await test('comments between SQL keywords cannot hide duplicate DDL or transaction controls', async () => {
    await observer.query('CREATE TABLE public.mra_comment_existing (id int)');
    const f = await fixture(['CREATE/**/TABLE IF NOT EXISTS public.mra_comment_existing (id int);']);
    await blocked(async () => { const p = await f.plan(); return f.apply(p); });
    assert.deepEqual(await f.rows(), []);
    const escape = await fixture(['START/**/TRANSACTION; SELECT 1;']); await blocked(escape.plan);
  });
  await test('exact five additive autonomy SQL files execute in order and preserve NULL authority without backfill', async () => {
    const files = ['operations', 'communications', 'access', 'paid', 'authority'];
    const sqls = await Promise.all(files.map(file => readFile(new URL(`../../../docs/migration-registry-adoption/sql/${file}.sql`, import.meta.url), 'utf8')));
    const f = await fixture(sqls);
    for (let i = 1; i < 5; i++) f.manifest.application[i].after = [f.manifest.application[i-1].id];
    const bytes = JSON.stringify(f.manifest); await writeFile(f.options.manifestPath, bytes); f.options.expectedManifestSha256 = digest(bytes);
    const p = await f.plan(); assert.equal(p.blockedIssues.length, 0); assert.equal(p.actions.length, 5);
    const wrapped = { query: async (text, values) => {
      const result = await a.query(text, values);
      if (text === sqls[2]) await a.query("INSERT INTO company_autonomy_release.job_bindings VALUES ('tenant','job','owner','policy','{}',false,0)");
      return result;
    } };
    await f.apply(p, { client: wrapped }); assert.equal((await f.rows()).length, 5);
    for (const table of ['company_autonomy.periods','company_autonomy.messages','company_autonomy_release.job_bindings','autonomous_paid_app.operations']) assert.ok((await observer.query('SELECT to_regclass($1) AS t', [table])).rows[0].t);
    assert.equal((await observer.query('SELECT authority_digest FROM company_autonomy_release.job_bindings')).rows[0].authority_digest, null);
    assert.equal((await f.plan()).actions.length, 0);
  });
  await test('artifact-owned BEGIN/COMMIT remains atomic with registry; SQL failure rolls back wrapper', async () => {
    const f = await fixture(['-- artifact wrapper\nBEGIN; CREATE TABLE public.mra_artifact (id int); COMMIT;'], { owners: ['artifact'] });
    const p = await f.plan(); await f.apply(p); assert.equal((await f.rows()).length, 1);
    const bad = await fixture(['BEGIN; CREATE TABLE public.mra_bad_artifact (id int); SELECT * FROM public.mra_missing_artifact; COMMIT;'], { owners: ['artifact'] });
    await assert.rejects(async () => bad.apply(await bad.plan())); await missing('mra_bad_artifact'); assert.deepEqual(await bad.rows(), []);
  });
  async function waitBlocked(pid, holder) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const row = (await observer.query('SELECT $2::int=ANY(pg_blocking_pids($1)) AS waiting', [pid, holder])).rows[0];
      if (row.waiting) return; await delay(10);
    }
    throw Error('Independent owner did not wait on native advisory lock');
  }
  await test('independent owner attempts serialize on native advisory lock and stale approval cannot duplicate DDL', async () => {
    const sql = 'CREATE TABLE public.mra_concurrent (id int);'; const f = await fixture([sql]); const p = await f.plan();
    const entered = gate(), release = gate();
    const wrapped = { query: async (text, values) => { const result = await a.query(text, values); if (text === sql) { entered.release(); await release.promise; } return result; } };
    const first = outcome(f.apply(p, { client: wrapped }));
    await Promise.race([entered.promise, first.then(x => { throw x.error ?? Error('Owner exited before DDL gate'); })]);
    const aPid = (await a.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const bPid = (await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const second = outcome(f.apply(p, { client: b }));
    try { await waitBlocked(bPid, aPid); assert.deepEqual(await f.rows(), []); }
    finally { release.release(); }
    assert.equal((await first).error, undefined); assert.ok((await second).error, 'Stale approved digest must fail after waiting'); assert.equal((await f.rows()).length, 1);
  });
  await test('backend crash rolls back uncommitted DDL/registry and fresh owner safely retries after server restart', async () => {
    const sql = 'CREATE TABLE public.mra_crash (id int);'; const f = await fixture([sql]); const p = await f.plan();
    const crashClient = await connect('adoption-crash-owner'); const pid = (await crashClient.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const entered = gate(), release = gate();
    const wrapped = { query: async (text, values) => { const result = await crashClient.query(text, values); if (text === sql) { entered.release(); await release.promise; } return result; } };
    const attempt = outcome(f.apply(p, { client: wrapped }));
    await Promise.race([entered.promise, attempt.then(x => { throw x.error ?? Error('Owner exited before crash gate'); })]);
    assert.equal((await observer.query('SELECT pg_terminate_backend($1,5000) AS killed', [pid])).rows[0].killed, true);
    release.release(); assert.ok((await attempt).error); await missing('mra_crash'); assert.deepEqual(await f.rows(), []);
    await Promise.all([...clients].map(close)); stop('immediate'); running = false; start(); running = true;
    const resumed = await connect('adoption-resumed-owner');
    f.options.client = resumed;
    assert.deepEqual(await identity(resumed), f.options.expectedIdentity);
    const newPlan = await executor.planAdoption(f.options); assert.equal(newPlan.blockedIssues.length, 0);
    await executor.applyAdoption({ ...f.options, authorize: true, expectedRegistrySha256: newPlan.registrySha256, expectedContextSha256: newPlan.contextSha256, approvedActions: newPlan.actions });
    assert.equal((await resumed.query(`SELECT count(*)::int AS count FROM public.${f.table}`)).rows[0].count, 1);
    assert.ok((await resumed.query("SELECT to_regclass('public.mra_crash') AS t")).rows[0].t);
    const applied = await executor.planAdoption(f.options); assert.equal(applied.actions.length, 0);
  });
  console.log(`RESULT ${passed}/${passed} native PostgreSQL checks passed; zero skipped; independent connections and server crash recovery; no external DB/provider calls.`);
} finally {
  await Promise.all([...clients].map(close));
  if (running) stop('immediate');
  await rm(work, { recursive: true, force: true });
}
