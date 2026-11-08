import { z } from 'zod';
import { jsonError,readJson,isUuid } from '@/server/http';
import { getCurrentCustomer } from '@/server/queries';
import { requestJobCancellation } from '@/server/job-cancellation';
import { dispatchJobCancellation } from '@/server/job-cancellation-delivery';
export const dynamic='force-dynamic';
const Body=z.object({reason:z.string().trim().max(1000).optional()});
/** Acknowledgement means the cancellation fence/outbox is durable, not that external cleanup finished. */
export async function POST(request:Request,ctx:{params:Promise<{jobId:string}>}){
 const me=await getCurrentCustomer();if(!me)return jsonError(401,'Authentication required');
 const {jobId}=await ctx.params;if(!isUuid(jobId))return jsonError(404,'Job not found');
 const body=await readJson(request,Body);if(!body.ok)return body.res;
 const result=await requestJobCancellation(jobId,{id:me.id},body.data.reason);
 if(!result.ok)return jsonError(result.status,result.error,result.state?{state:result.state}:undefined);
 let pending=false;
 try{pending=(await dispatchJobCancellation(jobId)).errors.length>0;}catch{pending=true;}
 return Response.json({ok:true,notificationPending:pending},{status:202});
}
