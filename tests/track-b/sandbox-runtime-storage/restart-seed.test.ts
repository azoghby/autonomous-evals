import {it,expect} from 'vitest';
import {connection,storage,publishActual} from './helpers';
it('publishes a full actual SQL image before closing source and restarting native PostgreSQL',async()=>{
 const c=connection();try{const s=storage(c.db),published=await publishActual(s,'native-restart');expect(published.record.imageSize).toBeGreaterThan(1000);expect(published.receipts.diff[0].updated).toBe(8);expect(published.receipts.diff[0].sample.length).toBeLessThanOrEqual(5);}finally{await c.close();}
});
