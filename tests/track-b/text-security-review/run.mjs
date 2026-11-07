// Offline isolated staging: copies this checkout; never installs, fetches, or invokes providers.
import { cp, mkdir, mkdtemp, rm, symlink, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const dependencies = resolve(process.env.TEXT_REVIEW_NODE_MODULES ?? join(here, '../node_modules'));
await access(join(dependencies, 'vitest/vitest.mjs'));
const stage = await mkdtemp(join(tmpdir(), 'ae-text-security-review-'));
try {
  await cp(join(repo, 'packages/core/src'), join(stage, 'src'), { recursive: true,
    filter: p => !/\.(test|spec)\.ts$/.test(p) });
  await cp(join(repo, 'packages/core/src/evals/text/__tests__'), join(stage, 'src/evals/text/__tests__'), { recursive: true });
  await mkdir(join(stage, 'src/text-security-review'), { recursive: true });
  await cp(join(here, 'review.test.ts'), join(stage, 'src/text-security-review/review.test.ts'));
  await symlink(dependencies, join(stage, 'node_modules'), 'dir');
  await writeFile(join(stage, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await writeFile(join(stage, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true,
    noEmit: true, skipLibCheck: true, esModuleInterop: true, types: ['node'],
  }, include: ['src/text-security-review/**/*.ts', 'src/evals/text/__tests__/**/*.ts'] }));
  for (const args of [
    [join(dependencies, 'typescript/bin/tsc'), '-p', join(stage, 'tsconfig.json')],
    [join(dependencies, 'vitest/vitest.mjs'), 'run', '--root', stage, 'src/text-security-review', 'src/evals/text/__tests__', '--maxWorkers', '2'],
  ]) {
    const r = spawnSync(process.execPath, args, { cwd: stage, stdio: 'inherit', env: process.env });
    if (r.status !== 0) { process.exitCode = r.status ?? 1; break; }
  }
} finally { await rm(stage, { recursive: true, force: true }); }
