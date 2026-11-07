import { describe, expect, it } from 'vitest';
import { createProgressChatService } from './service.js';
import type { ChatExchange, ConversationPort, ProgressSnapshot } from './types.js';

function fixture() {
  let subject: string | null = 'alice';
  let authorized = true;
  let reads = 0;
  const rows = new Map<string, ChatExchange[]>();
  const key = (s: {subjectId:string; jobId:string}) => JSON.stringify(s);
  const conversations: ConversationPort = {
    async get(scope, id) { return rows.get(key(scope))?.find(r => r.messageId === id) ?? null; },
    async append(scope, input) {
      const list = rows.get(key(scope)) ?? [];
      const old = list.find(r => r.messageId === input.messageId);
      if (old) return old;
      const value = { ...input, sequence: list.length + 1 };
      rows.set(key(scope), [...list, value]); return value;
    },
    async list(scope, query) { return (rows.get(key(scope)) ?? []).filter(r => r.sequence > query.afterSequence).slice(0, query.limit); },
  };
  let data: ProgressSnapshot = {
    jobId: 'job-1', observedAt: '2026-11-07T20:00:00.000Z', status: 'running', statusEvidenceRef: 'job-status-1',
    milestones: [{id: 'm1', milestone: 'running', at: '2026-11-07T19:00:00.000Z', evidenceRef: 'progress-1'}],
    findings: [{id:'f1',status:'confirmed',severity:'high',evidenceRefs:['evidence-1']}],
    blockers: [{id:'b1',kind:'budget',evidenceRef:'blocker-1'}],
    costs: [{id:'c1',source:'naive',microUsd:123456,evidenceRef:'cost-1'}], unknownCosts:true,
  };
  const access = {
    async authenticate() { return subject === null ? null : {subjectId:subject}; },
    async resolveAuthorizedJob(caller: {subjectId:string}, jobId:string) { return authorized ? {subjectId:caller.subjectId,jobId} : null; },
  };
  const service = createProgressChatService({access,conversations,progress:{async read(){reads++; return data;}}});
  return {service,conversations,access,setSubject:(v:string|null)=>{subject=v;},deny:()=>{authorized=false;},reads:()=>reads,
    setData:(v:ProgressSnapshot)=>{data=v;},data};
}
const request = {jobId:'job-1',messageId:'message-1',question:'What is the progress?'};

describe('private progress chat', () => {
  it('authenticates and authorizes every operation, including replay and history', async () => {
    const f = fixture(); await f.service.send(request); f.deny();
    for (const op of [()=>f.service.send(request),()=>f.service.history({jobId:'job-1'}),()=>f.service.poll({jobId:'job-1'})]) {
      await expect(op()).rejects.toMatchObject({code:'not_found'});
    }
    expect(f.reads()).toBe(1);
    f.setSubject(null); await expect(f.service.send(request)).rejects.toMatchObject({code:'unauthenticated'});
  });
  it('isolates private conversations by authenticated user and job', async () => {
    const f = fixture(); await f.service.send(request);
    f.setSubject('bob'); expect((await f.service.history({jobId:'job-1'})).messages).toEqual([]);
    f.setSubject('alice'); expect((await f.service.history({jobId:'job-2'})).messages).toEqual([]);
    expect((await f.service.history({jobId:'job-1'})).messages).toHaveLength(1);
  });
  it('rejects client identity and bounds all entry points', async () => {
    const f=fixture();
    for (const value of [{...request,customerId:'victim'},{...request,question:' '.repeat(20)},{...request,question:'x'.repeat(4001)},{...request,jobId:'../victim'}]) {
      await expect(f.service.send(value)).rejects.toMatchObject({code:'invalid_input'});
    }
    await expect(f.service.history({jobId:'job-1',limit:51})).rejects.toMatchObject({code:'invalid_input'});
    await expect(f.service.poll({jobId:'job-1',cursor:'garbage'})).rejects.toMatchObject({code:'invalid_input'});
    expect(f.reads()).toBe(0);
  });
  it('replays stable replies despite status changes and conflicts on changed input', async () => {
    const f=fixture(); const first=await f.service.send(request);
    f.setData({...f.data,status:'delivered'});
    expect(await f.service.send(request)).toEqual(first); expect(f.reads()).toBe(1);
    await expect(f.service.send({...request,question:'cost?'})).rejects.toMatchObject({code:'conflict'});
    const results=await Promise.all(Array.from({length:10},()=>f.service.send({...request,messageId:'race'})));
    expect(new Set(results.map(r=>r.sequence)).size).toBe(1);
  });
  it('provides bounded history and cursor polling without writing conversations', async () => {
    const f=fixture(); const first=await f.service.poll({jobId:'job-1'});
    expect(first.changed).toBe(true); expect(first.asOf).toBe(f.data.observedAt);
    const same=await f.service.poll({jobId:'job-1',cursor:first.cursor}); expect(same.changed).toBe(false); expect(same.reply).toBeUndefined();
    f.setData({...f.data,status:'investigating'}); expect((await f.service.poll({jobId:'job-1',cursor:first.cursor})).changed).toBe(true);
    expect((await f.service.history({jobId:'job-1'})).messages).toEqual([]);
    await f.service.send(request); await f.service.send({...request,messageId:'m2'});
    const page=await f.service.history({jobId:'job-1',limit:1}); expect(page.messages).toHaveLength(1);
    expect((await f.service.history({jobId:'job-1',afterSequence:page.nextAfterSequence})).messages[0]?.sequence).toBe(2);
  });
  it('rejects wrong job snapshots, unstructured sensitive data and unsafe cost totals', async () => {
    const f=fixture(); f.setData({...f.data,jobId:'victim'});
    await expect(f.service.send(request)).rejects.toMatchObject({code:'invalid_snapshot'});
    f.setData({...f.data,rawPrompt:'password=supersecret'} as ProgressSnapshot);
    await expect(f.service.send(request)).rejects.toMatchObject({code:'invalid_snapshot'});
    f.setData({...f.data,costs:[{...f.data.costs[0]!,microUsd:Number.MAX_SAFE_INTEGER},{...f.data.costs[0]!,id:'c2',microUsd:1}]});
    await expect(f.service.send(request)).rejects.toMatchObject({code:'invalid_snapshot'});
  });
  it('rejects a trusted resolver returning a mismatched identity', async () => {
    const f=fixture(); f.access.resolveAuthorizedJob=async()=>({subjectId:'victim',jobId:'job-1'});
    await expect(f.service.send(request)).rejects.toMatchObject({code:'not_found'});
  });
  it('does not expose raw infrastructure exception bodies', async () => {
    const f=fixture(); f.access.authenticate=async()=>{throw new Error('postgres://secret:password@host');};
    await expect(f.service.send(request)).rejects.toMatchObject({code:'storage_error',message:'Conversation storage is unavailable or invalid.'});
  });
});
it('rejects duplicate projection rows and milestones newer than projection freshness',async()=>{
  const f=fixture();f.setData({...f.data,costs:[f.data.costs[0]!,f.data.costs[0]!]});
  await expect(f.service.send(request)).rejects.toMatchObject({code:'invalid_snapshot'});
  f.setData({...f.data,milestones:[{...f.data.milestones[0]!,at:'2027-01-01T00:00:00Z'}]});
  await expect(f.service.send(request)).rejects.toMatchObject({code:'invalid_snapshot'});
});
it('handles each persisted lifecycle status without inventing a transition',async()=>{
  for(const status of ['draft','needs_clarification','quoted','awaiting_payment','planning','running','investigating','delivered','payment_review','paused_budget','failed','cancelled'] as const){
    const f=fixture();f.setData({...f.data,status});
    const reply=(await f.service.send(request)).reply;
    expect(reply.text).toContain(`Recorded job status: ${status}.`);
    expect(reply.evidenceRefs).toContain('job-status-1');
    expect(reply.unknowns.join(' ')).toContain('ETA');
  }
});
