import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { composeSqlRoot } from '../../../docs/migration-registry-adoption/compose.mjs';
const hash = b => createHash('sha256').update(b).digest('hex');
const root = resolve(import.meta.dirname, '../../..');
const read = p => readFileSync(join(root, p));
const json = p => JSON.parse(read(p));
const manifestPath = 'docs/migration-registry-adoption/MIGRATIONS.json';
const manifest = json(manifestPath), judged = json('docs/track-b-judged-release/MIGRATIONS.json');
const pin = json('docs/migration-registry-adoption/PIN.json');
test('current judged identities, exact historical entries, aliases and separate database preserved; extension hashes/order explicit', () => {
  assert.equal(hash(read(manifestPath)), pin.manifestSha256);
  assert.equal(hash(read('docs/track-b-judged-release/MIGRATIONS.json')), pin.judgedManifestSha256);
  assert.deepEqual(manifest.application.slice(0, 31), judged.application);
  assert.deepEqual(manifest.separateSimulator, judged.separateSimulator);
  assert.deepEqual(manifest.identityAliases, judged.identityAliases);
  assert.equal(manifest.application.length, 36);
  const seen = new Set();
  for (const m of manifest.application) { for (const dependency of m.after) assert.ok(seen.has(dependency), `${m.id}: ${dependency}`); seen.add(m.id); }
  assert.equal(pin.additionalMigrations.length, 5);
  for (const entry of pin.additionalMigrations) {
    const actual = manifest.application.find(m => m.id === entry.id);
    assert.equal(hash(read(`docs/migration-registry-adoption/sql/${entry.file}`)), entry.sha256);
    assert.equal(actual.sha256, entry.sha256); assert.deepEqual(actual.after, entry.after);
  }
  const paid = json('docs/autonomy-paid-app-integration/APPLICATION.json');
  assert.equal(pin.additionalMigrations[3].sha256, paid.paths['apps/web/src/server/autonomous-paid.sql']);
  assert.equal(pin.additionalMigrations[4].sha256, paid.paths['apps/web/src/server/autonomous-paid-authority.sql']);
});
test('composed SQL reproduces every pinned byte; changed reviewed input refuses before output creation', () => {
  const work = mkdtempSync('/private/tmp/mra-pin-');
  try {
    const stage = join(work, 'reviewed'); mkdirSync(stage);
    const inventory = new Map();
    const paths = spawnSync('rg', ['--files', '-g', '*.sql', '-g', '*.patch'], { cwd: root, encoding: 'utf8' }); assert.equal(paths.status, 0);
    for (const path of paths.stdout.trim().split('\n')) {
      const bytes = read(path); inventory.set(hash(bytes), bytes);
      if (path.endsWith('.patch')) {
        // New-file patch bodies are local immutable source artifacts, not shell-applied patches.
        for (const block of bytes.toString('utf8').split(/^diff --git /m).slice(1)) {
          if (!block.includes('--- /dev/null\n')) continue;
          const text = block.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).map(line => line.slice(1)).join('\n') + '\n';
          inventory.set(hash(text), Buffer.from(text));
        }
      }
    }
    for (const m of [...judged.application, judged.separateSimulator]) {
      const bytes = inventory.get(m.sha256); assert.ok(bytes, `Pinned local SQL not found for ${m.id}`);
      const path = join(stage, m.sourcePath); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes);
    }
    const output = join(work, 'composed'); const result = composeSqlRoot({ reviewedStage: stage, output });
    assert.equal(result.applied, false);
    for (const m of [...manifest.application, manifest.separateSimulator]) for (const path of [m.sourcePath, m.canonicalPath].filter(Boolean)) assert.equal(hash(readFileSync(join(output, path))), m.sha256);
    assert.throws(() => composeSqlRoot({ reviewedStage: stage, output }));
    writeFileSync(join(stage, judged.application[0].sourcePath), 'SELECT 42;');
    const changedOutput = join(work, 'changed'); assert.throws(() => composeSqlRoot({ reviewedStage: stage, output: changedOutput })); assert.equal(existsSync(changedOutput), false);
  } finally { rmSync(work, { recursive: true, force: true }); }
});
