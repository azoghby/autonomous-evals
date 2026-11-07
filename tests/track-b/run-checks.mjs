import { cp, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const source = join(repo, 'packages/core/src');
const owned = ['agents', 'evals', 'reporting', 'targets', 'simulator'];
const present = await readdir(source).catch((error) => {
  if (error.code === 'ENOENT') return [];
  throw error;
});
const missing = owned.filter((name) => !present.includes(name));
if (missing.length) {
  console.error(`Track B source directories not integrated: ${missing.join(', ')}. No checks passed.`);
  process.exit(1);
}
const staging = await mkdtemp(join(tmpdir(), 'ae-track-b-'));
const run = (program, args) => {
  const result = spawnSync(process.execPath, [program, ...args], { cwd: staging, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Check failed with exit ${result.status ?? result.signal}`);
};
try {
  await mkdir(join(staging, 'src'));
  for (const directory of owned) {
    await cp(join(source, directory), join(staging, 'src', directory), { recursive: true });
  }
  // Read shared types if integrated, without changing Track A's source/configuration.
  if (present.includes('contracts')) {
    await cp(join(source, 'contracts'), join(staging, 'src/contracts'), { recursive: true });
  }
  await symlink(join(here, 'node_modules'), join(staging, 'node_modules'), 'dir');
  await writeFile(join(staging, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await writeFile(join(staging, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler',
      strict: true, noEmit: true, skipLibCheck: true, esModuleInterop: true,
      resolveJsonModule: true, isolatedModules: true, types: ['node'],
    },
    include: ['src/**/*.ts'],
  }));
  run(join(here, 'node_modules/typescript/bin/tsc'), ['--project', join(staging, 'tsconfig.json')]);
  run(join(here, 'node_modules/vitest/vitest.mjs'), ['run', '--root', staging]);
  console.log('Track B strict type-check and discovered tests passed. Live-provider checks are separate.');
} finally {
  await rm(staging, { recursive: true, force: true });
}
