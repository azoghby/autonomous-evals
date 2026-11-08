import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../../..');
const modules = process.env.TRACK_B_REVIEW_NODE_MODULES ?? resolve(repo, 'tests/track-b/node_modules');
const ref = process.argv[2] ?? '8634ceb30f3d98de7ec24b240a4f7549dce80033';
function git(args) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}
const sha = git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
const stage = await mkdtemp(join(tmpdir(), 'calendar-security-assurance-'));
try {
  console.log(`Source ${git(['rev-parse', 'HEAD'])}; local contracts ${sha}`);
  for (const dir of ['agents', 'evals', 'reporting', 'targets', 'simulator', 'monitoring', 'judges']) {
    await cp(join(repo, 'packages/core/src', dir), join(stage, 'src', dir), { recursive: true, filter: p => !/\.(test|spec)\.ts$/.test(p) });
  }
  for (const p of git(['ls-tree', '-r', '--name-only', sha, '--', 'packages/core/src/contracts']).split('\n')) {
    if (!p.endsWith('.ts') || /\.(test|spec)\.ts$/.test(p)) continue;
    const dest = join(stage, 'src/contracts', p.slice('packages/core/src/contracts/'.length));
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, git(['show', `${sha}:${p}`]) + '\n');
  }
  await mkdir(join(stage, 'review'));
  for (const p of ['boundaries.test.ts']) await cp(join(here, p), join(stage, 'review', p));
  await symlink(modules, join(stage, 'node_modules'), 'dir');
  await writeFile(join(stage, 'package.json'), JSON.stringify({ type: 'module', private: true }));
  await writeFile(join(stage, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, noEmit: true, skipLibCheck: true, esModuleInterop: true, types: ['node'] }, include: ['src/**/*.ts', 'review/**/*.ts'] }));
  for (const [p, args] of [
    ['typescript/bin/tsc', ['--project', join(stage, 'tsconfig.json')]],
    ['vitest/vitest.mjs', ['run', '--root', stage, '--maxWorkers=1', '--testTimeout=30000', '--hookTimeout=30000', '--reporter=default', '--reporter=json', `--outputFile.json=${join(stage, 'results.json')}`]],
  ]) {
    const r = spawnSync(process.execPath, [join(modules, p), ...args], { cwd: stage, stdio: 'inherit' });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`${p}: ${r.status}`);
  }
  const r = JSON.parse(await readFile(join(stage, 'results.json'), 'utf8'));
  const assertions = r.testResults.flatMap(f => f.assertionResults);
  if (r.testResults.length !== 1 || assertions.length !== 15 || assertions.some(a => a.status !== 'passed')) throw new Error('Missing/failed/skipped tests');
  console.log('15 passed: 14 acceptance/regression, 1 explicitly labeled defect characterization. Green does not mean the characterized defect is fixed.');
} finally { await rm(stage, { recursive: true, force: true }); }
