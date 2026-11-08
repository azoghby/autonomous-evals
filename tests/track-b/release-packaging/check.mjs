import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { manifest as sql, validateManifest, root } from './migrations/preflight.mjs';
import { manifest as packages, buildPatch, show } from './packages/build-patch.mjs';

// Lightweight integration check: no installs, SQL engines or application execution.
validateManifest();
assert.equal(packages.parent, sql.parentBase);
assert.equal(packages.compatiblePriorTrackA, sql.applicationBaseline.commit);
const packageInputs = ['packages/core/package.json', 'apps/web/package.json', 'package-lock.json'];
for (const path of packageInputs) {
  assert.equal(show(packages.trackA, path), show(sql.applicationBaseline.commit, path), `Package pin disagreement: ${path}`);
}
for (const entry of sql.applicationBaseline.migrations) {
  const bytes = execFileSync('git', ['show', `${packages.trackA}:${entry.path}`], { cwd: root });
  assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, `SQL baseline pin disagreement: ${entry.path}`);
}
const patch = readFileSync(new URL('../../../docs/release-packaging-integration/packages/track-a-manifests-lock.patch', import.meta.url), 'utf8');
assert.equal(patch, buildPatch());
const evidence = JSON.parse(readFileSync(new URL('../../../docs/release-packaging-integration/packages/evidence/result.json', import.meta.url)));
assert.equal(evidence.patchSha256, createHash('sha256').update(patch).digest('hex'));
assert.equal(evidence.trackA, packages.trackA);
assert.equal(evidence.packagingAccepted, true);
assert.equal(evidence.releaseAccepted, false);
console.log(JSON.stringify({
  parentBase: sql.parentBase,
  packageTrackA: packages.trackA,
  sqlTrackA: sql.applicationBaseline.commit,
  verified: { identicalPackageInputs: packageInputs.length, identicalBaselineMigrations: sql.applicationBaseline.migrations.length,
    canonicalApplicationArtifacts: sql.application.length, deterministicPackagePatch: true, recordedPackageEvidenceMatchesPatch: true },
  limits: ['Pin agreement and artifact integrity only; does not reexecute child evidence or combine application patches.',
    'No final combined application build, production SQL, authentication, providers or deployment tested.'],
  releaseAccepted: false
}, null, 2));
