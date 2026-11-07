// Stages Track B agents/evals/reporting + Track A contracts + the review reproducers into a temp dir and runs vitest.
// Usage: node tests/track-b/agent-review/run.mjs [--track-a-ref origin/track-a] [-- vitest args]
// Requires `npm ci --prefix tests/track-b --workspaces=false` first. No network, no live API.
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const trackB = resolve(here, '..');
const argv = process.argv.slice(2);
const refIndex = argv.indexOf('--track-a-ref');
const ref = refIndex >= 0 ? argv[refIndex + 1] : 'origin/track-a';
const extra = argv.includes('--') ? argv.slice(argv.indexOf('--') + 1) : [];

const git = (args, enc = 'utf8') => {
  const r = spawnSync('git', args, { cwd: repo, encoding: enc, shell: false, maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
};

const staging = await mkdtemp(join(tmpdir(), 'ae-agent-review-'));
try {
  const src = join(staging, 'src');
  await mkdir(src);
  for (const d of ['agents', 'evals', 'reporting']) {
    await cp(join(repo, 'packages/core/src', d), join(src, d), { recursive: true, filter: (p) => !/\.(test|spec)\.ts$/.test(p) && !p.includes('__tests__/') || p.endsWith('/fakes.ts') });
  }
  // Reuse the production fakes (FakeNaive etc.) without their tests.
  await cp(join(repo, 'packages/core/src/agents/__tests__/fakes.ts'), join(src, 'agents/__tests__/fakes.ts'), { recursive: true });
  const sha = git(['rev-parse', '--verify', `${ref}^{commit}`]).trim();
  for (const entry of git(['ls-tree', '-r', '--name-only', sha, '--', 'packages/core/src/contracts']).split('\n').filter((p) => p.endsWith('.ts'))) {
    const dest = join(src, 'contracts', entry.slice('packages/core/src/contracts/'.length));
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, git(['cat-file', 'blob', `${sha}:${entry}`], 'buffer'));
  }
  await cp(here, join(src, 'agent-review'), { recursive: true, filter: (p) => !p.endsWith('run.mjs') });
  await symlink(join(trackB, 'node_modules'), join(staging, 'node_modules'), 'dir');
  await writeFile(join(staging, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await writeFile(join(staging, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, noEmit: true, skipLibCheck: true, esModuleInterop: true, isolatedModules: true, types: ['node'] }, include: ['src/**/*.ts'] }));
  console.log(`contracts from ${sha}`);
  const tsc = spawnSync(process.execPath, [join(trackB, 'node_modules/typescript/bin/tsc'), '--project', join(staging, 'tsconfig.json')], { cwd: staging, stdio: 'inherit' });
  if (tsc.status !== 0) process.exit(tsc.status ?? 1);
  const v = spawnSync(process.execPath, [join(trackB, 'node_modules/vitest/vitest.mjs'), 'run', '--root', staging, 'src/agent-review', ...extra], { cwd: staging, stdio: 'inherit', env: { ...process.env, TRACE_ACCEPTANCE_PATH: join(trackB, 'trace-acceptance.json') } });
  process.exitCode = v.status ?? 1;
} finally {
  await rm(staging, { recursive: true, force: true });
}
