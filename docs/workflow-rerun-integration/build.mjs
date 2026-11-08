import { readFileSync,writeFileSync,mkdirSync,copyFileSync } from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {stagePinnedFinal,finalCommit} from './upstream.mjs';
const here=dirname(fileURLToPath(import.meta.url)),root=resolve(here,'../..');
export async function stageRerun(){
 const result=await stagePinnedFinal(),stage=result.stage;
 const paths=['apps/web/src/server/rich-services.ts','apps/web/src/server/job-actions.ts','apps/web/src/server/mcp-tools.ts','apps/web/src/app/api/jobs/[jobId]/findings/[findingId]/rerun/route.ts','apps/web/src/server/rich-rerun.ts','apps/web/migrations/006-workflow-finding-reruns.sql'];
 const before=new Map(paths.map(p=>{try{return [p,readFileSync(join(stage,p),'utf8')]}catch{return[p,null]}}));
 let s=before.get(paths[0]);
 s=s.replace('authority: { workflowRunId: string }','authority: { workflowRunId: string; rerun?: { ownerId: string; targetVersion: string } }');
 s=s.replace("|| !['planning', 'running', 'investigating'].includes(loaded.job.state)","|| !(authority.rerun ? loaded.job.state === 'delivered' && loaded.job.customerId === authority.rerun.ownerId : ['planning', 'running', 'investigating'].includes(loaded.job.state))");
 s=s.replace("const targetVersion = createHash", "if (authority.rerun && !credentials.rows[0]?.ciphertext) return refused();\n    const targetVersion = createHash");
 s=s.replace('return { ...loaded, row:', 'if (authority.rerun && targetVersion !== authority.rerun.targetVersion) return refused();\n    return { ...loaded, row:');
 s=s.replace('const a = await canonical();\n    if (a.job.package !== \'text_eval\') return refused();\n    await text.reportInput',"const a = await canonical();\n    if (authority.rerun || a.job.package !== 'text_eval') return refused();\n    await text.reportInput");
 // A caller must supply original branch; the resolver never creates one and checks its ledger ownership.
 s=s.replace('target: createTextTarget(a.intake.endpoint)', `target: { async send(input) { const fresh=await canonical(); if(fresh.targetVersion!==a.targetVersion) return refused(); return createTextTarget(fresh.intake.endpoint).send(input); } }`);
 s=s.replace('targetForScenario: () => platformTarget(a.intake.endpoint)', `targetForScenario: () => ({ async complete(messages) { const fresh=await canonical(); const currentBranch=await ledger.findOwnedBranch(a.row.neonBranchId!); if(fresh.targetVersion!==a.targetVersion || fresh.row.neonBranchId!==a.row.neonBranchId || currentBranch?.jobId!==ctx.jobId || currentBranch.state!=='ready') return refused(); return platformTarget(fresh.intake.endpoint).complete(messages); } })`);
 writeFileSync(join(stage,paths[0]),s);
 s=before.get(paths[1]);
 s=s.slice(0,s.indexOf('/** Shared by the rerun route'))+`/** Both authenticated transports use the same durable rich service. */
export async function rerunFindingForJob(data: JobData, findingId: string, key?: string, ownerId?: string): Promise<ActionResult<unknown>> {
 if (!key || !ownerId) return {ok:false,status:400,error:'Idempotency-Key and authenticated owner required'};
 try { const {rerunRichFinding,RerunRefusal}=await import('./rich-rerun');
  try { return {ok:true,value:await rerunRichFinding({jobId:data.job.id,findingId,key,ownerId})}; }
  catch(error){ if(error instanceof RerunRefusal) return {ok:false,status:error.status,error:error.message}; throw error; }
 } catch { return {ok:false,status:409,error:'Re-run unavailable; operator reconciliation required'}; }
}
`;
 s=s.replace('import { and, count, eq } from "drizzle-orm";\n','').replace('import { db, schema } from "@ae/core/db/client";\n','').replace('import { Finding, Suite, type Scenario } from "@ae/core/contracts/index";\n','').replace('import { readJobArtifactText } from "@ae/core/storage/blob";\n','').replace('import { isUuid } from "./http";\n','').replace('import { addMessage, getJob, makeServiceContext, saveFindings }','import { addMessage }').replace('import { getEvalServices } from "./services";\n','').replace('const MAX_RERUNS_PER_FINDING = 3;\n','');
 writeFileSync(join(stage,paths[1]),s);
 s=before.get(paths[2]).replace('jobId: string, findingId: string): Promise<McpToolResult>', 'jobId: string, findingId: string, idempotencyKey?: string): Promise<McpToolResult>').replace('rerunFindingForJob(data, findingId)','rerunFindingForJob(data, findingId, idempotencyKey, c.customerId)').replace('ok(r.value as Record<string, unknown>)','ok(r.value as Record<string, unknown>)');
 s=s.replace('howToRerun:', `reruns: await (await import('./rich-rerun')).readRichRerunsForOwner(jobId,c.customerId),\n    howToRerun:`);
 s=s.replace('findingId: z.uuid().describe', 'idempotencyKey: z.string().regex(/^[A-Za-z0-9_.:-]{8,128}$/).optional(), findingId: z.uuid().describe');
 s=s.replace('i: { jobId: string; findingId: string }) => rerunFinding(c, i.jobId, i.findingId)', 'i: { jobId: string; findingId: string; idempotencyKey?: string }) => rerunFinding(c, i.jobId, i.findingId, i.idempotencyKey)');
 s=s.replace('Re-run one finding against the frozen scenario', 'Requires idempotencyKey; retries must reuse it. Reruns the original full frozen12 for the finding');
 writeFileSync(join(stage,paths[2]),s);
 s=before.get(paths[3]).replace('POST(_req:', 'POST(req:').replace('rerunFindingForJob(data, findingId)','rerunFindingForJob(data, findingId, req.headers.get("Idempotency-Key") ?? undefined, me.id)').replace('{ status: 201 }','{ status: (r.value as {state:string}).state === "completed" ? 200 : 202 }');
 s+=`
/** Separate private appendices; original report and finding rows remain immutable. */
export async function GET(_req: Request, ctx: { params: Promise<{jobId:string;findingId:string}> }) {
 const me=await getCurrentCustomer(); if(!me) return jsonError(401,'Authentication required');
 const {jobId,findingId}=await ctx.params; const data=await getJobForViewer(jobId,me);
 if(!data || data.job.customerId!==me.id) return jsonError(404,'Job not found');
 const {readRichRerunsForOwner}=await import('@/server/rich-rerun');
 return Response.json({reruns:await readRichRerunsForOwner(jobId,me.id,findingId)});
}
`;
 writeFileSync(join(stage,paths[3]),s);
 for(const p of paths.slice(4)){mkdirSync(dirname(join(stage,p)),{recursive:true});copyFileSync(join(here,'source',p),join(stage,p));}
 return {...result,rerunPaths:paths,before};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const r=await stageRerun();let patch='';const pins={};
 for(const p of r.rerunPaths){const old=r.before.get(p),body=readFileSync(join(r.stage,p),'utf8');pins[p]=old===null?null:createHash('sha256').update(old).digest('hex');
 if(old!==null){const a=join(r.stage,'old.tmp'),b=join(r.stage,'new.tmp');writeFileSync(a,old);writeFileSync(b,body);let diff;try{diff=execFileSync('diff',['-u',a,b],{encoding:'utf8'})}catch(e){diff=e.stdout}patch+=`diff --git a/${p} b/${p}\n`+diff.replace(/^--- .*\n\+\+\+ .*\n/,`--- a/${p}\n+++ b/${p}\n`);}
 else patch+=`diff --git a/${p} b/${p}\nnew file mode 100644\n--- /dev/null\n+++ b/${p}\n@@ -0,0 +1,${body.trimEnd().split('\n').length} @@\n`+body.trimEnd().split('\n').map(l=>'+'+l).join('\n')+'\n';
 mkdirSync(dirname(join(here,'source',p)),{recursive:true});writeFileSync(join(here,'source',p),body);
 }
 writeFileSync(join(here,'rerun.patch'),patch);writeFileSync(join(here,'SERIES.json'),JSON.stringify({parent:'01cd322b18dbfd5067323fba051c633d55151574',predecessor:finalCommit,predecessorArtifact:'docs/track-b-final-composition/INTEGRITY.json',core:r.pins.trackB,preimageSha256:pins,patchSha256:createHash('sha256').update(patch).digest('hex')},null,2)+'\n');
 console.log(r.stage);
}
