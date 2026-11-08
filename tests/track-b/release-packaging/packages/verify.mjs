import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync, realpathSync, readdirSync } from 'node:fs';
import { join, relative, posix } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { artifacts, manifest, repo, show, patchedFiles, buildPatch } from './build-patch.mjs';

// Invoke via run.sh: all npm operations share the cross-workstream mkdir lock.
assert(existsSync('/tmp/track-b-release-heavy.lock'), 'Use run.sh to acquire shared heavy-check lock');
const output = mkdtempSync(join(tmpdir(), 'track-b-release-packages-'));
const report = {
  trackA: manifest.trackA, parent: manifest.parent,
  checkout: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  tools: { node: process.version }, output, verified: {}, blockers: [],
  assumptions: [
    'Selected Track A pin is the owner integration target; later commits require rerunning.',
    'Owner will apply this artifact and existing Workflow/chat/data artifacts through their normal review process.'
  ],
  limits: [
    'Offline npm extraction disables lifecycle scripts; no full Next/Workflow build or service execution.',
    'Isolated fixtures use only the reachable closure of the existing Track A lock entries; they are resolution checks, not application runtime execution.',
    'TypeScript resolver checks module availability, not semantic application type correctness.',
    'No provider/cloud calls, credentials, deployment, or release acceptance.'
  ],
  releaseAccepted: false
};
function command(label, executable, args, cwd) {
  const result = spawnSync(executable, args, {
    cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, NODE_PATH: '', npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_ignore_scripts: 'true', npm_config_update_notifier: 'false' }
  });
  writeFileSync(join(output, `${label}.log`), `${executable} ${args.join(' ')}\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  assert.equal(result.status, 0, `${label} failed; inspect ${output}/${label}.log`);
  return result.stdout.trim();
}
function archive(sha, dest) {
  mkdirSync(dest, { recursive: true });
  const tar = execFileSync('git', ['archive', sha], { cwd: repo, maxBuffer: 128 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', dest], { input: tar });
}
function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const file = join(dir, e.name);
    return e.isDirectory() ? sourceFiles(file) : /\.[cm]?tsx?$/.test(e.name) && !/\.(test|spec)\./.test(e.name) && !e.name.endsWith('.d.ts') ? [file] : [];
  });
}
function isolatedLock(deps, lock) {
  const packages = { '': { name: 'isolated-owner', dependencies: deps } };
  function find(from, name) {
    let dir = from;
    for (;;) {
      const candidate = posix.join(dir, 'node_modules', name);
      if (lock.packages[candidate]) return candidate;
      if (dir === '.') break;
      dir = posix.dirname(dir);
    }
  }
  function visit(key) {
    if (packages[key]) return;
    const pkg = lock.packages[key];
    assert(pkg && !pkg.link, `Missing concrete lock entry ${key}`);
    packages[key] = pkg;
    for (const name of new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})])) {
      const target = find(key, name);
      if (target) visit(target);
      else assert(pkg.optionalDependencies?.[name] || pkg.peerDependenciesMeta?.[name]?.optional, `Missing required locked dependency ${key}: ${name}`);
    }
  }
  for (const name of Object.keys(deps)) visit(`node_modules/${name}`);
  return { name: 'isolated-owner', lockfileVersion: 3, requires: true, packages };
}
try {
  command('parent', 'git', ['merge-base', '--is-ancestor', manifest.parent, 'HEAD'], repo);
  report.tools.npm = command('npm-version', 'npm', ['--version'], repo);
  const patch = readFileSync(join(artifacts, 'track-a-manifests-lock.patch'), 'utf8');
  assert.equal(patch, buildPatch(), 'Committed patch differs from deterministic pinned generator');
  report.patchSha256 = createHash('sha256').update(patch).digest('hex');
  const stage = join(output, 'track-a');
  archive(manifest.trackA, stage);
  command('patch-check', 'git', ['apply', '--check', join(artifacts, 'track-a-manifests-lock.patch')], stage);
  command('patch-apply', 'git', ['apply', join(artifacts, 'track-a-manifests-lock.patch')], stage);
  const lock = JSON.parse(readFileSync(join(stage, 'package-lock.json')));
  const before = JSON.parse(show(manifest.trackA, 'package-lock.json'));
  const files = patchedFiles();
  for (const [file, body] of Object.entries(files)) assert.equal(readFileSync(join(stage, file), 'utf8'), body);
  for (const key of Object.keys(before.packages)) {
    if (!manifest.dependencies[key]) assert.deepEqual(lock.packages[key], before.packages[key], `Unrelated lock mutation ${key}`);
  }
  for (const [owner, deps] of Object.entries(manifest.dependencies)) {
    const pkg = JSON.parse(readFileSync(join(stage, owner, 'package.json')));
    assert.deepEqual(pkg.dependencies, lock.packages[owner].dependencies);
    for (const [name, version] of Object.entries(deps)) assert.equal(pkg.dependencies[name], version);
  }
  report.verified.manifestAndLock = { owners: 2, exactAdditions: 7, unrelatedLockEntriesUnchanged: true };
  for (const file of Object.keys(files)) assert.equal(show(manifest.compatiblePriorTrackA, file), show(manifest.trackA, file));
  report.verified.priorPinIdenticalPackageInputs = manifest.compatiblePriorTrackA;
  command('workspace-ci', 'npm', ['ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], stage);
  assert.equal(readFileSync(join(stage, 'package-lock.json'), 'utf8'), files['package-lock.json']);
  report.verified.workspaceOfflineCi = true;
  const require = createRequire(join(stage, 'package.json'));
  const ts = require('typescript');
  report.tools.typescript = ts.version;
  const nameOf = spec => spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
  report.verified.owners = {};
  for (const [owner, deps] of Object.entries(manifest.dependencies)) {
    const imports = [];
    for (const file of sourceFiles(join(stage, owner, 'src'))) {
      const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      function visit(n) {
        let literal;
        if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier) literal = n.moduleSpecifier;
        if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require')) && n.arguments.length === 1) literal = n.arguments[0];
        if (literal && ts.isStringLiteral(literal) && deps[nameOf(literal.text)]) imports.push({
          file: relative(stage, file), line: ast.getLineAndCharacterOfPosition(n.getStart()).line + 1,
          specifier: literal.text, explicitlyTypeOnly: !!(n.isTypeOnly || n.importClause?.isTypeOnly)
        });
        ts.forEachChild(n, visit);
      }
      visit(ast);
    }
    const specs = [...new Set(imports.map(i => i.specifier))].sort();
    for (const name of Object.keys(deps)) assert(specs.some(s => nameOf(s) === name), `No actual import site: ${owner}/${name}`);
    const fixture = join(output, owner.replaceAll('/', '-'));
    mkdirSync(fixture);
    writeFileSync(join(fixture, 'package.json'), JSON.stringify({ name: 'isolated-owner', private: true, type: 'module', dependencies: deps }, null, 2));
    const fixtureLock = isolatedLock(deps, lock);
    const fixtureLockText = JSON.stringify(fixtureLock, null, 2) + '\n';
    writeFileSync(join(fixture, 'package-lock.json'), fixtureLockText);
    const probe = join(fixture, 'probe.ts');
    writeFileSync(probe, specs.map(s => `import ${JSON.stringify(s)};`).join('\n'));
    const resolve = spec => ts.resolveModuleName(spec, probe, { moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext }, ts.sys).resolvedModule;
    for (const spec of specs) assert.equal(resolve(spec), undefined, `Negative control leaked external modules: ${spec}`);
    command(`${owner.replaceAll('/', '-')}-install`, 'npm', ['ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], fixture);
    assert.equal(readFileSync(join(fixture, 'package-lock.json'), 'utf8'), fixtureLockText);
    for (const [name, version] of Object.entries(deps)) assert.equal(JSON.parse(readFileSync(join(fixture, 'node_modules', name, 'package.json'))).version, version);
    const resolutions = specs.map(specifier => {
      const resolved = resolve(specifier);
      assert(resolved, `Cannot resolve actual source import ${specifier}`);
      const path = realpathSync(resolved.resolvedFileName);
      assert(path.startsWith(realpathSync(join(fixture, 'node_modules')) + '/'), `Resolution escaped owner fixture: ${path}`);
      // Resolve Node's actual ESM export condition without importing/executing providers.
      const esm = command(`resolve-${owner.replaceAll('/', '-')}-${specs.indexOf(specifier)}`, process.execPath, ['--input-type=module', '-e', `console.log(import.meta.resolve(${JSON.stringify(specifier)}))`], fixture);
      assert(esm.startsWith('file://' + realpathSync(join(fixture, 'node_modules')) + '/'));
      assert(existsSync(new URL(esm)));
      return { specifier, types: relative(realpathSync(fixture), path), esm: relative(realpathSync(fixture), new URL(esm).pathname) };
    });
    report.verified.owners[owner] = { exactVersions: deps, lockedClosurePackages: Object.keys(fixtureLock.packages).length - 1, sourceImportSites: imports, negativeControlUnresolved: specs.length, resolutions };
  }
  report.packagingAccepted = true;
} catch (error) {
  report.packagingAccepted = false;
  report.blockers.push(error.message);
  process.exitCode = 1;
} finally {
  writeFileSync(join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
