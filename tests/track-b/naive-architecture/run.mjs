// Isolated local harness: no env/secret reads or provider calls.
import { cp, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const stage = await mkdtemp(join(tmpdir(), 'ae-naive-architecture-'));
try {
  await cp(join(repo, 'packages/core/src'), join(stage, 'packages/core/src'), { recursive: true });
  await cp(here, join(stage, 'tests/track-b/naive-architecture'), { recursive: true });
  await symlink(resolve(here, '../node_modules'), join(stage, 'node_modules'), 'dir');
  await writeFile(join(stage, 'package.json'), '{"private":true,"type":"module"}');
  await writeFile(join(stage, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true,
    noEmit: true, skipLibCheck: true, esModuleInterop: true, types: ['node'],
  }, include: ['tests/track-b/naive-architecture/*.test.ts'] }));
  for (const [program, args] of [
    ['typescript/bin/tsc', ['--project', 'tsconfig.json']],
    ['vitest/vitest.mjs', ['run', 'tests/track-b/naive-architecture', '--maxWorkers=1']],
  ]) {
    const result = spawnSync(process.execPath, [join(stage, 'node_modules', program), ...args], { cwd: stage, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Check failed: ${program}`);
  }
} finally { await rm(stage, { recursive: true, force: true }); }
