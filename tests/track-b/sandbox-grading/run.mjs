import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Offline: no dependency installation, fetch, contract rewriting, or cloud calls.
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const modules = resolve(process.env.SANDBOX_GRADING_NODE_MODULES ?? join(here, '../node_modules'));
const contract = 'packages/core/src/sandbox/spec.ts';
const source = 'packages/core/src/evals/sandbox/grading';
const tests = 'tests/track-b/sandbox-grading';
// Default remains the pinned contract; an explicit owner compatibility check may stage a newer exact spec.
const ref = process.env.TRACK_A_REF ?? 'aa94505';

function command(program, args, options = {}) {
  const result = spawnSync(program, args, { cwd: repo, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} failed (${result.status ?? result.signal}):\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  return result.stdout;
}

async function main() {
  if (process.argv.length !== 2) throw new Error('Usage: node tests/track-b/sandbox-grading/run.mjs (default contract aa94505; TRACK_A_REF for compatibility)');
  for (const required of ['typescript/bin/tsc', 'zod/package.json', '@types/node/package.json']) {
    try { await stat(join(modules, required)); }
    catch { throw new Error(`Missing installed ${required}; set SANDBOX_GRADING_NODE_MODULES to an existing compatible node_modules. No dependencies were installed.`); }
  }
  const sha = command('git', ['rev-parse', '--verify', `${ref}^{commit}`]).trim();
  // Buffer preserves the exact pinned blob, including all whitespace.
  const blob = command('git', ['show', `${sha}:${contract}`], { encoding: 'buffer' });
  const digest = createHash('sha256').update(blob).digest('hex');
  const names = (await readdir(here)).filter(name => name.endsWith('.test.ts')).sort();
  if (!names.length) throw new Error('No grading tests found; no checks passed.');
  const stage = await mkdtemp(join(tmpdir(), 'sandbox-grading-'));
  try {
    await mkdir(dirname(join(stage, contract)), { recursive: true });
    await writeFile(join(stage, contract), blob);
    await cp(join(repo, source), join(stage, source), { recursive: true });
    await mkdir(join(stage, tests), { recursive: true });
    for (const name of names) await cp(join(here, name), join(stage, tests, name));
    await symlink(modules, join(stage, 'node_modules'), 'dir');
    await writeFile(join(stage, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    await writeFile(join(stage, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
      target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
      skipLibCheck: true, esModuleInterop: true, types: ['node'], rootDir: '.', outDir: 'dist',
    }, include: [`${source}/**/*.ts`, contract, `${tests}/*.test.ts`] }));
    console.log(`Contract: ${sha}:${contract}; unchanged blob sha256:${digest}`);
    command(process.execPath, [join(modules, 'typescript/bin/tsc'), '--project', join(stage, 'tsconfig.json')], { cwd: stage });
    const output = command(process.execPath, ['--test', '--test-reporter=tap', ...names.map(name => join(stage, 'dist', tests, name.replace(/\.ts$/, '.js')))], { cwd: stage });
    process.stdout.write(output);
    const count = key => Number(new RegExp(`^# ${key} (\\d+)$`, 'm').exec(output)?.[1] ?? NaN);
    if (!(count('tests') > 0) || count('pass') !== count('tests') || ['fail', 'cancelled', 'skipped', 'todo'].some(key => count(key) !== 0)) {
      throw new Error('Test completeness check failed: missing, failed, cancelled, skipped, or todo tests.');
    }
    console.log(`Strict type-check passed; ${names.length} test files, ${count('tests')} tests passed. Offline fixtures only; no live runtime/provider acceptance claimed.`);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
