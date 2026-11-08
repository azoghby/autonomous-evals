import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const here = dirname(fileURLToPath(import.meta.url)), repo = resolve(here, '../../..');
const deps = resolve(process.env.TRACK_B_NODE_MODULES ?? join(here, '../node_modules'));
const stage = await mkdtemp(join(tmpdir(), 'sandbox-generation-engine-'));
try {
  await cp(join(repo, 'packages/core/src'), join(stage, 'packages/core/src'), { recursive: true, filter: p => !/\.(test|spec)\.ts$/.test(p) });
  for (const directory of ['sandbox-integration', 'sandbox-generation-engine'])
    await cp(join(repo, 'tests/track-b', directory), join(stage, 'tests/track-b', directory), { recursive: true });
  await mkdir(join(stage, 'node_modules'));
  for (const name of await readdir(deps)) {
    const source = name === 'ipaddr.js' ? resolve(process.env.TRACK_B_IPADDR_MODULE ?? join(deps, 'ipaddr.js')) : join(deps, name);
    await symlink(source, join(stage, 'node_modules', name));
  }
  await writeFile(join(stage, 'package.json'), '{"private":true,"type":"module"}');
  await writeFile(join(stage, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, noEmit: true,
    skipLibCheck: true, esModuleInterop: true, types: ['node'],
  }, include: ['tests/track-b/sandbox-generation-engine/**/*.ts'] }));
  for (const [bin, args] of [
    ['typescript/bin/tsc', ['-p', join(stage, 'tsconfig.json')]],
    ['vitest/vitest.mjs', ['run', 'tests/track-b/sandbox-generation-engine', '--root', stage, '--maxWorkers=1', '--reporter=default', '--reporter=json', '--outputFile=results.json']],
  ]) {
    const run = spawnSync(process.execPath, [join(deps, bin), ...args], { cwd: stage, stdio: 'inherit' });
    if (run.status !== 0) throw new Error(`${bin} failed (${run.status})`);
  }
  const report = JSON.parse(await readFile(join(stage, 'results.json'), 'utf8'));
  if (!report.numPassedTests || report.numPendingTests || report.numFailedTests) throw new Error('Incomplete test execution');
  console.log(`Strict TypeScript; ${report.numPassedTests} offline engine tests passed, zero skipped. Native PostgreSQL restart; no provider/network/cloud calls.`);
} finally { await rm(stage, { recursive: true, force: true }); }
