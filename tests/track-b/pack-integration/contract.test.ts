import { describe, expect, it } from 'vitest';
import { RED_TEAM_LIBRARY } from '../../../packages/core/src/redteam/library';
import { createTrustedRegistry, supportedSemantic, trustedSpecDigest } from '../../../packages/core/src/evals/packs/trusted';
import { draftFromAppendedInventory, freezePack, packReviewDigest, packDigest, verifyPack, type PackDraft } from '../../../packages/core/src/evals/packs/contract';

const sourceRevision=process.env.PACK_TRACK_A_REVISION;
if(!sourceRevision) throw new Error('PACK_TRACK_A_REVISION must be supplied by the pinned local-git fixture harness');
const registry=createTrustedRegistry({sourceRevision,sourcePath:'packages/core/src/redteam/library.ts',specs:RED_TEAM_LIBRARY});
const draft:PackDraft={packId:'redteam',version:'1',baseDigest:'a'.repeat(64),authorization:{authorizationId:'auth-reviewed',sourceRuleIds:['source-rule-review'],targetConfigDigest:'b'.repeat(64)},scenarioIds:['rt_inj_direct_fake_system','rt_jb_dev_mode','rt_inj_tool_output','rt_unknown_future']};
const review=(value=draft)=>({reviewerId:'human-review',reviewedAt:'2026-11-07T00:00:00.000Z',contentDigest:packReviewDigest(value,registry)});
const freeze=()=>freezePack(draft,registry,review());
describe('reviewed appended pack contract against actual pinned Track A library',()=>{
  it('captures all Workflow extras and rejects dropped base or unrelated cases',()=>{
    const base=Array.from({length:12},(_,i)=>`S${String(i+1).padStart(2,'0')}`);
    const extra=[...draft.scenarioIds,'rt_new_extra'];
    const input={draft:{packId:draft.packId,version:draft.version,baseDigest:draft.baseDigest,authorization:draft.authorization},baseScenarioIds:base,sharedScenarioIds:[...base,...extra]};
    expect(draftFromAppendedInventory(input).scenarioIds).toEqual(extra);
    for(const sharedScenarioIds of [[...base.slice(1),...extra],[...base,...extra,'unexpected_case'],[...base,...extra,extra[0]!]]) {
      expect(()=>draftFromAppendedInventory({...input,sharedScenarioIds})).toThrow('shared_scope_mismatch');
    }
  });
  it('resolves trusted IDs independently from serialized arbitrary scenario checks',()=>{
    const pack=freeze();
    expect(pack.inventory.map(e=>[e.id,e.state])).toEqual([
      ['rt_inj_direct_fake_system','accepted'],['rt_jb_dev_mode','accepted'],['rt_inj_tool_output','quarantined'],['rt_unknown_future','quarantined'],
    ]);
    expect(pack.inventory[0].specDigest).toBe(trustedSpecDigest(RED_TEAM_LIBRARY.find(s=>s.id==='rt_inj_direct_fake_system')));
    expect(pack.inventory[3]).toMatchObject({spec:null,specDigest:null,reason:'unknown_trusted_id'});
    expect(pack.baseDigest).toBe(draft.baseDigest);
    expect(Object.isFrozen(pack.inventory[0].spec?.turns)).toBe(true);
    expect(verifyPack(JSON.parse(JSON.stringify(pack)),registry)).toEqual(pack);
  });
  it('retains every expected case and rejects duplicate or over-capacity scope',()=>{
    const ids=RED_TEAM_LIBRARY.slice(0,20).map(s=>s.id);
    const full={...draft,scenarioIds:ids};
    expect(freezePack(full,registry,review(full)).inventory.map(e=>e.id)).toEqual(ids);
    expect(()=>packReviewDigest({...draft,scenarioIds:[...ids,'rt_extra']},registry)).toThrow();
    expect(()=>packReviewDigest({...draft,scenarioIds:['rt_jb_dev_mode','rt_jb_dev_mode']},registry)).toThrow('duplicate_inventory');
  });
  it('requires review over version, base, ordered full scope, configuration and authorization',()=>{
    for(const change of [{version:'2'},{baseDigest:'c'.repeat(64)},{scenarioIds:[...draft.scenarioIds].reverse()},{authorization:{...draft.authorization,authorizationId:'other'}},{authorization:{...draft.authorization,targetConfigDigest:'d'.repeat(64)}},{authorization:{...draft.authorization,sourceRuleIds:['another-rule']}}]) {
      expect(()=>freezePack({...draft,...change},registry,review())).toThrow('review_digest_mismatch');
    }
  });
  it('rejects tampered specs even when attacker recomputes every stored hash',()=>{
    const pack=JSON.parse(JSON.stringify(freeze()));
    pack.inventory[0].spec.turns=['arbitrary prompt'];
    pack.inventory[0].specDigest=packDigest(pack.inventory[0].spec);
    const {review:_review,digest:_digest,...content}=pack;
    pack.review.contentDigest=packDigest(content);
    const {digest:_d,...body}=pack;pack.digest=packDigest(body);
    expect(()=>verifyPack(pack,registry)).toThrow();
    expect(()=>verifyPack({...freeze(),code:'return true'},registry)).toThrow();
    expect(()=>packReviewDigest({...draft,code:'return true'} as PackDraft,registry)).toThrow();
    expect(()=>packReviewDigest({...draft,authorization:{...draft.authorization,sourceRuleIds:['rule','rule']}},registry)).toThrow('duplicate_source_rules');
  });
  it('pins complete registry and provenance and refuses unsupported authoring semantics',()=>{
    expect(registry.specs).toHaveLength(RED_TEAM_LIBRARY.length);
    const accepted=registry.specs.filter(s=>supportedSemantic(s)).map(s=>s.id);
    expect(accepted).toEqual(['rt_inj_direct_fake_system','rt_jb_dev_mode']);
    const changed=createTrustedRegistry({sourceRevision:'f'.repeat(40),sourcePath:'packages/core/src/redteam/library.ts',specs:RED_TEAM_LIBRARY});
    expect(()=>verifyPack(freeze(),changed)).toThrow();
    expect(()=>createTrustedRegistry({sourceRevision:'branch',sourcePath:'packages/core/src/redteam/library.ts',specs:RED_TEAM_LIBRARY})).toThrow('unpinned_source');
    expect(()=>createTrustedRegistry({sourceRevision:sourceRevision!,sourcePath:'packages/core/src/redteam/library.ts',specs:[{...RED_TEAM_LIBRARY[0],code:'() => true'}]})).toThrow();
  });
});
