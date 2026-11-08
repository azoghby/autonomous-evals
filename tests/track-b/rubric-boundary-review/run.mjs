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
const stage = await mkdtemp(join(tmpdir(), 'ae-rubric-boundary-review-'));
try {
  await cp(join(repo, 'packages/core/src'), join(stage, 'src'), { recursive: true,
    filter: p => !/\.(test|spec)\.ts$/.test(p) });
  await cp(join(repo, 'packages/core/src/evals/text/__tests__'), join(stage, 'src/evals/text/__tests__'), { recursive: true });
  await cp(join(repo, 'packages/core/src/judges/gateway.test.ts'), join(stage, 'src/judges/gateway.test.ts'));
  await mkdir(join(stage, 'src/rubric-boundary-review'), { recursive: true });
  await cp(join(here, 'review.test.ts'), join(stage, 'src/rubric-boundary-review/review.test.ts'));
  await cp(join(repo, 'tests/track-b/live-evidence/text-design-natural-language-2026-11-07.json'), join(stage, 'src/rubric-boundary-review/live.json'));
  await cp(join(repo, 'tests/track-b/live-evidence/text-design-rubric-binding-2026-11-07.json'), join(stage, 'src/rubric-boundary-review/binding.json'));
  await symlink(dependencies, join(stage, 'node_modules'), 'dir');
  await writeFile(join(stage, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await writeFile(join(stage, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true,
    noEmit: true, skipLibCheck: true, esModuleInterop: true, types: ['node'],
  }, include: ['src/rubric-boundary-review/**/*.ts', 'src/evals/text/__tests__/**/*.ts', 'src/judges/gateway.test.ts'] }));
  for (const args of [
    [join(dependencies, 'typescript/bin/tsc'), '-p', join(stage, 'tsconfig.json')],
    [join(dependencies, 'vitest/vitest.mjs'), 'run', '--root', stage, 'src/rubric-boundary-review', 'src/evals/text/__tests__', 'src/judges/gateway.test.ts', '--maxWorkers', '2'],
  ]) {
    const r = spawnSync(process.execPath, args, { cwd: stage, stdio: 'inherit', env: process.env });
    if (r.status !== 0) { process.exitCode = r.status ?? 1; break; }
  }
} finally { await rm(stage, { recursive: true, force: true }); }
