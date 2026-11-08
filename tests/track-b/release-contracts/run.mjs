// Combined offline gate. A successful characterization never overrides a release blocker.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

assert.ok(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === '--strict'), 'Only --strict is supported');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
function git(...args) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
}
const base = '6ff8a0642fc14dfd23842456d124a4b84f5e040a';
const trackA = '8634ceb30f3d98de7ec24b240a4f7549dce80033';
assert.equal(git('rev-parse', 'origin/track-a^{commit}'), trackA, 'Local ref drift; re-review required, never fetch');
git('merge-base', '--is-ancestor', base, 'HEAD');
const owned = p => p.startsWith('tests/track-b/release-contracts/') || p.startsWith('docs/track-b-release-contracts/');
assert.ok(git('diff', '--name-only', base).split('\n').filter(Boolean).every(owned), 'Tracked inputs differ from pinned base outside owned paths');
assert.ok(git('ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean).every(owned), 'Untracked source inputs outside owned paths require review');
const out = join(repo, 'docs/track-b-release-contracts/combined');
mkdirSync(out, { recursive: true });
const map = JSON.parse(readFileSync(join(repo, 'tests/track-b/release-contracts/services/service-map.json'), 'utf8'));
assert.equal(map.trackA, trackA);
assert.equal(map.baseParent, base);
assert.equal(Object.keys(map.methods).length, 12);
assert.equal(map.requirements.length, 10);
const result = { base, trackA, testedHead: git('rev-parse', 'HEAD'), node: process.version,
  sourceUnchangedFromBase: true, components: [],
  serviceGates: { releaseAccepted: map.releaseAccepted, gatedMethods: Object.entries(map.methods).filter(([,v]) => v.release !== 'accepted').map(([k]) => k),
    gatedRequirements: map.requirements.filter(v => v.release !== 'accepted').map(v => v.id) } };
for (const name of ['exports', 'sql', 'services', 'packs']) {
  const args = [join(repo, 'tests/track-b/release-contracts', name, 'run.mjs'), ...(name === 'services' ? [] : ['--strict'])];
  const r = spawnSync(process.execPath, args, { cwd: repo, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 60000 });
  writeFileSync(join(out, `${name}.stdout.txt`), r.stdout ?? '');
  writeFileSync(join(out, `${name}.stderr.txt`), r.stderr ?? '');
  const item = { name, exitCode: r.status, signal: r.signal, error: r.error?.message ?? null,
    stdout: `${name}.stdout.txt`, stderr: `${name}.stderr.txt` };
  if (name === 'exports' && !r.error) {
    try { const e = JSON.parse(r.stdout); item.observations = { accepted: e.accepted, probes: e.checks.resolution.probes, consumerBindings: e.checks.consumerBindings.checked,
      bundleOutputs: e.checks.bundle.outputFiles, manifestProblems: e.checks.manifests.problems.length, dependencyPairs: e.checks.manifests.summary }; } catch { item.parseError = 'Export evidence missing'; }
  }
  result.components.push(item);
  console.log(`${name}: exit ${r.status}${r.error ? ` (${r.error.message})` : ''}`);
}
result.releaseAccepted = result.components.every(c => c.exitCode === 0 && !c.error && !c.parseError) &&
  map.releaseAccepted === true && result.serviceGates.gatedMethods.length === 0 && result.serviceGates.gatedRequirements.length === 0;
writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2) + '\n');
console.log(`Release accepted: ${result.releaseAccepted}; evidence: docs/track-b-release-contracts/combined/result.json`);
process.exitCode = result.releaseAccepted ? 0 : 1;
