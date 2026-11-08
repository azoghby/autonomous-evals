import type { DataBatch } from '@ae/core/evals/data/acquisition';
import type { DataTaskSpec, ReviewStatus } from '@ae/core/evals/data/types';
import type { ExpertContribution } from '@ae/core/evals/data/expert';

export interface ExpertReviewItem { jobId: string; kind: 'contribution'|'corpus'; digest: string; taskId: string }
export type ExpertReviewDetail = ExpertReviewItem & {snapshotDigest:string;principalId:string} & (
 {kind:'contribution';snapshot:{task:DataTaskSpec;contribution:ExpertContribution}} |
 {kind:'corpus';snapshot:{task:DataTaskSpec;candidates:DataBatch}}
);
export interface AnswerDecision {status:ReviewStatus;rationale:string;evidenceSourceIds:string[]}
export interface ReviewForm {
 qualifications:boolean;consent:boolean;independent:boolean;attestation:boolean;
 decision:''|'approved'|'rejected';
 answers:Record<string,AnswerDecision>;
 sources:Record<string,{status:ReviewStatus;notes:string}>;
}
export const emptyReviewForm = ():ReviewForm=>({qualifications:false,consent:false,independent:false,attestation:false,decision:'',answers:{},sources:{}});
const invalid=(reason:string):never=>{throw new Error(reason);};
/** Client validation supports deliberate review; server authorization/digest checks remain mandatory. */
export function buildExpertReviewSubmission(detail:ExpertReviewDetail,form:ReviewForm,reviewedAt=new Date().toISOString()) {
 if(!form.attestation)return invalid('Confirm that you reviewed this exact snapshot.');
 if(!form.independent)return invalid('Confirm your independence from the target, generator and contributor.');
 if(detail.principalId===detail.snapshot.task.targetId)return invalid('The target cannot review its own evidence.');
 const data=detail.kind==='contribution'?detail.snapshot.contribution:detail.snapshot.candidates;
 if(data.cases.some(c=>c.generatorId===detail.principalId)||data.sources.some(s=>s.provenance.producerId===detail.principalId)
  ||detail.kind==='contribution'&&detail.snapshot.contribution.contributorId===detail.principalId)return invalid('The evidence producer cannot approve this snapshot.');
 const answer=(id:string)=>form.answers[id]??{status:'pending' as const,rationale:'',evidenceSourceIds:[]};
 function evidence(ids:string[]) {
  if(ids.some(id=>!data.sources.some(s=>s.id===id)))return invalid('Select evidence from the retained sources.');
  return [...new Set(ids)];
 }
 if(detail.kind==='contribution') {
  if(!form.qualifications||!form.consent)return invalid('Verify qualifications and the retained data-use consent.');
  const approvedAnswers=data.cases.filter(c=>c.expectedAnswer!==undefined).map(c=>{
   const decision=answer(c.id);
   if(decision.status!=='approved'||!decision.rationale.trim())return invalid(`Explicit answer approval and rationale required for ${c.id}.`);
   return {caseId:c.id,exactAnswer:c.expectedAnswer!,rationale:decision.rationale.trim(),evidenceSourceIds:evidence(decision.evidenceSourceIds)};
  });
  return {snapshotDigest:detail.snapshotDigest,attestation:true as const,review:{contributionId:detail.snapshot.contribution.id,reviewedAt,
   qualificationsVerified:true,consentVerified:true,conflictOfInterestCleared:true,approvedAnswers}};
 }
 if(!form.decision)return invalid('Choose a corpus decision.');
 const reviewed:DataBatch=structuredClone(detail.snapshot.candidates);
 reviewed.sources=reviewed.sources.map(s=>{
  const decision=form.sources[s.id]??{status:'pending' as const,notes:''};
  if(form.decision==='approved'&&(decision.status==='pending'||!decision.notes.trim()))return invalid(`Explicit source decision and permission evidence notes required for ${s.id}.`);
  return {...s,review:{status:decision.status,notes:decision.notes.trim(),reviewerId:detail.principalId,reviewedAt}};
 });
 reviewed.cases=reviewed.cases.map(c=>{
  if(c.expectedAnswer===undefined)return c;
  const decision=answer(c.id);
  if(form.decision==='approved'&&(decision.status==='pending'||!decision.rationale.trim()))return invalid(`Explicit answer decision and rationale required for ${c.id}.`);
  // Expert qualification/consent attestations can only be retained, never fabricated by this form.
  const verification={...c.verification,status:decision.status,method:c.verification?.method??'independent_evidence' as const,
   verifierId:detail.principalId,independentOfTarget:form.independent,independentOfGenerator:form.independent,
   reviewedAnswer:c.expectedAnswer,reviewedAt,rationale:decision.rationale.trim(),evidenceSourceIds:evidence(decision.evidenceSourceIds)};
  delete verification.contextDigest; // Server binds its authenticated principal and final exact reviewed sources.
  return {...c,verification};
 });
 return {snapshotDigest:detail.snapshotDigest,attestation:true as const,decision:form.decision,reviewed};
}
export const expertReviewPath=(item:ExpertReviewItem)=>`/api/operator/expert-reviews/${encodeURIComponent(item.jobId)}/${item.kind}/${encodeURIComponent(item.digest)}`;
