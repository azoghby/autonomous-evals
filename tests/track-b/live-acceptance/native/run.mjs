#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verify } from '../../postgres-live/verify.mjs';
import { verifyCheckpoints } from '../../postgres-live/checkpoints.mjs';
import { verifyRecovery } from './verify-recovery.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../../..');
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--harness' || args[2] !== '--track-a-ref' || !/^[0-9a-f]{40}$/.test(args[3])) throw new Error('Usage: node tests/track-b/live-acceptance/native/run.mjs --harness /absolute/path/to/installed/track-b-harness --track-a-ref <40-character-local-commit>');
if (userInfo().uid === 0) throw new Error('Run as an ordinary user; this runner never creates OS users.');
const harness = resolve(args[1]);
const requireHarness = createRequire(join(harness, 'package.json'));

const work = await mkdtemp(join(tmpdir(), 'track-b-live-acceptance-'));
const cleanEnv = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'SystemRoot'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
let server;
try {
  const runtime = join(work, 'runtime');
  const platformPackage = `@embedded-postgres/${process.platform}-${process.arch}`;
  const installed = spawnSync('npm', ['install', '--prefix', runtime, '--no-audit', '--no-fund', '--save-exact', 'embedded-postgres@18.6.0-beta.19', `${platformPackage}@18.6.0-beta.19`, 'pg@8.16.3', 'typescript@5.9.3'], { env: cleanEnv, encoding: 'utf8', timeout: 120000 });
  if (installed.status !== 0) throw new Error('Disposable native PostgreSQL runtime install failed. No acceptance checks passed.');
  const requireRuntime = createRequire(join(runtime, 'package.json'));
  const { default: EmbeddedPostgres } = await import(pathToFileURL(requireRuntime.resolve('embedded-postgres')));
  const { Pool } = requireRuntime('pg');
  const ts = requireRuntime('typescript');
  for (const name of await readdir(join(harness, 'node_modules'))) {
    if (name === '.bin') continue;
    try { await symlink(join(harness, 'node_modules', name), join(runtime, 'node_modules', name)); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const stage = join(work, 'stage'), compiled = join(work, 'compiled');
  await mkdir(stage); await mkdir(compiled);
  for (const dir of [stage, compiled]) {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
    await symlink(join(runtime, 'node_modules'), join(dir, 'node_modules'));
  }
  await cp(join(repo, 'packages/core/src'), join(stage, 'src'), { recursive: true });
  const sourceHashes = {};
  const contractRef = args[3];
  const tree = spawnSync('git', ['ls-tree', '-r', '--name-only', contractRef, '--', 'packages/core/src/contracts'], { cwd: repo, encoding: 'utf8', timeout: 10000 });
  assert.equal(tree.status, 0, 'Pinned local Track A contracts unavailable');
  const contractPaths = tree.stdout.trim().split('\n').filter(p => p.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(p));
  assert.ok(contractPaths.includes('packages/core/src/contracts/index.ts'), 'Pinned Track A contract index absent');
  for (const path of contractPaths) {
    assert.ok(/^packages\/core\/src\/contracts\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.ts$/.test(path), 'Unsafe contract path');
    const blob = spawnSync('git', ['show', `${contractRef}:${path}`], { cwd: repo, encoding: 'utf8', timeout: 10000 });
    assert.equal(blob.status, 0, 'Pinned contract blob unavailable');
    const rel = path.slice('packages/core/'.length);
    await mkdir(dirname(join(stage, rel)), { recursive: true });
    await mkdir(dirname(join(compiled, rel)), { recursive: true });
    await writeFile(join(stage, rel), blob.stdout);
    await writeFile(join(compiled, rel.replace(/\.ts$/, '.js')), ts.transpileModule(blob.stdout, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
    sourceHashes[`${path}@${contractRef}`] = createHash('sha256').update(blob.stdout).digest('hex');
  }
  async function compile(source, destination) {
    await mkdir(destination, { recursive: true });
    for (const entry of await readdir(source, { withFileTypes: true })) {
      const input = join(source, entry.name);
      if (entry.isDirectory()) await compile(input, join(destination, entry.name));
      else if (entry.name.endsWith('.ts') && !/\.(test|spec|d)\.ts$/.test(entry.name)) {
        const sourceText = await readFile(input, 'utf8');
        sourceHashes[input.slice(repo.length + 1)] = createHash('sha256').update(sourceText).digest('hex');
        await writeFile(join(destination, entry.name.replace(/\.ts$/, '.js')), ts.transpileModule(sourceText, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
      }
    }
  }
  await compile(join(repo, 'packages/core/src'), join(compiled, 'src'));
  const reservation = createServer();
  await new Promise((ok, fail) => { reservation.once('error', fail); reservation.listen(0, '127.0.0.1', ok); });
  const port = reservation.address().port;
  await new Promise(ok => reservation.close(ok));
  const config = { host: '127.0.0.1', port, user: 'postgres', password: randomBytes(24).toString('hex'), database: 'track_b_acceptance' };
  server = new EmbeddedPostgres({ databaseDir: join(work, 'data'), port, user: config.user, password: config.password,
    persistent: true, createPostgresUser: false, autoRehydrateSymlinks: true,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    postgresFlags: ['-h', '127.0.0.1', '-k', work, '-c', 'fsync=on', '-c', 'synchronous_commit=on', '-c', 'full_page_writes=on'],
    onLog() {}, onError() {},
  });
  await server.initialise(); await server.start(); await server.createDatabase(config.database);
  const load = p => import(pathToFileURL(join(compiled, 'src', p)));
  const { PostgresBranchLedger } = await load('simulator/branch-ledger.js');
  const { pooledCalendarDatabase } = await load('simulator/pool.js');
  const restart = async () => { await server.stop(); await server.start(); };
  const migration = p => readFile(join(repo, 'packages/core/src', p), 'utf8');
  const lock = JSON.parse(await readFile(join(runtime, 'package-lock.json'), 'utf8'));
  const integrity = name => Object.entries(lock.packages).find(([key]) => key.endsWith(`node_modules/${name}`))?.[1]?.integrity;
  assert.ok(integrity(platformPackage));
  console.log(JSON.stringify({ runtime: 'embedded-postgres@18.6.0-beta.19', platformPackage, platformIntegrity: integrity(platformPackage), node: process.version, typescript: ts.version,
    scope: 'LOCAL_NATIVE_SQL_AND_LOOPBACK_TLS_ONLY; no external providers', sourceHashes }, null, 2));
  await verify({ Pool, config, PostgresBranchLedger, pooledCalendarDatabase,
    migration: await migration('simulator/ledger-migrations/001_branch_ownership.sql'), restart });
  const { PostgresTextCheckpointStore } = await load('evals/integration/checkpoints.js');
  await verifyCheckpoints({ Pool, config, Store: PostgresTextCheckpointStore, database: pooledCalendarDatabase,
    migration: await migration('evals/integration/migrations/001-text-integration.sql'), restart });
  const { PostgresWorkflowInvestigationJournal } = await load('simulator/workflow/postgres-journal.js');
  const { createPostgresConversationPort } = await load('reporting/chat/postgres-conversations.js');
  await verifyRecovery({ Pool, config, Journal: PostgresWorkflowInvestigationJournal, conversations: createPostgresConversationPort,
    database: pooledCalendarDatabase, migrations: await Promise.all(['simulator/workflow/persistence-migrations/001-workflow-investigation-journals.sql', 'reporting/chat/persistence-migrations/001-conversations.sql'].map(migration)), restart });
  const selected = ['src/targets/tls.test.ts', 'src/reporting/chat/postgres-conversations.test.ts', 'src/evals/text/__tests__/live-v3.test.ts', 'src/targets/remediation.test.ts', 'src/evals/remediation/remediation.test.ts'];
  const output = join(stage, 'vitest-results.json');
  await server.createDatabase('track_b_chat_vitest');
  const url = new URL(`postgresql://127.0.0.1:${port}/track_b_chat_vitest`); url.username = config.user; url.password = config.password;
  const result = spawnSync(process.execPath, [join(harness, 'node_modules/vitest/vitest.mjs'), 'run', ...selected, '--root', stage, '--maxWorkers=1', '--reporter=default', '--reporter=json', `--outputFile.json=${output}`], {
    env: { ...cleanEnv, CHAT_PERSISTENCE_TEST_DATABASE_URL: url.href }, cwd: stage, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024,
  });
  // Strip the private disposable connection reference before surfacing failure diagnostics.
  if (result.status !== 0) console.error(`${result.stdout ?? ''}\n${result.stderr ?? ''}`.replaceAll(url.href, '[private-local-db]').replaceAll(config.password, '[redacted]'));
  assert.equal(result.status, 0, 'Selected local Vitest integration failed; raw output suppressed to avoid credential disclosure');
  const report = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(report.testResults.length, selected.length);
  for (const name of selected) {
    const entry = report.testResults.find(r => r.name.endsWith(name));
    assert.ok(entry?.assertionResults.length, `Missing test file ${name}`);
    assert.ok(entry.assertionResults.every(r => r.status === 'passed'), `Incomplete test file ${name}`);
    console.log(`LOCAL VITEST PASS ${name}: ${entry.assertionResults.length}/${entry.assertionResults.length}; zero skipped`);
  }
  console.log('NATIVE ACCEPTANCE PASS: existing SQL concurrency/checkpoints, native journal/chat restart, real local TLS; external-provider acceptance NOT RUN.');
} finally {
  if (server?.process) await server.stop();
  if (!server?.process) await rm(work, { recursive: true, force: true });
  console.log(`LOCAL CLEANUP stopped=${!server?.process}; disposable directory removed=${!server?.process}`);
}
