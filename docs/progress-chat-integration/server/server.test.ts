import { describe, it, expect, vi } from 'vitest';
import { mapSnapshot, pinned } from '@chat-server';
const id = '11111111-1111-4111-8111-111111111111';
const job = { id, customer_id: 'owner', state: 'running', updated_at: '2026-11-07T00:00:00Z' };
const key = Buffer.alloc(32, 7);
describe('persisted projection', () => {
  it('maps running and delivered status without fabricated completion or costs', () => {
    const running = mapSnapshot(job, [], [], [], key, 'owner');
    expect(running.status).toBe('running'); expect(running.unknownCosts).toBe(true);
    expect(running.costs).toEqual([]); expect(running.findings).toEqual([]);
    expect(mapSnapshot({...job,state:'delivered'},[],[],[],key,'owner').status).toBe('delivered');
  });
  it('binds opaque evidence to user and job; drops raw prose and uses persisted times', () => {
    const progress = [{id:'event-id',milestone:'trace_review',created_at:'2026-11-07T01:00:00Z',message:'raw trace secret'}];
    const one = mapSnapshot(job,progress,[{id:'f',status:'confirmed',severity:'high',created_at:job.updated_at}],
      [{id:'cost',source:'naive',micro_usd:'123',created_at:job.updated_at}],key,'owner');
    expect(one.observedAt).toBe('2026-11-07T01:00:00.000Z');
    expect(one.milestones[0].milestone).toBe('other'); expect(one.costs[0].microUsd).toBe(123);
    expect(JSON.stringify(one)).not.toContain('raw trace'); expect(JSON.stringify(one)).not.toContain('event-id');
    expect(one.statusEvidenceRef).not.toBe(mapSnapshot(job,[],[],[],key,'operator').statusEvidenceRef);
    expect(one.statusEvidenceRef).not.toBe(mapSnapshot({...job,id:'22222222-2222-4222-8222-222222222222'},[],[],[],key,'owner').statusEvidenceRef);
  });
  it('fails closed for invalid enums, precision overflow, excessive rows and negative cost', () => {
    expect(()=>mapSnapshot({...job,state:'complete'},[],[],[],key,'owner')).toThrow();
    for (const micro_usd of ['9007199254740992','-1']) expect(()=>mapSnapshot(job,[],[],[{id:'x',source:'naive',micro_usd,created_at:job.updated_at}],key,'owner')).toThrow();
    expect(()=>mapSnapshot(job,Array(201).fill({id:'x',milestone:'other',created_at:job.updated_at}),[],[],key,'owner')).toThrow();
  });
});
describe('pinned database boundary', () => {
  it.each([true,false])('commits once and releases; readOnly=%s', async readOnly => {
    const query = vi.fn(async()=>({rows:[]})); const release=vi.fn(); const client={query,release};
    const result=await pinned({connect:async()=>client} as never,readOnly,async tx=>{await tx.query('SELECT safe');return 3;});
    expect(result).toBe(3); expect(query.mock.calls[0][0]).toContain(readOnly?'REPEATABLE READ READ ONLY':'READ COMMITTED');
    expect(query.mock.calls.at(-1)?.[0]).toBe('COMMIT'); expect(release).toHaveBeenCalledOnce();
  });
  it('rolls back and releases without retrying failing callbacks', async()=>{
    const query=vi.fn(async()=>({rows:[]})); const release=vi.fn(); const run=vi.fn(async()=>{throw new Error('private database detail');});
    await expect(pinned({connect:async()=>({query,release})} as never,true,run)).rejects.toThrow();
    expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK'); expect(run).toHaveBeenCalledOnce(); expect(release).toHaveBeenCalledOnce();
  });
});
