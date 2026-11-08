import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {reviewDigest} from '@ae/core/evals/data/binding';
import {issueSourcingPolicy,issueSourcingConsent} from './expert-sourcing-store';
import {installDerivedSourcingAuthority} from './expert-sourcing-bridge';
import type {FactualGapPlanRequest,FactualGapProductionInput} from './expert-data-plan';
import type {withSourcingLocks} from './expert-sourcing-locks';
export const fakeSourcingLocks:typeof withSourcingLocks=async(_keys,work)=>work(async()=>{});
export async function createSourcingSchema(pg:PGlite){await pg.exec(readFileSync('docs/naive-sourcing-authority-integration/sql/001-expert-sourcing-authority.sql','utf8'));}
export async function configureSourcing(pg:PGlite,request:FactualGapPlanRequest,input:FactualGapProductionInput,decryptCredentials?:(s:string)=>Record<string,string>){
 const sql={query:<T>(q:string,p?:unknown[])=>pg.query<T>(q,p)},tenant=input.factualGapEntry.tenantId,topic='Product support';
 const policy=await issueSourcingPolicy(sql,{tenantId:tenant,environment:'test',topic,capsPolicyId:'pilot',maxRequirements:36,maxContextChars:16000,grantLifetimeSeconds:3600,expiresAt:'2099-01-01T00:00:00Z'},async()=>({operatorId:'operator'}));
 await issueSourcingConsent(sql,{jobId:request.jobId,topic,canonicalInputDigest:request.canonicalInputDigest,accepted:true,expiresAt:'2099-01-01T00:00:00Z'},async()=>({customerId:tenant}),async()=>({tenantId:tenant,environment:'test',canonicalInputDigest:request.canonicalInputDigest}));
 const identity={jobId:request.jobId,customerId:tenant,environment:'test'},profile={policyId:'generic-text-factual-gap-v1',designId:'generic-text-factual-gap-v1',versionLabel:request.versionLabel,admissionPolicyId:'automated-text-design-factual-gap-v1',factualGapPolicy:'propose_missing_reference.v1',expertTaskId:request.taskId};
 for(const [kind,id,value] of [['naive_execution_policy','selection-v1',{schemaVersion:'naive_text_execution_selection.v1',identity,profile}],['naive_factual_gap_proposal','proposal-v1',{schemaVersion:'naive_factual_gap_retention.v1',identity,profile,canonicalInputDigest:request.canonicalInputDigest,targetDigest:input.factualGapEntry.targetDigest,proposal:request.proposal}]] as const)await pg.query("INSERT INTO text_integration.checkpoints(job_id,kind,id,state,input_digest,value,token) VALUES($1,$2,$3,'completed',$4,$5::jsonb,'fixture-token')",[request.jobId,kind,id,reviewDigest(value),JSON.stringify(value)]);
 await pg.transaction(tx=>installDerivedSourcingAuthority({query:(q,p)=>tx.query(q,p)},{request,input,targetDigest:input.factualGapEntry.targetDigest},{expectedPolicyId:policy.id,decryptCredentials}));
}
