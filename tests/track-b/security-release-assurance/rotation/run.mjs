// Offline staging only; uses already-installed dependencies and local Git objects.
import { cp, mkdir, mkdtemp, rm, symlink, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../../..');
const deps = resolve(process.env.ROTATION_NODE_MODULES ?? join(repo, 'tests/track-b/node_modules'));
await access(join(deps, 'vitest/vitest.mjs'));
function git(args) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout;
}
const ref = process.env.TRACK_A_REF ?? '8634ceb30f3d98de7ec24b240a4f7549dce80033';
const sha = git(['rev-parse', '--verify', `${ref}^{commit}`]).trim();
const stage = await mkdtemp(join(tmpdir(), 'ae-security-rotation-'));
try {
  await cp(join(repo, 'packages/core/src'), join(stage, 'src'), { recursive: true,
    filter: p => !/\.(test|spec)\.ts$/.test(p) });
  const root = 'packages/core/src/contracts/';
  for (const path of git(['ls-tree', '-r', '--name-only', sha, '--', root]).trim().split('\n')) {
    if (!path.endsWith('.ts') || /\.(test|spec)\.ts$/.test(path)) continue;
    const dest = join(stage, 'src/contracts', path.slice(root.length));
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, git(['show', `${sha}:${path}`]));
  }
  await mkdir(join(stage, 'src/rotation'), { recursive: true });
  await cp(join(here, 'rotation.test.ts'), join(stage, 'src/rotation/rotation.test.ts'));
  await cp(join(repo, 'packages/core/src/agents/__tests__/fakes.ts'), join(stage, 'src/agents/__tests__/fakes.ts'));
  await symlink(deps, join(stage, 'node_modules'), 'dir');
  await writeFile(join(stage, 'package.json'), JSON.stringify({ type: 'module', private: true }));
  await writeFile(join(stage, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, noEmit: true,
    skipLibCheck: true, esModuleInterop: true, types: ['node'],
  }, include: ['src/rotation/rotation.test.ts'] }));
  console.log(`Source ${git(['rev-parse', 'HEAD']).trim()}; contracts ${sha}; only targeted rotation tests`);
  for (const args of [
    [join(deps, 'typescript/bin/tsc'), '-p', join(stage, 'tsconfig.json')],
    [join(deps, 'vitest/vitest.mjs'), 'run', 'src/rotation/rotation.test.ts', '--root', stage, '--maxWorkers', '1'],
  ]) {
    const r = spawnSync(process.execPath, args, { cwd: stage, stdio: 'inherit' });
    if (r.status !== 0) { process.exitCode = r.status ?? 1; break; }
  }
} finally { await rm(stage, { recursive: true, force: true }); }
