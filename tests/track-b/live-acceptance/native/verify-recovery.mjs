import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

const gate = () => { let resolve; return { promise: new Promise(r => { resolve = r; }), resolve: () => resolve() }; };
const outcome = p => p.then(value => ({ value }), error => ({ error }));
async function waitForBlocked(observer, holder, applicationName) {
  const deadline = Date.now() + 5000;
  do {
    const { rows } = await observer.query(`SELECT pid, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
      WHERE application_name=$1 AND $2::int=ANY(pg_blocking_pids(pid))`, [applicationName, holder]);
    if (rows.length) return rows[0];
    await delay(10);
  } while (Date.now() < deadline);
  throw new Error('Native journal waiter did not block on its real owner');
}
function record() {
  return { original: { jobId: 'native-job', branchId: 'native-branch', runId: 'native-run', suiteHash: 'a'.repeat(64), versionLabel: 'baseline', origin: 'internal_fixture',
    results: Array.from({ length: 12 }, (_, i) => ({ scenarioId: `scenario-${i}`, scope: { jobId: 'native-job', runId: `scope-${i}`, version: 'baseline' },
      outcome: i < 4 ? 'product_failure' : 'passed', reason: i < 4 ? 'state_mismatch' : 'sql_checks_passed' })) }, attempts: [] };
}

/** Actual server sessions, autocommit boundaries, process restart and immutable private-chat replay. */
export async function verifyRecovery({ Pool, config, Journal, conversations, database, migrations, restart }) {
  let pools = [];
  const makePool = name => {
    const p = new Pool({ ...config, max: 1, application_name: name, connectionTimeoutMillis: 5000, statement_timeout: 8000 });
    p.on('error', () => {}); p.on('connect', client => client.on('error', () => {})); pools.push(p); return p;
  };
  let observer = makePool('recovery-observer');
  let a = makePool('journal-a'), b = makePool('journal-b');
  let ja = new Journal(a, 'tenant-a'), jb = new Journal(b, 'tenant-a');
  const key = 'calendar-investigation:native-job:native-run';
  let passed = 0;
  const test = async (name, fn) => { await fn(); console.log(`RECOVERY PASS ${++passed}: ${name}`); };
  const read = (journal, k = key) => journal.withLock(k, () => journal.load(k));
  const pending = record(); pending.attempts.push({ scenarioId: 'scenario-0' });
  try {
    for (const sql of migrations) await observer.query(sql);
    await test('native sessions serialize same-key journals while durable pending intent is visible before dispatch', async () => {
      const entered = gate(), release = gate();
      const owner = outcome(ja.withLock(key, async () => { await ja.save(key, record()); await ja.save(key, pending); entered.resolve(); await release.promise; }));
      await Promise.race([entered.promise, owner.then(x => { throw x.error ?? new Error('Owner left early'); })]);
      let waiterEntered = false;
      const waiter = outcome(jb.withLock(key, async () => { waiterEntered = true; assert.deepEqual(await jb.load(key), pending); }));
      try {
        const ownerPid = (await observer.query("SELECT pid FROM pg_stat_activity WHERE application_name='journal-a'")).rows[0].pid;
        const blocked = await waitForBlocked(observer, ownerPid, 'journal-b');
        assert.notEqual(blocked.pid, ownerPid); assert.equal(waiterEntered, false);
        assert.deepEqual((await observer.query('SELECT record FROM app_workflow_investigation_journals WHERE tenant_id=$1 AND journal_key=$2', ['tenant-a', key])).rows[0].record, pending);
        const other = new Journal(makePool('journal-other'), 'tenant-b');
        assert.equal(await read(other), undefined);
      } finally { release.resolve(); }
      assert.equal((await owner).error, undefined); assert.equal((await waiter).error, undefined);
    });
    await test('terminated backend releases native journal lock, retains intent, and never retries callback', async () => {
      const entered = gate(), release = gate(); let calls = 0;
      const owner = outcome(ja.withLock(key, async () => { calls++; assert.deepEqual(await ja.load(key), pending); entered.resolve(); await release.promise; }));
      await Promise.race([entered.promise, owner.then(x => { throw x.error ?? new Error('Owner left early'); })]);
      const waiter = outcome(read(jb));
      try {
        const ownerPid = (await observer.query("SELECT pid FROM pg_stat_activity WHERE application_name='journal-a'")).rows[0].pid;
        await waitForBlocked(observer, ownerPid, 'journal-b');
        assert.equal((await observer.query('SELECT pg_terminate_backend($1,5000) AS killed', [ownerPid])).rows[0].killed, true);
        assert.deepEqual((await waiter).value, pending);
      } finally { release.resolve(); }
      assert.equal((await owner).error?.message, 'workflow_journal_unlock_failed'); assert.equal(calls, 1);
      assert.deepEqual(await read(ja), pending);
    });
    const scope = { subjectId: 'native-alice', jobId: 'native-job' };
    const input = { messageId: 'private-message', inputDigest: 'c'.repeat(64), reply: {
      asOf: '2026-11-07T00:00:00Z', topic: 'progress', text: 'Persisted native acceptance reply.', evidenceRefs: ['status-native'], unknowns: ['ETA unknown.'] } };
    let saved;
    await test('private chat persists one immutable exchange across independent sessions and isolates subject/job', async () => {
      const ca = conversations(database(a)), cb = conversations(database(b));
      const replies = await Promise.all([ca.append(scope, input), cb.append(scope, { ...input, inputDigest: 'd'.repeat(64), reply: { ...input.reply, text: 'Second candidate.' } })]);
      assert.deepEqual(replies[0], replies[1]); saved = replies[0];
      assert.equal(saved.sequence, 1);
      assert.equal(await cb.get({ ...scope, subjectId: 'native-bob' }, input.messageId), null);
      assert.deepEqual(await cb.list({ ...scope, jobId: 'other-job' }, { afterSequence: 0, limit: 50 }), []);
    });
    await test('native server restart preserves pending journal intent and immutable private chat', async () => {
      await Promise.all(pools.map(p => p.end())); pools = [];
      await restart(); observer = makePool('recovery-after-restart');
      a = makePool('journal-after-restart'); ja = new Journal(a, 'tenant-a');
      assert.deepEqual(await read(ja), pending);
      const chat = conversations(database(a));
      assert.deepEqual(await chat.get(scope, input.messageId), saved);
      assert.deepEqual(await chat.append(scope, { ...input, inputDigest: 'e'.repeat(64) }), saved);
      assert.equal((await chat.append(scope, { ...input, messageId: 'after-restart' })).sequence, 2);
    });
    await test('native recovered intent cannot erase, complete without durable intent, or exceed three candidates', async () => {
      const erased = record();
      await assert.rejects(ja.withLock(key, () => ja.save(key, erased)), /^Error: workflow_journal_/);
      const illegal = structuredClone(pending); illegal.attempts.push({ scenarioId: 'scenario-1', result: { ...illegal.original.results[1], scope: { ...illegal.original.results[1].scope, runId: 'reproduction-1' } } });
      await assert.rejects(ja.withLock(key, () => ja.save(key, illegal)), /^Error: workflow_journal_/);
      const legal = structuredClone(pending);
      await ja.withLock(key, async () => {
        legal.attempts.push({ scenarioId: 'scenario-1' }); await ja.save(key, legal);
        legal.attempts.push({ scenarioId: 'scenario-2' }); await ja.save(key, legal);
      });
      const extra = structuredClone(legal); extra.attempts.push({ scenarioId: 'scenario-3' });
      await assert.rejects(ja.withLock(key, () => ja.save(key, extra)), /^Error: workflow_journal_/);
      assert.deepEqual(await read(ja), legal);
    });
    console.log(`RECOVERY RESULT ${passed}/5 actual native PostgreSQL checks passed; zero skipped`);
  } finally { await Promise.all(pools.map(p => p.end())); }
}
