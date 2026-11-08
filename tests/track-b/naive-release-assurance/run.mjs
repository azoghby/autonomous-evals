import { access, cp, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Offline only. Stage a private tree so dependency resolution never alters source
// directories or another team's manifest. No installation or fallback test suite.
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const deps = process.argv.slice(2).map(p => resolve(p));
if (!deps.length) deps.push(resolve(here, '../node_modules'));
const stage = await mkdtemp(join(tmpdir(), 'naive-release-assurance-'));
const relative = 'tests/track-b/naive-release-assurance';
async function files(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await files(p));
    else if (entry.isFile() && entry.name.endsWith('.test.ts')) result.push(p);
  }
  return result.sort();
}
async function run(args) {
  console.log(JSON.stringify({ command: process.execPath, args }));
  const status = await new Promise((done, reject) => {
    const child = spawn(process.execPath, args, { cwd: stage, stdio: 'inherit', shell: false });
    child.once('error', reject);
    child.once('exit', code => done(code ?? 1));
  });
  if (status !== 0) throw new Error(`Scoped check failed (exit ${status})`);
}
try {
  const tests = await files(here);
  for (const scope of ['crash', 'reservations', 'version', 'cost']) {
    if (!tests.some(p => p.startsWith(join(here, scope) + '/'))) throw new Error(`Missing ${scope} evidence; refusing partial acceptance`);
  }
  await mkdir(join(stage, 'packages/core'), { recursive: true });
  await cp(join(repo, 'packages/core/src'), join(stage, 'packages/core/src'), { recursive: true });
  await cp(here, join(stage, relative), { recursive: true, filter: p => !p.split('/').includes('node_modules') });
  const modules = join(stage, 'node_modules');
  await mkdir(modules);
  const linked = new Set();
  for (const dep of deps) {
    for (const entry of await readdir(dep, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      if (entry.name.startsWith('@')) {
        await mkdir(join(modules, entry.name), { recursive: true });
        for (const name of await readdir(join(dep, entry.name))) {
          const key = `${entry.name}/${name}`;
          if (!linked.has(key)) { await symlink(join(dep, key), join(modules, key)); linked.add(key); }
        }
      } else if (!linked.has(entry.name)) {
        await symlink(join(dep, entry.name), join(modules, entry.name)); linked.add(entry.name);
      }
    }
  }
  for (const required of ['typescript/bin/tsc', 'tsx/dist/loader.mjs']) {
    try { await access(join(modules, required)); }
    catch { throw new Error(`Missing offline dependency ${required}; pass existing node_modules directories as runner arguments. No tests were run.`); }
  }
  const roots = tests.map(p => join(relative, p.slice(here.length + 1)));
  await writeFile(join(stage, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await writeFile(join(stage, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, noEmit: true, skipLibCheck: true, esModuleInterop: true, types: ['node'] },
    files: roots,
  }));
  console.log(`Strict scoped check: ${roots.length} files; dependency roots ${JSON.stringify(deps)}`);
  await run([join(modules, 'typescript/bin/tsc'), '-p', 'tsconfig.json']);
  await run(['--import', join(modules, 'tsx/dist/loader.mjs'), '--test', '--test-concurrency=1', ...roots]);
  console.log('PASS: strict TypeScript and all four scoped evidence groups. Characterizations do not confer production acceptance.');
} finally {
  await rm(stage, { recursive: true, force: true });
}
