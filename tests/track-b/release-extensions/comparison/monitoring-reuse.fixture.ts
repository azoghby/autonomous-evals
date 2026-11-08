// Appended to the historical offline fixture declarations, without changing any original assertion.
describe('combined approved-suite monitoring seam',()=>{
 it('reuses the reviewed frozen baseline suite without suite/design checkpoints and preserves rich outcomes',async()=>{
  const f=await fixture();try{
   expect((await f.sql.query("SELECT kind FROM text_integration.checkpoints")).rows).toEqual([]);
   const before=await f.sql.query<{suite:unknown;retained:unknown}>('SELECT suite,retained FROM workflow_comparison.bindings WHERE job_id=$1',[suite.jobId]);
   expect(before.rows[0].suite).toEqual(suite);
   const result:any=await f.app.compare(principal,ctx,request,sub);
   expect(result.baseline.artifact).toEqual(before.rows[0].retained);
   expect(result.current.artifact.suite).toEqual(before.rows[0].suite);
   expect(result.current.artifact.run.suiteDigest).toBe(suite.digest);
   expect(result.current.artifact.run.executions).toHaveLength(12);
   for(const execution of result.current.artifact.run.executions){
    expect(execution.checks).toEqual(expect.arrayContaining([expect.objectContaining({kind:'objective',status:'pass'}),expect.objectContaining({kind:'rubric',status:'not_assessed'})]));
   }
   expect((await f.sql.query("SELECT kind FROM text_integration.checkpoints WHERE kind IN ('suite','design')")).rows).toEqual([]);
   expect(f.calls()).toBe(12);
   const second:any=await f.app.compare(principal,ctx,{...request,operationId:'monitor:day:2026-11-08'},sub);
   expect(second.baseline.artifact).toEqual(result.baseline.artifact);
   expect(second.current.artifact.suite).toEqual(suite);expect(f.calls()).toBe(24);
   expect((await f.sql.query('SELECT suite,retained FROM workflow_comparison.bindings WHERE job_id=$1',[suite.jobId])).rows).toEqual(before.rows);
  }finally{await f.db.close();}
 });
});
