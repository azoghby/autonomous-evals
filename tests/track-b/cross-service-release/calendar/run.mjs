import { cp, mkdir, mkdtemp, rm, symlink, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../../..');
const modules = process.env.TRACK_B_MODULES ?? join(here, '../../node_modules');
const args = process.argv.slice(2);
const ref = args.length === 0 ? '8634ceb30f3d98de7ec24b240a4f7549dce80033' : args[0] === '--track-a-ref' && args.length === 2 ? args[1] : null;
if (!ref || ref.startsWith('-')) throw new Error('Usage: node run.mjs [--track-a-ref <local-git-ref>]');
function git(args) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
const sha = git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
console.log(`Review source HEAD: ${git(['rev-parse', 'HEAD'])}; local contracts: ${sha}`);
const stage = await mkdtemp(join(tmpdir(), 'calendar-cross-service-release-'));
const tests = [];
try {
  for (const dir of ['agents', 'evals', 'reporting', 'targets', 'simulator', 'monitoring', 'judges']) {
    await cp(join(repo, 'packages/core/src', dir), join(stage, 'packages/core/src', dir), {
      recursive: true, filter: path => !/\.(test|spec)\.ts$/.test(path),
    });
  }
  for (const file of git(['ls-tree', '-r', '--name-only', sha, '--', 'packages/core/src/contracts']).split('\n')) {
    if (!file.endsWith('.ts') || /\.(test|spec)\.ts$/.test(file)) continue;
    const dest = join(stage, 'packages/core/src/contracts', file.slice('packages/core/src/contracts/'.length));
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, git(['show', `${sha}:${file}`]) + '\n');
  }
  const scoped = 'tests/track-b/cross-service-release/calendar';
  await cp(here, join(stage, scoped), { recursive: true });
  tests.push(`${scoped}/calendar.test.ts`);
  await symlink(modules, join(stage, 'node_modules'), 'dir');
  await writeFile(join(stage, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await writeFile(join(stage, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true,
    noEmit: true, skipLibCheck: true, esModuleInterop: true, types: ['node'],
  }, include: ['packages/core/src/**/*.ts', 'tests/**/*.ts'] }));
  for (const [program, args] of [
    ['typescript/bin/tsc', ['--project', join(stage, 'tsconfig.json')]],
    ['vitest/vitest.mjs', ['run', ...tests, '--root', stage, '--maxWorkers=1', '--reporter=default', '--reporter=json', `--outputFile.json=${join(stage, 'results.json')}`]],
  ]) {
    const result = spawnSync(process.execPath, [join(modules, program), ...args], { cwd: stage, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${program} failed: ${result.status}`);
  }
  const result = JSON.parse(await readFile(join(stage, 'results.json'), 'utf8'));
  const assertions = result.testResults.flatMap(f => f.assertionResults);
  if (result.testResults.length !== tests.length || assertions.length !== 5 || assertions.some(t => t.status !== 'passed')) throw new Error('Missing, failed, skipped or todo review tests');
  console.log(`Strict review: ${tests.length} files, ${assertions.length} passed, none skipped. Calendar cross-service acceptance cases only; no provider calls.`);
} finally { await rm(stage, { recursive: true, force: true }); }
