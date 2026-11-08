import { getCurrentCustomer } from '@/server/queries';
import { getJob,makeServiceContext } from '@/server/job-store';
import { comparisonProduction } from '@/server/comparison-production';
import { comparisonBindingSchema } from '@/server/rich-comparison';
import { isUuid } from '@/server/http';
export const dynamic='force-dynamic';
async function owned(jobId:string) {
 const me=await getCurrentCustomer(); if(!me || !isUuid(jobId)) return null;
 const job=await getJob(jobId);return job?.customerId===me.id?{tenantId:me.id,environment:job.environment}:null;
}
export async function GET(request:Request,context:{params:Promise<{jobId:string}>}) {
 const {jobId}=await context.params;const p=await owned(jobId);if(!p)return Response.json({error:'Not found'},{status:404});
 const runtime=await comparisonProduction(jobId);
 try {
  const op=new URL(request.url).searchParams.get('operationId');
  const body=op?await runtime.app.read(p,jobId,op):await runtime.app.inventory(p,jobId);
  return Response.json(body,{headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
 } catch {return Response.json({error:'Evidence unavailable'},{status:409});}finally{await runtime.dispose();}
}
export async function POST(request:Request,context:{params:Promise<{jobId:string}>}) {
 const {jobId}=await context.params; const p=await owned(jobId);if(!p)return Response.json({error:'Not found'},{status:404});
 const body=await request.json().catch(()=>null) as {operationId?:unknown}|null;
 if(typeof body?.operationId!=='string'|| !/^[A-Za-z0-9_-]{1,64}$/.test(body.operationId))return Response.json({error:'Stable operation ID required'},{status:400});
 const runtime=await comparisonProduction(jobId);
 try {
  const b=comparisonBindingSchema.parse(await runtime.app.inventory(p,jobId));
  const result=await runtime.app.compare(p,await makeServiceContext(jobId),{operationId:`compare:${body.operationId}`,baselineVersion:b.baseline.version,currentVersion:b.current.version,mode:'comparison'});
  return Response.json(result,{headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
 }catch{return Response.json({error:'Comparison requires operator review'},{status:409});}finally{await runtime.dispose();}
}
