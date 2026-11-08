import { cp, mkdir, mkdtemp, readdir, rm, symlink, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const modules = process.env.TRACK_B_REVIEW_NODE_MODULES ?? join(here, '../node_modules');
const args = process.argv.slice(2);
const ref = args.length === 0 ? 'origin/track-a' : args[0] === '--track-a-ref' && args.length === 2 ? args[1] : null;
if (!ref || ref.startsWith('-')) throw new Error('Usage: node run.mjs [--track-a-ref <local-git-ref>]');
function git(args) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
const sha = git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
console.log(`Review source HEAD: ${git(['rev-parse', 'HEAD'])}; local contracts: ${sha}`);
const stage = await mkdtemp(join(tmpdir(), 'comparison-monitoring-'));
const tests = [];
try {
  for (const dir of ['agents', 'evals', 'reporting', 'targets', 'simulator', 'monitoring', 'judges']) {
    await cp(join(repo, 'packages/core/src', dir), join(stage, 'src', dir), {
      recursive: true, filter: path => !/\.(test|spec)\.ts$/.test(path),
    });
  }
  await cp(join(repo, 'packages/core/src/monitoring/index.test.ts'), join(stage, 'src/monitoring/index.test.ts'));
  tests.push('src/monitoring/index.test.ts');
  for (const file of git(['ls-tree', '-r', '--name-only', sha, '--', 'packages/core/src/contracts']).split('\n')) {
    if (!file.endsWith('.ts') || /\.(test|spec)\.ts$/.test(file)) continue;
    const dest = join(stage, 'src/contracts', file.slice('packages/core/src/contracts/'.length));
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, git(['show', `${sha}:${file}`]) + '\n');
  }
  await mkdir(join(stage, 'review'), { recursive: true });
  for (const name of await readdir(here)) if (name.endsWith('.ts')) {
    await cp(join(here, name), join(stage, 'review', name));
    if (name.endsWith('.test.ts')) tests.push(`review/${name}`);
  }
  await symlink(modules, join(stage, 'node_modules'), 'dir');
  await writeFile(join(stage, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await writeFile(join(stage, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true,
    noEmit: true, skipLibCheck: true, esModuleInterop: true, types: ['node'],
  }, include: ['src/**/*.ts', 'review/**/*.ts'] }));
  for (const [program, args] of [
    ['typescript/bin/tsc', ['--project', join(stage, 'tsconfig.json')]],
    ['vitest/vitest.mjs', ['run', '--root', stage, '--maxWorkers=1', '--reporter=default', '--reporter=json', `--outputFile.json=${join(stage, 'results.json')}`]],
  ]) {
    const result = spawnSync(process.execPath, [join(modules, program), ...args], { cwd: stage, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${program} failed: ${result.status}`);
  }
  const result = JSON.parse(await readFile(join(stage, 'results.json'), 'utf8'));
  const assertions = result.testResults.flatMap(f => f.assertionResults);
  if (result.testResults.length !== tests.length || !assertions.length || assertions.some(t => t.status !== 'passed')) throw new Error('Missing, failed, skipped or todo review tests');
  console.log(`Strict review: ${tests.length} files, ${assertions.length} passed, none skipped. Local fixtures only; no provider, cloud, or message sends. Application deployment remains a separate gate.`);
} finally { await rm(stage, { recursive: true, force: true }); }
