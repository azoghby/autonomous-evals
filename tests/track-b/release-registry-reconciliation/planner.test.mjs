import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {planReconciliation} from '../../../docs/release-registry-reconciliation/planner.mjs';

// This is a synthetic owner export and hash inventory, not hosted acceptance.
// The release manifest itself is the actual immutable 31-migration artifact.
const actual = JSON.parse(readFileSync(new URL('../../../docs/track-b-judged-release/MIGRATIONS.json', import.meta.url)));
const clone = value => structuredClone(value);
const allEntries = manifest => [...manifest.application, manifest.separateSimulator];
function fixture() {
  const manifest = clone(actual);
  const inventory = allEntries(manifest).map(m => ({
    id: m.id, database: m.database, sourcePath: m.sourcePath, sourceSha256: m.sha256,
    ...(m.canonicalPath ? {canonicalPath: m.canonicalPath, canonicalSha256: m.sha256} : {}),
  }));
  const registry = {
    format: 1, exportedBy: 'synthetic-test-owner',
    databaseRefs: {application: 'test-app-db', 'isolated-calendar-only': 'test-calendar-db'},
    records: allEntries(manifest).map(({id, database, sha256}) => ({id, database, sha256, state: 'applied'})),
  };
  return {manifest, inventory, registry};
}
const blocked = input => {
  const result = planReconciliation(input);
  assert.ok(result.blockedIssues.length > 0, JSON.stringify(result));
  assert.ok(result.pendingMigrations.every(m => m.ready !== true));
  return result;
};
const row = (input, id) => input.registry.records.find(r => r.id === id);
const canonical = 'app.workflow-finding-reruns.008';
const alias = 'app.workflow-finding-reruns.006';

test('actual manifest: 31 application migrations and separate simulator, pure immutable inputs', () => {
  const input = fixture();
  assert.equal(input.manifest.application.length, 31);
  const before = JSON.stringify(input);
  const result = planReconciliation(input);
  assert.equal(JSON.stringify(input), before);
  assert.equal(result.readOnly, true);
  assert.equal(result.deploymentAccepted, false);
  assert.deepEqual(result.blockedIssues, []);
  assert.deepEqual(result.pendingMigrations, []);
  assert.deepEqual(result.reconciliationProposals, []);
  assert.equal(result.appliedMigrations.length, 32);
});

test('empty export reports ordered pending work without pretending it was applied', () => {
  const input = fixture(); input.registry.records = [];
  const result = planReconciliation(input);
  assert.deepEqual(result.blockedIssues, []);
  assert.equal(result.pendingMigrations.length, 32);
  assert.deepEqual(result.appliedMigrations, []);
  assert.deepEqual(result.reconciliationProposals, []);
  const ordered = new Set();
  for (const m of result.pendingMigrations.filter(m => m.database === 'application')) {
    const entry = input.manifest.application.find(e => e.id === m.id);
    for (const dependency of entry.after) assert.ok(ordered.has(dependency));
    assert.equal(m.transactionOwner, entry.transactionOwner);
    ordered.add(m.id);
  }
});

for (const [oldId, newId] of Object.entries(actual.identityAliases)) {
  test(`verified exact alias ${oldId} proposes identity-only reconciliation`, () => {
    const input = fixture(); row(input, newId).id = oldId;
    const result = planReconciliation(input);
    assert.deepEqual(result.blockedIssues, []);
    assert.ok(!result.pendingMigrations.some(m => m.id === newId));
    assert.equal(result.reconciliationProposals.length, 1);
    const proposal = result.reconciliationProposals[0];
    assert.equal(proposal.kind, 'replace-alias-identity');
    assert.equal(proposal.fromId, oldId);
    assert.equal(proposal.toId, newId);
    assert.equal(proposal.database, 'application');
    assert.equal(proposal.sha256, row(input, oldId).sha256);
    assert.equal(proposal.executeSql, false);
    assert.equal(proposal.transactionOwner, input.manifest.application.find(m => m.id === newId).transactionOwner);
  });
}

test('both verified aliases preserve predecessor identity evidence together', () => {
  const input = fixture();
  for (const [oldId, newId] of Object.entries(input.manifest.identityAliases)) row(input, newId).id = oldId;
  const result = planReconciliation(input);
  assert.deepEqual(result.blockedIssues, []);
  assert.equal(result.reconciliationProposals.length, 2);
  assert.deepEqual(result.pendingMigrations, []);
});

test('canonical plus alias cannot be silently collapsed, even with equal hashes', () => {
  const input = fixture(); input.registry.records.push({...row(input, canonical), id: alias});
  assert.deepEqual(blocked(input).reconciliationProposals, []);
});
test('duplicate identical canonical rows block', () => {
  const input = fixture(); input.registry.records.push(clone(input.registry.records[0])); blocked(input);
});
test('duplicate aliases block', () => {
  const input = fixture(); row(input, canonical).id = alias;
  input.registry.records.push(clone(row(input, alias))); blocked(input);
});

for (const state of ['pending', 'inflight', 'failed', 'started', '', null]) {
  test(`non-applied state ${JSON.stringify(state)} never schedules SQL rerun`, () => {
    const input = fixture(); row(input, canonical).state = state;
    const result = blocked(input);
    assert.ok(!result.pendingMigrations.some(m => m.id === canonical));
    assert.deepEqual(result.reconciliationProposals, []);
  });
}
for (const field of ['id', 'database', 'sha256', 'state']) {
  test(`incomplete registry row missing ${field} blocks`, () => {
    const input = fixture(); delete row(input, canonical)[field]; blocked(input);
  });
}
test('canonical and alias hash conflicts block without alias proposal or pending rerun', () => {
  for (const id of [canonical, alias]) {
    const input = fixture(); const record = row(input, canonical); record.id = id; record.sha256 = '0'.repeat(64);
    const result = blocked(input);
    assert.deepEqual(result.reconciliationProposals, []);
    assert.ok(!result.pendingMigrations.some(m => m.id === canonical));
  }
});
test('source and canonical SQL inventory hash mismatches independently block', () => {
  for (const field of ['sourceSha256', 'canonicalSha256']) {
    const input = fixture(); input.inventory[0][field] = 'f'.repeat(64); blocked(input);
  }
});
test('missing, duplicate, extra, and wrong-path inventory entries block', () => {
  for (const mutate of [
    x => x.inventory.pop(),
    x => x.inventory.push(clone(x.inventory[0])),
    x => x.inventory.push({...x.inventory[0], id: 'app.unknown.0000'}),
    x => { x.inventory[0].sourcePath = 'other/0000_init.sql'; },
  ]) { const input = fixture(); mutate(input); blocked(input); }
});
test('an applied row with unapplied predecessor blocks; alias is not sufficient dependency proof', () => {
  const input = fixture(); row(input, canonical).id = alias;
  input.registry.records = input.registry.records.filter(r => r.id !== 'app.workflow-resumption.007');
  const result = blocked(input);
  assert.deepEqual(result.reconciliationProposals, []);
});
test('malformed dependency graphs and aliases fail closed', () => {
  for (const mutate of [
    x => { x.manifest.application[0].after = ['app.nonexistent']; },
    x => { x.manifest.application[0].after = [x.manifest.application[0].id]; },
    x => { x.manifest.application[0].after = [canonical]; },
    x => { x.manifest.application[1].id = x.manifest.application[0].id; },
    x => { x.manifest.identityAliases[alias] = 'app.nonexistent'; },
    x => { x.manifest.identityAliases[canonical] = canonical; },
    x => { x.manifest.identityAliases[alias] = 'app.workflow-comparison.006'; },
  ]) { const input = fixture(); mutate(input); blocked(input); }
});

test('simulator cannot be satisfied by an application database row or shared database reference', () => {
  const input = fixture(); row(input, 'simulator.calendar-seed').database = 'application'; blocked(input);
  const shared = fixture(); shared.registry.databaseRefs['isolated-calendar-only'] = shared.registry.databaseRefs.application;
  blocked(shared);
});
test('simulator metadata cannot smuggle an unsafe optional canonical SQL path', () => {
  const input = fixture();
  input.manifest.separateSimulator.canonicalPath = '../outside-calendar.sql';
  const simulator = input.inventory.find(m => m.id === 'simulator.calendar-seed');
  simulator.canonicalPath = '../outside-calendar.sql';
  simulator.canonicalSha256 = input.manifest.separateSimulator.sha256;
  blocked(input);
});
test('unknown full IDs require an exact explicit exclusion decision', () => {
  const input = fixture(); const unknown = {id: 'legacy.other.006', database: 'application', sha256: '1'.repeat(64), state: 'applied'};
  input.registry.records.push(unknown);
  blocked(input);
  input.scopeDecisions = [{...unknown, decision: 'exclude', reason: 'Owner verified unrelated release scope in synthetic test'}];
  const result = planReconciliation(input);
  assert.deepEqual(result.blockedIssues, []);
  assert.equal(result.excludedRecords.length, 1);
  for (const field of ['sha256', 'state', 'database', 'id']) {
    const stale = clone(input); stale.scopeDecisions[0][field] += '-stale'; blocked(stale);
  }
});
test('scope exclusions cannot hide known conflicts or grant broad numeric/basename matching', () => {
  const input = fixture(); row(input, canonical).sha256 = '0'.repeat(64);
  input.scopeDecisions = [{...row(input, canonical), decision: 'exclude', reason: 'cannot waive known mismatch'}]; blocked(input);
  for (const replacement of ['006', '008-workflow-finding-reruns.sql', 'workflow-finding-reruns.008']) {
    const other = fixture(); row(other, canonical).id = replacement;
    const result = blocked(other);
    assert.deepEqual(result.reconciliationProposals, []);
  }
});
test('duplicate, unused, and reasonless scope decisions fail closed', () => {
  const input = fixture();
  const unknown = {id: 'other.release', database: 'application', sha256: 'a'.repeat(64), state: 'applied'};
  const decision = {...unknown, decision: 'exclude', reason: 'Synthetic explicit owner decision'};
  input.scopeDecisions = [decision]; blocked(input);
  input.registry.records.push(unknown);
  input.scopeDecisions = [decision, clone(decision)]; blocked(input);
  input.scopeDecisions = [{...decision, reason: ''}]; blocked(input);
});
test('scope decisions cannot waive unknown incomplete or inflight registry rows', () => {
  for (const state of ['inflight', 'failed', 'pending', '', null]) {
    const input = fixture();
    const unknown = {id: 'other.release', database: 'application', sha256: 'a'.repeat(64), state};
    input.registry.records.push(unknown);
    input.scopeDecisions = [{...unknown, decision: 'exclude', reason: 'Cannot waive incomplete application evidence'}];
    blocked(input);
  }
});
test('malformed top-level input and malformed trusted export fail closed', () => {
  for (const input of [null, {}, {manifest: null}, {...fixture(), registry: null}, {...fixture(), inventory: null}]) blocked(input);
  for (const mutate of [
    x => { x.registry.format = 2; }, x => { x.registry.exportedBy = ''; },
    x => { delete x.registry.databaseRefs.application; }, x => { x.registry.records = {}; },
    x => { x.manifest.application[0].sha256 = 'not-a-hash'; },
    x => { x.manifest.application[0].transactionOwner = 'unrecognized'; },
  ]) { const input = fixture(); mutate(input); blocked(input); }
});
