it('charges measured investigator cost once through a keyed canonical sink across replay',async()=>{
 const f=await fixture();
 const charges=new Map<string,number>();
 const recordCost=vi.fn(async(cost:{microUsd:number;meta?:Record<string,unknown>})=>{
  const key=String(cost.meta?.idempotencyKey);
  if(charges.has(key))expect(charges.get(key)).toBe(cost.microUsd);
  charges.set(key,cost.microUsd);
 });
 const context={...ctx,recordCost};
 f.runtime.target.mockImplementation(async()=>({send:async()=>({ok:true as const,text:'WRONG',latencyMs:1})}));
 try{
  await f.app.compare(principal,context,request,sub);
  expect(recordCost).toHaveBeenCalledTimes(2);
  expect([...charges.values()]).toEqual([7]);
  expect(recordCost.mock.calls[0]).toEqual([expect.objectContaining({microUsd:7,source:'naive',meta:expect.objectContaining({idempotencyKey:'naive:fixture-session'})})]);
  const rows=await f.sql.query('SELECT micro_usd FROM workflow_comparison.costs');
  expect(rows.rows).toHaveLength(1);
  await f.app.compare(principal,context,request,sub);
  expect(recordCost).toHaveBeenCalledTimes(2);
  expect([...charges.values()]).toEqual([7]);
 }finally{await f.db.close();}
});
it('retains measured cost and fences tick when canonical delivery fails',async()=>{
 const f=await fixture();
 const recordCost=vi.fn(async()=>{throw new Error('synthetic_sink_lost_ack');});
 const context={...ctx,recordCost};
 f.runtime.target.mockImplementation(async()=>({send:async()=>({ok:true as const,text:'WRONG',latencyMs:1})}));
 try{
  await expect(f.app.compare(principal,context,request,sub)).rejects.toThrow();
  expect(recordCost).toHaveBeenCalledTimes(1);
  expect((await f.sql.query('SELECT micro_usd FROM workflow_comparison.costs')).rows).toHaveLength(1);
  await expect(f.app.compare(principal,context,request,sub)).rejects.toThrow('reconciliation');
  expect(recordCost).toHaveBeenCalledTimes(1);
 }finally{await f.db.close();}
});
