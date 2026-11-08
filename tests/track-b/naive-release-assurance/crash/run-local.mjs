// Offline staging only: uses existing dependencies, never installs or accesses a provider.
// Usage: node run-local.mjs /absolute/installed/track-b/node_modules /absolute/installed/tsx
import { cp, mkdtemp, readdir, rm, symlink, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../../..');
const [deps, tsx] = process.argv.slice(2);
if (!deps || !tsx) throw new Error('Pass existing node_modules directory and tsx executable; no packages are fetched.');
const stage = await mkdtemp(join(here, '.stage-'));
try {
  await cp(join(repo, 'packages/core/src'), join(stage, 'packages/core/src'), { recursive: true });
  const target = join(stage, 'tests/track-b/naive-release-assurance/crash');
  await mkdir(target, { recursive: true });
  await cp(join(here, 'transitions.test.ts'), join(target, 'transitions.test.ts'));
  const modules = join(stage, 'tests/track-b/node_modules');
  await mkdir(join(modules, '.bin'), { recursive: true });
  for (const name of await readdir(resolve(deps))) {
    if (name.startsWith('.')) continue;
    await symlink(join(resolve(deps), name), join(modules, name), 'dir');
  }
  await symlink(resolve(tsx), join(modules, '.bin/tsx'));
  await symlink(modules, join(stage, 'node_modules'), 'dir');
  await writeFile(join(stage, 'package.json'), '{"private":true,"type":"module"}');
  console.log('Staged command: tests/track-b/node_modules/.bin/tsx --test tests/track-b/naive-release-assurance/crash/*.test.ts');
  const result = spawnSync(join(modules, '.bin/tsx'), ['--test', 'tests/track-b/naive-release-assurance/crash/transitions.test.ts'], {
    cwd: stage, stdio: 'inherit',
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally { await rm(stage, { recursive: true, force: true }); }
