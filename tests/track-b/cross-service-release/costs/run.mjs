import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../../..');
const modules = resolve(process.env.TRACK_B_REVIEW_NODE_MODULES ?? join(repo, 'tests/track-b/node_modules'));
const ref = process.env.TRACK_B_CONTRACT_REF ?? 'origin/track-a';
function git(args) {
  const p = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (p.status !== 0) throw new Error(p.stderr); return p.stdout.trim();
}
const sha = git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
console.log(`Source ${git(['rev-parse', 'HEAD'])}; local contract ${sha}`);
const stage = await mkdtemp(join(tmpdir(), 'release-cost-check-'));
try {
  for (const dir of ['agents', 'evals', 'reporting', 'targets', 'simulator', 'monitoring', 'judges']) await cp(join(repo, 'packages/core/src', dir), join(stage, 'packages/core/src', dir), { recursive: true, filter: p => !/\.(test|spec)\.ts$/.test(p) && !p.includes('/__tests__') });
  for (const file of git(['ls-tree', '-r', '--name-only', sha, '--', 'packages/core/src/contracts']).split('\n')) {
    if (!file.endsWith('.ts') || /\.(test|spec)\.ts$/.test(file)) continue;
    await mkdir(dirname(join(stage, file)), { recursive: true });
    await writeFile(join(stage, file), git(['show', `${sha}:${file}`]) + '\n');
  }
  const dest = join(stage, 'tests/track-b/cross-service-release/costs');
  await mkdir(dest, { recursive: true });
  for (const file of await readdir(here)) if (file.endsWith('.ts')) await cp(join(here, file), join(dest, file));
  await symlink(modules, join(stage, 'node_modules'), 'dir');
  await writeFile(join(stage, 'package.json'), '{"type":"module","private":true}');
  await writeFile(join(stage, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, noEmit: true, skipLibCheck: true, esModuleInterop: true, types: ['node'] }, include: ['tests/**/*.ts'] }));
  for (const [program, args] of [
    ['typescript/bin/tsc', ['--project', join(stage, 'tsconfig.json')]],
    ['vitest/vitest.mjs', ['run', 'tests/track-b/cross-service-release/costs/costs.test.ts', '--root', stage, '--maxWorkers=1', '--reporter=default', '--reporter=json', `--outputFile.json=${join(stage, 'results.json')}`]],
  ]) {
    const p = spawnSync(process.execPath, [join(modules, program), ...args], { cwd: stage, stdio: 'inherit' });
    if (p.error) throw p.error; if (p.status !== 0) throw new Error(`${program} failed: ${p.status}`);
  }
  const result = JSON.parse(await readFile(join(stage, 'results.json'), 'utf8'));
  const assertions = result.testResults.flatMap(f => f.assertionResults);
  if (assertions.length !== 6 || assertions.some(t => t.status !== 'passed')) throw new Error('Missing, skipped or failed cost cases');
  console.log('Strict scoped check: 6 passed (5 acceptance, 1 current-defect characterization); disk PGlite only.');
} finally { await rm(stage, { recursive: true, force: true }); }
