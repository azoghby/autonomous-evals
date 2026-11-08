import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
export const patches = [
  'docs/chat-workflow-release/restored/chat-release-verification/app-ui/restore-history.patch',
  'docs/chat-workflow-release/restored/chat-release-verification/app-ui/next-esm-compatibility.patch',
  'docs/chat-workflow-release/0002-app-source-compatibility.patch',
  'docs/chat-workflow-release/0003-explicit-benchmark-refusal.patch',
  'docs/release-packaging-integration/packages/track-a-manifests-lock.patch',
  'docs/controlled-acceptance-targets/0001-controlled-acceptance-targets.patch',
];
export const inputPaths = [...patches,
  'docs/release-packaging-integration/migrations/manifest.json',
  'docs/structured-progress-integration/backend/001-structured-progress.sql',
  'docs/workflow-integration/workflow-producers/migrations/002-rich-artifacts.sql',
  'docs/controlled-acceptance-targets/PATCH.json',
];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const migrationRenames = {
  'apps/web/migrations/003-remediation.sql': 'apps/web/migrations/004-workflow-remediation.sql',
  'apps/web/migrations/003-workflow-packs.sql': 'apps/web/migrations/005-workflow-packs.sql',
};

/** Apply to a disposable final composition only. No dependency installation or SQL execution. */
export function applyChat(stage) {
  for (const path of patches) {
    try {
      const exclusions = path.endsWith('0002-app-source-compatibility.patch') ? ['--exclude=apps/web/src/server/data-production.ts'] : [];
      execFileSync('git', ['apply', '--check', ...exclusions, join(root, path)], { cwd: stage, stdio: 'pipe' });
      execFileSync('git', ['apply', ...exclusions, join(root, path)], { cwd: stage, stdio: 'pipe' });
    } catch (error) {
      throw new Error(`Chat/build composition refused ${path}; review staged source against pinned input, do not force or skip hunks. ${error.stderr?.toString() ?? error.message}`, { cause: error });
    }
  }
  const dataPath = join(stage, 'apps/web/src/server/data-production.ts');
  let data = readFileSync(dataPath, 'utf8');
  for (const name of ['discovery', 'discovery/persistence']) {
    const before = `'@ae/core/evals/data/${name}'`;
    if (data.split(before).length !== 2) throw new Error(`Expected exactly one directory import to correct: ${before}`);
    data = data.replace(before, `'@ae/core/evals/data/${name}/index'`);
  }
  writeFileSync(dataPath, data);
  const deps = readFileSync(join(stage, 'packages/core/src/integration/eval-services.ts'), 'utf8');
  for (const required of ['NAIVE_BUDGET_PERIOD_ID', 'NAIVE_IDEMPOTENCY_NAMESPACE', 'directory: verified.directory', 'dryRun: true', 'version === undefined']) {
    if (!deps.includes(required)) throw new Error(`Exact Naive authority pin lost during chat composition: ${required}`);
  }
  return { patches, servercompat: 'Not replayed: complete bridge already owns hardened bootstrap and canonical cost sink.' };
}

/** Unique canonical identity and exact executable SQL order; produces files but never executes SQL. */
export function writeMigrationManifest(stage) {
  for (const [from, to] of Object.entries(migrationRenames)) {
    if (!existsSync(join(stage, from))) throw new Error(`Final migration composition incomplete: ${from}; apply remediation and pack layers first.`);
    if (existsSync(join(stage, to))) throw new Error(`Canonical migration target already exists: ${to}; refusing overwrite/replay.`);
    renameSync(join(stage, from), join(stage, to));
  }
  const prior = JSON.parse(readFileSync(join(root, inputPaths[6]), 'utf8'));
  const output = join(stage, 'owner-migrations');
  mkdirSync(output, { recursive: true });
  const application = [];
  function add(id, sourcePath, transactionOwner, after, origin = 'stage') {
    if (application.some(m => m.id === id)) throw new Error(`Duplicate migration identity: ${id}`);
    const bytes = readFileSync(join(origin === 'stage' ? stage : root, sourcePath));
    const canonicalPath = `owner-migrations/${id}.sql`;
    writeFileSync(join(stage, canonicalPath), bytes);
    application.push({ id, sourcePath, sourceOrigin: origin, canonicalPath, sha256: hash(bytes), transactionOwner, after, database: 'application' });
  }
  let baselineLast;
  for (const entry of prior.applicationBaseline.migrations) {
    const id = `app.baseline.${basename(entry.path, '.sql')}`;
    add(id, entry.path, 'owner-existing-process', baselineLast ? [baselineLast] : []);
    baselineLast = id;
  }
  const resolved = new Map();
  for (const entry of prior.application) {
    const id = `app.${entry.id}`;
    const sourcePath = entry.patchTarget ?? entry.path;
    const origin = sourcePath.startsWith('docs/') ? 'artifact' : 'stage';
    add(id, sourcePath, entry.transactionOwner, [baselineLast, ...entry.after.map(a => resolved.get(a))], origin);
    resolved.set(entry.id, id);
  }
  add('app.workflow-data.003', 'apps/web/migrations/003-workflow-data.sql', 'artifact', ['app.workflow002', 'app.data002']);
  add('app.workflow-remediation.004', 'apps/web/migrations/004-workflow-remediation.sql', 'artifact', ['app.workflow-data.003', 'app.journal']);
  add('app.workflow-packs.005', 'apps/web/migrations/005-workflow-packs.sql', 'artifact', ['app.workflow-remediation.004']);
  const seen = new Set();
  for (const entry of application) {
    for (const predecessor of entry.after) if (!seen.has(predecessor)) throw new Error(`Migration ${entry.id} has unsatisfied predecessor ${predecessor}`);
    seen.add(entry.id);
    const sql = readFileSync(join(stage, entry.canonicalPath), 'utf8');
    if (entry.transactionOwner === 'artifact' && !/^\s*(?:--[^\n]*\n|\s)*BEGIN\s*;/i.test(sql)) {
      // New data/remediation/pack migrations do not own transactions. Preserve the SQL's actual contract.
      entry.transactionOwner = 'runner';
    }
  }
  const simulatorBytes = readFileSync(join(stage, prior.simulatorSeed.path));
  const manifest = {
    format: 1, applied: false, deploymentAccepted: false, searchPath: prior.searchPath,
    identityRule: 'Full canonical ID plus SHA-256; never numeric-prefix or basename discovery.',
    migrationRenames, excludedChat: prior.excludedChat, application,
    separateSimulator: { id: 'simulator.calendar-seed', database: 'isolated-calendar-only', sourcePath: prior.simulatorSeed.path, sha256: hash(simulatorBytes), transactionOwner: prior.simulatorSeed.transactionOwner },
    prerequisites: [
      'Owner durable migration registry and exclusive lock; stop incompatible writers before historical cost reconciliation.',
      'Same-engine, same-role complete schema/catalog preflight and server-only grants; public, pg_catalog search_path.',
      'Runner-owned SQL: one pinned transaction per artifact. Artifact-owned SQL: idle dedicated session, no outer transaction.',
      'Core chat selected once; never apply the excluded documentation copy or auto-discover repeated numeric prefixes.',
      'Calendar endpoint and monitoring remain separate owner extension points; no deployment or acceptance is implied.',
    ],
  };
  writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
