import { cp, mkdir, mkdtemp, rm, symlink, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../../..');
const ref = process.argv[2] ?? 'f0068733ca49c37f40fd7de279325f21a4b5fbbb';
const modules = resolve(process.env.TRACK_B_NODE_MODULES ?? join(repo, 'tests/track-b/node_modules'));
function git(args) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout;
}
const sha = git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).trim();
const stage = await mkdtemp(join(tmpdir(), 'calendar-ordering-'));
console.log(`Track B HEAD ${git(['rev-parse', 'HEAD']).trim()}; Track A ${sha}; providers disabled; one worker`);
try {
  for (const dir of ['agents', 'evals', 'reporting', 'targets', 'simulator', 'judges', 'monitoring']) {
    await cp(join(repo, 'packages/core/src', dir), join(stage, 'src', dir), { recursive: true, filter: p => !/\.(test|spec)\.ts$/.test(p) });
  }
  for (const prefix of ['packages/core/src/contracts/']) {
    for (const p of git(['ls-tree', '-r', '--name-only', sha, '--', prefix]).trim().split('\n')) {
      if (!p.endsWith('.ts') || /\.(test|spec)\.ts$/.test(p)) continue;
      const dest = join(stage, 'src', p.slice('packages/core/src/'.length));
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, git(['show', `${sha}:${p}`]));
    }
  }
  for (const file of ['cases.ts', 'ordering.test.ts']) await cp(join(here, file), join(stage, file));
  await symlink(modules, join(stage, 'node_modules'), 'dir');
  await writeFile(join(stage, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await writeFile(join(stage, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, noEmit: true, skipLibCheck: true, esModuleInterop: true, types: ['node'] }, include: ['cases.ts', 'ordering.test.ts'] }));
  for (const [tool, args] of [
    ['typescript/bin/tsc', ['-p', join(stage, 'tsconfig.json')]],
    ['vitest/vitest.mjs', ['run', 'ordering.test.ts', '--root', stage, '--maxWorkers=1', '--testTimeout=30000', '--reporter=default', '--reporter=json', `--outputFile.json=${join(stage, 'results.json')}`]],
  ]) {
    const r = spawnSync(process.execPath, [join(modules, tool), ...args], { cwd: stage, stdio: 'inherit' });
    if (r.error || r.status !== 0) throw r.error ?? new Error(`${tool} exited ${r.status}`);
  }
  const result = JSON.parse(await readFile(join(stage, 'results.json'), 'utf8'));
  const cases = result.testResults.flatMap(f => f.assertionResults);
  if (result.testResults.length !== 1 || cases.length !== 2 || cases.some(c => c.status !== 'passed')) throw new Error('Incomplete scoped ordering execution');
  console.log(`Strict TypeScript passed. ${cases.length} tests executed, none skipped. Characterizations are explicitly labeled and are not release acceptance.`);
} finally { await rm(stage, { recursive: true, force: true }); }
