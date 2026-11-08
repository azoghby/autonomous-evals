import { handleJudgeOwnerRecovery } from '@/server/judge-owner-recovery';
import { judgeOwnerRecoveryDependencies } from '@/server/judge-owner-recovery-production';
export const dynamic='force-dynamic';
export const maxDuration=300;
export async function POST(req:Request,context:{params:Promise<{id:string}>}){
 const {id}=await context.params;
 try{return await handleJudgeOwnerRecovery(req,id,judgeOwnerRecoveryDependencies());}
 catch{return Response.json({error:'Judge recovery unavailable'},{status:503,headers:{'Cache-Control':'private, no-store, max-age=0',Vary:'Cookie','X-Content-Type-Options':'nosniff'}});}
}
