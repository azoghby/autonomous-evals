import { mkdtemp, mkdir, readdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes, createHash } from 'node:crypto';
import { verify } from './verify.mjs';
import { verifyCheckpoints } from './checkpoints.mjs';

// Installs only in a disposable directory; no repository dependency changes.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const harness = resolve(process.env.TRACK_B_HARNESS ?? join(repo, 'tests/track-b'));
const requireHarness = createRequire(join(harness, 'package.json'));
const ts = requireHarness('typescript');
if (userInfo().uid === 0) throw new Error('Run as an ordinary user; this runner never creates OS users.');
const work = await mkdtemp('/tmp/track-b-postgres-live-');
let server;
let stopped = false;
const logs = [];
try {
  const runtime = join(work, 'runtime');
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  const platformPackage = `@embedded-postgres/${platform}-${process.arch}`;
  const installed = spawnSync('npm', ['install', '--prefix', runtime, '--no-audit', '--no-fund', '--save-exact', 'embedded-postgres@18.6.0-beta.19', `${platformPackage}@18.6.0-beta.19`, 'pg@8.16.3'], { encoding: 'utf8', timeout: 120000 });
  if (installed.status !== 0) throw new Error(`Temporary runtime install failed: ${installed.stderr}`);
  const requireRuntime = createRequire(join(runtime, 'package.json'));
  const { default: EmbeddedPostgres } = await import(pathToFileURL(requireRuntime.resolve('embedded-postgres')));
  const { Pool } = requireRuntime('pg');
  const stage = join(work, 'stage');
  await mkdir(stage);
  await writeFile(join(stage, 'package.json'), JSON.stringify({ type: 'module' }));
  await symlink(join(harness, 'node_modules'), join(stage, 'node_modules'));
  // Compile a byte-for-byte source snapshot; never patch production inputs.
  const hashes = {};
  async function compile(source, destination) {
    await mkdir(destination, { recursive: true });
    for (const entry of await readdir(source, { withFileTypes: true })) {
      const input = join(source, entry.name);
      if (entry.isDirectory()) await compile(input, join(destination, entry.name));
      else if (entry.name.endsWith('.ts') && !/\.(test|spec|d)\.ts$/.test(entry.name)) {
        const text = await readFile(input, 'utf8');
        hashes[input.slice(repo.length + 1)] = createHash('sha256').update(text).digest('hex');
        await writeFile(join(destination, entry.name.replace(/\.ts$/, '.js')), ts.transpileModule(text, {
          compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
        }).outputText);
      }
    }
  }
  await compile(join(repo, 'packages/core/src'), join(stage, 'src'));
  const reservation = createServer();
  await new Promise((ok, fail) => { reservation.once('error', fail); reservation.listen(0, '127.0.0.1', ok); });
  const port = reservation.address().port;
  await new Promise((ok) => reservation.close(ok));
  // There is a small port selection race; a bind failure must fail, never use another DB.
  const config = { host: '127.0.0.1', port, user: 'postgres', password: randomBytes(24).toString('hex'), database: 'track_b_live' };
  server = new EmbeddedPostgres({ databaseDir: join(work, 'data'), port, user: config.user, password: config.password,
    persistent: true, createPostgresUser: false, autoRehydrateSymlinks: true,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    postgresFlags: ['-h', '127.0.0.1', '-k', work, '-c', 'fsync=on', '-c', 'synchronous_commit=on', '-c', 'full_page_writes=on'],
    onLog: (line) => logs.push(String(line)), onError: (line) => logs.push(String(line)),
  });
  await server.initialise();
  await server.start();
  await server.createDatabase(config.database);
  const { PostgresBranchLedger } = await import(pathToFileURL(join(stage, 'src/simulator/branch-ledger.js')));
  const { pooledCalendarDatabase } = await import(pathToFileURL(join(stage, 'src/simulator/pool.js')));
  const migration = await readFile(join(repo, 'packages/core/src/simulator/ledger-migrations/001_branch_ownership.sql'), 'utf8');
  const lock = JSON.parse(await readFile(join(runtime, 'package-lock.json'), 'utf8'));
  // npm can canonicalize /tmp to /private/tmp in lock keys on macOS.
  const integrity = (name) => {
    const entry = Object.entries(lock.packages).find(([key]) => key.endsWith(`node_modules/${name}`))?.[1];
    assertIntegrity(entry, name);
    return entry.integrity;
  };
  function assertIntegrity(entry, name) {
    if (!entry?.integrity) throw new Error(`Missing npm integrity for ${name}`);
  }
  console.log(JSON.stringify({ platform: process.platform, arch: process.arch, node: process.version,
    runtime: 'embedded-postgres@18.6.0-beta.19', pg: requireRuntime('pg/package.json').version,
    runtimeIntegrity: integrity('embedded-postgres'),
    platformPackage, platformIntegrity: integrity(platformPackage),
    typescript: ts.version, port, sourceHashes: Object.fromEntries(Object.entries(hashes).filter(([key]) => /simulator\/(branch-ledger|pool)\.ts$/.test(key))),
    migrationSha256: createHash('sha256').update(migration).digest('hex') }, null, 2));
  await verify({ Pool, config, PostgresBranchLedger, pooledCalendarDatabase, migration,
    restart: async () => { await server.stop(); await server.start(); } });
  const { PostgresTextCheckpointStore } = await import(pathToFileURL(join(stage, 'src/evals/integration/checkpoints.js')));
  const checkpointMigration = await readFile(join(repo, 'packages/core/src/evals/integration/migrations/001-text-integration.sql'), 'utf8');
  console.log(JSON.stringify({ checkpointSourceSha256: hashes['packages/core/src/evals/integration/checkpoints.ts'],
    checkpointMigrationSha256: createHash('sha256').update(checkpointMigration).digest('hex') }));
  await verifyCheckpoints({ Pool, config, Store: PostgresTextCheckpointStore, database: pooledCalendarDatabase,
    migration: checkpointMigration, restart: async () => { await server.stop(); await server.start(); } });
} catch (error) {
  console.error(logs.slice(-12).join(''));
  throw error;
} finally {
  if (server?.process) { await server.stop(); stopped = true; }
  // Never remove a running server's data.
  if (!server?.process) await rm(work, { recursive: true, force: true });
  console.log(`Cleanup: server stopped=${stopped}; disposable directory removed=${!server?.process}`);
}
