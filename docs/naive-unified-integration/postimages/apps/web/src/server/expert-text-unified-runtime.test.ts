import { beforeEach, expect, it, vi } from 'vitest';
const ports=vi.hoisted(()=>({plan:vi.fn(),owner:vi.fn(),current:vi.fn(),scope:undefined as undefined|{owner:{jobId:string;stageKey:string;generation:number;token:string};assertActive?:()=>void}}));
vi.mock('./expert-data-plan-binding',()=>({assertFactualGapPlanCurrent:ports.plan}));
vi.mock('./workflow-stage-runtime',()=>({currentWorkflowStageScope:()=>ports.scope,assertWorkflowStageCurrent:ports.current}));
vi.mock('@ae/core/db/workflow-stage-authority',()=>({assertWorkflowStageOwner:ports.owner}));
import { assertExpertTextStage, createExpertTextRuntime } from './expert-text-runtime';
beforeEach(()=>{vi.clearAllMocks();ports.scope=undefined;});
it('rechecks factual authority in the composed runtime before owner data or provider access',async()=>{
 const revoked=new Error('factual_gap_plan_binding_revoked');
 ports.plan.mockRejectedValueOnce(revoked);
 const sql={query:vi.fn().mockResolvedValue({rows:[]}),transaction:vi.fn()};
 await expect(createExpertTextRuntime({jobId:'job'} as Parameters<typeof createExpertTextRuntime>[0],{sql})).rejects.toBe(revoked);
 expect(ports.plan).toHaveBeenCalledWith(sql,'job');
 expect(sql.query).toHaveBeenCalledTimes(1);
 expect(sql.query.mock.calls[0][0]).toContain("kind='expert_runtime_cost'");
 expect(sql.transaction).not.toHaveBeenCalled();
});
it('the composed runtime rejects an aborted stage before checking database ownership',async()=>{
 const stopped=new Error('workflow_stage_lease_lost');
 ports.scope={owner:{jobId:'job',stageKey:'expert',generation:2,token:'owner'},assertActive:()=>{throw stopped;}};
 await expect(assertExpertTextStage('job',{query:vi.fn()})).rejects.toBe(stopped);
 expect(ports.owner).not.toHaveBeenCalled();
 expect(ports.current).not.toHaveBeenCalled();
});
