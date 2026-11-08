import { beforeEach, it, expect } from 'vitest';
import { progressChatForRequest } from '@chat-server';
import { fixtureDatabase } from './fixture-pool';
import { fixtureSession } from './fixture-session';
import { encryptJson, encrypt } from '@ae/core/storage/crypto';
const jobId='11111111-1111-4111-8111-111111111111';
let queries: Array<{sql:string; params?:unknown[]}>;let allowed=true;let known='current-private-credential';let storedText='Safe persisted reply';
beforeEach(()=>{
  queries=[];allowed=true;known='current-private-credential';storedText='Safe persisted reply';
  process.env.DATABASE_URL='postgres://fixture-local-do-not-connect';
  process.env.CREDENTIALS_ENCRYPTION_KEY=Buffer.alloc(32,9).toString('base64');
  fixtureSession.viewer={id:'owner',isOperator:false};
  fixtureDatabase.query=async(sql,params)=>{
    queries.push({sql,params});
    if(sql.includes('FROM jobs')) return {rows: allowed ? [{id:jobId,customer_id:'owner',state:'running',updated_at:'2026-11-07T00:00:00Z'}] : []};
    if(sql.includes('FROM job_credentials'))return {rows:[{ciphertext:encryptJson({target:known})}]};
    if(sql.includes('FROM job_github_targets'))return {rows:[{token_ciphertext:encrypt('github-current-credential')}]};
    if(sql.includes('FROM reporting_chat_exchanges'))return {rows:[{subject_id:'owner',job_id:jobId,message_id:'saved',input_digest:'a'.repeat(64),sequence:'1',reply:{asOf:'2026-11-07T00:00:00Z',topic:'overview',text:storedText,evidenceRefs:[],unknowns:[]}}]};
    return {rows:[]};
  };
});
it('uses session identity and authorization SQL before any secret reads; denies cross-job',async()=>{
  fixtureSession.viewer=null;await expect(progressChatForRequest(jobId)).rejects.toMatchObject({code:'unauthenticated'});expect(queries).toEqual([]);
  fixtureSession.viewer={id:'other-user',isOperator:false};allowed=false;
  await expect(progressChatForRequest(jobId)).rejects.toMatchObject({code:'not_found'});
  expect(queries.some(q=>q.sql.includes('job_credentials'))).toBe(false);
  const check=queries.find(q=>q.sql.includes('FROM jobs'))!;expect(check.params).toEqual([jobId,'other-user',false]);
});
it('reads projection and current encrypted credentials on one repeatable read connection with SELECT-only data',async()=>{
  const service=await progressChatForRequest(jobId);const result=await service.poll({jobId});
  expect(result.reply?.text).toContain('running');
  expect(queries[0].sql).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  expect(queries.filter(q=>/^(INSERT|UPDATE|DELETE)/.test(q.sql))).toEqual([]);
  for(const q of queries.filter(q=>q.sql.startsWith('SELECT')))expect(q.params?.[0]).toBe(jobId);
  expect(queries.some(q=>/trace|intake|report_blob|error/.test(q.sql))).toBe(false);
});
it('screens immutable history using the current decrypted job and GitHub secrets',async()=>{
  storedText='Previously stored '+known;
  await expect((await progressChatForRequest(jobId)).history({jobId})).rejects.toMatchObject({code:'invalid_snapshot'});
  storedText='Previously stored github-current-credential';
  await expect((await progressChatForRequest(jobId)).history({jobId})).rejects.toMatchObject({code:'invalid_snapshot'});
});
it('screens projection/poll under current decrypted policy and rechecks job access after construction',async()=>{
  known='running';await expect(progressChatForRequest(jobId)).rejects.toMatchObject({code:'invalid_snapshot'});
  known='current-private-credential';const service=await progressChatForRequest(jobId);allowed=false;
  await expect(service.poll({jobId})).rejects.toMatchObject({code:'not_found'});
  await expect(service.history({jobId})).rejects.toMatchObject({code:'not_found'});
});
