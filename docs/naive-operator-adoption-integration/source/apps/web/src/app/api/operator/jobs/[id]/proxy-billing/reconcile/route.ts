import { handleProxyBillingRecovery } from '@/server/naive-proxy-recovery';
export const dynamic='force-dynamic';
export const maxDuration=300;
/** Reads retained provider audit only; no evaluation, send, or inference dispatch. */
export async function POST(req:Request,context:{params:Promise<{id:string}>}) {
 const {id}=await context.params;
 return handleProxyBillingRecovery(req,id);
}
