// Offline, targeted suite only. Stages real production code; never installs or fetches.
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const own = dirname(fileURLToPath(import.meta.url)), repo = resolve(own, '../../../..');
const dependencies = process.env.TRACK_B_REVIEW_NODE_MODULES ?? '/tmp/autonomous-evals-checks.m10du4/node_modules';
const contractsRef = 'be522f1e13e697017bac96728748b82cadc08ab9';
const stage = await mkdtemp(join(tmpdir(), 'identity-assurance-'));
function run(command, args, cwd = stage) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) throw result.error ?? new Error(`Exit ${result.status}: ${command}`);
  return result.stdout;
}
try {
  await mkdir(join(stage, 'packages/core/src'), { recursive: true });
  for (const dir of await readdir(join(repo, 'packages/core/src'))) {
    await cp(join(repo, 'packages/core/src', dir), join(stage, 'packages/core/src', dir), {
      recursive: true, filter: path => !/\.(test|spec)\.[cm]?[jt]sx?$/.test(path),
    });
  }
  const listing = run('git', ['ls-tree', '-r', '--name-only', contractsRef, '--', 'packages/core/src/contracts'], repo);
  if (!listing.trim()) throw new Error('Pinned local contracts missing');
  for (const path of listing.trim().split('\n').filter(p => p.endsWith('.ts') && !p.endsWith('.test.ts'))) {
    const blob = spawnSync('git', ['show', `${contractsRef}:${path}`], { cwd: repo, encoding: 'utf8' });
    if (blob.status !== 0) throw new Error('Pinned contract read failed');
    const content = blob.stdout;
    await mkdir(dirname(join(stage, path)), { recursive: true }); await writeFile(join(stage, path), content);
  }
  const relative = 'tests/track-b/security-release-assurance/identity';
  await cp(own, join(stage, relative), { recursive: true, filter: path => !path.endsWith('.mjs') && !path.endsWith('.md') });
  await symlink(dependencies, join(stage, 'node_modules'), 'dir');
  await writeFile(join(stage, 'package.json'), '{"private":true,"type":"module"}');
  await writeFile(join(stage, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, noEmit: true,
    skipLibCheck: true, esModuleInterop: true, resolveJsonModule: true, isolatedModules: true, types: ['node'],
  }, include: ['packages/**/*.ts', 'tests/**/*.ts'] }));
  run(process.execPath, [join(stage, 'node_modules/typescript/bin/tsc'), '--noEmit']);
  run(process.execPath, [join(stage, 'node_modules/vitest/vitest.mjs'), 'run', relative, '--maxWorkers=1', '--testTimeout=30000', '--hookTimeout=30000', '--reporter=default', '--reporter=json', '--outputFile=results.json']);
  const report = JSON.parse(await readFile(join(stage, 'results.json'), 'utf8'));
  if (report.numPassedTests !== 7 || report.numPendingTests || report.numTodoTests || report.numFailedTests) throw new Error('Incomplete targeted suite');
  console.log(`Strict types passed. 4 acceptance + 3 defect-characterization tests passed; none skipped. Contracts: ${contractsRef}.`);
} finally { await rm(stage, { recursive: true, force: true }); }
