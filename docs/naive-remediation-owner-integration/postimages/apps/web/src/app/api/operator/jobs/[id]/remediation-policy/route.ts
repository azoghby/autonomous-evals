import { requireOperator, readJson, isUuid } from '@/server/http';
import { expertOwnerDatabase } from '@/server/automated-expert-owner';
import { RemediationPolicyMutation, mutateNaiveRemediationTrialPolicy, readNaiveRemediationPolicyStatus } from '@/server/naive-remediation-policy';
export const dynamic='force-dynamic';
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'private, no-store','Vary':'Cookie'}});
type Context={params:Promise<{id:string}>};
export async function GET(_request:Request,context:Context){
 const auth=await requireOperator();if(auth.res)return auth.res;
 const {id}=await context.params;if(!isUuid(id))return json({error:'Invalid job'},400);
 try{return json(await readNaiveRemediationPolicyStatus(expertOwnerDatabase(),id.toLowerCase(),auth.viewer.id));}
 catch{return json({error:'Remediation policy unavailable'},409);}
}
export async function POST(request:Request,context:Context){
 const auth=await requireOperator();if(auth.res)return auth.res;
 const {id}=await context.params;if(!isUuid(id))return json({error:'Invalid job'},400);
 if(request.headers.get('origin')!==new URL(request.url).origin||!['same-origin',null].includes(request.headers.get('sec-fetch-site')))return json({error:'Same origin required'},403);
 if(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')return json({error:'JSON required'},415);
 const parsed=await readJson(request,RemediationPolicyMutation,2048);if(!parsed.ok)return parsed.res;
 try{await mutateNaiveRemediationTrialPolicy(expertOwnerDatabase(),id.toLowerCase(),auth.viewer.id,parsed.data);return json({ok:true});}
 catch{return json({error:'Remediation policy unavailable'},409);}
}
