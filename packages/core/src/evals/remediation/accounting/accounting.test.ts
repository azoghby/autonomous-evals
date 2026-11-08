import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import type { AgentTransactionalSql } from '../../../agents/postgres-ports';
import type { DispatchEvidence } from '../../../targets/remediation';
import { PostgresRemediationAccounting } from './index';

const inputDigest = 'a'.repeat(64);
const op = { operationId:'remediation:job:target:root:scenario', kind:'target' as const, inputDigest };
const evidence: DispatchEvidence = { operationId:op.operationId,inputDigest, jobId:'job', targetId:'target', targetVersion:'v1', environment:'test', trialId:'trial', baselineRunId:'baseline',suiteDigest:'b'.repeat(64),runId:'run',scenarioId:'scenario',patchDigest:'c'.repeat(64),payloadDigest:'d'.repeat(64) };
const measured = { promptTokens:2,completionTokens:3,totalTokens:5 };

describe('durable remediation accounting SQL (PGlite, no real multi-connection races)', () => {
  let engine: PGlite, sql: AgentTransactionalSql;
  let failCost = false;
  const make = (jobId = 'job', bound = 40) => new PostgresRemediationAccounting({sql,jobId,
    reservation: operation => ({jobId,reservationId:operation.operationId,amountMicroUsd:bound,
      scopes:[{key:`job:${jobId}`,capMicroUsd:100},{key:'agent:evaluation_engineer:period',capMicroUsd:100}]}),
    deliverCost: async (tx,cost) => {
      await tx.query(`INSERT INTO workflow_integration.cost_keys(key,job_id,payload) VALUES($1,$2,$3::jsonb)`, [cost.idempotencyKey,cost.jobId,JSON.stringify(cost)]);
      if (failCost) throw new Error('injected_delivery_failure');
    },
  });
  beforeAll(async () => {
    engine = new PGlite();
    await engine.exec(readFileSync(new URL('../../../agents/persistence-migrations/001-agent-persistence.sql',import.meta.url),'utf8'));
    await engine.exec(readFileSync(new URL('./001-remediation-accounting.sql',import.meta.url),'utf8'));
    await engine.exec('CREATE SCHEMA workflow_integration; CREATE TABLE workflow_integration.cost_keys(key text PRIMARY KEY,job_id text,payload jsonb)');
    sql = {query:<T>(query:string,params?:unknown[])=>engine.query<T>(query,params),transaction:fn=>engine.transaction(tx=>fn({query:<T>(query:string,params?:unknown[])=>tx.query<T>(query,params)}))};
  });
  beforeEach(async () => {
    failCost = false;
    await engine.exec('TRUNCATE remediation_accounting.reconciliation_outbox,remediation_accounting.operations,agent_persistence.reservations,agent_persistence.scopes,workflow_integration.cost_keys');
  });
  afterAll(async () => { await engine.close(); });
  it('reserves atomically, survives fresh adapter replay and refuses changed identity/policy', async () => {
    expect(await make().authorize(op)).toBe(true);
    expect(await make().authorize(op)).toBe(true);
    expect((await engine.query('SELECT * FROM agent_persistence.reservations')).rows).toHaveLength(1);
    await expect(make().authorize({...op,inputDigest:'f'.repeat(64)})).rejects.toThrow('conflict');
    await expect(make('job',41).authorize(op)).rejects.toThrow('conflict');
    expect(await make('other').authorize({...op,operationId:'other1'})).toBe(true);
    expect(await make('another').authorize({...op,operationId:'other2'})).toBe(false);
    expect(await make('another').authorize({...op,operationId:'other2'})).toBe(false);
  });
  it('fences duplicate dispatch across fresh instances and validates evidence identity', async () => {
    await make().authorize(op);
    await expect(make().beforeDispatch({...evidence,inputDigest:'f'.repeat(64)})).rejects.toThrow('conflict');
    await make().beforeDispatch(evidence);
    await expect(make().beforeDispatch(evidence)).rejects.toThrow('conflict');
    await expect(make().observed({...evidence,payloadDigest:'f'.repeat(64)},measured)).rejects.toThrow('conflict');
    expect((await make().pending())).toHaveLength(1);
  });
  it('retains unknown money and late usage after ambiguity without releasing reservation', async () => {
    await make().authorize(op); await make().beforeDispatch(evidence);
    await make().observed(evidence,null); await make().ambiguous(evidence);
    await make().observed(evidence,measured); await make().observed(evidence,null);
    await make().reconcile({...op,receiptId:'owner-receipt',usage:null,microUsd:null});
    expect((await engine.query<{usage:unknown;ambiguous:boolean}>('SELECT usage,ambiguous FROM remediation_accounting.operations')).rows[0]).toEqual({usage:measured,ambiguous:true});
    expect((await engine.query('SELECT * FROM workflow_integration.cost_keys')).rows).toHaveLength(0);
    expect((await engine.query<{settled_micro_usd:unknown}>('SELECT settled_micro_usd FROM agent_persistence.reservations')).rows[0]!.settled_micro_usd).toBeNull();
    expect(await make().pending()).toHaveLength(1);
    await expect(make().observed(evidence,{...measured,promptTokens:3,totalTokens:6})).rejects.toThrow('conflict');
  });
  it('atomically settles and delivers exactly one global keyed priced receipt', async () => {
    await make().authorize(op); await make().beforeDispatch(evidence);
    const receipt = {...op,receiptId:'priced-provider-receipt',usage:measured,microUsd:12};
    await make().reconcile(receipt); await make().reconcile(receipt);
    expect((await engine.query('SELECT * FROM workflow_integration.cost_keys')).rows).toHaveLength(1);
    expect(await make().pending()).toHaveLength(0);
    await expect(make().reconcile({...receipt,microUsd:13})).rejects.toThrow('conflict');
    await make().ambiguous(evidence); await make().observed(evidence,null);
    expect(await make().pending()).toHaveLength(0);
  });
  it('rolls settlement, keyed cost and outbox back together on failed delivery', async () => {
    await make().authorize(op); await make().beforeDispatch(evidence);
    failCost = true;
    await expect(make().reconcile({...op,receiptId:'priced',usage:measured,microUsd:12})).rejects.toThrow('injected_delivery_failure');
    expect((await engine.query('SELECT * FROM workflow_integration.cost_keys')).rows).toHaveLength(0);
    expect((await engine.query<{settled_micro_usd:unknown}>('SELECT settled_micro_usd FROM agent_persistence.reservations')).rows[0]!.settled_micro_usd).toBeNull();
    expect(await make().pending()).toHaveLength(1);
    failCost = false;
    await make().reconcile({...op,receiptId:'priced',usage:measured,microUsd:12});
  });
  it('rolls operation back if budget reservation fails internally', async () => {
    const faulty: AgentTransactionalSql = { ...sql, transaction:fn=>sql.transaction(tx=>fn({query:async <T>(query:string,params?:unknown[])=>{
      const result = await tx.query<T>(query,params);
      if (query.startsWith('UPDATE agent_persistence.reservations')) throw new Error('injected_reservation_failure');
      return result;
    }})) };
    const accounting = new PostgresRemediationAccounting({sql:faulty,jobId:'job',reservation:operation=>({jobId:'job',reservationId:operation.operationId,amountMicroUsd:40,scopes:[{key:'job:job',capMicroUsd:100},{key:'agent:evaluation_engineer:period',capMicroUsd:100}]}),deliverCost:async()=>undefined});
    await expect(accounting.authorize(op)).rejects.toThrow('injected_reservation_failure');
    expect((await engine.query('SELECT * FROM remediation_accounting.operations')).rows).toHaveLength(0);
    expect((await engine.query('SELECT * FROM agent_persistence.reservations')).rows).toHaveLength(0);
  });
});
