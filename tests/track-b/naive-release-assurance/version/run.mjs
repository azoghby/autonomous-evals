// Offline staging only. Reuses installed dependencies; never installs or fetches.
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../../..');
const deps = resolve(process.argv[2] ?? join(repo, 'tests/track-b/node_modules'));
const tsx = resolve(process.argv[3] ?? join(deps, '.bin/tsx'));
const stage = await mkdtemp(join(tmpdir(), 'ae-version-assurance-'));
const relativeTest = 'tests/track-b/naive-release-assurance/version/version.test.ts';
try {
  // Copy only the dependency closure; other teams' eval packs/app/contracts are untouched.
  await mkdir(join(stage, 'packages/core/src/evals'), { recursive: true });
  const agentFiles = ['runtime.ts', 'session-service.ts', 'postgres-ports.ts', 'memory-ports.ts', 'roles.ts', 'redact.ts', 'provision.ts', '__tests__/fakes.ts', 'persistence-migrations/001-agent-persistence.sql'];
  for (const file of agentFiles) {
    const target = join(stage, 'packages/core/src/agents', file);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(repo, 'packages/core/src/agents', file), target);
  }
  for (const file of ['types.ts', 'pricing.ts']) await cp(join(repo, 'packages/core/src/evals', file), join(stage, 'packages/core/src/evals', file));
  await mkdir(dirname(join(stage, relativeTest)), { recursive: true });
  await cp(join(here, 'version.test.ts'), join(stage, relativeTest));
  await symlink(deps, join(stage, 'node_modules'), 'dir');
  await mkdir(join(stage, 'tests/track-b/node_modules/.bin'), { recursive: true });
  await symlink(tsx, join(stage, 'tests/track-b/node_modules/.bin/tsx'));
  const command = 'tests/track-b/node_modules/.bin/tsx';
  console.log(`Staged exact command: ${command} --test ${relativeTest}`);
  const result = spawnSync(join(stage, command), ['--test', relativeTest], { cwd: stage, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(stage, { recursive: true, force: true });
}
