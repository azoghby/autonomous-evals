// One offline stage, one strict compile, and only this team's selected test files.
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const modules = resolve(process.env.TRACK_B_REVIEW_NODE_MODULES ?? join(repo, 'tests/track-b/node_modules'));
const ref = process.env.TRACK_A_REF ?? '8634ceb30f3d98de7ec24b240a4f7549dce80033';
function execute(command, args, cwd, capture = false) {
  const r = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: capture ? 'pipe' : 'inherit' });
  if (r.error || r.status !== 0) throw r.error ?? new Error(`${command} exited ${r.status}: ${r.stderr ?? ''}`);
  return r.stdout;
}
const git = args => execute('git', args, repo, true);
if (ref.startsWith('-') || /[\0\r\n]/.test(ref)) throw new Error('Invalid local contracts ref');
const sha = git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).trim();
await access(join(modules, 'typescript/bin/tsc'));
await access(join(modules, 'vitest/vitest.mjs'));
const stage = await mkdtemp(join(tmpdir(), 'security-release-assurance-'));
try {
  const source = join(stage, 'packages/core/src');
  await cp(join(repo, 'packages/core/src'), source, { recursive: true, filter: p => !/\.(test|spec)\.[cm]?[jt]sx?$/.test(p) });
  const prefix = 'packages/core/src/contracts/';
  const paths = git(['ls-tree', '-r', '--name-only', sha, '--', prefix]).trim().split('\n').filter(p => p.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(p));
  if (!paths.includes(prefix + 'services.ts')) throw new Error('Local contracts unavailable');
  for (const path of paths) {
    await mkdir(dirname(join(stage, path)), { recursive: true });
    await writeFile(join(stage, path), git(['show', `${sha}:${path}`]));
  }
  const selected = [];
  async function suite(name, destination) {
    await mkdir(join(stage, destination), { recursive: true });
    for (const file of (await readdir(join(here, name))).sort()) {
      if (!file.endsWith('.ts')) continue;
      await cp(join(here, name, file), join(stage, destination, file));
      if (file.endsWith('.test.ts')) selected.push(`${destination}/${file}`);
    }
  }
  await suite('rotation', 'packages/core/src/rotation');
  await cp(join(repo, 'packages/core/src/agents/__tests__/fakes.ts'), join(source, 'agents/__tests__/fakes.ts'));
  await suite('identity', 'tests/track-b/security-release-assurance/identity');
  await suite('calendar', 'packages/core/review');
  await suite('provenance', 'packages/core/src/provenance');
  await cp(join(repo, 'packages/core/src/evals/text/__tests__/fixtures.ts'), join(source, 'evals/text/__tests__/fixtures.ts'));
  await symlink(modules, join(stage, 'node_modules'), 'dir');
  await writeFile(join(stage, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await writeFile(join(stage, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, noEmit: true,
    skipLibCheck: true, esModuleInterop: true, resolveJsonModule: true, isolatedModules: true, types: ['node'],
  }, include: ['packages/**/*.ts', 'tests/**/*.ts'] }));
  console.log(`Production source HEAD ${git(['rev-parse', 'HEAD']).trim()}; local contracts ${sha}`);
  console.log(`Selected test files: ${selected.join(', ')}`);
  execute(process.execPath, [join(modules, 'typescript/bin/tsc'), '-p', join(stage, 'tsconfig.json')], stage);
  console.log('STRICT TYPES PASSED');
  execute(process.execPath, [join(modules, 'vitest/vitest.mjs'), 'run', ...selected, '--root', stage,
    '--maxWorkers=1', '--testTimeout=30000', '--hookTimeout=30000', '--reporter=default', '--reporter=json', '--outputFile=results.json'], stage);
  const results = JSON.parse(await readFile(join(stage, 'results.json'), 'utf8'));
  const assertions = results.testResults.flatMap(f => f.assertionResults);
  const defects = assertions.filter(a => /defect characterization/i.test(a.fullName));
  if (results.testResults.length !== selected.length || assertions.length !== 38 || assertions.some(a => a.status !== 'passed')) throw new Error('Missing, skipped, todo, or failed scoped tests');
  console.log(`SCOPED RESULT: ${assertions.length} passed; ${assertions.length - defects.length} acceptance/regressions; ${defects.length} defect characterizations; no skips/todos.`);
} finally { await rm(stage, { recursive: true, force: true }); }
