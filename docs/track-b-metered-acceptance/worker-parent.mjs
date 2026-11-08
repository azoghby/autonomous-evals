import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {join} from 'node:path';
export function buildAppWorker(stage) {
 const require=createRequire(join(stage,'package.json'));
 const modulePath=join(stage,'acceptance-metered-worker.mjs');
 require('esbuild').buildSync({entryPoints:[fileURLToPath(new URL('./app-phase.ts',import.meta.url))],outfile:modulePath,
  bundle:true,platform:'node',format:'esm',packages:'external',alias:{'@ae/core':join(stage,'packages/core/src'),'@':join(stage,'apps/web/src'),'server-only':join(stage,'empty.ts')}});
 return modulePath;
}
// Internal mechanical port, not a release driver. Caller owns preflight and the
// reviewed compiled module. Child results remain unaccepted application facts.
export function runMeteredWorker({modulePath,input,meter}) {
 meter.signal.throwIfAborted();
 return new Promise((resolve,reject)=>{
  const child=fork(fileURLToPath(new URL('./worker.mjs',import.meta.url)),[],{stdio:['ignore','ignore','ignore','ipc']});
  let value,failed=false;
  let killTimer;
  const abort=()=>{if(failed)return;failed=true;if(child.connected)child.send({type:'abort'});killTimer=setTimeout(()=>child.kill('SIGKILL'),1000);killTimer.unref();reject(Error('worker_aborted'));};
  meter.signal.addEventListener('abort',abort,{once:true});
  child.on('message',async message=>{
   if(message.type==='dispatch')try{await meter.beforeDispatch(message.intent);meter.signal.throwIfAborted();if(child.connected)child.send({type:'ack',id:message.id});}catch{abort();}
   if(message.type==='result')value=message.value;
   if(message.type==='failure'){failed=true;reject(Error('app_worker_failed'));}
  });
  child.on('error',reject);
  child.on('exit',code=>{clearTimeout(killTimer);meter.signal.removeEventListener('abort',abort);if(!failed&&code===0&&value!==undefined)resolve(value);else reject(Error('app_worker_failed'));});
  child.send({type:'start',modulePath,input});
 });
}
