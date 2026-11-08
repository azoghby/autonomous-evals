it('production runtime executes all24 immutable rubric checks with real SQL reservations and offline Gateway replies',async()=>{
 const {workflowJudgeRuntime}=await import('@/server/rich-judge');
 const previous=process.env.WORKFLOW_JUDGE_PHASE_DISPATCH_LIMITS,priorToken=process.env.AI_GATEWAY_API_KEY;
 process.env.WORKFLOW_JUDGE_PHASE_DISPATCH_LIMITS='{"baseline":24}';
 process.env.AI_GATEWAY_API_KEY='fixture-gateway-key';
 const f=await fixture();try{
  f.policy.privateKeyRef='AI_GATEWAY_API_KEY';
  const runtime=workflowJudgeRuntime();
  const judge=createTrustedJudgeResolver({...f.deps,runtime:{...runtime,fetch:f.fetcher}});
  const suite=verifyAdmittedFrozenSuite(JSON.parse(readFileSync(join(stage,'packages/core/src/evals/text/__tests__/evidence/text-design-v3-2026-11-07.json'),'utf8')).outcome.suite);
  const before=JSON.stringify(suite);
  f.fetcher.mockImplementation(async()=>envelope({outcome:'inconclusive',explanation:'Offline fixture only.',evidenceQuotes:[]}));
  const run=await executeSuite(suite,'production-original24',{target:{send:async()=>({ok:true,text:'The basic plan permits three projects.',latencyMs:1})},judge,evaluateObjective:evaluateObjectiveCheck});
  expect(JSON.stringify(suite)).toBe(before);
  expect(run.executions.flatMap(s=>s.checks).filter(c=>c.kind==='rubric')).toHaveLength(24);
  expect(f.fetcher).toHaveBeenCalledTimes(24);
  expect((await f.sql.query('SELECT * FROM agent_persistence.reservations')).rows).toHaveLength(24);
  await expect(runtime.beforeDispatch({kind:'gateway',operationId:'overflow'})).rejects.toThrow();
 }finally{
  await f.db.close();
  if(previous===undefined)delete process.env.WORKFLOW_JUDGE_PHASE_DISPATCH_LIMITS;else process.env.WORKFLOW_JUDGE_PHASE_DISPATCH_LIMITS=previous;
  if(priorToken===undefined)delete process.env.AI_GATEWAY_API_KEY;else process.env.AI_GATEWAY_API_KEY=priorToken;
 }
},30000);
