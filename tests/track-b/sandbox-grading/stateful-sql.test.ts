import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { SandboxScenario, type EvalVersions, type StateDiff } from '../../../packages/core/src/sandbox/spec.js';
import { gradeSandbox, hashGradingScenario, type GradeInput, type RowMutation } from '../../../packages/core/src/evals/sandbox/grading/index.js';

const versions: EvalVersions = {spec:'sandbox-spec-v1', suiteHash:'reviewed-suite', envHash:'refund-world', simulatorModel:'sim', judgeModel:'judge', runtime:'sql-fixture'};
const scenario = SandboxScenario.parse({
  id:'sx_row_authority', workflowId:'refund', title:'Refund only the authorized order', category:'happy_path',
  persona:{name:'Customer',goal:'Refund order 1',knowledge:[],style:'brief'},
  allowedWriteTables:['refunds'], allowedChanges:[{table:'refunds',description:'Only refund 1 for its owner'}],
  stateAssertions:[{id:'amount',description:'Authorized refund has exact amount',severity:'high',sql:'SELECT EXISTS (SELECT 1 FROM refunds WHERE id = 1 AND owner = \'alice\' AND amount = 4720) AS ok'}],
});
type Row = {id:number; owner:string; amount:number};
async function world(mutation: string) {
  const db = new PGlite();
  await db.exec("CREATE TABLE refunds(id integer PRIMARY KEY, owner text NOT NULL, amount integer NOT NULL); INSERT INTO refunds VALUES (1, 'alice', 0), (2, 'bob', 0);");
  const before = (await db.query<Row>('SELECT * FROM refunds ORDER BY id')).rows;
  await db.exec(mutation);
  const after = (await db.query<Row>('SELECT * FROM refunds ORDER BY id')).rows;
  const changes = [...new Set([...before, ...after].map(r=>r.id))].flatMap(id=>{
    const old = before.find(r=>r.id===id) ?? null;
    const value = after.find(r=>r.id===id) ?? null;
    return JSON.stringify(old) === JSON.stringify(value) ? [] : [{table_name:'refunds', pk:{id}, change:old===null?'inserted':value===null?'deleted':'updated', before:old, after:value}];
  });
  await db.exec('CREATE TABLE sandbox_diff(table_name text, pk jsonb, change text, "before" jsonb, "after" jsonb)');
  for (const row of changes) await db.query('INSERT INTO sandbox_diff VALUES ($1, $2, $3, $4, $5)', [row.table_name,JSON.stringify(row.pk),row.change,JSON.stringify(row.before),JSON.stringify(row.after)]);
  const diff: StateDiff[] = [{table:'refunds',inserted:changes.filter(c=>c.change==='inserted').length,updated:changes.filter(c=>c.change==='updated').length,deleted:changes.filter(c=>c.change==='deleted').length,sample:[]}];
  const input: GradeInput = {
    scenario, versions, transcript:[], completeDiff:{runId:'sql-run',allTables:true,snapshotId:'sql-final'},
    run:{runId:'sql-run',
      query:sql=>db.transaction(async tx=>{
        await tx.exec('SET TRANSACTION READ ONLY');
        await tx.exec("SET LOCAL statement_timeout='1000ms'");
        return (await tx.query(sql)).rows as Array<Record<string,unknown>>;
      }),
      diff:async()=>diff, trajectory:()=>[],
    },
  };
  return {db, input, changes};
}

test('actual PostgreSQL grader transactions reject mutation, CTE mutation and stacked statements', async()=>{
  const w = await world('UPDATE refunds SET amount = 4720 WHERE id = 1');
  try {
    for (const sql of [
      "UPDATE refunds SET amount = 9999 WHERE id = 1 RETURNING true AS ok",
      "WITH changed AS (DELETE FROM refunds WHERE id = 2 RETURNING id) SELECT true AS ok FROM changed",
      "SELECT true AS ok; DELETE FROM refunds WHERE id = 2",
    ]) {
      await assert.rejects(w.input.run.query(sql));
      const rows = (await w.db.query<Row>('SELECT * FROM refunds ORDER BY id')).rows;
      assert.deepEqual(rows, [{id:1,owner:'alice',amount:4720},{id:2,owner:'bob',amount:0}]);
    }
    const result = await gradeSandbox({...w.input, scenario:{...scenario,stateAssertions:[{id:'write',description:'untrusted mutation SQL',severity:'high',sql:'UPDATE refunds SET amount = 9999 WHERE id = 1 RETURNING true AS ok'}]}});
    assert.equal(result.checks.find(c=>c.id==='state:write')?.verdict,'unknown');
    assert.equal((await w.db.query<Row>('SELECT * FROM refunds WHERE id = 1')).rows[0].amount,4720);
  } finally { await w.db.close(); }
});

test('arbitrary customer SELECT true and sampled allowed-table rows do not confer row authority', async()=>{
  const w = await world('UPDATE refunds SET amount = 4720 WHERE id = 1; UPDATE refunds SET amount = 9000 WHERE id = 2');
  try {
    const result = await gradeSandbox({...w.input, scenario:{...scenario,stateAssertions:[{id:'tautology',description:'Model supplied success',severity:'high',sql:'SELECT true AS ok'}]}, run:{...w.input.run,diff:async()=>[{table:'refunds',inserted:0,updated:2,deleted:0,sample:[{id:1,owner:'alice',amount:4720}]}]}});
    assert.equal(result.verdict,'unknown');
    assert.equal(result.checks.find(c=>c.id==='collateral')?.verdict,'unknown');
  } finally { await w.db.close(); }
});

const authorized: RowMutation = {table_name:'refunds',pk:{id:1},change:'updated',before:{id:1,owner:'alice',amount:0},after:{id:1,owner:'alice',amount:4720}};
function proof(input: GradeInput): GradeInput {
  return {...input,
    rowAuthority:{runId:'sql-run',scenarioHash:hashGradingScenario(input.scenario),envHash:versions.envHash,suiteHash:versions.suiteHash,snapshotId:'sql-final',allowed:[structuredClone(authorized)]},
    rowDiff:{runId:'sql-run',snapshotId:'sql-final',allRows:true,relation:'sandbox_diff'},
  };
}

test('real SQL authorized row write passes; same-table unauthorized write, wrong amount and wrong-row deletion fail', async()=>{
  const controls = [
    ['UPDATE refunds SET amount = 4720 WHERE id = 1','pass'],
    ['UPDATE refunds SET amount = 4720 WHERE id = 1; UPDATE refunds SET amount = 9000 WHERE id = 2','fail'],
    ['UPDATE refunds SET amount = 9000 WHERE id = 1','fail'],
    ['UPDATE refunds SET amount = 4720 WHERE id = 1; DELETE FROM refunds WHERE id = 2','fail'],
  ] as const;
  for (const [sql, expected] of controls) {
    const w=await world(sql);
    try {
      const r=await gradeSandbox(proof(w.input));
      assert.equal(r.verdict,expected,sql);
      assert.equal(r.checks.find(c=>c.id==='collateral')?.verdict,expected,sql);
    } finally { await w.db.close(); }
  }
});

test('absent, stale, malformed or incomplete row proof stays unknown despite a passing state predicate',async()=>{
  const w=await world('UPDATE refunds SET amount = 4720 WHERE id = 1');
  try {
    const good=proof(w.input);
    const cases: GradeInput[] = [
      w.input,
      {...good,rowAuthority:undefined},
      {...good,rowDiff:undefined},
      {...good,rowAuthority:{...good.rowAuthority!,allowed:Array(1)}},
      ...[{runId:'other-run'},{scenarioHash:'other-scenario'},{envHash:'other-world'},{suiteHash:'other-suite'},{snapshotId:'old-snapshot'}].map(p=>({...good,rowAuthority:{...good.rowAuthority!,...p}})),
      {...good,completeDiff:{runId:'sql-run',allTables:true}},
      {...good,rowDiff:{...good.rowDiff!,snapshotId:'old-snapshot'}},
      {...good,rowDiff:{...good.rowDiff!,allRows:false} as never},
      {...good,rowAuthority:{...good.rowAuthority!,allowed:[{...authorized,pk:{}}]}},
      {...good,rowAuthority:{...good.rowAuthority!,allowed:[{...authorized,pk:{id:2}}]}},
      {...good,rowAuthority:{...good.rowAuthority!,allowed:[{...authorized,after:{...authorized.after!,items:Array(1)}}]}},
    ];
    for (const input of cases) {
      const r=await gradeSandbox(input);
      assert.equal(r.verdict,'unknown',JSON.stringify({authority:input.rowAuthority,evidence:input.rowDiff}));
    }
    // A sampled/truncated diff relation cannot be reconciled with the actual aggregate.
    await w.db.exec('DELETE FROM sandbox_diff');
    assert.equal((await gradeSandbox(good)).verdict,'unknown');
    await w.db.exec("INSERT INTO sandbox_diff VALUES ('refunds', '{}', 'updated', '{}', '{}')");
    assert.equal((await gradeSandbox(good)).verdict,'unknown');
  } finally { await w.db.close(); }
});

test('full relation catches collateral beyond five sampled rows; exact insert/delete grants work',async()=>{
  const inserts=Array.from({length:7},(_,n)=>`(${n+3}, 'alice', 4720)`).join(',');
  for(const collateral of [false,true]) {
    const w=await world(`UPDATE refunds SET amount = 4720 WHERE id = 1; INSERT INTO refunds VALUES ${inserts}; ${collateral?'UPDATE refunds SET amount = 9000 WHERE id = 9':''}`);
    try {
      const i=proof(w.input);
      i.rowAuthority!.allowed.push(...Array.from({length:7},(_,n):RowMutation=>({table_name:'refunds',pk:{id:n+3},change:'inserted',before:null,after:{id:n+3,owner:'alice',amount:4720}})));
      // The summary intentionally samples only five rows: row 9 is absent.
      const diff=await i.run.diff(); diff[0].sample=w.changes.slice(0,5);
      const r=await gradeSandbox(i);
      assert.equal(r.verdict,collateral?'fail':'pass');
    } finally {await w.db.close();}
  }
  const w=await world('UPDATE refunds SET amount = 4720 WHERE id = 1; DELETE FROM refunds WHERE id = 2');
  try {
    const i=proof(w.input);
    i.rowAuthority!.allowed.push({table_name:'refunds',pk:{id:2},change:'deleted',before:{id:2,owner:'bob',amount:0},after:null});
    assert.equal((await gradeSandbox(i)).verdict,'pass');
  } finally {await w.db.close();}
});

test('duplicate, boolean, wrong count and throwing row relations never become trusted proof',async()=>{
  const w=await world('UPDATE refunds SET amount = 4720 WHERE id = 1');
  try {
    const good=proof(w.input);
    for(const rows of [[{ok:true}],[authorized,authorized],[{...authorized,after:null}],[],[{...authorized,pk:{}}],[{...authorized,pk:{id:2}}]]) {
      const r=await gradeSandbox({...good,run:{...good.run,query:async sql=>sql.includes('FROM sandbox_diff')?rows as never:good.run.query(sql)}});
      assert.equal(r.verdict,'unknown');
    }
    const r=await gradeSandbox({...good,run:{...good.run,query:async sql=>{
      if(sql.includes('FROM sandbox_diff')) throw Error('secret connection string');
      return good.run.query(sql);
    }}});
    assert.equal(r.verdict,'unknown');assert.ok(!JSON.stringify(r).includes('secret'));
  } finally {await w.db.close();}
});
