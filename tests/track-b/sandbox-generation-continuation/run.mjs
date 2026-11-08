import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
const sha = git(['rev-parse', 'HEAD']).trim();
const spec = await readFile(join(repo, 'packages/core/src/sandbox/spec.ts'), 'utf8');
const stage = await mkdtemp(join(tmpdir(), 'sandbox-generation-continuation-check-'));
try {
  await cp(join(repo, 'packages/core/src'), join(stage, 'src'), {
    recursive: true,
    filter: path => !/\.(test|spec)\.ts$/.test(path),
  });
  await cp(here, join(stage, 'src/generation-continuation-tests'), { recursive: true, filter: path => !path.endsWith('run.mjs') });
  await symlink(deps, join(stage, 'node_modules'), 'dir');
  await writeFile(join(stage, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await writeFile(join(stage, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true,
    noEmit: true, skipLibCheck: true, esModuleInterop: true, types: ['node'],
  }, include: ['src/generation-continuation-tests/**/*.ts', 'src/evals/sandbox/generation/**/*.ts'] }));
  console.log(`Working tree based on ${sha}; current spec, sha256:${createHash('sha256').update(spec).digest('hex')}`);
  for (const [bin, args] of [
    ['typescript/bin/tsc', ['-p', join(stage, 'tsconfig.json')]],
    ['vitest/vitest.mjs', ['run', 'src/generation-continuation-tests', '--root', stage, '--maxWorkers=1', '--reporter=default', '--reporter=json', '--outputFile=results.json']],
  ]) {
    const run = spawnSync(process.execPath, [join(deps, bin), ...args], { cwd: stage, stdio: 'inherit' });
    if (run.status !== 0) {
      if (bin.startsWith('vitest')) console.error(await readFile(join(stage, 'results.json'), 'utf8').catch(() => 'No report'));
      throw new Error(`${bin} failed: ${run.status}`);
    }
  }
  const report = JSON.parse(await readFile(join(stage, 'results.json'), 'utf8'));
  if (!report.numPassedTests || report.numPendingTests || report.numFailedTests || report.testResults.some(file => file.assertionResults.some(test => test.status !== 'passed'))) throw new Error('Incomplete test execution');
  console.log(`Strict typecheck; ${report.numPassedTests} offline tests passed, none skipped. No live acceptance claimed.`);
} finally {
  await rm(stage, { recursive: true, force: true });
}
