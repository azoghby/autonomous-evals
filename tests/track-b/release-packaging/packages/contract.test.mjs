import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { artifacts, manifest, show, patchedFiles, buildPatch } from './build-patch.mjs';

test('exact seven additions belong to their importing package', () => {
  assert.deepEqual(manifest.dependencies, {
    'packages/core': { resend: '6.37.0', dotenv: '18.0.9' },
    'apps/web': { 'drizzle-orm': '0.45.4', zod: '4.6.7', stripe: '23.1.0', '@neondatabase/serverless': '1.2.0', '@x402/core': '2.30.0' }
  });
  const files = patchedFiles();
  const lock = JSON.parse(files['package-lock.json']);
  for (const [owner, deps] of Object.entries(manifest.dependencies)) {
    const baseline = JSON.parse(show(manifest.trackA, `${owner}/package.json`));
    const patched = JSON.parse(files[`${owner}/package.json`]);
    assert.deepEqual(patched.dependencies, lock.packages[owner].dependencies);
    for (const [name, version] of Object.entries(deps)) {
      assert.equal(baseline.dependencies[name], undefined, 'Baseline must demonstrate the missing direct declaration');
      assert.equal(patched.dependencies[name], version);
      assert.equal(lock.packages[`node_modules/${name}`].version, version);
    }
    const expected = structuredClone(baseline);
    Object.assign(expected.dependencies, deps);
    assert.deepEqual(patched, expected, 'No unrelated manifest modifications');
  }
});

test('artifact is deterministic and edits only two manifests and the lock', () => {
  const patch = readFileSync(join(artifacts, 'track-a-manifests-lock.patch'), 'utf8');
  assert.equal(patch, buildPatch());
  assert.deepEqual([...patch.matchAll(/^diff --git a\/(.*?) b\//gm)].map(m => m[1]).sort(), [
    'apps/web/package.json', 'package-lock.json', 'packages/core/package.json'
  ]);
  const before = JSON.parse(show(manifest.trackA, 'package-lock.json'));
  const after = JSON.parse(patchedFiles()['package-lock.json']);
  for (const [owner, deps] of Object.entries(manifest.dependencies)) Object.assign(before.packages[owner].dependencies, deps);
  assert.deepEqual(after, before, 'Tarball versions, integrity, flags, and all other lock entries must remain unchanged');
});

test('historical release-contract baseline is evidence, not a silent current acceptance claim', () => {
  const historical = JSON.parse(readFileSync(join(artifacts, '../../track-b-release-contracts/exports/strict-result.json')));
  assert.notEqual(historical.trackA, manifest.trackA);
  assert.notEqual(historical.accepted, true);
});
