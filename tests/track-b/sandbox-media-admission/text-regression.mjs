// Offline strict scoped check. No installs; contracts read from an existing local git revision.
import { cp, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const runnerDir = dirname(fileURLToPath(import.meta.url));
const own = resolve(runnerDir, '../cross-service-release/text');
const repo = resolve(runnerDir, '../../..');
const deps = process.env.TRACK_B_REVIEW_NODE_MODULES ?? '/tmp/workflow-bootstrap.JpxCTM/node_modules';
const ref = process.env.TRACK_B_CONTRACT_REF ?? 'be522f1e13e697017bac96728748b82cadc08ab9';
const stage = await mkdtemp(join(tmpdir(), 'text-cross-release-'));
function run(cmd, args, cwd = stage, quiet = false) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.stdout && !quiet) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.error || r.status !== 0) throw r.error ?? new Error(`${cmd} failed: ${r.status}`);
  return r.stdout;
}
try {
  const src = join(stage, 'packages/core/src');
  const archive = spawnSync('git',['archive','74fab97','packages/core/src/sandbox'],{cwd:repo,maxBuffer:64*1024*1024});
  if(archive.status!==0) throw Error('Missing pinned sandbox contract');
  const untar=spawnSync('tar',['-x','-C',stage],{input:archive.stdout});
  if(untar.status!==0) throw Error('Contract staging failed');
  await mkdir(src, { recursive: true });
  for (const dir of ['ai', 'agents', 'evals', 'reporting', 'simulator', 'targets', 'monitoring', 'judges']) {
    await cp(join(repo, 'packages/core/src', dir), join(src, dir), { recursive: true, filter: p => !/\.(test|spec)\.[cm]?[jt]sx?$/.test(p) });
  }
  const contracts = run('git', ['ls-tree', '-r', '--name-only', ref, '--', 'packages/core/src/contracts'], repo, true).trim().split('\n');
  for (const path of contracts.filter(p => p.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(p))) {
    const content = run('git', ['show', `${ref}:${path}`], repo, true);
    await mkdir(dirname(join(stage, path)), { recursive: true });
    await writeFile(join(stage, path), content);
  }
  const tests = join(stage, 'tests/track-b/cross-service-release/text');
  await mkdir(tests, { recursive: true });
  for (const file of ['cases.ts', 'text.test.ts']) await cp(join(own, file), join(tests, file));
  await mkdir(join(stage,'node_modules'));
  for(const name of await readdir(deps)) await symlink(name==='ipaddr.js'?'/tmp/sandbox-generation-deps.cBCEai/node_modules/ipaddr.js':join(deps,name),join(stage,'node_modules',name));
  await writeFile(join(stage, 'package.json'), '{"private":true,"type":"module"}');
  await writeFile(join(stage, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, skipLibCheck: true, esModuleInterop: true, resolveJsonModule: true, types: ['node'], outDir: 'out' }, include: ['packages/core/src/ai/**/*.ts', 'packages/core/src/agents/**/*.ts', 'packages/core/src/evals/**/*.ts', 'packages/core/src/reporting/**/*.ts', 'packages/core/src/simulator/**/*.ts', 'packages/core/src/targets/**/*.ts', 'packages/core/src/monitoring/**/*.ts', 'packages/core/src/judges/**/*.ts', 'tests/**/*.ts'] }));
  run(process.execPath, [join(stage, 'node_modules/typescript/bin/tsc')]);
  // tsc preserves extensionless production imports, matching the existing bundler conventions.
  // A local loader resolves only those emitted relative module paths; no transpiler/network.
  await writeFile(join(stage, 'loader.mjs'), `import { existsSync } from 'node:fs';\nimport { fileURLToPath } from 'node:url';\nexport async function resolve(specifier, context, next) {\n if (specifier.startsWith('.') && context.parentURL) {\n const base = new URL(specifier, context.parentURL);\n for (const suffix of ['.js','/index.js']) { const url = new URL(base.href + suffix); if (existsSync(fileURLToPath(url))) return next(url.href, context); }\n }\n return next(specifier, context);\n}\n`);
  // SQL migrations are runtime assets, copied beside emitted JS.
  for (const path of ['agents/persistence-migrations', 'evals/integration/migrations', 'reporting/chat/persistence-migrations']) await cp(join(src, path), join(stage, 'out/packages/core/src', path), { recursive: true });
  run(process.execPath, ['--loader', join(stage, 'loader.mjs'), '--test', join(stage, 'out/tests/track-b/cross-service-release/text/text.test.js')]);
  console.log(`Strict compilation and 2 scoped node:test acceptance cases passed. Contracts: ${ref}.`);
} finally { await rm(stage, { recursive: true, force: true }); }
