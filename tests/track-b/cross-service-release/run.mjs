// Offline strict scoped check. No installs; contracts read from an existing local git revision.
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const own = dirname(fileURLToPath(import.meta.url));
const repo = resolve(own, '../../..');
const deps = process.env.TRACK_B_REVIEW_NODE_MODULES ?? '/tmp/autonomous-evals-checks.m10du4/node_modules';
const ref = process.env.TRACK_B_CONTRACT_REF ?? '8634ceb30f3d98de7ec24b240a4f7549dce80033';
const stage = await mkdtemp(join(tmpdir(), 'combined-cross-release-'));
function run(cmd, args, cwd = stage, quiet = false) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.stdout && !quiet) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.error || r.status !== 0) throw r.error ?? new Error(`${cmd} failed: ${r.status}`);
  return r.stdout;
}
try {
  const src = join(stage, 'packages/core/src');
  await mkdir(src, { recursive: true });
  for (const dir of ['agents', 'evals', 'reporting', 'simulator', 'targets', 'monitoring', 'judges']) {
    await cp(join(repo, 'packages/core/src', dir), join(src, dir), { recursive: true, filter: p => !/\.(test|spec)\.[cm]?[jt]sx?$/.test(p) });
  }
  const contracts = run('git', ['ls-tree', '-r', '--name-only', ref, '--', 'packages/core/src/contracts'], repo, true).trim().split('\n');
  for (const path of contracts.filter(p => p.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(p))) {
    const content = run('git', ['show', `${ref}:${path}`], repo, true);
    await mkdir(dirname(join(stage, path)), { recursive: true });
    await writeFile(join(stage, path), content);
  }
  const testRoot = 'tests/track-b/cross-service-release';
  const testFiles = [];
  for (const area of ['text', 'calendar', 'costs', 'ordering']) {
    const source = join(own, area);
    if (area === 'ordering') {
      for (const file of ['cases.ts', 'ordering.test.ts']) await cp(join(source, file), join(stage, file));
      testFiles.push('ordering.test.js');
      continue;
    }
    await cp(source, join(stage, testRoot, area), { recursive: true, filter: p => !p.endsWith('results.txt') });
    async function discover(dir, relative = '') {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(relative, entry.name);
        if (entry.isDirectory()) await discover(join(dir, entry.name), path);
        else if (entry.name.endsWith('.test.ts')) testFiles.push(join(testRoot, area, path).replace(/\.ts$/, '.js'));
      }
    }
    await discover(source);
    if (!testFiles.some(p => p.startsWith(join(testRoot, area)))) throw new Error(`Missing scoped tests: ${area}`);
  }
  console.log(`Combined source HEAD: ${run('git', ['rev-parse', 'HEAD'], repo, true).trim()}; local contracts: ${ref}`);
  await symlink(deps, join(stage, 'node_modules'), 'dir');
  await writeFile(join(stage, 'package.json'), '{"private":true,"type":"module"}');
  await writeFile(join(stage, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, skipLibCheck: true, esModuleInterop: true, resolveJsonModule: true, types: ['node'], outDir: 'out' }, include: ['packages/**/*.ts', 'tests/**/*.ts', 'cases.ts', 'ordering.test.ts'] }));
  await symlink(join(stage, 'packages/core/src'), join(stage, 'src'), 'dir');
  run(process.execPath, [join(stage, 'node_modules/typescript/bin/tsc')]);
  // tsc preserves extensionless production imports, matching the existing bundler conventions.
  // A local loader resolves only those emitted relative module paths; no transpiler/network.
  await writeFile(join(stage, 'loader.mjs'), `import { existsSync } from 'node:fs';\nimport { fileURLToPath } from 'node:url';\nexport async function resolve(specifier, context, next) {\n if (specifier.startsWith('.') && context.parentURL) {\n const base = new URL(specifier, context.parentURL);\n for (const suffix of ['.js','/index.js']) { const url = new URL(base.href + suffix); if (existsSync(fileURLToPath(url))) return next(url.href, context); }\n }\n return next(specifier, context);\n}\n`);
  // SQL migrations are runtime assets, copied beside emitted JS.
  for (const path of ['agents/persistence-migrations', 'evals/integration/migrations', 'reporting/chat/persistence-migrations']) await cp(join(src, path), join(stage, 'out/packages/core/src', path), { recursive: true });
  const nodeFiles = [], vitestFiles = [];
  for (const file of testFiles.sort()) {
    const source = file.replace(/\.js$/, '.ts');
    ((await readFile(join(stage, source), 'utf8')).includes("from 'vitest'") ? vitestFiles : nodeFiles).push(source);
  }
  if (nodeFiles.length) run(process.execPath, ['--loader', join(stage, 'loader.mjs'), '--test', '--test-concurrency=1', ...nodeFiles.map(p => join(stage, 'out', p.replace(/\.ts$/, '.js')))]);
  if (vitestFiles.length) {
    run(process.execPath, [join(stage, 'node_modules/vitest/vitest.mjs'), 'run', ...vitestFiles, '--root', stage, '--maxWorkers=1', '--testTimeout=60000', '--reporter=default', '--reporter=json', `--outputFile.json=${join(stage, 'results.json')}`]);
    const results = JSON.parse(await readFile(join(stage, 'results.json'), 'utf8'));
    const assertions = results.testResults.flatMap(f => f.assertionResults);
    if (results.testResults.length !== vitestFiles.length || assertions.some(t => t.status !== 'passed')) throw new Error('Missing, skipped or failed scoped tests');
    console.log(`Vitest: ${assertions.length} assertions passed; zero skipped or failed.`);
  }
  console.log(`Combined strict scoped check passed: ${testFiles.length} test files. Contracts: ${ref}.`);
} finally { await rm(stage, { recursive: true, force: true }); }
