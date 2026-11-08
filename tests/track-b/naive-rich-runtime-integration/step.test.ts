import {beforeEach,describe,it,expect,vi} from 'vitest';
const m=vi.hoisted(()=>({runtime:vi.fn(),persist:vi.fn(),progress:vi.fn(),render:vi.fn()}));
vi.mock('@/server/expert-text-runtime',()=>({createExpertTextRuntime:m.runtime}));
vi.mock('@/server/job-store',()=>({recordProgress:m.progress,setJobState:vi.fn()}));
vi.mock('@workflow-test/steps/common',()=>({withBudget:async(_job:string,_agent:string,fn:Function)=>({status:'ok',data:await fn({})}),loadIntake:async()=>({package:'text_eval'})}));
vi.mock('@ae/core/integration/eval-services',()=>({evalServices:{renderReport:m.render}}));
vi.mock('@workflow-test/steps/evaluate',()=>({persistReportStep:m.persist}));
import {expertTextEvaluationStep,expertTextReportStep} from '@workflow-test/steps/expert-text';
beforeEach(()=>{vi.resetAllMocks();});
describe('actual expert execution and report steps',()=>{
 it('zero assessed scenarios stay pending without report publication',async()=>{m.runtime.mockResolvedValue({suite:{},assertCurrent:async()=>{},run:async()=>({results:[]}),investigate:async()=>[],reportContext:async()=>({assessed:0,summary:'All unavailable'})});expect(await expertTextEvaluationStep('job')).toEqual({status:'pending'});expect(m.render).not.toHaveBeenCalled();expect(m.persist).not.toHaveBeenCalled();});
 it('adds mixed assessment counts and limitations to the published report',async()=>{const summary='Text baseline assessment: 1 of 2 scenarios assessed.\nS01: objective; check=fail\nS02: inconclusive; check=inconclusive\nLimitations: unknown provider costs';m.runtime.mockResolvedValue({reportContext:async()=>({assessed:1,summary}),assertCurrent:async()=>{}});m.render.mockResolvedValue({jobId:'123e4567-e89b-42d3-a456-426614174000',summary:'Operator summary',markdown:'Report',html:'<p>Report</p>',findings:[]});await expertTextReportStep('job',[],{} as never);const report=m.persist.mock.calls[0]![1];expect(report.summary).toContain(summary);expect(report.markdown).toContain(summary);expect(report.html).toContain('Assessment coverage and limitations');});
 it('refuses report generation when all results are unknown',async()=>{m.runtime.mockResolvedValue({reportContext:async()=>({assessed:0,summary:'All unavailable'})});await expect(expertTextReportStep('job',[],{} as never)).rejects.toThrow('expert_text_no_assessment');expect(m.render).not.toHaveBeenCalled();expect(m.persist).not.toHaveBeenCalled();});
});
