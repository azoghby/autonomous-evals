import { cp, mkdir, mkdtemp, readdir, rm, symlink, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Isolated runner: copies production chat verbatim; never rewrites production or the shared harness.
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const dependencies = resolve(process.env.CHAT_REVIEW_NODE_MODULES ?? join(here, '../node_modules'));
const stage = await mkdtemp(join(tmpdir(), 'chat-security-review-'));
try {
  await mkdir(join(stage, 'chat'));
  for (const name of await readdir(join(repo, 'packages/core/src/reporting/chat'))) {
    if (name.endsWith('.test.ts')) continue;
    await cp(join(repo, 'packages/core/src/reporting/chat', name), join(stage, 'chat', name), { recursive: true });
  }
  await cp(join(here, 'security.test.ts'), join(stage, 'security.test.ts'));
  await symlink(dependencies, join(stage, 'node_modules'), 'dir');
  await writeFile(join(stage, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await writeFile(join(stage, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true,
    noEmit: true, skipLibCheck: true, esModuleInterop: true, types: ['node'],
  }, include: ['**/*.ts'] }));
  for (const [program, args] of [
    ['typescript/bin/tsc', ['--project', join(stage, 'tsconfig.json')]],
    ['vitest/vitest.mjs', ['run', '--root', stage, '--maxWorkers=1', '--reporter=default', '--reporter=json', `--outputFile.json=${join(stage, 'results.json')}`]],
  ]) {
    const result = spawnSync(process.execPath, [join(dependencies, program), ...args], {
      cwd: stage, stdio: 'inherit', env: { ...process.env, CHAT_PERSISTENCE_TEST_DATABASE_URL: '' },
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${program} failed: ${result.status}`);
  }
  const report = JSON.parse(await readFile(join(stage, 'results.json'), 'utf8'));
  const assertions = report.testResults.flatMap(file => file.assertionResults);
  if (report.testResults.length !== 1 || assertions.length === 0 || assertions.some(test => test.status !== 'passed')) {
    throw new Error('Review completeness failed: missing, failed, skipped or todo tests');
  }
  console.log(`Review strict type-check passed; ${assertions.length} assertions passed, none skipped. PGlite only; no production integration claim.`);
} finally {
  await rm(stage, { recursive: true, force: true });
}
