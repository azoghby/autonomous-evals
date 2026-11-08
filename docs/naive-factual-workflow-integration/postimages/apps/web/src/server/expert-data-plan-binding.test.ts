import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentTransactionalSql } from '@ae/core/agents/postgres-ports';
import type { ServiceContext } from '@ae/core/contracts/services';
import { reviewDigest } from '@ae/core/evals/data/binding';
import { factualGapInputDigest } from '@ae/core/evals/text/factual-gap';
import { deriveFactualGapPlan, installFactualGapExpertPlan, type FactualGapPlanRequest } from './expert-data-plan';
import { assertFactualGapPlanCurrent } from './expert-data-plan-binding';

const ports = vi.hoisted(() => ({ sql: undefined as AgentTransactionalSql | undefined,
  buildAgentDeps: vi.fn(async () => { throw new Error('provider construction forbidden'); }),
  recordCost: vi.fn(), ownerStep: vi.fn(), responses: vi.fn(), target: vi.fn(),
}));
vi.mock('@ae/core/storage/crypto', () => ({ decryptJson: (cipher: string) => ({ endpoint: cipher === 'encrypted-v1' ? 'first-private-key' : 'rotated-private-key' }) }));
vi.mock('@ae/core/integration/eval-services', () => ({ buildAgentDeps: ports.buildAgentDeps }));
vi.mock('@ae/core/simulator/pool', () => ({ pooledCalendarDatabase: () => ports.sql }));
vi.mock('@/server/automated-expert-owner', () => ({ expertOwnerDatabase: () => ports.sql, createOwnerExpertStep: ports.ownerStep }));
vi.mock('@/server/automated-expert-responses', () => ({ createSqlExpertResponseService: ports.responses }));
vi.mock('@/server/session', () => ({ getCurrentCustomer: vi.fn(async () => null) }));
vi.mock('@/server/job-store', () => ({ recordCost: ports.recordCost, jobKnownCostMicroUsd: vi.fn(async () => 0) }));

const jobId = '123e4567-e89b-42d3-a456-426614174000';
const tenant = '223e4567-e89b-42d3-a456-426614174000';
const expert = '323e4567-e89b-42d3-a456-426614174000';
const dbs: PGlite[] = [];
afterEach(async () => { vi.unstubAllEnvs(); vi.clearAllMocks(); ports.sql = undefined; for (const pg of dbs.splice(0)) await pg.close(); });

/** Exact existing migrations with synthetic supporting tables. No provider capabilities. */
async function fixture() {
  vi.stubEnv('EVAL_SERVICES', 'real'); vi.stubEnv('DATABASE_URL_UNPOOLED', 'postgres://fixture.invalid/binding-test');
  const pg = new PGlite(); dbs.push(pg);
  await pg.exec(`CREATE TABLE customers(id uuid PRIMARY KEY);CREATE TABLE jobs(id uuid PRIMARY KEY,customer_id uuid,environment text,package text,is_mock boolean,state text,intake jsonb,created_at timestamptz DEFAULT now(),credentials_delete_after timestamptz,retest_of_job_id uuid);
    CREATE TABLE job_credentials(job_id uuid PRIMARY KEY,ciphertext text);CREATE TABLE experts(id uuid PRIMARY KEY,email text,status text,source text,consent_flags jsonb);
    CREATE TABLE expert_requests(id uuid PRIMARY KEY);CREATE TABLE expert_engagements(id uuid PRIMARY KEY);CREATE TABLE outreach_drafts(id uuid PRIMARY KEY);
    CREATE TABLE expert_responses(id uuid PRIMARY KEY);CREATE TABLE contact_suppressions(email text);`);
  for (const file of ['0024_expert_automation.sql', '0025_expert_workflow.sql']) await pg.exec(readFileSync(resolve('packages/core/src/db/migrations', file), 'utf8'));
  await pg.exec(readFileSync(resolve('packages/core/src/evals/integration/migrations/001-text-integration.sql'), 'utf8'));
  const intake = { package: 'text_eval', authorizedToTest: true, endpoint: { url: 'https://example.com/agent', model: 'model', systemPrompt: 'Answer product questions.' }, _credentialSlots: ['endpoint'] };
  await pg.query('INSERT INTO customers VALUES($1)', [tenant]);
  await pg.query("INSERT INTO jobs(id,customer_id,environment,package,is_mock,state,intake,credentials_delete_after) VALUES($1,$2,'test','text_eval',false,'planning',$3::jsonb,now()+interval '1 day')", [jobId, tenant, JSON.stringify(intake)]);
  await pg.query('INSERT INTO job_credentials VALUES($1,$2)', [jobId, 'encrypted-v1']);
  const request: FactualGapPlanRequest = { jobId, environment: 'test', taskId: 'factual-entry-v1', versionLabel: 'v1', canonicalInputDigest: reviewDigest({ package: intake.package, authorizedToTest: true, endpoint: { ...intake.endpoint, referenceText: null }, notes: null }),
    proposal: { schemaVersion: 'text_factual_gap.v1', authority: 'model_proposed_coverage_requires_owner_validation', inputDigest: factualGapInputDigest({ job: { jobId, customerId: tenant, environment: 'test' }, versionLabel: 'v1', systemPrompt: intake.endpoint.systemPrompt, referenceText: null }),
      requirements: [{ reason: 'factual_check_missing_reference', scenarioId: 'S01', userMessage: 'What are the limits?', check: { id: 'S01.r1', kind: 'rubric', description: 'Product limits', rubric: 'Matches product facts.', requiresReference: true, assessesFactualCorrectness: true } }] } };
  const plan = deriveFactualGapPlan(request, { customer_id: tenant, intake }, reviewDigest({ ...intake.endpoint, apiKey: 'first-private-key' }));
  const sql: AgentTransactionalSql = { query: (q, p) => pg.query(q, p), transaction: fn => pg.transaction(tx => fn({ query: (q, p) => tx.query(q, p) })) };
  ports.sql = sql;
  const decryptCredentials = (cipher: string) => ({ endpoint: cipher === 'encrypted-v1' ? 'first-private-key' : 'rotated-private-key' });
  await pg.query("INSERT INTO expert_automation_policies VALUES('pilot',true,25000000,50000000)");
  await pg.query("INSERT INTO expert_automation_scopes VALUES($1,$2,$3,$4,'pilot','Product support',true,true)", [jobId, request.taskId, tenant, reviewDigest({ task: plan.task, topic: 'Product support' })]);
  await pg.query("INSERT INTO experts VALUES($1,'expert@example.com','active','opt_in','{\"contactForPaidWork\":true}'::jsonb)", [expert]);
  await pg.query("INSERT INTO expert_automation_qualifications VALUES($1,'Product support',true,'[\"owner evidence\"]'::jsonb,'[\"evaluation\"]'::jsonb,'consent-receipt',null)", [expert]);
  async function install() { expect(await installFactualGapExpertPlan(request, { sql, decryptCredentials })).toMatchObject({ status: 'installed' }); }
  async function effects() {
    const counts: Record<string, number> = {};
    for (const table of ['expert_automation_operations', 'expert_automation_invitations', 'outreach_drafts', 'expert_requests', 'expert_workflow.contribution_reviews', 'text_integration.checkpoints']) counts[table] = (await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
    return counts;
  }
  return { pg, sql, request, plan, intake, install, effects, decryptCredentials };
}

it('revalidates the exact installed factual plan with current secured credentials and performs no writes', async () => {
  const f = await fixture(); await f.install();
  const before = await f.effects();
  await expect(assertFactualGapPlanCurrent(f.sql, jobId, { decryptCredentials: f.decryptCredentials })).resolves.toBeUndefined();
  await expect(assertFactualGapPlanCurrent(f.sql, jobId)).resolves.toBeUndefined();
  expect(await f.effects()).toEqual(before);
  expect(ports.buildAgentDeps).not.toHaveBeenCalled();
});

it.each([
  ['credential rotation', "UPDATE job_credentials SET ciphertext='encrypted-v2'"],
  ['credential removal', 'DELETE FROM job_credentials'],
  ['credential expiry', "UPDATE jobs SET credentials_delete_after=now()-interval '1 second'"],
  ['target URL change', "UPDATE jobs SET intake=jsonb_set(intake,'{endpoint,url}','\"https://other.example.com/agent\"'::jsonb)"],
  ['system prompt change', "UPDATE jobs SET intake=jsonb_set(intake,'{endpoint,systemPrompt}','\"New instructions\"'::jsonb)"],
  ['reference replacement', "UPDATE jobs SET intake=jsonb_set(intake,'{endpoint,referenceText}','\"Unapproved reference\"'::jsonb)"],
  ['environment change', "UPDATE jobs SET environment='live'"],
  ['required slot change', "UPDATE jobs SET intake=jsonb_set(intake,'{_credentialSlots}','[\"endpointB\"]'::jsonb)"],
  ['inline credential', "UPDATE jobs SET intake=jsonb_set(intake,'{endpoint,apiKey}','\"plaintext-secret\"'::jsonb)"],
  ['scope revocation', 'UPDATE expert_automation_scopes SET enabled=false'],
  ['scope task binding', "UPDATE expert_automation_scopes SET request_hash=repeat('0',64)"],
  ['policy revocation', 'UPDATE expert_automation_policies SET enabled=false'],
  ['sharing consent revocation', 'UPDATE expert_automation_scopes SET customer_sharing_consent=false'],
  ['plan revocation', 'UPDATE expert_workflow.plans SET enabled=false'],
] as const)('rejects post-install %s without a new operation, invitation, review or receipt', async (_name, mutation) => {
  const f = await fixture(); await f.install(); await f.pg.exec(mutation);
  const before = await f.effects();
  await expect(assertFactualGapPlanCurrent(f.sql, jobId, { decryptCredentials: f.decryptCredentials })).rejects.toThrow();
  expect(await f.effects()).toEqual(before);
  expect(ports.buildAgentDeps).not.toHaveBeenCalled();
});

it('refuses canonical customer changes after installation', async () => {
  const f = await fixture(); await f.install();
  const other = '423e4567-e89b-42d3-a456-426614174000';
  await f.pg.query('INSERT INTO customers VALUES($1)', [other]); await f.pg.query('UPDATE jobs SET customer_id=$1', [other]);
  await expect(assertFactualGapPlanCurrent(f.sql, jobId, { decryptCredentials: f.decryptCredentials })).rejects.toThrow();
  expect(Object.values(await f.effects()).every(n => n === 0)).toBe(true);
});

it.each([null, {}, { schemaVersion: 'unexpected' }])('rejects malformed retained factual metadata %j even with a matching input digest', async entry => {
  const f = await fixture();
  const malformed = { ...f.plan, factualGapEntry: entry };
  await f.pg.query("INSERT INTO expert_workflow.plans(job_id,tenant_id,input,input_digest,topic,enabled,response_deadline) VALUES($1,$2,$3::jsonb,$4,'Product support',true,now()+interval '1 day')", [jobId, tenant, JSON.stringify(malformed), reviewDigest(malformed)]);
  await expect(assertFactualGapPlanCurrent(f.sql, jobId, { decryptCredentials: f.decryptCredentials })).rejects.toThrow();
  expect(Object.values(await f.effects()).every(n => n === 0)).toBe(true);
});

it('leaves legacy plans without factualGapEntry to their existing authority checks', async () => {
  const f = await fixture();
  const { factualGapEntry: _entry, ...legacy } = f.plan;
  await f.pg.query("INSERT INTO expert_workflow.plans(job_id,tenant_id,input,input_digest,topic,enabled,response_deadline) VALUES($1,$2,$3::jsonb,$4,'Product support',true,now()+interval '1 day')", [jobId, tenant, JSON.stringify(legacy), reviewDigest(legacy)]);
  await f.pg.exec('DELETE FROM job_credentials; UPDATE expert_automation_scopes SET enabled=false');
  await expect(assertFactualGapPlanCurrent(f.sql, jobId, { decryptCredentials: f.decryptCredentials })).resolves.toBeUndefined();
  expect(Object.values(await f.effects()).every(n => n === 0)).toBe(true);
});

it.each(['input digest', 'proposal digest', 'changed proposal', 'required uses', 'extra metadata'] as const)('rejects retained %s tampering without installing another binding', async mutation => {
  const f = await fixture();
  const retained = structuredClone(f.plan);
  if (mutation === 'proposal digest') retained.factualGapEntry.proposalDigest = '0'.repeat(64);
  if (mutation === 'changed proposal') {
    retained.factualGapEntry.proposal.requirements[0].check.rubric = 'Different factual authority.';
    retained.factualGapEntry.proposalDigest = reviewDigest(retained.factualGapEntry.proposal);
  }
  if (mutation === 'required uses') retained.task.requiredUses = ['generation'];
  if (mutation === 'extra metadata') Object.assign(retained.factualGapEntry, { ownerApproved: true });
  await f.pg.query("INSERT INTO expert_workflow.plans(job_id,tenant_id,input,input_digest,topic,enabled,response_deadline) VALUES($1,$2,$3::jsonb,$4,'Product support',true,now()+interval '1 day')", [jobId, tenant, JSON.stringify(retained), mutation === 'input digest' ? '0'.repeat(64) : reviewDigest(retained)]);
  const before = await f.effects();
  await expect(assertFactualGapPlanCurrent(f.sql, jobId, { decryptCredentials: f.decryptCredentials })).rejects.toThrow('factual_gap_plan_binding_revoked');
  expect(await f.effects()).toEqual(before);
});

it.each(['rotated', 'removed', 'expired', 'intake'] as const)('both actual candidate consumers reject %s factual bindings before provider or durable writes', async mutation => {
  const f = await fixture(); await f.install();
  if (mutation === 'rotated') await f.pg.exec("UPDATE job_credentials SET ciphertext='encrypted-v2'");
  if (mutation === 'removed') await f.pg.exec('DELETE FROM job_credentials');
  if (mutation === 'expired') await f.pg.exec("UPDATE jobs SET credentials_delete_after=now()-interval '1 second'");
  if (mutation === 'intake') await f.pg.exec("UPDATE jobs SET intake=jsonb_set(intake,'{endpoint,url}','\"https://other.example.com/agent\"'::jsonb)");
  const before = await f.effects();
  const { advanceExpertProductionData } = await import('./expert-data-production');
  const { createExpertTextRuntime } = await import('./expert-text-runtime');
  await expect(advanceExpertProductionData(jobId, f.plan, 'Product support')).rejects.toThrow('factual_gap_plan_binding_revoked');
  const recordCost = vi.fn(async () => {});
  const ctx = { jobId, environment: 'test', budgetMicroUsd: 3_000_000, recordCost } as unknown as ServiceContext;
  await expect(createExpertTextRuntime(ctx, { sql: f.sql, targetTransport: { post: ports.target } })).rejects.toThrow('factual_gap_plan_binding_revoked');
  expect(await f.effects()).toEqual(before);
  expect(recordCost).not.toHaveBeenCalled(); expect(ports.recordCost).not.toHaveBeenCalled();
  expect(ports.buildAgentDeps).not.toHaveBeenCalled(); expect(ports.ownerStep).not.toHaveBeenCalled(); expect(ports.responses).not.toHaveBeenCalled(); expect(ports.target).not.toHaveBeenCalled();
});

it('production rechecks factual authority after initial credentials resolve and before a durable operation', async () => {
  const f = await fixture(); await f.install();
  let credentialReads = 0;
  ports.sql = { ...f.sql, query: async <T>(query: string, params?: unknown[]) => {
    const result = await f.sql.query<T>(query, params);
    if (query.includes('SELECT ciphertext FROM job_credentials') && ++credentialReads === 2) {
      await f.pg.exec("UPDATE job_credentials SET ciphertext='encrypted-v2'");
    }
    return result;
  } };
  const before = await f.effects();
  const { advanceExpertProductionData } = await import('./expert-data-production');
  await expect(advanceExpertProductionData(jobId, f.plan, 'Product support')).rejects.toThrow('factual_gap_plan_binding_revoked');
  expect(credentialReads).toBeGreaterThanOrEqual(3);
  expect(await f.effects()).toEqual(before);
  expect(ports.buildAgentDeps).not.toHaveBeenCalled(); expect(ports.ownerStep).not.toHaveBeenCalled(); expect(ports.recordCost).not.toHaveBeenCalled();
});
