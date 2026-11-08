import 'server-only';
import {createHash} from 'node:crypto';
interface LockClient {query(text:string,params?:unknown[]):Promise<{rows:Array<Record<string,unknown>>}>;release(error?:Error):void;on?(event:string,handler:()=>void):unknown;off?(event:string,handler:()=>void):unknown}
export interface SourcingLockPool {connect():Promise<LockClient>;end():Promise<void>}
const unavailable=()=>new Error('expert_sourcing_lock_unavailable');
const lockKey=(identity:string)=>BigInt.asIntN(64,BigInt('0x'+createHash('sha256').update(identity).digest('hex').slice(0,16))).toString();
async function defaultPool():Promise<SourcingLockPool>{
 const url=process.env.DATABASE_URL_UNPOOLED?.trim()||process.env.DATABASE_URL?.trim();
 if(!url||new URL(url).hostname.includes('-pooler'))throw unavailable();
 const {Pool}=await import('@neondatabase/serverless');
 return new Pool({connectionString:url,max:1,connectionTimeoutMillis:10000,query_timeout:10000}) as unknown as SourcingLockPool;
}
/** Session locks span the final authorization check and external dispatch, not an open row transaction.
 * Keys are policy before job, or job alone for customer revocation. Never nest this helper. */
export async function withSourcingLocks<T>(keys:readonly string[],work:(assertHeld:()=>Promise<void>)=>Promise<T>,makePool:()=>Promise<SourcingLockPool>=defaultPool):Promise<T>{
 if(!keys.length||keys.length>2||new Set(keys).size!==keys.length||keys.some(k=>!/^expert-sourcing:(policy|job):[A-Za-z0-9:_-]{1,160}$/.test(k))||keys.length===2&&(!keys[0]!.startsWith('expert-sourcing:policy:')||!keys[1]!.startsWith('expert-sourcing:job:')))throw unavailable();
 const pool=await makePool();let client:LockClient;
 try{client=await pool.connect();}catch{await pool.end().catch(()=>{});throw unavailable();}
 let lost=false;let destroy=false;let pid:unknown;const acquired:string[]=[];
 const onError=()=>{lost=true;};client.on?.('error',onError);
 async function assertHeld(){
  if(lost)throw unavailable();
  try{const row=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0];if(!row||row.pid!==pid)throw unavailable();}
  catch{lost=true;destroy=true;throw unavailable();}
 }
 try{
  for(const key of keys){const id=lockKey(key);const row=(await client.query('SELECT pg_try_advisory_lock($1::bigint) AS ok, pg_backend_pid() AS pid',[id])).rows[0];if(!row?.ok)throw unavailable();if(pid!==undefined&&row.pid!==pid){destroy=true;throw unavailable();}pid=row.pid;acquired.push(id);}
  await assertHeld();return await work(assertHeld);
 }catch(error){if(lost)destroy=true;throw error;}
 finally{
  for(const id of acquired.reverse()){
   try{const row=(await client.query('SELECT pg_advisory_unlock($1::bigint) AS ok',[id])).rows[0];if(row?.ok!==true)destroy=true;}catch{destroy=true;}
  }
  client.off?.('error',onError);client.release(destroy?unavailable():undefined);await pool.end().catch(()=>{});
 }
}
