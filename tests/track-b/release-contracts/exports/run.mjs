#!/usr/bin/env node
// Offline, exact-revision package export and production dependency release gate.
import assert from 'node:assert/strict';
import { builtinModules, createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const BASE = '6ff8a0642fc14dfd23842456d124a4b84f5e040a';
const TRACK_A = '8634ceb30f3d98de7ec24b240a4f7549dce80033';
const args = process.argv.slice(2);
if (args.some(x => !['--strict', '--characterize'].includes(x)) || args.length > 1) {
  throw new Error('Usage: node tests/track-b/release-contracts/exports/run.mjs [--strict|--characterize]');
}
const mode = args[0] ?? '--strict';
function command(file, argv, options = {}) {
  const result = spawnSync(file, argv, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${file} ${argv.join(' ')}: ${result.status}\n${result.stderr}`);
  return result.stdout.trim();
}
const repo = command('git', ['rev-parse', '--show-toplevel'], { cwd: process.cwd() });
assert.equal(command('git', ['rev-parse', 'origin/track-a^{commit}'], { cwd: repo }), TRACK_A, 'local origin/track-a drifted; no fetch permitted');
assert.equal(command('git', ['rev-parse', `${BASE}^{commit}`], { cwd: repo }), BASE);
command('git', ['merge-base', '--is-ancestor', BASE, 'HEAD'], { cwd: repo });
// Existing tools only. Override with an absolute node_modules directory; never install.
const deps = resolve(process.env.RELEASE_EXPORTS_NODE_MODULES ?? '/tmp/workflow-bootstrap.JpxCTM/node_modules');
const require = createRequire(join(deps, '_release_exports.cjs'));
const ts = require('typescript');
const esbuild = require('esbuild');
const stage = await realpath(await mkdtemp(join(tmpdir(), 'release-exports-')));
const report = { base: BASE, trackA: TRACK_A, mode, tools: { node: process.version, typescript: ts.version, esbuild: esbuild.version }, checks: {}, defects: [] };
const builtins = new Set(builtinModules.map(x => x.replace(/^node:/, '')));
const packageName = x => x.startsWith('@') ? x.split('/').slice(0, 2).join('/') : x.split('/')[0];
const external = x => !x.startsWith('.') && !x.startsWith('/') && !x.startsWith('#');
async function files(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else if (/\.[cm]?tsx?$/.test(entry.name) && !/\.(test|spec)\.[cm]?tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) result.push(path);
  }
  return result.sort();
}
function imports(path, source) {
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const result = [];
  function visit(n) {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      const clause = n.importClause;
      const bindings = clause?.namedBindings;
      const allType = clause && !clause.name && bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every(x => x.isTypeOnly);
      const exportTypes = ts.isExportDeclaration(n) && n.exportClause && ts.isNamedExports(n.exportClause) && n.exportClause.elements.length > 0 && n.exportClause.elements.every(x => x.isTypeOnly);
      result.push({ specifier: n.moduleSpecifier.text, typeOnly: !!(n.isTypeOnly || clause?.isTypeOnly || allType || exportTypes), line: ast.getLineAndCharacterOfPosition(n.getStart()).line + 1 });
    } else if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require')) && n.arguments.length === 1 && ts.isStringLiteral(n.arguments[0])) {
      result.push({ specifier: n.arguments[0].text, typeOnly: false, line: ast.getLineAndCharacterOfPosition(n.getStart()).line + 1 });
    }
    ts.forEachChild(n, visit);
  }
  visit(ast);
  return result;
}
const EXPECTED_MANIFEST_PROBLEMS = [
  ['apps/web:@neondatabase/serverless', 1],
  ['apps/web:@x402/core', 2],
  ['apps/web:drizzle-orm', 42],
  ['apps/web:stripe', 2],
  ['apps/web:zod', 17],
  ['packages/core:dotenv', 1],
  ['packages/core:resend', 1],
];
try {
  const archive = join(stage, 'source.tar');
  command('git', ['archive', '--format=tar', `--output=${archive}`, TRACK_A], { cwd: repo });
  command('tar', ['-xf', archive, '-C', stage]);
  const core = JSON.parse(await readFile(join(stage, 'packages/core/package.json'), 'utf8'));
  assert.equal(core.name, '@ae/core');
  assert.deepEqual(core.exports, { './*': './src/*.ts' });
  await mkdir(join(stage, 'node_modules/@ae'), { recursive: true });
  await symlink(join(stage, 'packages/core'), join(stage, 'node_modules/@ae/core'), 'dir');
  const coreFiles = await files(join(stage, 'packages/core/src'));
  const appFiles = await files(join(stage, 'apps/web/src'));
  const parsed = new Map();
  for (const file of [...coreFiles, ...appFiles]) parsed.set(file, imports(file, await readFile(file, 'utf8')));
  const publicImports = [...new Set([...parsed.values()].flat().map(x => x.specifier).filter(x => x.startsWith('@ae/core/')))];
  const barrels = coreFiles.filter(x => x.endsWith('/index.ts')).map(x => `@ae/core/${x.slice(join(stage, 'packages/core/src').length + 1, -3)}`);
  const probes = [...new Set([...publicImports, ...barrels])].sort();
  const options = { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, target: ts.ScriptTarget.ES2022, noEmit: true };
  const unresolved = [];
  for (const specifier of probes) {
    const resolved = ts.resolveModuleName(specifier, join(stage, 'consumer.ts'), options, ts.sys).resolvedModule;
    if (!resolved) unresolved.push(specifier);
    else assert(resolved.resolvedFileName.startsWith(join(stage, 'packages/core/src/')), `unexpected resolution: ${specifier}`);
  }
  report.checks.resolution = { consumerSubpaths: publicImports.length, explicitBarrels: barrels.length, probes: probes.length, unresolved };
  if (unresolved.length) report.defects.push({ kind: 'unresolved-public-import', specifiers: unresolved });
  // TypeScript's export symbol table includes both value and type exports.
  // Check actual consumer binding names without executing modules or importing SDKs.
  const program = ts.createProgram([...coreFiles, ...appFiles], options);
  const checker = program.getTypeChecker();
  const bindingProblems = [];
  let bindingsChecked = 0;
  for (const file of [...coreFiles, ...appFiles]) {
    const source = program.getSourceFile(file);
    for (const node of source.statements) {
      if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier) || !node.moduleSpecifier.text.startsWith('@ae/core/')) continue;
      const module = checker.getSymbolAtLocation(node.moduleSpecifier);
      const exports = new Set(module ? checker.getExportsOfModule(module).map(x => x.name) : []);
      const clause = node.importClause;
      const names = clause?.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements.map(x => (x.propertyName ?? x.name).text) : [];
      if (clause?.name) names.push('default');
      for (const name of names) {
        bindingsChecked++;
        if (!exports.has(name)) bindingProblems.push({ file: file.slice(stage.length + 1), specifier: node.moduleSpecifier.text, name });
      }
    }
  }
  report.checks.consumerBindings = { checked: bindingsChecked, problems: bindingProblems };
  if (bindingProblems.length) report.defects.push({ kind: 'consumer-binding', problems: bindingProblems });
  // This manifest makes explicit /index imports public; it does not promise directory aliases.
  assert.equal(ts.resolveModuleName('@ae/core', join(stage, 'consumer.ts'), options, ts.sys).resolvedModule, undefined);
  report.checks.rootExportAvailable = false;
  report.checks.directoryAliases = barrels.map(x => ({ specifier: x.replace(/\/index$/, ''), resolved: !!ts.resolveModuleName(x.replace(/\/index$/, ''), join(stage, 'consumer.ts'), options, ts.sys).resolvedModule }));
  assert(report.checks.directoryAliases.every(x => !x.resolved));
  // Real bundler follows all relative source edges and validates re-export collisions.
  // Only third-party imports are external: this checks code without loading provider code.
  const entryPoints = {};
  await mkdir(join(stage, 'probes'));
  for (const [i, specifier] of probes.entries()) {
    const file = join(stage, 'probes', `${i}.ts`);
    await writeFile(file, `export * from ${JSON.stringify(specifier)};\n`);
    entryPoints[`probe-${i}`] = file;
  }
  const build = await esbuild.build({ entryPoints, bundle: true, write: false, outdir: join(stage, 'out'), platform: 'node', format: 'esm', logLevel: 'silent', plugins: [{ name: 'third-party-only', setup(build) {
    build.onResolve({ filter: /^[^./]/ }, ({ path }) => external(path) && !path.startsWith('@ae/core/') ? { path, external: true } : undefined);
  } }] }).then(x => ({ errors: [], warnings: x.warnings.map(x => x.text), outputFiles: x.outputFiles.length }), error => ({ errors: error.errors.map(x => ({ text: x.text, file: x.location?.file, line: x.location?.line })), warnings: error.warnings.map(x => x.text), outputFiles: 0 }));
  report.checks.bundle = build;
  if (build.errors.length || build.warnings.length) report.defects.push({ kind: 'public-bundle', ...build });
  const dependencyProblems = [];
  for (const [directory, sources] of [['packages/core', coreFiles], ['apps/web', appFiles]]) {
    const manifest = JSON.parse(await readFile(join(stage, directory, 'package.json'), 'utf8'));
    const runtime = { ...manifest.dependencies, ...manifest.peerDependencies, ...manifest.optionalDependencies };
    const all = { ...runtime, ...manifest.devDependencies };
    for (const file of sources) for (const item of parsed.get(file)) {
      const name = packageName(item.specifier);
      if (!external(item.specifier) || item.specifier.startsWith('@/') || builtins.has(item.specifier.replace(/^node:/, '')) || name === manifest.name) continue;
      if (!(item.typeOnly ? all[name] : runtime[name])) dependencyProblems.push({ package: directory, file: file.slice(stage.length + 1), line: item.line, specifier: item.specifier, typeOnly: item.typeOnly, reason: all[name] ? 'runtime dependency declared only in devDependencies' : 'dependency absent from owning manifest' });
    }
  }
  report.checks.manifests = { productionFiles: coreFiles.length + appFiles.length, problems: dependencyProblems };
  const grouped = new Map();
  for (const item of dependencyProblems) {
    const key = `${item.package}:${packageName(item.specifier)}`;
    grouped.set(key, (grouped.get(key) ?? 0) + 1);
  }
  report.checks.manifests.summary = [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b));
  if (dependencyProblems.length) report.defects.push({ kind: 'manifest-dependency', count: dependencyProblems.length });
  const lock = JSON.parse(await readFile(join(stage, 'package-lock.json'), 'utf8'));
  for (const directory of ['', 'packages/core', 'apps/web']) {
    const manifest = JSON.parse(await readFile(join(stage, directory, 'package.json'), 'utf8'));
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      assert.deepEqual(lock.packages[directory]?.[section] ?? {}, manifest[section] ?? {}, `lock manifest mismatch: ${directory || 'root'} ${section}`);
    }
  }
  report.checks.lockManifests = { checked: 3, matched: true };
  report.accepted = report.defects.length === 0;
  if (mode === '--characterize') {
    // Baseline observations belong here, never in strict release acceptance.
    assert.deepEqual(unresolved, []);
    assert.deepEqual(build.errors, []);
    assert.deepEqual(build.warnings, []);
    assert.deepEqual(bindingProblems, []);
    assert.deepEqual(report.checks.manifests.summary, EXPECTED_MANIFEST_PROBLEMS);
    report.characterizationPassed = true;
  }
  console.log(JSON.stringify(report, null, 2));
  if (mode === '--strict' && !report.accepted) process.exitCode = 1;
} finally {
  await rm(stage, { recursive: true, force: true });
}
