import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { advanceDataOrchestration, type DataOrchestrationPorts } from './orchestration';
import { createFileDataOperationLedger } from './operation-ledger';
import { fixtureJob, fixtureSpec } from './adapters/fixtures';
import type { EvaluationDataTask } from './acquisition';
import { createAutomatedExpertAdapter, type ExpertLoopRecord, type AutomatedExpertOwnerPorts } from './adapters/automated-expert';

const empty = { sources: [], cases: [] };
const context = { job: fixtureJob, versionLabel: 'expert-v1', systemPrompt: null };
async function setup() {
 const directory = await mkdtemp(join(tmpdir(), 'expert-resume-'));
 let task: EvaluationDataTask | null = null;
 const expert = vi.fn(async () => ({ status: 'pending' as const }));
 const ports: DataOrchestrationPorts = {
  operations: createFileDataOperationLedger(directory),
  acquisition: {
   store: {
    get: async () => structuredClone(task),
    insertIfAbsent: async value => { const inserted = !task; task ??= { ...structuredClone(value), phase: 'expert', state: 'waiting_for_expert' }; return { inserted, record: structuredClone(task) }; },
    compareAndSet: async (_id, revision, next) => { if (task?.revision !== revision) return null; task=structuredClone(next); return structuredClone(task); },
   },
   discover: async () => ({ status: 'complete', data: empty }),
   generate: async () => ({ status: 'complete', data: empty }), expert,
  },
  readReview: async () => ({ status: 'pending' }),
  freeze: vi.fn(async () => ({ status: 'pending' as const })), deliverCost: async () => {},
 };
 return { ports, directory, expert, close: () => rm(directory,{recursive:true,force:true}) };
}
describe('provider-owned expert advancement', () => {
 it('keeps legacy pending effects fenced without an explicit reconciliation port', async () => {
  const h=await setup();try {
   expect((await advanceDataOrchestration(fixtureSpec,empty,context,h.ports)).status).toBe('reconciliation_required');
   h.ports.operations=createFileDataOperationLedger(h.directory);
   expect((await advanceDataOrchestration(fixtureSpec,empty,context,h.ports)).status).toBe('reconciliation_required');
   expect(h.expert).toHaveBeenCalledTimes(1);
  } finally { await h.close(); }
 });
 it('advances the actual expert adapter across invocation/restart without sending twice', async () => {
  const h=await setup();let state: ExpertLoopRecord|null=null;
  const owner: AutomatedExpertOwnerPorts = {
   store: { get:async()=>structuredClone(state), insertIfAbsent:async r=>{state??=structuredClone(r);return structuredClone(state);},compareAndSet:async(_key,revision,next)=>{if(state?.revision!==revision)return null;state=structuredClone(next);return structuredClone(state);} },
   authorize:async()=>({allowed:true,policyId:'pilot',dayScope:'2026-11-08',customerSharingConsent:false,approvedColdContactIds:[],knownSecrets:[]}),
   ensureRequest:async()=>{},discover:async()=>[{id:'expert-1',qualified:true,optedIn:true,honorariumMicroUsd:25_000_000}],reserve:async()=>true,
   invite:vi.fn(async()=>{throw Error('lost acknowledgement');}),recoverDelivery:vi.fn(async()=>({status:'sent' as const,deliveryId:'delivery-1'})),contributions:async()=>[],
  };
  try {
   const adapter=createAutomatedExpertAdapter(owner,{topic:'Export formats'});
   h.ports.acquisition.expert=adapter;h.ports.resumeExpert=adapter;
   await advanceDataOrchestration(fixtureSpec,empty,context,h.ports);
   expect(state!.state).toBe('selected');
   await advanceDataOrchestration(fixtureSpec,empty,context,h.ports);
   expect(state!.state).toBe('dispatching');
   h.ports.operations=createFileDataOperationLedger(h.directory);
   h.ports.resumeExpert=createAutomatedExpertAdapter(owner,{topic:'Export formats'});
   await advanceDataOrchestration(fixtureSpec,empty,context,h.ports);
   expect(state!.state).toBe('sent');
   await advanceDataOrchestration(fixtureSpec,empty,context,h.ports);
   expect(owner.invite).toHaveBeenCalledTimes(1);expect(owner.recoverDelivery).toHaveBeenCalledTimes(1);
   expect(h.ports.freeze).not.toHaveBeenCalled();
  } finally {await h.close();}
 });
 it('persists a reconciled result and does not call reconciliation again on replay', async()=>{
  const h=await setup();try {
   await advanceDataOrchestration(fixtureSpec,empty,context,h.ports);
   h.ports.resumeExpert=vi.fn(async()=>({status:'complete' as const,data:empty}));
   expect((await advanceDataOrchestration(fixtureSpec,empty,context,h.ports)).status).toBe('waiting_for_review');
   await advanceDataOrchestration(fixtureSpec,empty,context,h.ports);
   expect(h.ports.resumeExpert).toHaveBeenCalledTimes(1);expect(h.expert).toHaveBeenCalledTimes(1);
  }finally{await h.close();}
 });
});
