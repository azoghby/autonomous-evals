// Offline only: stages production sources and pinned local contracts, never installs dependencies.
import { access, cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../../..');
const modules = resolve(process.env.TRACK_B_NODE_MODULES ?? join(repo, 'tests/track-b/node_modules'));
await access(join(modules, 'vitest/vitest.mjs'));
function git(args) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout;
}
const contracts = git(['rev-parse', '--verify', '--end-of-options', `${process.argv[2] ?? '8634ceb30f3d98de7ec24b240a4f7549dce80033'}^{commit}`]).trim();
const stage = await mkdtemp(join(tmpdir(), 'track-b-provenance-'));
console.log(`Production HEAD ${git(['rev-parse', 'HEAD']).trim()}; contracts ${contracts}; offline`);
try {
  await cp(join(repo, 'packages/core/src'), join(stage, 'src'), { recursive: true, filter: p => !/\.(test|spec)\.ts$/.test(p) });
  await mkdir(join(stage, 'src/provenance'), { recursive: true });
  for (const file of ['support.ts', 'acceptance.test.ts', 'defect-characterization.test.ts']) await cp(join(here, file), join(stage, 'src/provenance', file));
  await cp(join(repo, 'packages/core/src/evals/text/__tests__/fixtures.ts'), join(stage, 'src/evals/text/__tests__/fixtures.ts'));
  for (const p of git(['ls-tree', '-r', '--name-only', contracts, '--', 'packages/core/src/contracts/']).trim().split('\n')) {
    if (!p.endsWith('.ts') || /\.(test|spec)\.ts$/.test(p)) continue;
    const dest = join(stage, 'src', p.slice('packages/core/src/'.length));
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, git(['show', `${contracts}:${p}`]));
  }
  await symlink(modules, join(stage, 'node_modules'), 'dir');
  await writeFile(join(stage, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await writeFile(join(stage, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, noEmit: true, skipLibCheck: true, esModuleInterop: true, types: ['node'] }, include: ['src/provenance/**/*.ts'] }));
  for (const args of [
    [join(modules, 'typescript/bin/tsc'), '-p', join(stage, 'tsconfig.json')],
    [join(modules, 'vitest/vitest.mjs'), 'run', '--root', stage, 'src/provenance/acceptance.test.ts', '--maxWorkers=1'],
    [join(modules, 'vitest/vitest.mjs'), 'run', '--root', stage, 'src/provenance/defect-characterization.test.ts', '--maxWorkers=1'],
  ]) {
    const r = spawnSync(process.execPath, args, { cwd: stage, stdio: 'inherit' });
    if (r.error || r.status !== 0) throw r.error ?? new Error(`check exited ${r.status}`);
  }
} finally { await rm(stage, { recursive: true, force: true }); }
