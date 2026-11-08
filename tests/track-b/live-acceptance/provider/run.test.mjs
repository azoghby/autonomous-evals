import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { plan, secret, main, evidenceScope } from './run.mjs';
import { stageCore } from './stage-core.mjs';
const artifact = JSON.parse(await readFile(new URL('../../../../packages/core/src/evals/text/__tests__/evidence/text-design-v3-2026-11-07.json', import.meta.url), 'utf8'));
test('reuses immutable accepted design and computes operation caps', () => {
  assert.deepEqual([plan(artifact).targetCalls, plan(artifact).gatewayCalls], [4, 8]);
  const changed = structuredClone(artifact); changed.outcome.suite.digest = 'changed'; assert.throws(() => plan(changed));
});
test('explicit live gate refuses implicit invocation and does not load private config', async () => {
  await assert.rejects(main(['--config', '/must-never-read']), /usage_requires_explicit_live/);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./run.mjs', import.meta.url)), '--plan'], { encoding: 'utf8' });
  assert.equal(result.status, 0); assert.equal(JSON.parse(result.stdout).liveRunPerformed, false);
});
test('private file refs work; permissive, multiline and missing refs are refused', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'provider-secret-fixture-'));
  try {
    const file = join(directory, 'token'); await writeFile(file, 'synthetic-test-token\n', { mode: 0o600 });
    assert.equal(await secret({ file }), 'synthetic-test-token');
    await chmod(file, 0o644); await assert.rejects(secret({ file }), /private/);
    await chmod(file, 0o600); await writeFile(file, 'one\ntwo'); await assert.rejects(secret({ file }), /invalid/);
    await assert.rejects(secret({ env: 'ABSENT_ACCEPTANCE_TEST_TOKEN' }), /unavailable/);
    await assert.rejects(secret({ env: 'A', file }), /invalid/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('staged executable imports actual core paths and validates accepted digest without network', async () => {
  const staged = await stageCore(process.env.ACCEPTANCE_DEPENDENCIES ?? fileURLToPath(new URL('../../node_modules/', import.meta.url)));
  try {
    const load = relative => import(pathToFileURL(join(staged.root, 'src', relative)));
    const [{ verifyAdmittedFrozenSuite }, { executeSuite }, { createGatewayJudge }, { createTextTarget }, { targetUrl }] = await Promise.all([
      load('evals/text/freeze.js'), load('evals/text/execute.js'), load('judges/gateway.js'), load('targets/text.js'), load('targets/transport.js'),
    ]);
    assert.equal(verifyAdmittedFrozenSuite(artifact.outcome.suite).digest, artifact.outcome.suite.digest);
    assert.equal(typeof executeSuite, 'function'); assert.equal(typeof createGatewayJudge, 'function'); assert.equal(typeof createTextTarget, 'function');
    assert.throws(() => targetUrl('http://localhost:3000/completions'));
  } finally { await staged.cleanup(); }
});

test('target evidence distinguishes fixtures from external targets without attestation claims', () => {
  const fixture = { targetEvidence: { kind: 'controlled_fixture', deploymentRevision: 'a'.repeat(40), patchSha256: 'b'.repeat(64) }, buggy: { model: 'track-b-lumen-buggy-v1' } };
  const evidence = evidenceScope(fixture);
  assert.equal(evidence.scope, 'controlled_fixture_text_only');
  assert.equal(evidence.provenance.remoteAttestation, false);
  assert.equal(evidence.provesCustomerModelBehavior, false);
  fixture.targetEvidence.kind = 'external_target';
  assert.equal(evidence.provenance.kind, 'controlled_fixture');
  assert.throws(() => evidenceScope(fixture), /controlled_model/);
  const external = evidenceScope({ targetEvidence: { kind: 'external_target' } });
  assert.equal(external.scope, 'external_target_text_only');
  assert.equal(external.provenance.authority, 'operator_declared');
});
test('evidence declarations reject absent, ambiguous and unsafe metadata', () => {
  for (const targetEvidence of [undefined, [], {}, { kind: 'actual_llm' }, { kind: 'external_target', secret: 'must-not-copy' }, { kind: 'controlled_fixture' }, { kind: 'controlled_fixture', deploymentRevision: 'a'.repeat(40), patchSha256: 'bad' }]) {
    assert.throws(() => evidenceScope({ targetEvidence }));
  }
});

test('live invocation rejects missing provenance before resolving any secret or creating journal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'provider-provenance-'));
  try {
    const config = join(directory, 'config.json');
    await writeFile(config, JSON.stringify({ runId: 'no_provenance', evidenceFile: join(directory, 'journal'), gateway: { model: 'test' }, approvedTargetCalls: 4, approvedGatewayCalls: 8 }), { mode: 0o600 });
    await assert.rejects(main(['--live', '--config', config]), /target_evidence_declaration_required/);
    await assert.rejects(readFile(join(directory, 'journal')), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
