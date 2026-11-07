// Offline review runner: isolated staging, existing dependency cache, no installs/network.
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const own = dirname(fileURLToPath(import.meta.url));
const repo = resolve(own, '../../..');
const dependencies = process.env.TRACK_B_REVIEW_NODE_MODULES ?? '/tmp/autonomous-evals-checks.m10du4/node_modules';
const ref = 'be522f1e13e697017bac96728748b82cadc08ab9';
const stage = await mkdtemp(join(tmpdir(), 'progress-review-'));
function run(command, args, cwd = stage) {
  const r = spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 16 * 1024 * 1024 });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.error || r.status !== 0) throw r.error ?? new Error(`${command} failed: ${r.status}`);
  return r.stdout;
}
try {
  const src = join(stage, 'packages/core/src');
  await mkdir(src, { recursive: true });
  for (const dir of ['agents', 'evals', 'reporting', 'simulator', 'targets']) {
    await cp(join(repo, 'packages/core/src', dir), join(src, dir), { recursive: true,
      filter: path => !/\.(test|spec)\.[cm]?[jt]sx?$/.test(path) || path.includes('/reporting/') || path.includes('/evals/data/') || path.includes('/evals/integration/') });
  }
  const git = args => spawnSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const listing = git(['ls-tree', '-r', '--name-only', ref, '--', 'packages/core/src/contracts']);
  if (listing.status !== 0) throw new Error('Pinned contracts unavailable locally');
  for (const path of listing.stdout.trim().split('\n').filter(p => p.endsWith('.ts') && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(p))) {
    const blob = git(['show', `${ref}:${path}`]); if (blob.status !== 0) throw new Error('Cannot read pinned contract');
    await mkdir(dirname(join(stage, path)), { recursive: true }); await writeFile(join(stage, path), blob.stdout);
  }
  const tests = join(stage, 'tests/track-b/progress-projection-review');
  await mkdir(tests, { recursive: true }); await cp(join(own, 'review.test.ts'), join(tests, 'review.test.ts'));
  await symlink(dependencies, join(stage, 'node_modules'), 'dir');
  await writeFile(join(stage, 'package.json'), '{"private":true,"type":"module"}');
  await writeFile(join(stage, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, noEmit: true, skipLibCheck: true, esModuleInterop: true, resolveJsonModule: true, isolatedModules: true, types: ['node'] }, include: ['packages/**/*.ts', 'tests/**/*.ts'] }));
  run(process.execPath, [join(stage, 'node_modules/typescript/bin/tsc'), '--noEmit']);
  run(process.execPath, [join(stage, 'node_modules/vitest/vitest.mjs'), 'run', '--maxWorkers=1', '--reporter=default', '--reporter=json', '--outputFile=results.json']);
  const report = JSON.parse(await readFile(join(stage, 'results.json'), 'utf8'));
  if (report.numPendingTests || report.numTodoTests || report.numFailedTests || !report.numPassedTests) throw new Error('Incomplete tests');
  console.log(`Strict types passed. ${report.numPassedTests} tests in ${report.testResults.length} files; none skipped. Contracts: ${ref}.`);
} finally { await rm(stage, { recursive: true, force: true }); }
