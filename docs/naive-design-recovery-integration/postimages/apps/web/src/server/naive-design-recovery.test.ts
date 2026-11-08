import {describe,it,expect,vi,afterEach} from 'vitest';
import {createHash} from 'node:crypto';
vi.mock('server-only',()=>({}));
vi.mock('./services',()=>({isWorkflowStagePendingError:()=>false}));
import {naiveDesignRecoveryStage} from './naive-design-recovery';
import {textDesignTaskScope} from '@ae/core/evals/text/design';
import {canonicalJson} from '@ae/core/evals/text/freeze';
const intake={package:'text_eval' as const,authorizedToTest:true,endpoint:{url:'https://example.com',model:'m',systemPrompt:'Be useful.',referenceText:'Reference.'}};
const job={jobId:'job',customerId:'customer',environment:'test' as const,package:'text_eval' as const,isFixture:false,quoteVersion:null,linkedRetestOf:null};
const profile={policyId:'generic-text-v1' as const,designId:'generic-text-v1',versionLabel:'generic-text-v1',admissionPolicyId:'automated-text-design-v1'};
function fixture(row:unknown={customer_id:'customer',environment:'test',intake,retest_of_job_id:null}){return {generic:true as const,identity:{jobId:'job',customerId:'customer',environment:'test' as const},profile,sql:{query:vi.fn(async()=>({rows:row?[row]:[]})),transaction:vi.fn()}};}
afterEach(()=>vi.unstubAllEnvs());
describe('canonical design recovery descriptor',()=>{
 it('derives exact core scope and outer checkpoint digest before admission',async()=>{
 vi.stubEnv('EVAL_SERVICES','real');const selected=fixture();const stage=await naiveDesignRecoveryStage('job',intake,selected as never);
 const input={versionLabel:profile.versionLabel,systemPrompt:intake.endpoint.systemPrompt,referenceText:intake.endpoint.referenceText};
 expect(stage.expectedChildPlan).toEqual({profile:'naive-design-v1',scope:textDesignTaskScope({job,...input}),outerDesignId:profile.designId,inputDigest:createHash('sha256').update(canonicalJson({environment:'test',input:{suiteId:profile.designId,...input}})).digest('hex')});
 expect(stage.recovery).toBe('naive-design-v1');
 });
 it('holds mode rollback, changed canonical ownership and changed input',async()=>{
 vi.stubEnv('EVAL_SERVICES','lite');await expect(naiveDesignRecoveryStage('job',intake,fixture() as never)).rejects.toThrow('NAIVE_EXECUTION_SELECTION_HOLD');
 vi.stubEnv('EVAL_SERVICES','real');await expect(naiveDesignRecoveryStage('job',intake,fixture(null) as never)).rejects.toThrow('NAIVE_EXECUTION_SELECTION_HOLD');
 await expect(naiveDesignRecoveryStage('job',{...intake,endpoint:{...intake.endpoint,systemPrompt:'changed'}},fixture() as never)).rejects.toThrow('NAIVE_EXECUTION_SELECTION_HOLD');
 });
});
