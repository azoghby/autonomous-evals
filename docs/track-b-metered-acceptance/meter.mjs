import { openSync, closeSync, fsyncSync, writeSync, readFileSync, mkdirSync, rmdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Local owner/worker IPC ledger. One exclusive lock; contention/crash fails closed.
// Never remove a stale lock automatically. Hosted multi-machine use requires a
// transactional shared store with the same contract; this is not that attestation.
export function durableMeter(path, limits, { signal, now = Date.now } = {}) {
  const kinds = ['target','gateway','naive','cloudMutation'];
  for (const k of [...kinds,'maxElapsedMs']) if (!Number.isSafeInteger(limits[k]) || limits[k] < 0) throw Error('invalid_limits');
  const frozen = Object.fromEntries([...kinds,'maxElapsedMs'].map(k=>[k,limits[k]]));
  const lock = path+'.lock';
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal,controller.signal]) : controller.signal;
  const locked = fn => { mkdirSync(lock); try { return fn(); } finally { rmdirSync(lock); } };
  function append(row) {
    const fd=openSync(path,'a',0o600);
    try { const data=Buffer.from(JSON.stringify(row)+'\n'); let pos=0; while(pos<data.length) pos+=writeSync(fd,data,pos,data.length-pos); fsyncSync(fd); }
    finally { closeSync(fd); }
  }
  locked(()=>{
    try { readFileSync(path); } catch(e) {
      if(e.code!=='ENOENT') throw e;
      append({type:'header',limits:frozen,startedAt:now()});
      const fd=openSync(dirname(path),'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
    }
  });
  function load() {
    const raw=readFileSync(path,'utf8'); if(!raw.endsWith('\n')) throw Error('ambiguous_meter_log');
    const [header,...rows]=raw.trimEnd().split('\n').map(s=>JSON.parse(s));
    if(header.type!=='header'||JSON.stringify(header.limits)!==JSON.stringify(frozen)||!Number.isSafeInteger(header.startedAt)) throw Error('meter_authority_changed');
    const counts=Object.fromEntries(kinds.map(k=>[k,0])), ids=new Set();
    for(const r of rows) { if(r.type!=='attempt'||!kinds.includes(r.kind)||typeof r.operationId!=='string'||ids.has(r.operationId)) throw Error('invalid_meter_log'); ids.add(r.operationId); counts[r.kind]++; }
    return {header,counts,ids};
  }
  // The deadline also cancels requests already in flight, not just the next ACK.
  const remaining=Math.max(0,load().header.startedAt+frozen.maxElapsedMs-now());
  const timer=setTimeout(()=>controller.abort(),remaining);timer.unref();
  // No replay ACK: an uncertain acknowledged attempt retains capacity forever.
  async function beforeDispatch(intent) {
    try {
      combined.throwIfAborted();
      locked(()=>{
        const {header,counts,ids}=load();
        if(!kinds.includes(intent.kind)||!/^[-A-Za-z0-9:_.]{1,256}$/.test(intent.operationId)) throw Error('invalid_dispatch_intent');
        if(ids.has(intent.operationId)) throw Error('dispatch_already_reserved');
        if(now()<header.startedAt||now()-header.startedAt>=frozen.maxElapsedMs||counts[intent.kind]>=frozen[intent.kind]) throw Error('dispatch_cap_or_deadline');
        combined.throwIfAborted(); append({type:'attempt',kind:intent.kind,operationId:intent.operationId});
      });
      combined.throwIfAborted();
    } catch(e) { controller.abort(); throw e; }
  }
  return { beforeDispatch, signal:combined, snapshot:()=>locked(()=>{const {counts,header}=load();return {counts,startedAt:header.startedAt};}) };
}
