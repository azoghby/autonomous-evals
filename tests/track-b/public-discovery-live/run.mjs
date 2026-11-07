// Explicit opt-in diagnostic: bounded real public GETs, no credentials or provider spend.
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

if (!process.argv.includes('--live')) throw new Error('Pass --live to authorize the bounded public-source diagnostic');
const own = dirname(fileURLToPath(import.meta.url));
const repo = resolve(own, '../../..');
const stage = await mkdtemp(join(tmpdir(), 'trackb-public-live-'));
function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: stage, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status) throw result.error ?? new Error(`Diagnostic command failed: ${result.status}`);
}
try {
  await cp(join(repo, 'packages/core/src'), join(stage, 'src'), { recursive: true,
    filter: path => !/\.(test|spec)\.tsx?$/.test(path) });
  await cp(join(own, 'probe.test.ts'), join(stage, 'probe.test.ts'));
  await symlink(join(repo, 'tests/track-b/node_modules'), join(stage, 'node_modules'), 'dir');
  await writeFile(join(stage, 'package.json'), '{"private":true,"type":"module"}');
  await writeFile(join(stage, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true,
    noEmit: true, skipLibCheck: true, esModuleInterop: true, types: ['node'],
  }, files: ['probe.test.ts'] }));
  run([join(stage, 'node_modules/typescript/bin/tsc'), '--noEmit']);
  run([join(stage, 'node_modules/vitest/vitest.mjs'), 'run', 'probe.test.ts', '--maxWorkers=1']);
} finally {
  try { await writeFile(join(own, 'result.json'), await readFile(join(stage, 'result.json'))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await rm(stage, { recursive: true, force: true });
}
