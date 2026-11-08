import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const deps = resolve(process.env.TRACK_B_NODE_MODULES ?? join(here, '../node_modules'));
function git(args) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
}
const sha = git(['rev-parse', 'aa94505^{commit}']).trim();
const spec = git(['show', `${sha}:packages/core/src/sandbox/spec.ts`]);
const stage = await mkdtemp(join(tmpdir(), 'sandbox-generation-check-'));
try {
  await cp(join(repo, 'packages/core/src'), join(stage, 'src'), {
    recursive: true,
    filter: path => !/\.(test|spec)\.ts$/.test(path) && !path.includes('/src/sandbox'),
  });
  await mkdir(join(stage, 'src/sandbox'), { recursive: true });
  await writeFile(join(stage, 'src/sandbox/spec.ts'), spec);
  for (const path of git(['ls-tree', '-r', '--name-only', sha, '--', 'packages/core/src/contracts']).trim().split('\n').filter(path => path.endsWith('.ts'))) {
    const dest = join(stage, 'src/contracts', path.slice('packages/core/src/contracts/'.length));
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, git(['show', `${sha}:${path}`]));
  }
  await cp(here, join(stage, 'src/generation-tests'), { recursive: true, filter: path => !path.endsWith('run.mjs') });
  await symlink(deps, join(stage, 'node_modules'), 'dir');
  await writeFile(join(stage, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await writeFile(join(stage, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true,
    noEmit: true, skipLibCheck: true, esModuleInterop: true, types: ['node'],
  }, include: ['src/generation-tests/**/*.ts', 'src/evals/sandbox/generation/**/*.ts'] }));
  console.log(`Exact spec ${sha}, sha256:${createHash('sha256').update(spec).digest('hex')}`);
  for (const [bin, args] of [
    ['typescript/bin/tsc', ['-p', join(stage, 'tsconfig.json')]],
    ['vitest/vitest.mjs', ['run', 'src/generation-tests', '--root', stage, '--maxWorkers=1', '--reporter=json', '--outputFile=results.json']],
  ]) {
    const run = spawnSync(process.execPath, [join(deps, bin), ...args], { cwd: stage, stdio: 'inherit' });
    if (run.status !== 0) throw new Error(`${bin} failed: ${run.status}`);
  }
  const report = JSON.parse(await readFile(join(stage, 'results.json'), 'utf8'));
  if (!report.numPassedTests || report.numPendingTests || report.numFailedTests || report.testResults.some(file => file.assertionResults.some(test => test.status !== 'passed'))) throw new Error('Incomplete test execution');
  console.log(`Strict typecheck; ${report.numPassedTests} offline tests passed, none skipped. No live acceptance claimed.`);
} finally {
  await rm(stage, { recursive: true, force: true });
}
