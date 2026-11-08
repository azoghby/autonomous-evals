import { z } from 'zod';
import { canonicalJson } from '../text/freeze';
import { createTrustedRegistry, immutable, supportedSemantic, trustedSpecDigest, TrustedRedTeamSpecSchema, type TrustedRegistry } from './trusted';
export type { TrustedRegistry, TrustedRedTeamSpec } from './trusted';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z.string().min(1).max(256);
const Provenance = z.object({sourceRevision:z.string().regex(/^[a-f0-9]{40}$/),sourcePath:z.literal('packages/core/src/redteam/library.ts'),libraryDigest:digest}).strict();
const Authorization = z.object({authorizationId:identity,sourceRuleIds:z.array(identity).min(1).max(100),targetConfigDigest:digest}).strict();
const Entry = z.object({id:z.string().regex(/^rt_[a-z0-9_]+$/).max(64),specDigest:digest.nullable(),state:z.enum(['accepted','quarantined']),reason:identity.nullable(),semanticType:z.literal('redteam.literal_response.v1').nullable(),spec:TrustedRedTeamSpecSchema.nullable()}).strict();
export type PackEntry = z.infer<typeof Entry>;
const Content = z.object({schemaVersion:z.literal('appended_pack.v1'),packId:identity,version:identity,baseDigest:digest,provenance:Provenance,authorization:Authorization,inventory:z.array(Entry).min(1).max(20)}).strict();
const Frozen = Content.extend({review:z.object({reviewerId:identity,reviewedAt:z.string().datetime(),contentDigest:digest}).strict(),digest}).strict();
export type FrozenPack = z.infer<typeof Frozen>;
const Draft = z.object({packId:identity,version:identity,baseDigest:digest,authorization:Authorization,scenarioIds:z.array(z.string().regex(/^rt_[a-z0-9_]+$/).max(64)).min(1).max(20)}).strict();
export type PackDraft = z.infer<typeof Draft>;
/** Workflow boundary: capture every appended ID, never a hand-picked subset or check spec. */
export function draftFromAppendedInventory(input: {
  draft: Omit<PackDraft, 'scenarioIds'>; baseScenarioIds: readonly string[]; sharedScenarioIds: readonly string[];
}): PackDraft {
  const {baseScenarioIds:base,sharedScenarioIds:shared}=input;
  if(base.length!==12 || new Set(base).size!==12 || shared.length>32 || new Set(shared).size!==shared.length
    || base.some(id=>id.startsWith('rt_')) || canonicalJson(shared.filter(id=>!id.startsWith('rt_')))!==canonicalJson(base)) throw new Error('pack_shared_scope_mismatch');
  return Draft.parse({...input.draft,scenarioIds:shared.filter(id=>id.startsWith('rt_'))});
}
export const canonicalPackJson = (value: unknown): string => canonicalJson(value);
export const packDigest = trustedSpecDigest;
function registryCheck(registry: TrustedRegistry): TrustedRegistry {
  const clean = createTrustedRegistry({...registry.provenance,specs:registry.specs});
  if (canonicalJson(clean.provenance)!==canonicalJson(registry.provenance)) throw new Error('pack_registry_integrity');
  return clean;
}
function contentFor(draft:PackDraft, registry:TrustedRegistry): z.infer<typeof Content> {
  registry=registryCheck(registry);
  draft=Draft.parse(draft);
  if (new Set(draft.scenarioIds).size!==draft.scenarioIds.length) throw new Error('pack_duplicate_inventory');
  const inventory:PackEntry[]=draft.scenarioIds.map(id=> {
    const spec=registry.specs.find(s=>s.id===id) ?? null;
    const semanticType=spec ? supportedSemantic(spec) : null;
    return {id,spec,specDigest:spec ? trustedSpecDigest(spec) : null,semanticType,state:semanticType?'accepted':'quarantined',reason:!spec?'unknown_trusted_id':!semanticType?'unsupported_pack_semantics':null};
  });
  const parsed=Content.parse({schemaVersion:'appended_pack.v1',packId:draft.packId,version:draft.version,baseDigest:draft.baseDigest,provenance:registry.provenance,authorization:draft.authorization,inventory});
  if (new Set(parsed.authorization.sourceRuleIds).size!==parsed.authorization.sourceRuleIds.length) throw new Error('pack_duplicate_source_rules');
  return parsed;
}
/** Produce the exact content digest for external review, before freezing. */
export function packReviewDigest(draft:PackDraft,registry:TrustedRegistry):string {return packDigest(contentFor(draft,registry));}
/** Freeze only a complete reviewed ordered inventory; no truncation to Suite.max(32).
 * Review identity/authorization issuance must be verified by the composition root. */
export function freezePack(draft:PackDraft, registry:TrustedRegistry, review:FrozenPack['review']):FrozenPack {
  const content=contentFor(draft,registry);
  if (review.contentDigest!==packDigest(content)) throw new Error('pack_review_digest_mismatch');
  const body={...content,review};
  return immutable(Frozen.parse({...body,digest:packDigest(body)}));
}
export function verifyPack(stored:unknown,registry:TrustedRegistry):FrozenPack {
  const parsed=Frozen.parse(stored);
  const {digest:storedDigest,...body}=parsed;
  if (storedDigest!==packDigest(body)) throw new Error('pack_digest_mismatch');
  const expected=freezePack({packId:parsed.packId,version:parsed.version,baseDigest:parsed.baseDigest,authorization:parsed.authorization,scenarioIds:parsed.inventory.map(e=>e.id)},registry,parsed.review);
  if(canonicalJson(expected)!==canonicalJson(parsed)) throw new Error('pack_trusted_spec_mismatch');
  return expected;
}
