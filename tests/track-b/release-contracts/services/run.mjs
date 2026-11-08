import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const pinned = '8634ceb30f3d98de7ec24b240a4f7549dce80033';
function git(args, cwd = process.cwd()) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(r.stderr);
  return args[0] === 'show' ? r.stdout : r.stdout.trimEnd();
}
const repo = git(['rev-parse', '--show-toplevel']);
const here = dirname(fileURLToPath(import.meta.url));
if (git(['rev-parse', 'origin/track-a'], repo) !== pinned) throw new Error('origin/track-a moved; explicit re-review required');
const candidates = process.env.TRACK_B_NODE_MODULES ? [resolve(process.env.TRACK_B_NODE_MODULES)] : [join(repo, 'tests/track-b/node_modules'), '/tmp/autonomous-evals-checks.m10du4/node_modules'];
let modules;
for (const p of candidates) { try { await access(join(p, 'vitest/vitest.mjs')); await access(join(p, 'typescript/bin/tsc')); modules = p; break; } catch {} }
if (!modules) throw new Error('Offline dependencies missing; set TRACK_B_NODE_MODULES; do not install');
const stage = await mkdtemp(join(tmpdir(), 'release-services-'));
try {
  for (const dir of ['agents', 'evals', 'reporting', 'targets', 'simulator', 'judges', 'monitoring']) {
    await cp(join(repo, 'packages/core/src', dir), join(stage, 'src', dir), { recursive: true, filter: p => !/\.(test|spec)\.ts$/.test(p) });
  }
  const prefixes = ['packages/core/src/contracts/', 'packages/core/src/integration/compose.ts', 'packages/core/src/lite/', 'packages/core/src/redteam/', 'apps/web/src/server/services.ts'];
  const snapshots = [];
  for (const prefix of prefixes) for (const path of git(['ls-tree', '-r', '--name-only', pinned, '--', prefix], repo).split('\n')) {
    if (!path.endsWith('.ts') || /\.(test|spec)\.ts$/.test(path)) continue;
    const relative = path.startsWith('packages/core/src/') ? `src/${path.slice('packages/core/src/'.length)}` : 'app/services.ts';
    const dest = join(stage, relative);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, git(['show', `${pinned}:${path}`], repo));
    snapshots.push({ path, blob: git(['rev-parse', `${pinned}:${path}`], repo) });
  }
  await cp(join(here, 'boundaries'), join(stage, 'boundaries'), { recursive: true });
  await mkdir(join(stage, 'src/ai'), { recursive: true });
  await writeFile(join(stage, 'src/ai/gateway.ts'), (await readFile(join(here, 'boundaries/gateway.ts'), 'utf8')).replace('../src/contracts/services', '../contracts/services'));
  await cp(join(here, 'services.test.ts'), join(stage, 'services.test.ts'));
  await cp(join(here, 'service-map.json'), join(stage, 'service-map.json'));
  await writeFile(join(stage, 'snapshots.json'), JSON.stringify(snapshots));
  await symlink(modules, join(stage, 'node_modules'), 'dir');
  await writeFile(join(stage, 'package.json'), '{"private":true,"type":"module"}');
  const aliases = { '@ae/core/integration/eval-services': './boundaries/bootstrap.ts', '@ae/core': './src', 'server-only': './boundaries/empty.ts', workflow: './boundaries/workflow.ts', './target-url': './boundaries/target-url.ts', './redteam-mock': './boundaries/redteam-mock.ts', './lite-target': './boundaries/lite-target.ts' };
  await writeFile(join(stage, 'vitest.config.ts'), `export default {resolve:{alias:${JSON.stringify(Object.fromEntries(Object.entries(aliases).map(([k,v]) => [k, join(stage,v)])))}},test:{include:['services.test.ts'],maxWorkers:1}};`);
  // Relative app imports resolve to explicit host boundary doubles for TypeScript too.
  for (const name of ['target-url', 'redteam-mock', 'lite-target']) await cp(join(stage, 'boundaries', `${name}.ts`), join(stage, 'app', `${name}.ts`));
  await writeFile(join(stage, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, noEmit: true, skipLibCheck: true, esModuleInterop: true, types: ['node'], paths: { '@ae/core/integration/eval-services': ['./boundaries/bootstrap.ts'], '@ae/core/*': ['./src/*'], workflow: ['./boundaries/workflow.ts'], 'server-only': ['./boundaries/empty.ts'] } }, include: ['src/**/*.ts', 'app/**/*.ts', 'boundaries/**/*.ts', 'services.test.ts'] }));
  console.log(`Track B ${git(['rev-parse','HEAD'],repo)}; Track A ${pinned}; dependencies ${modules}; providers blocked`);
  for (const [tool,args] of [['typescript/bin/tsc',['-p',join(stage,'tsconfig.json')]],['vitest/vitest.mjs',['run','--root',stage,'--reporter=default','--reporter=json',`--outputFile.json=${join(stage,'results.json')}`]]]) {
    const r = spawnSync(process.execPath,[join(modules,tool),...args],{ cwd:stage,stdio:'inherit', env:{...process.env, EVAL_SERVICES:'mock'} });
    if (r.error || r.status !== 0) throw r.error ?? new Error(`${tool} exited ${r.status}`);
  }
  const results = JSON.parse(await readFile(join(stage,'results.json'),'utf8'));
  const cases = results.testResults.flatMap(f => f.assertionResults);
  if (results.testResults.length !== 1 || cases.length !== 14 || cases.some(c => c.status !== 'passed')) throw new Error('Incomplete scoped execution');
  console.log('Strict scoped TypeScript passed; 14 tests executed, none skipped. Characterizations do not close release gates.');
} finally { await rm(stage,{recursive:true,force:true}); }
