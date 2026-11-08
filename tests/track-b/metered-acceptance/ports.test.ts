import {it,expect,vi} from 'vitest';
import {z} from 'zod';
import { acceptancePorts } from '@/server/acceptance-runtime';
import { workflowJudgeRuntime } from '@/server/rich-judge';
import {createTextTarget} from '@ae/core/targets/text';
import {createRemediationTarget} from '@ae/core/targets/remediation';
import {AgentSessionService} from '@ae/core/agents/session-service';
import {harness,fixtureJob} from '@ae/core/agents/__tests__/fakes';
import {durableMeter} from '../../../docs/track-b-metered-acceptance/meter.mjs';
import {APPROVED} from '../../../docs/track-b-metered-acceptance/plan.mjs';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

it('actual production default runtime admits16 of24 rubric attempts; acceptance does not enlarge it',async()=>{
 const base=workflowJudgeRuntime(),meter=vi.fn(async()=>{});
 const runtime=acceptancePorts({signal:new AbortController().signal,beforeDispatch:meter}).judge(base);
 const results=await Promise.allSettled(Array.from({length:24},(_,i)=>runtime.beforeDispatch({kind:'gateway',operationId:`rubric:${i}`})));
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(16);expect(meter).toHaveBeenCalledTimes(16);
});
it('real Text adapter posts cap512 only after durable meter and denies further sends',async()=>{
 const meter=durableMeter(join(mkdtempSync(join(tmpdir(),'ports-')),'ledger'),{...APPROVED,target:1});
 const post=vi.fn(async(_url,body:any)=>{expect(meter.snapshot().counts.target).toBe(1);expect(body.max_completion_tokens).toBe(512);return {choices:[{message:{role:'assistant',content:'READY'},finish_reason:'stop'}]};});
 const target=createTextTarget({url:'https://fixture.invalid/chat/completions',model:'fixture',maxCompletionTokens:512},acceptancePorts(meter).target({post}));
 const req={scenarioId:'S01',runId:'baseline',systemPrompt:'fixture',userMessage:'question'};
 expect((await target.send(req)).ok).toBe(true);expect((await target.send(req)).ok).toBe(false);expect(post).toHaveBeenCalledOnce();
});
it('actual session service meters create and get and preserves task/session/cost replay',async()=>{
 const h=harness(()=>({structuredOutput:{answer:'fixture'}}));
 const intents:any[]=[];
 const ports=acceptancePorts({signal:new AbortController().signal,beforeDispatch:async i=>{intents.push(i);}});
 const service=new AgentSessionService({...h.deps,naive:ports.sessions(h.naive)});
 const spec={job:fixtureJob(),role:'evaluation_engineer' as const,purpose:'proposal_fixture',message:'Return a fixture answer.',output:{name:'fixture',schema:z.object({answer:z.string()})},budgetMicroUsd:100000};
 const first=await service.run(spec);expect(first.status).toBe('completed');expect(intents).toHaveLength(2);
 expect(await new AgentSessionService({...h.deps,naive:ports.sessions(h.naive)}).run(spec)).toEqual(first);expect(intents).toHaveLength(2);
 await ports.sessions(h.naive).listAgentSessions('fixture',{limit:1});expect(intents).toHaveLength(3);
});
it('abort during durable admission prevents target send; fetch passes parent cancellation',async()=>{
 const c=new AbortController(),post=vi.fn();
 const ports=acceptancePorts({signal:c.signal,beforeDispatch:async()=>{c.abort();}});
 await expect(ports.target({post}).post('https://fixture.invalid',{})).rejects.toThrow();expect(post).not.toHaveBeenCalled();
 const active=new AbortController();let received:AbortSignal|undefined;
 const f=acceptancePorts({signal:active.signal,beforeDispatch:async()=>{}}).fetch(async(_u,i)=>{received=i?.signal as AbortSignal;return new Response('{}');});
 await f('https://fixture.invalid');active.abort();expect(received?.aborted).toBe(true);
});
