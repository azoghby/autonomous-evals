// Offline, isolated strict check of actual core modules, existing data tests and review reproductions.
// Usage: node run.mjs [--deps /absolute/path/to/node_modules]
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--deps')) throw new Error('Usage: node run.mjs [--deps /absolute/path/to/node_modules]');
const deps = resolve(args[1] ?? join(here, '../node_modules'));
const staging = await mkdtemp(join(tmpdir(), 'ae-data-review-'));
try {
  await mkdir(join(staging, 'src/agents'), { recursive: true });
  await cp(join(repo, 'packages/core/src/evals/data'), join(staging, 'src/evals/data'), { recursive: true });
  await rm(join(staging, 'src/evals/data/adapters'), { recursive: true, force: true });
  await cp(join(repo, 'packages/core/src/evals/types.ts'), join(staging, 'src/evals/types.ts'));
  await cp(join(repo, 'packages/core/src/agents/redact.ts'), join(staging, 'src/agents/redact.ts'));
  await cp(join(repo, 'packages/core/src/agents/postgres-ports.ts'), join(staging, 'src/agents/postgres-ports.ts'));
  await cp(join(here, 'review.test.ts'), join(staging, 'src/evals/data/review.test.ts'));
  await symlink(deps, join(staging, 'node_modules'), 'dir');
  await writeFile(join(staging, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await writeFile(join(staging, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, noEmit: true,
    skipLibCheck: true, esModuleInterop: true, isolatedModules: true, types: ['node'],
  }, include: ['src/**/*.ts'] }));
  for (const [program, argv] of [
    ['typescript/bin/tsc', ['--project', join(staging, 'tsconfig.json')]],
    ['vitest/vitest.mjs', ['run', '--root', staging, '--maxWorkers=2']],
  ]) {
    const result = spawnSync(process.execPath, [join(deps, program), ...argv], { cwd: staging, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) { process.exitCode = result.status ?? 1; break; }
  }
} finally {
  await rm(staging, { recursive: true, force: true });
}
