import {it,expect} from 'vitest';
import {connection,persistence,digest,report} from './helpers';
it('commits replay, private report and failed claim before native PostgreSQL restart',async()=>{
 const c=connection();try{
 const p=persistence(c.db);
 expect(await p.replay.once('restart-complete',digest('restart'),async()=>({evidence:'retained'}))).toEqual({evidence:'retained'});
 await p.persistPrivateReport(report('restart-report'));
 await expect(p.replay.once('restart-pending',digest('pending'),async()=>{throw new Error('effect acknowledgement lost');})).rejects.toThrow();
 }finally{await c.close();}
});
