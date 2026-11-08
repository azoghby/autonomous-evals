// Local-only: no installation, fetch, provider, or cloud calls.
import { cp, mkdir, mkdtemp, rm, symlink, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const dependencies = resolve(process.env.REMEDIATION_REVIEW_NODE_MODULES ?? join(here, '../node_modules'));
await access(join(dependencies, 'vitest/vitest.mjs'));
const ref = process.env.TRACK_A_REF ?? 'origin/track-a';
function git(args) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout;
}
const sha = git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).trim();
const stage = await mkdtemp(join(tmpdir(), 'ae-remediation-review-'));
try {
  await cp(join(repo, 'packages/core/src'), join(stage, 'src'), { recursive: true,
    filter: p => !/\.(test|spec)\.ts$/.test(p) || /\/src\/(evals|judges)\//.test(p) });
  const contractRoot = 'packages/core/src/contracts/';
  for (const path of git(['ls-tree', '-r', '--name-only', sha, '--', contractRoot]).trim().split('\n')) {
    if (!path.endsWith('.ts') || /\.(test|spec)\.ts$/.test(path)) continue;
    const dest = join(stage, 'src/contracts', path.slice(contractRoot.length));
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, git(['show', `${sha}:${path}`]));
  }
  await mkdir(join(stage, 'src/remediation-review'), { recursive: true });
  await cp(join(here, 'review.test.ts'), join(stage, 'src/remediation-review/review.test.ts'));
  await symlink(dependencies, join(stage, 'node_modules'), 'dir');
  await writeFile(join(stage, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await writeFile(join(stage, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true,
    noEmit: true, skipLibCheck: true, esModuleInterop: true, resolveJsonModule: true,
    isolatedModules: true, types: ['node'],
  }, include: ['src/**/*.ts'] }));
  console.log('R1 budget recovery is an acceptance regression. EXPECTED-FAIL CHARACTERIZATION: secured-adapter receipt attestation integration gap remains unresolved, not an acceptance pass.');
  console.log(`Reviewed HEAD ${git(['rev-parse', 'HEAD']).trim()}; local Track A ${sha}; strict types + original evals/judges tests + independent review`);
  for (const args of [
    [join(dependencies, 'typescript/bin/tsc'), '-p', join(stage, 'tsconfig.json')],
    [join(dependencies, 'vitest/vitest.mjs'), 'run', '--root', stage, '--maxWorkers', '2', '--reporter=default', '--reporter=json', `--outputFile.json=${join(stage, 'results.json')}`],
  ]) {
    const r = spawnSync(process.execPath, args, { cwd: stage, stdio: 'inherit', env: { ...process.env, TRACK_A_CONTRACT_SHA: sha, TRACE_ACCEPTANCE_PATH: join(repo, 'tests/track-b/trace-acceptance.json') } });
    if (r.status !== 0) { process.exitCode = r.status ?? 1; break; }
  }
  if (!process.exitCode) {
    const report = JSON.parse(await readFile(join(stage, 'results.json'), 'utf8'));
    for (const file of report.testResults.filter(f => /\/src\/(remediation-review|evals\/remediation)\//.test(f.name))) console.log(`${'src/' + file.name.split('/src/').at(-1)}: ${file.assertionResults.length} tests, ${file.status}`);
    if (report.numPendingTests || report.numTodoTests) throw new Error('Skipped/todo tests are not accepted');
  }
} finally { await rm(stage, { recursive: true, force: true }); }
