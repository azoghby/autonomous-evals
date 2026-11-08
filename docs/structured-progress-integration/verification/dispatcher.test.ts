import {beforeEach,it,expect} from 'vitest';
import {progressChatForRequest} from '@dispatcher';
import {fixtureDatabase} from './fixture-pool';
import {fixtureSession} from './fixture-session';
const jobId='11111111-1111-4111-8111-111111111111';const time='2026-11-07T10:00:00.000Z';
let allowed:boolean,queries:Array<{sql:string,params?:unknown[]}>,watermark:string;
beforeEach(()=>{allowed=true;queries=[];watermark=time;fixtureSession.viewer={id:'owner',isOperator:false};process.env.DATABASE_URL='postgres://fixture-never-connect';process.env.CREDENTIALS_ENCRYPTION_KEY=Buffer.alloc(32,9).toString('base64');
 fixtureDatabase.query=async(sql,params)=>{queries.push({sql,params});
  if(sql.includes('SELECT package, environment'))return {rows:[{package:'text_eval',environment:'test'}]};
  if(sql.includes('FROM jobs'))return {rows:allowed?[{id:jobId,customer_id:'owner',state:'running',updated_at:time}]:[]};
  if(sql.includes('structured_progress.inventory'))return {rows:[{tenant_id:'owner',job_id:jobId,environment:'test',revision:1,observed_at:watermark,plan:{checkpoints:[{key:{jobId,kind:'design',id:'suite',inputDigest:'a'.repeat(64)},phase:'planning',format:'text_design'}],acquisitionTaskIds:[]}}]};
  if(sql.includes('FROM text_integration.checkpoints'))return {rows:[{input_digest:'a'.repeat(64),state:'completed',value:{status:'blocked',reason:'PRIVATE CONTENT'},token:'private'}]};
  if(sql.includes('FROM costs'))return {rows:[{id:'private-ledger',source:'ai_gateway',micro_usd:'37',created_at:time}]};
  return {rows:[]};
 };
});
it('actual request dispatcher composes structured checkpoints and complete app costs on one read boundary',async()=>{
 const reply=await(await progressChatForRequest(jobId)).poll({jobId});expect(reply.reply?.asOf).toBe(time);expect(reply.reply?.text).toContain('running');expect(reply.reply?.text).toContain('USD 0.000037 across 1 cost record(s)');expect(reply.reply?.text).toContain('Additional costs are explicitly marked unknown.');expect(reply.reply?.unknowns.join(' ')).toContain('cost');expect(JSON.stringify(reply)).not.toContain('PRIVATE');
 expect(queries.filter(q=>q.sql.includes('FROM text_integration.checkpoints'))).toHaveLength(1);
 expect(queries.filter(q=>q.sql.startsWith('BEGIN'))).toEqual([{sql:'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',params:undefined}]);
 expect(queries.some(q=>/^(INSERT|UPDATE|DELETE)/.test(q.sql))).toBe(false);
 expect(queries.find(q=>q.sql.includes('FROM costs'))?.params).toEqual([jobId]);
});
it('actual dispatcher rejects unauthorized caller before credential and inventory reads',async()=>{
 fixtureSession.viewer={id:'other',isOperator:false};allowed=false;await expect(progressChatForRequest(jobId)).rejects.toMatchObject({code:'not_found'});
 expect(queries.some(q=>q.sql.includes('job_credentials')||q.sql.includes('structured_progress.inventory'))).toBe(false);
 const auth=queries.find(q=>q.sql.includes('FROM jobs'));expect(auth?.params).toEqual([jobId,'other',false]);
});
it('actual dispatcher rejects included cost/job rows newer than stored inventory watermark',async()=>{
 watermark='2026-11-07T09:00:00.000Z';await expect(progressChatForRequest(jobId)).rejects.toMatchObject({code:'invalid_snapshot'});
});
