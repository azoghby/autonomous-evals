import { requireCronAuth } from '../_auth';
import { workflowSql } from '@/server/rich-services';
import { comparisonProduction } from '@/server/comparison-production';
import { makeServiceContext } from '@/server/job-store';
import { comparisonBindingSchema } from '@/server/rich-comparison';
export const dynamic='force-dynamic';
export const maxDuration=300;
export async function GET(request:Request) {
 const denied=requireCronAuth(request); if(denied) return denied;
 const environment=process.env.STRIPE_MODE==='live'?'live':'test';
 const sql=workflowSql(); const day=new Date().toISOString().slice(0,10);
 const subs=await sql.query<{id:string;job_id:string;customer_id:string;binding:unknown}>(`SELECT s.id,s.job_id,s.customer_id,b.binding FROM monitoring_subscriptions s JOIN workflow_comparison.bindings b ON b.job_id=s.job_id WHERE s.status='active' AND s.environment=$1`,[environment]);
 const result=[];
 for(const s of subs.rows) {
  let runtime:Awaited<ReturnType<typeof comparisonProduction>>|undefined;
  try {
   const b=comparisonBindingSchema.parse(s.binding); runtime=await comparisonProduction(s.job_id);
   await runtime.app.compare({tenantId:s.customer_id,environment},await makeServiceContext(s.job_id),{operationId:`monitor:${s.id}:${day}`,baselineVersion:b.baseline.version,currentVersion:b.current.version,mode:'monitoring'},s.id);
   result.push({subscriptionId:s.id,status:'retained',notifications:'draft_only'});
  } catch { result.push({subscriptionId:s.id,status:'needs_operator',notifications:'draft_only'}); }
  finally {await runtime?.dispose();}
 }
 return Response.json({result,sent:0});
}
