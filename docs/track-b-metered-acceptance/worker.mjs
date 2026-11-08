import {pathToFileURL} from 'node:url';
// Internal fork only, never a public listener. The parent must run preflight.
const controller=new AbortController(),pending=new Map();let ordinal=0;
process.on('disconnect',()=>{controller.abort();for(const {reject} of pending.values())reject(Error('parent_disconnected'));pending.clear();});
process.on('message',message=>{
 if(message.type==='abort') {controller.abort();for(const {reject} of pending.values())reject(Error('parent_aborted'));pending.clear();}
 if(message.type==='ack') {const p=pending.get(message.id);if(p){pending.delete(message.id);p.resolve();}}
});
process.once('message',async message=>{
 if(message.type!=='start')return;
 const beforeDispatch=intent=>new Promise((resolve,reject)=>{
   controller.signal.throwIfAborted();const id=++ordinal;pending.set(id,{resolve,reject});
   process.send({type:'dispatch',id,intent},e=>{if(e){pending.delete(id);reject(e);}});
 });
 try {
   const module=await import(pathToFileURL(message.modulePath));
   const value=await module.executeAppPhase(message.input,{signal:controller.signal,beforeDispatch});
   process.send({type:'result',value},()=>process.exit(0));
 }catch{process.send({type:'failure'},()=>process.exit(1));}
});
