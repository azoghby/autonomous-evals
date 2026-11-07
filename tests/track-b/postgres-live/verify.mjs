import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const gate = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const outcome = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));
const enteredOrFailed = (entered, first) => Promise.race([entered.promise, first.then(({ error }) => {
  throw error ?? new Error('Holder completed before entering its callback');
})]);
async function until(fn, label) {
  const deadline = Date.now() + 5000;
  do { const value = await fn(); if (value) return value; await delay(20); } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
}

export async function verify({ Pool, config, PostgresBranchLedger: Ledger, pooledCalendarDatabase: database, migration, restart }) {
  const pools = [];
  function pool(name, max = 1) {
    const p = new Pool({ ...config, max, application_name: name, connectionTimeoutMillis: 5000, statement_timeout: 8000 });
    p.on('error', () => {}); // Termination is intentional; checked-out listeners below also handle it.
    pools.push(p);
    return p;
  }
  let observer = pool('observer');
  const q = async (sql, params) => (await observer.query(sql, params)).rows;
  const record = (jobId) => ({ jobId, projectId: 'test-project', parentId: 'br-seed', name: `eval-job-${randomUUID()}`, state: 'creating', createAttempts: 1 });
  // Observation only: every SQL operation still goes to pg and real server locks.
  function tracked(p) {
    const events = [];
    return { events, query: (...args) => p.query(...args), async connect() {
      const client = await p.connect();
      const onError = () => {};
      client.on('error', onError);
      const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      events.push({ pid, event: 'connect' });
      return { query: (...args) => client.query(...args), release(error) {
        events.push({ pid, event: 'release', discard: error?.message });
        client.release(error);
        client.off('error', onError);
      } };
    } };
  }
  async function blocked(holder, waiter, type = 'advisory') {
    return until(async () => {
      const rows = await q(`SELECT a.pid, a.wait_event, pg_blocking_pids(a.pid) AS blockers
        FROM pg_stat_activity a WHERE a.application_name = $1 AND $2::int = ANY(pg_blocking_pids(a.pid))
        AND EXISTS (SELECT 1 FROM pg_locks l WHERE l.pid=a.pid AND NOT l.granted)`, [waiter, holder]);
      if (rows.length) { console.log(`EVIDENCE ${type}: ${JSON.stringify(rows[0])}`); return rows[0]; }
    }, `${waiter} blocked by ${holder}`);
  }
  async function noLocks() { assert.equal((await q("SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory'"))[0].n, 0); }
  let passed = 0;
  async function test(name, fn) { await fn(); await noLocks(); passed++; console.log(`PASS ${passed}: ${name}`); }
  try {
    const settings = (await q("SELECT version(), current_setting('listen_addresses') AS listen, current_setting('fsync') AS fsync, current_setting('synchronous_commit') AS synchronous_commit, current_setting('full_page_writes') AS full_page_writes"))[0];
    console.log(`SERVER ${JSON.stringify(settings)}`);
    assert.equal(settings.listen, '127.0.0.1');
    for (const setting of ['fsync', 'synchronous_commit', 'full_page_writes']) assert.equal(settings[setting], 'on');
    await observer.query(migration);
    await observer.query('CREATE TABLE live_calendar (id integer PRIMARY KEY, value integer NOT NULL); INSERT INTO live_calendar VALUES (1,0)');
    const a = tracked(pool('ledger-a')), b = tracked(pool('ledger-b'));
    await test('same job serializes real sessions; other job proceeds; waiter sees committed ready', async () => {
      const entered = gate(), release = gate(); let secondEntered = false;
      const intent = record('serialization');
      const first = outcome(new Ledger(a).withJobLock(intent.jobId, async (_, put) => {
        await put(intent); entered.resolve(); await release.promise;
        await put({ ...intent, state: 'ready', branchId: 'br-serialized' });
      }));
      await enteredOrFailed(entered, first);
      const second = outcome(new Ledger(b).withJobLock(intent.jobId, async (current) => {
        secondEntered = true; assert.equal(current.state, 'ready'); assert.equal(current.branchId, 'br-serialized');
      }));
      try {
        const holder = a.events.at(-1).pid;
        const waiting = await blocked(holder, 'ledger-b');
        assert.notEqual(waiting.pid, holder); assert.equal(secondEntered, false);
        const other = tracked(pool('ledger-other'));
        await new Ledger(other).withJobLock('unrelated', async () => assert.equal(secondEntered, false));
      } finally { release.resolve(); }
      assert.equal((await first).error, undefined); assert.equal((await second).error, undefined);
      assert.equal(secondEntered, true);
    });
    const durable = record('durable-failure');
    await test('creating is externally visible before callback failure and retained by fresh ledger', async () => {
      const failure = new Error('callback failed after durable intent');
      await assert.rejects(new Ledger(a).withJobLock(durable.jobId, async (_, put) => {
        await put(durable);
        assert.equal((await q('SELECT state FROM app_branch_ownership WHERE job_id=$1', [durable.jobId]))[0].state, 'creating');
        throw failure;
      }), (error) => error === failure);
      await new Ledger(b).withJobLock(durable.jobId, async (current) => assert.deepEqual(current, durable));
    });
    await test('backend termination releases session lock while original callback remains active', async () => {
      const entered = gate(), release = gate(); let originalActive = false;
      const intent = record('terminated-owner');
      const first = outcome(new Ledger(a).withJobLock(intent.jobId, async (_, put) => {
        await put(intent); originalActive = true; entered.resolve(); await release.promise; originalActive = false;
      }));
      await enteredOrFailed(entered, first);
      const pid = a.events.at(-1).pid;
      const second = outcome(new Ledger(b).withJobLock(intent.jobId, async (current) => {
        assert.equal(originalActive, true); assert.deepEqual(current, intent);
      }));
      try {
        await blocked(pid, 'ledger-b');
        assert.equal((await q('SELECT pg_terminate_backend($1,5000) AS killed', [pid]))[0].killed, true);
        assert.equal((await second).error, undefined);
      } finally { release.resolve(); }
      assert.equal((await first).error?.message, 'branch_ledger_unlock_failed');
      assert.equal(a.events.at(-1).discard, 'branch_ledger_unlock_failed');
      await new Ledger(a).withJobLock('replacement', async () => {});
      assert.notEqual(a.events.at(-1).pid, pid);
    });
    const c = tracked(pool('calendar-a')), d = tracked(pool('calendar-b'));
    await test('calendar transaction pins PID, hides uncommitted writes, commits, and closes executor', async () => {
      let escaped;
      await database(c).transaction(async (tx) => {
        escaped = tx;
        const pid = (await tx.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        await tx.query('UPDATE live_calendar SET value=10 WHERE id=1');
        assert.equal((await tx.query('SELECT pg_backend_pid() AS pid')).rows[0].pid, pid);
        assert.equal((await q('SELECT value FROM live_calendar WHERE id=1'))[0].value, 0);
      });
      assert.equal((await q('SELECT value FROM live_calendar WHERE id=1'))[0].value, 10);
      await assert.rejects(escaped.query('SELECT 1'), /calendar_transaction_closed/);
    });
    await test('calendar callback failure rolls back and reuses a clean connection without retry', async () => {
      let calls = 0;
      const error = new Error('rollback callback');
      await assert.rejects(database(c).transaction(async (tx) => {
        calls++; await tx.query('UPDATE live_calendar SET value=99 WHERE id=1'); throw error;
      }), (actual) => actual === error);
      assert.equal(calls, 1);
      assert.equal((await q('SELECT value FROM live_calendar WHERE id=1'))[0].value, 10);
      const pid = c.events.at(-1).pid;
      await database(c).transaction(async (tx) => assert.equal((await tx.query('SELECT pg_backend_pid() AS pid')).rows[0].pid, pid));
    });
    await test('concurrent calendar row updates block on the actual holder and preserve both increments', async () => {
      const entered = gate(), release = gate();
      const first = outcome(database(c).transaction(async (tx) => {
        await tx.query('UPDATE live_calendar SET value=value+1 WHERE id=1'); entered.resolve(); await release.promise;
      }));
      await enteredOrFailed(entered, first);
      const second = outcome(database(d).transaction(async (tx) => { await tx.query('UPDATE live_calendar SET value=value+1 WHERE id=1'); }));
      try { await blocked(c.events.at(-1).pid, 'calendar-b', 'row update'); } finally { release.resolve(); }
      assert.equal((await first).error, undefined); assert.equal((await second).error, undefined);
      assert.equal((await q('SELECT value FROM live_calendar WHERE id=1'))[0].value, 12);
    });
    await test('terminated calendar backend rolls back, fails commit once, discards and replaces connection', async () => {
      let calls = 0;
      const result = await outcome(database(c).transaction(async (tx) => {
        calls++; await tx.query('UPDATE live_calendar SET value=100 WHERE id=1');
        assert.equal((await q('SELECT pg_terminate_backend($1,5000) AS killed', [c.events.at(-1).pid]))[0].killed, true);
      }));
      assert.ok(result.error); assert.equal(calls, 1);
      assert.ok(c.events.at(-1).discard);
      const pid = c.events.at(-1).pid;
      assert.equal((await q('SELECT value FROM live_calendar WHERE id=1'))[0].value, 12);
      await database(c).transaction(async (tx) => assert.notEqual((await tx.query('SELECT pg_backend_pid() AS pid')).rows[0].pid, pid));
    });
    await test('creating intent survives clean PostgreSQL process restart and new pool', async () => {
      await Promise.all(pools.map((p) => p.end())); pools.length = 0;
      await restart(); observer = pool('observer-restarted');
      await new Ledger(tracked(pool('ledger-restarted'))).withJobLock(durable.jobId, async (current) => assert.deepEqual(current, durable));
    });
    console.log(`RESULT ${passed}/8 live PostgreSQL checks passed; zero skipped`);
  } finally { await Promise.all(pools.map((p) => p.end())); }
}
