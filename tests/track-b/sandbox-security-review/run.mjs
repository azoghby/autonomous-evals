import { cp, readdir, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
const stage = await mkdtemp(join(tmpdir(), 'sandbox-security-review-check-'));
try {
  await cp(join(repo, 'packages/core/src'), join(stage, 'packages/core/src'), {
    recursive: true,
    filter: path => !/\.(test|spec)\.ts$/.test(path) && !path.includes('/src/sandbox'),
  });
  await mkdir(join(stage, 'packages/core/src/sandbox'), { recursive: true });
  await writeFile(join(stage, 'packages/core/src/sandbox/spec.ts'), spec);
  for (const name of ['index.ts', 'services.ts']) {
    await mkdir(join(stage, 'packages/core/src/contracts'), {recursive:true});
    await writeFile(join(stage, 'packages/core/src/contracts', name), git(['show', `${sha}:packages/core/src/contracts/${name}`]));
  }
  for (const sibling of ['sandbox-generation', 'sandbox-execution', 'sandbox-grading', 'sandbox-identity', 'sandbox-integration']) {
    await cp(join(here, '..', sibling), join(stage, 'tests/track-b', sibling), { recursive: true });
  }
  await cp(here, join(stage, 'tests/track-b/sandbox-security-review'), { recursive: true, filter: path => !path.endsWith('run.mjs') });
  // Read only exact Track A runtime sources; no production checkout mutation or live adapter import.
  const runtimeRef = '875ceef6a743df41736ee55c4145ca794e0854a8';
  await mkdir(join(stage, 'packages/core/src/sandbox/runtime'), {recursive:true});
  for (const name of ['run','types','faults','json-schema','sql-text','simulate','world-sql'])
    await writeFile(join(stage, `packages/core/src/sandbox/runtime/${name}.ts`), git(['show', `${runtimeRef}:packages/core/src/sandbox/runtime/${name}.ts`]));
  await mkdir(join(stage, 'packages/core/src/ai'), {recursive:true});
  for (const name of ['gateway','models'])
    await writeFile(join(stage, `packages/core/src/ai/${name}.ts`), git(['show', `${runtimeRef}:packages/core/src/ai/${name}.ts`]));
  console.log(`Read-only Track A runtime ${runtimeRef}; pinned shared spec remains ${sha}`);
  const fixturePath = join(stage, 'tests/track-b/sandbox-generation/fixtures.ts');
  await writeFile(fixturePath, (await readFile(fixturePath, 'utf8')).replaceAll("'../sandbox/spec'", "'../../../packages/core/src/sandbox/spec'"));
  // Merge existing dependency trees in staging only; primary versions take precedence.
  const fallbackDeps = resolve(process.env.TRACK_B_RUNTIME_NODE_MODULES ?? '/tmp/workflow-bootstrap.JpxCTM/node_modules');
  const merged = join(stage, 'node_modules'); await mkdir(merged);
  const linked = new Set();
  for (const source of [deps, fallbackDeps]) for (const entry of await readdir(source)) {
    if (entry.startsWith('@')) {
      await mkdir(join(merged, entry), {recursive:true});
      for (const child of await readdir(join(source, entry))) {
        const key = `${entry}/${child}`;
        if (!linked.has(key)) { await symlink(join(source,key), join(merged,key), 'dir'); linked.add(key); }
      }
    } else if (!linked.has(entry)) { await symlink(join(source,entry), join(merged,entry)); linked.add(entry); }
  }

  await writeFile(join(stage, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await writeFile(join(stage, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true,
    noEmit: true, skipLibCheck: true, esModuleInterop: true, types: ['node'],
  }, include: ['tests/track-b/sandbox-security-review/**/*.ts', 'packages/core/src/evals/sandbox/integration/**/*.ts'] }));
  console.log(`Exact spec ${sha}, sha256:${createHash('sha256').update(spec).digest('hex')}`);
  for (const [bin, args] of [
    ['typescript/bin/tsc', ['-p', join(stage, 'tsconfig.json')]],
    ['vitest/vitest.mjs', ['run', 'tests/track-b/sandbox-security-review', '--root', stage, '--maxWorkers=1', '--testTimeout=60000', '--reporter=json', '--outputFile=results.json']],
  ]) {
    const run = spawnSync(process.execPath, [join(deps, bin), ...args], { cwd: stage, stdio: 'inherit' });
    if (run.status !== 0) {
      if (bin.startsWith('vitest')) { const report = JSON.parse(await readFile(join(stage, 'results.json'), 'utf8')); for (const file of report.testResults) for (const test of file.assertionResults) if (test.status !== 'passed') console.error(test.fullName, test.failureMessages); }
      throw new Error(`${bin} failed: ${run.status}`);
    }
  }
  const report = JSON.parse(await readFile(join(stage, 'results.json'), 'utf8'));
  if (!report.numPassedTests || report.numPendingTests || report.numFailedTests || report.testResults.some(file => file.assertionResults.some(test => test.status !== 'passed'))) throw new Error('Incomplete test execution');
  console.log(`Strict typecheck; ${report.numPassedTests} offline tests passed, none skipped. No live acceptance claimed.`);
} finally {
  await rm(stage, { recursive: true, force: true });
}
