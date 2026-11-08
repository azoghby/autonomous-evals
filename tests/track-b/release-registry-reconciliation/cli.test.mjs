import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, readdirSync, lstatSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';

const cli = fileURLToPath(new URL('../../../docs/release-registry-reconciliation/cli.mjs', import.meta.url));
const actual = JSON.parse(readFileSync(new URL('../../../docs/track-b-judged-release/MIGRATIONS.json', import.meta.url)));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'release-registry-test-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const root = join(dir, 'sql'); mkdirSync(root);
  const manifest = structuredClone(actual);
  const entries = [...manifest.application, manifest.separateSimulator];
  // Real local SQL bytes solely for IO tests; these hashes are deliberately not
  // represented as the historical migration hashes or any deployment evidence.
  for (const entry of entries) {
    const bytes = Buffer.from(`-- synthetic IO test only: ${entry.id}\r\nSELECT 1;\r\n`);
    entry.sha256 = digest(bytes);
    for (const p of [entry.sourcePath, entry.canonicalPath].filter(Boolean)) {
      mkdirSync(dirname(join(root, p)), {recursive: true}); writeFileSync(join(root, p), bytes);
    }
  }
  const registry = {
    format: 1, exportedBy: 'synthetic-cli-owner',
    databaseRefs: {application: 'fixture-app', 'isolated-calendar-only': 'fixture-calendar'},
    records: entries.map(({id, database, sha256}) => ({id, database, sha256, state: 'applied'})),
  };
  const manifestPath = join(dir, 'manifest.json'), registryPath = join(dir, 'registry.json');
  function save() {
    writeFileSync(manifestPath, JSON.stringify(manifest));
    writeFileSync(registryPath, JSON.stringify(registry));
  }
  save();
  const args = ['--manifest', manifestPath, '--sql-root', root, '--registry', registryPath];
  return {dir, root, manifest, registry, manifestPath, registryPath, args, save};
}
function snapshot(dir) {
  const files = {};
  function walk(base, relative = '') {
    for (const name of readdirSync(base)) {
      const p = join(base, name), key = join(relative, name), stat = lstatSync(p);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) walk(p, key);
      else files[key] = digest(readFileSync(p));
    }
  }
  walk(dir); return files;
}
const run = args => spawnSync(process.execPath, [cli, ...args], {encoding: 'utf8', timeout: 10_000});
test('CLI reads exact SQL bytes and owner JSON without changing any input', t => {
  const f = fixture(t), before = snapshot(f.dir), result = run(f.args);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.readOnly, true); assert.equal(plan.deploymentAccepted, false);
  assert.equal(plan.requiresExclusiveOwnerLockRevalidation, true);
  assert.equal(plan.inputEvidence.manifestSha256, digest(readFileSync(f.manifestPath)));
  assert.equal(plan.inputEvidence.registrySha256, digest(readFileSync(f.registryPath)));
  assert.ok(plan.inputEvidence.files.some(file => file.path === join(f.root, f.manifest.application[0].sourcePath)));
  assert.deepEqual(plan.blockedIssues, []); assert.equal(plan.appliedMigrations.length, 32);
  assert.deepEqual(snapshot(f.dir), before);
});
test('CLI distinguishes SQL content conflicts from clean pending work', t => {
  const f = fixture(t);
  f.registry.records = []; f.save();
  const pending = run(f.args);
  assert.equal(pending.status, 0, pending.stderr || pending.stdout);
  assert.equal(JSON.parse(pending.stdout).pendingMigrations.length, 32);
  writeFileSync(join(f.root, f.manifest.application[0].sourcePath), '-- changed bytes\n');
  const before = snapshot(f.dir), conflict = run(f.args);
  assert.equal(conflict.status, 2, conflict.stderr || conflict.stdout);
  assert.ok(JSON.parse(conflict.stdout).blockedIssues.length);
  assert.deepEqual(snapshot(f.dir), before);
});
test('CLI explicit scope file excludes only the exact unknown exported row', t => {
  const f = fixture(t);
  const unknown = {id: 'other.release.006', database: 'application', sha256: 'a'.repeat(64), state: 'applied'};
  f.registry.records.push(unknown); f.save();
  const blocked = run(f.args); assert.equal(blocked.status, 2, blocked.stderr || blocked.stdout);
  const scope = join(f.dir, 'scope.json');
  writeFileSync(scope, JSON.stringify([{...unknown, decision: 'exclude', reason: 'Synthetic owner scope decision'}]));
  const before = snapshot(f.dir), excluded = run([...f.args, '--scope-decisions', scope]);
  assert.equal(excluded.status, 0, excluded.stderr || excluded.stdout);
  assert.equal(JSON.parse(excluded.stdout).excludedRecords.length, 1);
  assert.deepEqual(snapshot(f.dir), before);
});
for (const unsafe of ['../outside.sql', '/tmp/outside.sql', 'C:\\outside.sql', 'a/../outside.sql', './outside.sql', 'a//outside.sql', 'a/./outside.sql']) {
  test(`CLI refuses unsafe manifest SQL path ${JSON.stringify(unsafe)}`, t => {
    const f = fixture(t); f.manifest.application[0].sourcePath = unsafe; f.save();
    const before = snapshot(f.dir), result = run(f.args);
    assert.notEqual(result.status, 0, result.stdout);
    assert.deepEqual(snapshot(f.dir), before);
  });
}
test('CLI refuses symlinked SQL files and directories even when target bytes match', t => {
  const f = fixture(t), m = f.manifest.application[0];
  const path = join(f.root, m.sourcePath), outside = join(f.dir, 'outside.sql');
  writeFileSync(outside, readFileSync(path)); rmSync(path); symlinkSync(outside, path);
  const result = run(f.args); assert.notEqual(result.status, 0, result.stdout);
  rmSync(path); writeFileSync(path, readFileSync(outside));
  const directory = dirname(path), renamed = join(f.dir, 'outside-directory');
  mkdirSync(renamed); // Put exact bytes outside the root and redirect a path component.
  for (const name of readdirSync(directory)) writeFileSync(join(renamed, name), readFileSync(join(directory, name)));
  rmSync(directory, {recursive: true}); symlinkSync(renamed, directory);
  const directoryResult = run(f.args); assert.notEqual(directoryResult.status, 0, directoryResult.stdout);
});
test('CLI rejects missing SQL files, malformed JSON, unknown flags, duplicate flags, and missing arguments', t => {
  const f = fixture(t);
  rmSync(join(f.root, f.manifest.application[0].sourcePath));
  assert.notEqual(run(f.args).status, 0);
  writeFileSync(f.manifestPath, '{malformed');
  assert.notEqual(run(f.args).status, 0);
  assert.equal(run(['--not-supported']).status, 1);
  assert.equal(run([]).status, 1);
  assert.equal(run([...f.args, '--manifest', f.manifestPath]).status, 1);
});
test('CLI rejects inherited property names as unsupported argument keys', t => {
  const f = fixture(t);
  for (const key of ['constructor', 'toString', '__proto__']) {
    const result = run([key, 'anything', ...f.args]);
    assert.equal(result.status, 1, result.stdout || result.stderr);
    assert.match(result.stderr, /Invalid, missing, or repeated argument/);
    assert.equal(result.stdout, '');
  }
});

test('CLI refuses directories supplied as input files or SQL files', t => {
  const f = fixture(t), sqlPath = join(f.root, f.manifest.application[0].sourcePath);
  rmSync(sqlPath); mkdirSync(sqlPath);
  const sqlResult = run(f.args);
  assert.equal(sqlResult.status, 1); assert.match(sqlResult.stderr, /Regular file required/);
  const registryIndex = f.args.indexOf('--registry') + 1;
  const directoryArgs = [...f.args]; directoryArgs[registryIndex] = f.root;
  const registryResult = run(directoryArgs);
  assert.equal(registryResult.status, 1); assert.match(registryResult.stderr, /Regular file required/);
});

test('CLI fences an input changed after its initial read', t => {
  const f = fixture(t), target = join(f.root, f.manifest.application[0].sourcePath);
  // Inject a competing local edit after the source read. This lives in a child
  // process so builtin instrumentation cannot affect any other test or caller.
  const script = `
    import fs from 'node:fs';
    import {syncBuiltinESMExports} from 'node:module';
    import {pathToFileURL} from 'node:url';
    const target = process.argv.at(-1), original = fs.readFileSync;
    const expected = original(target); let changed = false;
    fs.readFileSync = function(path, ...args) {
      const bytes = original(path, ...args);
      if (!changed && typeof path === 'number' && Buffer.isBuffer(bytes) && bytes.equals(expected)) {
        changed = true; fs.writeFileSync(target, Buffer.concat([bytes, Buffer.from('-- competing edit\\n')]));
      }
      return bytes;
    };
    syncBuiltinESMExports();
    const {main} = await import(pathToFileURL(process.argv[1]).href);
    process.exitCode = main(process.argv.slice(2, -1));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, cli, ...f.args, target], {encoding: 'utf8', timeout: 10_000});
  assert.equal(result.status, 1, result.stdout || result.stderr);
  assert.match(result.stderr, /Input changed during comparison/);
  assert.equal(result.stdout, '');
});
for(const duplicate of ['"state":"failed","state":"applied"','"state":"failed","st\\u0061te":"applied"'])test(`CLI refuses ambiguous registry object keys: ${duplicate}`,t=>{
 const f=fixture(t);
 writeFileSync(f.registryPath,readFileSync(f.registryPath,'utf8').replace('"state":"applied"',duplicate));
 const r=run(f.args);assert.equal(r.status,1);assert.match(r.stderr,/Duplicate JSON object key/);assert.equal(r.stdout,'');
});
test('CLI refuses duplicate manifest aliases even when the final mapping would be valid',t=>{
 const f=fixture(t);
 const key='"app.workflow-comparison.006"';
 writeFileSync(f.manifestPath,readFileSync(f.manifestPath,'utf8').replace(`${key}:`,`${key}:"wrong",${key}:`));
 const r=run(f.args);assert.equal(r.status,1);assert.match(r.stderr,/Duplicate JSON object key/);
});
test('CLI refuses invalid UTF-8 rather than replacing bytes inside registry metadata',t=>{
 const f=fixture(t),content=readFileSync(f.registryPath);
 const i=content.indexOf('synthetic-cli-owner');content[i]=0xff;writeFileSync(f.registryPath,content);
 assert.equal(run(f.args).status,1);
});
