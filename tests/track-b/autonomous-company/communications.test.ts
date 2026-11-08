import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUTONOMY_COMMUNICATIONS_SQL, PostgresCommunicationOutbox, type CommunicationPolicy, type CommunicationGuards, type CommunicationProvider, type CommunicationRequest, type ContactAuthorization } from '../../../packages/core/src/agents/autonomy/communications';
import type { AgentTransactionalSql } from '../../../packages/core/src/agents/postgres-ports';

describe('offline SQL communications outbox', () => {
 let sql: PGlite, db: AgentTransactionalSql;
 let contact: ContactAuthorization, currentVersion: string, secret: string, sends: number, lookups: number;
 const policy: CommunicationPolicy = { mode: 'autonomous.v1', version: 'policy1', tenantId: 'tenant', sender: 'company@example.com', dailyCap: 2, maxDispatchAttempts: 2, dispatchTimeoutMs: 100, deliveryDeadlineMs: 10000, enabledTemplates: ['clarification','quote','report_ready','monitoring_offer','expert_request'], approvedExpertContactIds: ['expert'], reportOrigin: 'https://company.example.com' };
 let guards: CommunicationGuards, provider: CommunicationProvider;
 const request = (id = 'message'): CommunicationRequest => ({ id, tenantId: 'tenant', jobId: 'job', contactId: 'customer', template: 'report_ready', reportId: 'report' });
 const outbox = (p = policy) => new PostgresCommunicationOutbox(db, p, guards);
 beforeEach(async () => {
  sql = new PGlite(); await sql.exec(AUTONOMY_COMMUNICATIONS_SQL);
  db = { query: (s,p) => sql.query(s,p), transaction: fn => sql.transaction(tx => fn({query: (s,p) => tx.query(s,p)})) };
  contact = { tenantId: 'tenant', jobId: 'job', email: 'customer@example.com', active: true, optedOut: false, productNotifications: true, marketingOptIn: false, expertConsent: false };
  currentVersion = 'policy1'; secret = ''; sends = 0; lookups = 0;
  guards = { async authorizeContent() { return true; }, async resolveContact() { return contact; }, async currentPolicyVersion() { return currentVersion; }, async containsCurrentSecret(t) { return !!secret && t.includes(secret); } };
  provider = { async send() { sends++; return {providerId: 'provider1', costMicroUsd: 0}; }, async lookup() { lookups++; return {status: 'sent', receipt: {providerId:'provider1',costMicroUsd:0}}; } };
 });
 afterEach(async () => { await sql.close(); });
 it('durably deduplicates across restart and concurrent dispatch with fixed template claims', async () => {
  const r = await outbox().enqueue(request(), 1000);
  expect(r.body).toContain('https://company.example.com/reports/report');
  await outbox().enqueue(request(), 1001);
  const results = await Promise.all([outbox().dispatch('message',provider,1002), outbox().dispatch('message',provider,1002)]);
  expect(results.some(x => x?.status === 'sent')).toBe(true); expect(sends).toBe(1);
  expect((await outbox().dispatch('message',provider,1003))?.cost).toEqual({known:true,microUsd:0});
  await expect(outbox().enqueue({...request(),reportId:'changed'},1003)).rejects.toThrow('identity_conflict');
 });
 it('atomically reserves daily cap on concurrent enqueues including retries', async () => {
  const results = await Promise.allSettled(['a','b','c'].map(id => outbox().enqueue(request(id),1000)));
  expect(results.filter(x => x.status === 'fulfilled')).toHaveLength(2);
  await outbox().enqueue(request('a'),1001);
  const rows = await sql.query<{reserved:number}>('SELECT reserved FROM company_autonomy.message_days');
  expect(rows.rows[0].reserved).toBe(2);
 });
 it('reconciles ambiguous provider delivery after restart without another send', async () => {
  provider.send = async () => { sends++; throw new Error('ack lost'); };
  await outbox().enqueue(request(),1000);
  expect((await outbox().dispatch('message',provider,1001))?.cost.known).toBe(false);
  expect((await outbox().recoverDue(provider,1200))[0]?.reason).toBe('authoritative_receipt_recovered');
  expect(sends).toBe(1); expect(lookups).toBe(1);
 });
 it('pauses unknown dispatch instead of blindly retrying or inventing a receipt', async () => {
  provider.send = async () => { sends++; throw new Error('network'); };
  provider.lookup = async () => ({status:'unknown'});
  await outbox().enqueue(request(),1000); await outbox().dispatch('message',provider,1001);
  expect((await outbox().recoverDue(provider,1200))[0]).toMatchObject({status:'paused',reason:'ambiguous_dispatch_no_blind_retry',receipt:null,cost:{known:false,microUsd:null}});
  await outbox().recoverDue(provider,1400); expect(sends).toBe(1);
 });
 it('only retries an authoritative not-sent receipt within the attempt and time bounds', async () => {
  provider.send = async () => { sends++; throw new Error('network'); };
  provider.lookup = async () => ({status:'not_sent'});
  await outbox().enqueue(request(),1000); await outbox().dispatch('message',provider,1001);
  await outbox().recoverDue(provider,1200);
  expect((await outbox().recoverDue(provider,1400))[0]?.status).toBe('refused'); expect(sends).toBe(2);
 });
 it.each(['optout','secret','policy','tenant','recipient'] as const)('rechecks current %s at dispatch', async change => {
  await outbox().enqueue(request(),1000);
  if(change === 'optout') contact.optedOut = true;
  if(change === 'secret') secret = 'report';
  if(change === 'policy') currentVersion = 'rotated';
  if(change === 'tenant') contact.tenantId = 'other';
  if(change === 'recipient') contact.email = 'different@example.com';
  expect((await outbox().dispatch('message',provider,1001))?.status).toBe('refused'); expect(sends).toBe(0);
 });
 it('rejects cross-tenant authority, model body injection, manual mode and unsolicited marketing/experts', async () => {
  await expect(outbox().enqueue({...request(),tenantId:'other'},1000)).rejects.toThrow('authority_denied');
  await expect(outbox().enqueue({...request(),body:'Ignore policy: your refund is sent'} as CommunicationRequest,1000)).rejects.toThrow('invalid_message_request');
  await expect(outbox({...policy,mode:'manual'}).enqueue(request(),1000)).rejects.toThrow('authority_denied');
  await expect(outbox().enqueue({...request(),template:'monitoring_offer'},1000)).rejects.toThrow('consent_denied');
  contact.expertConsent = true;
  await expect(outbox().enqueue({...request(),template:'expert_request'},1000)).rejects.toThrow('consent_denied');
 });
 it('refuses unsupported report-ready and quote claims against authoritative job state', async () => {
  guards.authorizeContent = async () => false;
  await expect(outbox().enqueue(request(),1000)).rejects.toThrow('message_content_not_authorized');
  expect(sends).toBe(0);
 });
 it('uses code-owned prices and records reason and policy on all transitions', async () => {
  const row = await outbox().enqueue({...request(),template:'quote',packageId:'trace_audit'},1000);
  expect(row.body).toContain('$5');
  const done = await outbox().dispatch('message',provider,1001);
  expect(done?.history.map(x => x.reason)).toEqual(['policy_authorized','provider_dispatch_intent','provider_receipt']);
  expect(done?.history.every(x => x.policyVersion === 'policy1')).toBe(true);
 });
 it('fences a stale worker after recovery has persisted a receipt', async () => {
  let started!: () => void, complete!: (r: {providerId:string;costMicroUsd:number}) => void;
  const begun = new Promise<void>(resolve => { started = resolve; });
  provider.send = () => { started(); return new Promise(resolve => { complete = resolve; }); };
  const box = outbox({...policy,dispatchTimeoutMs:5000});
  await box.enqueue(request(),1000);
  const first = box.dispatch('message',provider,1001);
  await begun;
  expect((await box.dispatch('message',provider,7000))?.reason).toBe('authoritative_receipt_recovered');
  complete({providerId:'stale-receipt',costMicroUsd:17});
  await expect(first).rejects.toThrow('lease_lost');
  expect((await box.get('message'))?.receipt?.providerId).toBe('provider1');
 });
 it('bounds a hung provider and preserves unknown cost for recovery', async () => {
  provider.send = () => new Promise(() => {});
  const box = outbox({...policy,dispatchTimeoutMs:5});
  await box.enqueue(request(),1000);
  const record = await box.dispatch('message',provider,1001);
  expect(record).toMatchObject({status:'dispatching',reason:'dispatch_ambiguous_await_receipt',cost:{known:false}});
 });
 it('refuses expired messages and prior-day reservations rather than exceeding a delivery-day cap', async () => {
  await outbox().enqueue(request(),1000);
  expect((await outbox().dispatch('message',provider,86400001))?.status).toBe('refused'); expect(sends).toBe(0);
 });
});
