// Offline scoped entrypoint; resolve repository from caller cwd, never fetch/install.
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
const own = dirname(fileURLToPath(import.meta.url));
const mode = process.argv[2] ?? '--strict';
if (!['--strict', '--characterize'].includes(mode) || process.argv.length > 3) throw Error('Usage: node run.mjs [--strict|--characterize]');
let gitCwd = process.cwd();
function git(args) {
  const r = spawnSync('git', args, { cwd: gitCwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw Error(r.stderr); return r.stdout.trim();
}
const repo = resolve(git(['rev-parse', '--show-toplevel']));
gitCwd = repo;
const pinned = '8634ceb30f3d98de7ec24b240a4f7549dce80033';
if (git(['rev-parse', 'origin/track-a']) !== pinned) throw Error('Local origin/track-a moved; review contract pin explicitly');
const modules = resolve(process.env.TRACK_B_REVIEW_NODE_MODULES ?? '/tmp/autonomous-evals-checks.m10du4/node_modules');
for (const file of ['typescript/bin/tsc', 'vitest/vitest.mjs', 'zod/package.json']) await access(join(modules, file));
const stage = await mkdtemp(join(tmpdir(), 'release-packs-'));
let status = 0;
try {
  for (const dir of ['agents', 'evals', 'reporting', 'targets', 'simulator', 'monitoring', 'judges']) {
    await cp(join(repo, 'packages/core/src', dir), join(stage, 'src', dir), { recursive: true,
      filter: p => !/\.(test|spec)\.ts$/.test(p) });
  }
  // Contract and pack implementation are read verbatim from the locally pinned Track A commit.
  for (const path of git(['ls-tree', '-r', '--name-only', pinned, '--', 'packages/core/src/contracts', 'packages/core/src/redteam']).split('\n')) {
    if (!path.endsWith('.ts') || /\.(test|spec)\.ts$/.test(path)) continue;
    const dest = join(stage, 'src', path.slice('packages/core/src/'.length));
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, git(['show', `${pinned}:${path}`]) + '\n');
  }
  await mkdir(join(stage, 'checks'));
  for (const name of ['fixtures.ts', 'acceptance.test.ts', 'gaps.test.ts']) await cp(join(own, name), join(stage, 'checks', name));
  await symlink(modules, join(stage, 'node_modules'), 'dir');
  await writeFile(join(stage, 'package.json'), '{"private":true,"type":"module"}');
  await writeFile(join(stage, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true,
    noEmit: true, skipLibCheck: true, esModuleInterop: true, types: ['node'],
  }, include: ['src/**/*.ts', 'checks/**/*.ts'] }));
  console.log(`PACKS ${mode}; HEAD=${git(['rev-parse', 'HEAD'])}; Track A=${pinned}; deps=${modules}`);
  for (const args of [[join(modules, 'typescript/bin/tsc'), '-p', join(stage, 'tsconfig.json')],
    [join(modules, 'vitest/vitest.mjs'), 'run', '--root', stage, '--maxWorkers=1', '--reporter=default', '--reporter=json', `--outputFile=${join(stage, 'results.json')}`]]) {
    const r = spawnSync(process.execPath, args, { cwd: stage, stdio: 'inherit', env: { ...process.env, PACKS_STRICT: mode === '--strict' ? '1' : '0' } });
    if (r.error) throw r.error;
    if (r.status !== 0) { status = r.status ?? 1; break; }
  }
  try {
    const result = JSON.parse(await readFile(join(stage, 'results.json'), 'utf8'));
    const assertions = result.testResults.flatMap(f => f.assertionResults);
    if (result.testResults.length !== 2 || assertions.length !== 19 || assertions.some(t => t.status !== 'passed')) status = 1;
    console.log(JSON.stringify({ mode, files: result.testResults.length, total: assertions.length,
      passed: assertions.filter(t => t.status === 'passed').length, failed: assertions.filter(t => t.status === 'failed').length,
      skippedOrTodo: assertions.filter(t => !['passed', 'failed'].includes(t.status)).length }));
  } catch { status = 1; }
  console.log(mode === '--characterize' ? 'CHARACTERIZATION ONLY: green confirms known gaps, not release acceptance.' : 'STRICT release gate: every unsafe path must reject or remain unresolved.');
} finally { await rm(stage, { recursive: true, force: true }); }
process.exitCode = status;
