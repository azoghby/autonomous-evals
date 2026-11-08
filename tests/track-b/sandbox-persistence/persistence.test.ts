import {describe,it,expect,vi} from 'vitest';
import {connection,persistence,digest,report,scope} from './helpers';
import {executionDigest} from '../../../packages/core/src/evals/sandbox/execution/runner';

describe('native PostgreSQL authenticated sandbox persistence',()=>{
 it('replays after server restart without callback and retains ambiguous pending',async()=>{
  const c=connection();try{const p=persistence(c.db),effect=vi.fn(async()=>({evidence:'new-effect'}));
   expect(await p.replay.once('restart-complete',digest('restart'),effect)).toEqual({evidence:'retained'});expect(effect).not.toHaveBeenCalled();
   await expect(p.replay.once('restart-pending',digest('pending'),effect)).rejects.toThrow();expect(effect).not.toHaveBeenCalled();
   expect(await p.readPrivateReport('restart-report')).toEqual(report('restart-report'));
  }finally{await c.close();}
 });
 it('permanently claims before effects across independent SQL connections',async()=>{
  const a=connection(),b=connection();let release!:()=>void;let entered!:()=>void;const started=new Promise<void>(r=>{entered=r;});const hold=new Promise<void>(r=>{release=r;});
  try{expect((await a.pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid).not.toBe((await b.pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
   const first=persistence(a.db).replay.once('concurrent',digest('one'),async()=>{entered();await hold;return {value:1};});await started;
   const duplicate=vi.fn(async()=>({value:2}));await expect(persistence(b.db).replay.once('concurrent',digest('one'),duplicate)).rejects.toThrow();expect(duplicate).not.toHaveBeenCalled();release();expect(await first).toEqual({value:1});
   expect(await persistence(b.db).replay.once('concurrent',digest('one'),duplicate)).toEqual({value:1});expect(duplicate).not.toHaveBeenCalled();
  }finally{release?.();await a.close();await b.close();}
 });
 it('rejects changed identity and isolates tenant, job and environment namespaces',async()=>{
  const c=connection();try{const p=persistence(c.db);await p.replay.once('same',digest('original'),async()=>({owner:'original'}));
   const effect=vi.fn(async()=>({owner:'changed'}));await expect(p.replay.once('same',digest('changed'),effect)).rejects.toThrow('conflict');expect(effect).not.toHaveBeenCalled();
   for(const other of [{...scope,tenantId:'tenant-b'},{...scope,jobId:'job-b'},{...scope,environmentId:'env-b'}]){
    expect(await persistence(c.db,{scope:other}).replay.once('same',digest('original'),async()=>({owner:JSON.stringify(other)}))).toEqual({owner:JSON.stringify(other)});
    expect(await persistence(c.db,{scope:other}).readPrivateReport('restart-report')).toBeNull();
   }
  }finally{await c.close();}
 });
 it('immutably upserts report content and enforces execution lookup identity',async()=>{
  const a=connection(),b=connection();try{const r=report('immutable');await Promise.all([persistence(a.db).persistPrivateReport(r),persistence(b.db).persistPrivateReport(r)]);
   expect(await persistence(b.db).readPrivateReport('immutable',r.execution.identityDigest)).toEqual(r);
   await expect(persistence(b.db).readPrivateReport('immutable',digest('changed'))).rejects.toThrow('conflict');
   await expect(persistence(b.db).persistPrivateReport({...r,unresolved:['changed']})).rejects.toThrow('conflict');
   expect(await persistence(a.db).readPrivateReport('immutable')).toEqual(r);
  }finally{await a.close();await b.close();}
 });
 it('reauthorizes completed replay, private read and writes, including effect completion',async()=>{
  const c=connection();try{let allowed=true;const authorize=vi.fn(async()=>allowed),p=persistence(c.db,{authorize});
   await p.replay.once('auth',digest('auth'),async()=>({value:'private'}));await p.persistPrivateReport(report('auth-report'));allowed=false;const effect=vi.fn(async()=>({value:'new'}));
   await expect(p.replay.once('auth',digest('auth'),effect)).rejects.toThrow();await expect(p.readPrivateReport('auth-report')).rejects.toThrow();await expect(p.persistPrivateReport(report('denied-write'))).rejects.toThrow();expect(effect).not.toHaveBeenCalled();
   allowed=true;await expect(p.replay.once('revoked-during-effect',digest('auth'),async()=>{allowed=false;return {value:'blocked'};})).rejects.toThrow();allowed=true;
   await expect(p.replay.once('revoked-during-effect',digest('auth'),effect)).rejects.toThrow();expect(effect).not.toHaveBeenCalled();
  }finally{await c.close();}
 });
 it('screens initial and rotated secrets before storage and completed replay',async()=>{
  const c=connection();try{let secrets=['stored-private-token'];const p=persistence(c.db,{knownSecrets:()=>secrets});
   await expect(p.replay.once('initial-secret',digest('secret'),async()=>({token:'stored-private-token'}))).rejects.toThrow();
   await expect(p.replay.once('initial-secret',digest('secret'),async()=>({safe:true}))).rejects.toThrow();
   await p.replay.once('rotated-secret',digest('rotation'),async()=>({content:'future-private-token'}));
   const r=report('rotated-report');r.execution.transcript=[{role:'assistant',content:'future-private-token'}];await p.persistPrivateReport(r);
   secrets=['future-private-token'];const effect=vi.fn(async()=>({content:'replacement'}));await expect(p.replay.once('rotated-secret',digest('rotation'),effect)).rejects.toThrow();expect(effect).not.toHaveBeenCalled();await expect(p.readPrivateReport('rotated-report')).rejects.toThrow();
   secrets=[];await expect(p.replay.once('initial-secret',digest('secret'),async()=>({safe:true}))).rejects.toThrow();
  }finally{await c.close();}
 });
 it('rejects invalid schema, identity digest, malformed JSON and oversized payloads',async()=>{
  const c=connection();try{const p=persistence(c.db),r=report('schema');
   await expect(p.persistPrivateReport({...r,schema:'incorrect'} as never)).rejects.toThrow();
   await expect(p.persistPrivateReport({...r,execution:{...r.execution,identityDigest:digest('tampered')}})).rejects.toThrow();
   await expect(p.persistPrivateReport({...r,execution:{...r.execution,input:{...r.execution.input,jobId:'other'}}})).rejects.toThrow();
   const wrongEnvironment=report('wrong_environment');wrongEnvironment.execution.input.environment.id='other_environment';wrongEnvironment.execution.input.versions.envHash=executionDigest(wrongEnvironment.execution.input.environment);wrongEnvironment.execution.identityDigest=executionDigest(wrongEnvironment.execution.input);await expect(p.persistPrivateReport(wrongEnvironment)).rejects.toThrow();
   await expect(p.replay.once('undefined',digest('json'),async()=>({value:undefined}))).rejects.toThrow();
   await expect(p.replay.once('nan',digest('json'),async()=>({value:NaN}))).rejects.toThrow();
   await expect(persistence(c.db,{maxPayloadBytes:1024}).replay.once('large',digest('size'),async()=>({value:'x'.repeat(2048)}))).rejects.toThrow();
  }finally{await c.close();}
 });
 it('handles generation pending explicitly with unresolved and conflicting identity',async()=>{
  const c=connection();try{const p=persistence(c.db);expect(await p.bindOperation('generation-1',digest('gen'))).toBe('bound');expect(await persistence(c.db).bindOperation('generation-1',digest('gen'))).toBe('unresolved');expect(await p.bindOperation('generation-1',digest('changed'))).toBe('conflict');}finally{await c.close();}
 });
});

describe('durable envelope integrity and asynchronous authorization',()=>{
 it('retains screening of previously known secrets after supplier rotation',async()=>{
  const c=connection();try{let secrets=['historical-private-token'];const p=persistence(c.db,{knownSecrets:()=>secrets});
   await p.replay.once('prime-secret-history',digest('prime'),async()=>({safe:true}));secrets=[];
   await expect(p.replay.once('old-secret-new-operation',digest('old-secret'),async()=>({content:'historical-private-token'}))).rejects.toThrow();
   const r=report('old-secret-report');r.execution.transcript=[{role:'assistant',content:'historical-private-token'}];await expect(p.persistPrivateReport(r)).rejects.toThrow();
  }finally{await c.close();}
 });
 it('samples rotated current secrets after asynchronous callback completion',async()=>{
  const c=connection();try{let secrets=['before-await-secret'];const p=persistence(c.db,{knownSecrets:()=>secrets});
   await expect(p.replay.once('rotate-during-callback',digest('rotate-during-callback'),async()=>{secrets=['after-await-secret'];return {content:'after-await-secret'};})).rejects.toThrow();
   await expect(p.replay.once('rotate-during-callback',digest('rotate-during-callback'),async()=>({safe:true}))).rejects.toThrow();
  }finally{await c.close();}
 });
 it('rechecks authorization after completed replay and private report SQL reads',async()=>{
  const c=connection();try{const p=persistence(c.db);await p.replay.once('auth-select',digest('auth-select'),async()=>({safe:true}));await p.persistPrivateReport(report('auth-select-report'));
   let allowed=true,arm=false;
   const wrapped={query:async<T>(sql:string,params?:unknown[])=>{const result=await c.db.query<T>(sql,params);if(arm&&/^SELECT \*/.test(sql))allowed=false;return result;},transaction:async<T>(fn:Parameters<typeof c.db.transaction<T>>[0])=>c.db.transaction(async tx=>fn({query:async<R>(sql:string,params?:unknown[])=>{const result=await tx.query<R>(sql,params);if(arm&&/^SELECT \*/.test(sql))allowed=false;return result;}}))};
   const guarded=persistence(wrapped,{authorize:async()=>allowed});arm=true;
   await expect(guarded.readPrivateReport('auth-select-report')).rejects.toThrow();allowed=true;
   const effect=vi.fn(async()=>({safe:false}));await expect(guarded.replay.once('auth-select',digest('auth-select'),effect)).rejects.toThrow();expect(effect).not.toHaveBeenCalled();
  }finally{await c.close();}
 });
});

describe('stored payload tampering',()=>{
 it('rejects changed report bytes under an unchanged exact report digest',async()=>{
  const c=connection();try{const p=persistence(c.db);await p.persistPrivateReport(report('tamper-report'));
   const changed=await c.pool.query("UPDATE text_integration.checkpoints SET value=jsonb_set(value,'{payload,unresolved}','[\"tampered\"]'::jsonb) WHERE kind='sandbox_private_report_v1' AND value->'payload'->'execution'->'input'->>'trialId'='tamper-report' RETURNING id");expect(changed.rows).toHaveLength(1);
   await expect(p.readPrivateReport('tamper-report')).rejects.toThrow();
  }finally{await c.close();}
 });
 it('rejects replay envelope schema and payload digest corruption without redispatch',async()=>{
  const c=connection();try{const p=persistence(c.db);const effect=vi.fn(async()=>({marker:'tamper-replay'}));await p.replay.once('tamper-replay',digest('tamper-replay'),effect);
   const key=(await c.pool.query("SELECT job_id,kind,id FROM text_integration.checkpoints WHERE kind='sandbox_once_v1' AND value->'payload'->>'marker'='tamper-replay'")).rows[0];expect(key).toBeTruthy();
   await c.pool.query("UPDATE text_integration.checkpoints SET value=jsonb_set(value,'{payloadDigest}',to_jsonb($4::text)) WHERE job_id=$1 AND kind=$2 AND id=$3",[key.job_id,key.kind,key.id,digest('wrong')]);
   await expect(p.replay.once('tamper-replay',digest('tamper-replay'),effect)).rejects.toThrow();expect(effect).toHaveBeenCalledTimes(1);
   await c.pool.query("UPDATE text_integration.checkpoints SET value=jsonb_set(value,'{schema}','\"wrong\"'::jsonb) WHERE job_id=$1 AND kind=$2 AND id=$3",[key.job_id,key.kind,key.id]);
   await expect(p.replay.once('tamper-replay',digest('tamper-replay'),effect)).rejects.toThrow();expect(effect).toHaveBeenCalledTimes(1);
  }finally{await c.close();}
 });
});
