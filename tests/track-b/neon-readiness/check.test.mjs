import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyBranches, main } from './check.mjs';
const config = { projectId: 'project-fixture', mainBranchId: 'br-main', seedBranchId: 'br-seed' };
test('only reads exact branches and exports no provider prose', async () => {
  const calls = [];
  const result = await verifyBranches({ call: async (method, path) => {
    calls.push([method, path]);
    return { status: 200, body: { branch: { id: path.split('/').at(-1), project_id: config.projectId, default: false, name: 'private-provider-prose' } } };
  } }, config);
  assert.equal(result.accepted, true);
  assert.deepEqual(calls, [['GET', '/projects/project-fixture/branches/br-main'], ['GET', '/projects/project-fixture/branches/br-seed']]);
  assert.equal(JSON.stringify(result).includes('private-provider-prose'), false);
  assert.equal(result.seedSchema, 'not_checked');
});
test('404 cannot establish that seed exists or distinguish visibility from absence', async () => {
  const result = await verifyBranches({ call: async () => ({ status: 404 }) }, config);
  assert.equal(result.accepted, false);
  assert.equal(result.checks[1].status, 'not_found_or_not_visible');
});
test('scope mismatch and transient failures reject', async () => {
  for (const response of [{ status: 503 }, { status: 200, body: { branch: { id: 'br-main', project_id: 'wrong', default: false } } }]) {
    await assert.rejects(verifyBranches({ call: async () => response }, config));
  }
});
test('invalid paths and equal branch IDs reject before dispatch', async () => {
  for (const bad of [{ ...config, projectId: '../x' }, { ...config, seedBranchId: config.mainBranchId }]) {
    let calls = 0;
    await assert.rejects(verifyBranches({ call: async () => { calls++; } }, bad));
    assert.equal(calls, 0);
  }
});
test('implicit CLI invocation cannot read private config', async () => {
  await assert.rejects(main(['--config', '/not-read']), /explicit_read_only/);
});
