import assert from 'node:assert/strict';

/** Real independent backends, not PGlite or mocked transactions. */
export async function verifyCheckpoints({ Pool, config, Store, database, migration, restart }) {
  let pools = [];
  const makePool = name => {
    const pool = new Pool({ ...config, max: 1, application_name: name,
      connectionTimeoutMillis: 5000, statement_timeout: 8000 });
    pools.push(pool);
    return pool;
  };
  const key = { jobId: 'checkpoint-job', kind: 'target', id: 'scenario-1', inputDigest: 'a'.repeat(64) };
  let passed = 0;
  const test = async (name, fn) => { await fn(); console.log(`CHECKPOINT PASS ${++passed}: ${name}`); };
  try {
    const a = makePool('checkpoint-a'), b = makePool('checkpoint-b');
    const pids = await Promise.all([a, b].map(async p => (await p.query('SELECT pg_backend_pid() AS pid')).rows[0].pid));
    assert.notEqual(pids[0], pids[1]);
    console.log(`CHECKPOINT independent backends: ${pids.join(', ')}`);
    await a.query(migration);
    const storeA = new Store(database(a)), storeB = new Store(database(b));
    let owner, reader, claim;
    await test('concurrent claims yield one durable owner and one pending observer', async () => {
      const result = await Promise.all([storeA.claim(key), storeB.claim(key)]);
      assert.deepEqual(result.map(x => x.state).sort(), ['claimed', 'pending']);
      const winner = result.findIndex(x => x.state === 'claimed');
      claim = result[winner]; owner = [storeA, storeB][winner]; reader = [storeB, storeA][winner];
      assert.deepEqual(await reader.get(key), { state: 'pending' });
      await assert.rejects(reader.claim({ ...key, inputDigest: 'b'.repeat(64) }), /identity_conflict/);
      await assert.rejects(reader.complete(key, 'forged-token', { ok: true }), /not_owner/);
    });
    await test('completion is immutable, replayable and isolated across jobs', async () => {
      const value = { response: 'accepted fixture response', usage: null };
      await owner.complete(key, claim.token, value);
      assert.deepEqual(await reader.claim(key), { state: 'completed', value });
      await owner.complete(key, claim.token, value);
      await assert.rejects(owner.complete(key, claim.token, { response: 'altered' }), /completion_conflict/);
      assert.equal(await reader.get({ ...key, jobId: 'different-job' }), null);
      assert.deepEqual(await reader.get(key), { state: 'completed', value });
    });
    await test('released claims rotate ownership; ambiguous calls cannot be reacquired', async () => {
      const polling = { ...key, kind: 'agent-poll', id: 'poll' };
      const first = await storeA.claim(polling); assert.equal(first.state, 'claimed');
      await storeA.release(polling, first.token);
      const second = await storeB.claim(polling); assert.equal(second.state, 'claimed');
      assert.notEqual(first.token, second.token);
      await assert.rejects(storeA.complete(polling, first.token, { ok: true }), /not_owner/);
      await storeB.markAmbiguous(polling, second.token);
      assert.deepEqual(await storeA.claim(polling), { state: 'ambiguous' });
      await assert.rejects(storeB.release(polling, second.token), /not_releasable/);
    });
    const interrupted = { ...key, id: 'interrupted-target' };
    await test('pending dispatch intent and completed result survive clean server restart', async () => {
      assert.equal((await storeA.claim(interrupted)).state, 'claimed');
      await Promise.all(pools.map(p => p.end())); pools = [];
      await restart();
      const recovered = new Store(database(makePool('checkpoint-restarted')));
      assert.deepEqual(await recovered.claim(interrupted), { state: 'pending' });
      assert.equal((await recovered.get(key)).state, 'completed');
      assert.deepEqual(await recovered.claim({ ...key, kind: 'agent-poll', id: 'poll' }), { state: 'ambiguous' });
    });
    console.log(`CHECKPOINT RESULT ${passed}/4 live PostgreSQL checks passed; zero skipped`);
  } finally { await Promise.all(pools.map(p => p.end())); }
}
