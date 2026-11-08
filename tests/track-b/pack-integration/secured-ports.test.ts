import { describe, expect, it } from 'vitest';
import { RED_TEAM_LIBRARY } from '../../../packages/core/src/redteam/library';
import { gradeRedTeam } from '../../../packages/core/src/redteam/grade';
import { createTrustedRegistry } from '../../../packages/core/src/evals/packs/trusted';
import { freezePack, packReviewDigest } from '../../../packages/core/src/evals/packs/contract';
import { createSecuredTextPackRunner, actualPackTargetDigest } from '../../../packages/core/src/evals/packs/secured-ports';
import type { PackDispatchContext } from '../../../packages/core/src/evals/packs/execution';

const registry=createTrustedRegistry({sourceRevision:process.env.PACK_TRACK_A_REVISION!,sourcePath:'packages/core/src/redteam/library.ts',specs:RED_TEAM_LIBRARY});
const configuration={endpoint:'https://target.example/eval',model:'reviewed-model',configurationVersion:'config-1',systemPrompt:'Maintain your assigned role.'};
const draft={packId:'redteam',version:'1',baseDigest:'a'.repeat(64),authorization:{authorizationId:'auth-1',sourceRuleIds:['role-integrity'],targetConfigDigest:actualPackTargetDigest(configuration)},scenarioIds:['rt_inj_direct_fake_system','rt_jb_dev_mode']};
const manifest=freezePack(draft,registry,{reviewerId:'reviewer',reviewedAt:'2026-11-07T00:00:00.000Z',contentDigest:packReviewDigest(draft,registry)});
const context:PackDispatchContext={jobId:'job-1',runId:'run-1',manifestDigest:manifest.digest,...manifest.authorization,provenance:registry.provenance};
const grader={provenance:registry.provenance,gradeRule:(spec:typeof RED_TEAM_LIBRARY[number],index:number,response:string)=>gradeRedTeam({...spec,rules:[spec.rules[index]!]}, {response})};

describe('secured target adapter with the actual pinned Track A grader',()=>{
  it('keeps source base64 and separator semantics rather than downgrading to substring checks',async()=>{
    const entry=manifest.inventory[0]!;
    const value=(entry.spec!.rules[0] as {values:string[]}).values[0]!;
    for(const text of [value,Buffer.from(value).toString('base64'),value.split('').join('-')]) {
      let request:unknown;
      const runner=createSecuredTextPackRunner({registry,configuration,grader,target:{async send(input){request=input;return {ok:true,text,latencyMs:1};}}});
      expect(runner.supports!(entry,context)).toBe(true);
      expect((await runner.execute(entry,context)).status).toBe('fail');
      expect(request).toEqual({scenarioId:entry.id,runId:'run-1',systemPrompt:configuration.systemPrompt,userMessage:entry.spec!.turns[0]});
    }
  });
  it('quarantines absent or mismatched trusted grader without sending',async()=>{
    let sends=0;
    for(const trusted of [undefined,{...grader,provenance:{...registry.provenance,sourceRevision:'0'.repeat(40)}}]) {
      const runner=createSecuredTextPackRunner({registry,configuration,grader:trusted,target:{async send(){sends++;throw new Error('must not send');}}});
      expect(runner.supports!(manifest.inventory[0]!,context)).toBe(false);
      expect((await runner.execute(manifest.inventory[0]!,context)).status).toBe('quarantined');
    }
    expect(sends).toBe(0);
  });
  it('rejects changed actual configuration before the secured target port',async()=>{
    const runner=createSecuredTextPackRunner({registry,configuration,grader,target:{async send(){throw new Error('must not send');}}});
    await expect(runner.execute(manifest.inventory[0]!,{...context,targetConfigDigest:'f'.repeat(64)})).rejects.toThrow('actual_target_configuration_mismatch');
    expect(actualPackTargetDigest({...configuration,systemPrompt:'Changed prompt'})).not.toBe(draft.authorization.targetConfigDigest);
  });
  it('rejects credential-bearing responses without persisting provider text',async()=>{
    const runner=createSecuredTextPackRunner({registry,configuration,grader,knownSecrets:['opaque-private-value'],target:{async send(){return {ok:true,text:'opaque-private-value',latencyMs:1};}}});
    await expect(runner.execute(manifest.inventory[0]!,context)).rejects.toThrow('credential_in_response');
  });
});
