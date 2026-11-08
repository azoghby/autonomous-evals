import {RED_TEAM_LIBRARY} from './packages/core/src/redteam/library';
import {makeSuite} from './packages/core/src/evals/text/__tests__/fixtures';
import {createTrustedRegistry, freezePack, packReviewDigest, type PackRunEvidence} from './packages/core/src/evals/packs/index';
import {executeSuite} from './packages/core/src/evals/text/execute';
import {evaluateObjectiveCheck} from './packages/core/src/evals/text/objective';
import {projectWorkflowPack, attachWorkflowPackEvidence, workflowPackFromArtifact, appendWorkflowPackReport} from './apps/web/src/server/workflow-pack-projection';
export const suite=makeSuite();
const registry=createTrustedRegistry({sourceRevision:'f0068733ca49c37f40fd7de279325f21a4b5fbbb',sourcePath:'packages/core/src/redteam/library.ts',specs:RED_TEAM_LIBRARY});
const draft={packId:'pack',version:'v1',baseDigest:suite.digest,authorization:{authorizationId:'reviewed',sourceRuleIds:['policy'],targetConfigDigest:'a'.repeat(64)},scenarioIds:['rt_inj_direct_fake_system','rt_inj_document','rt_unknown_case']};
const manifest=freezePack(draft,registry,{reviewerId:'reviewer',reviewedAt:'2026-11-07T20:00:00.000Z',contentDigest:packReviewDigest(draft,registry)});
export function evidence():PackRunEvidence {
 return {schemaVersion:'appended_pack_run.v1',runId:'pack-run',manifest,context:{jobId:suite.jobId,environment:'test',...draft.authorization},base:{digest:suite.digest,status:'pass',run:null,expectedIds:suite.scenarios.map(s=>s.id)},pack:{status:'pass',expectedIds:draft.scenarioIds,results:[{id:draft.scenarioIds[0]!,specDigest:manifest.inventory[0]!.specDigest,status:'pass',checks:manifest.inventory[0]!.spec!.rules.map((_,i)=>({id:`${draft.scenarioIds[0]}.rule.${i+1}`,status:'pass',detail:'PRIVATE_RESPONSE',evidenceQuotes:['PRIVATE_QUOTE']}))}]}};
}
