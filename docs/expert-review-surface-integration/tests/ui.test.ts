import { describe,it,expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildExpertReviewSubmission,emptyReviewForm,type ExpertReviewDetail } from '@/lib/client/expert-review';
import { ExpertReviewForm,EvidenceSource } from '@/components/app/expert-review-queue';
import { corpus,contribution,source,candidate } from './fixtures';
const at='2026-11-08T01:00:00Z';
function decided(){return {...emptyReviewForm(),independent:true,attestation:true,decision:'approved' as const,answers:{case:{status:'approved' as const,rationale:'Exact answer verified against source.',evidenceSourceIds:['source']}},sources:{source:{status:'approved' as const,notes:'Verified retained owner permission.'}}};}
describe('operator evidence review form behavior',()=>{
 it('starts with no grant, answer approval or submit enabled',()=>{
  const html=renderToStaticMarkup(createElement(ExpertReviewForm,{detail:contribution,onSubmit:async()=>{}}));
  expect(html).toContain('Record contribution review');expect(html).toContain('disabled=""');expect(html).not.toContain('checked=""');
  expect(html).toContain('Exact expected answer');expect(html).toContain('qualifications');expect(html).toContain('immutable snapshot');
  expect(()=>buildExpertReviewSubmission(contribution,emptyReviewForm(),at)).toThrow('exact snapshot');
 });
 it('requires independent human attestations and a deliberate exact answer decision',()=>{
  const form=decided();expect(()=>buildExpertReviewSubmission(contribution,form,at)).toThrow('qualifications');
  form.qualifications=true;form.consent=true;const pending={...form,answers:{case:{...form.answers.case,status:'pending' as const}}};
  expect(()=>buildExpertReviewSubmission(contribution,pending,at)).toThrow('Explicit answer approval');
 });
 it('submits only retained exact answers and evidence, never authority fields',()=>{
  const form={...decided(),qualifications:true,consent:true};
  const body=buildExpertReviewSubmission(contribution,form,at);
  expect(body).toMatchObject({snapshotDigest:contribution.snapshotDigest,attestation:true,review:{approvedAnswers:[{caseId:'case',exactAnswer:candidate.expectedAnswer,evidenceSourceIds:['source']}]}});
  expect(JSON.stringify(body)).not.toContain('reviewerId');expect(JSON.stringify(body)).not.toContain('contextDigest');
  form.answers.case.evidenceSourceIds=['invented'];expect(()=>buildExpertReviewSubmission(contribution,form,at)).toThrow('retained sources');
 });
 it('retains corpus license/content/labels and never invents expert attestations',()=>{
  const before=structuredClone(corpus);const body=buildExpertReviewSubmission(corpus,decided(),at);
  if(!('reviewed'in body))throw Error('wrong submission');
  expect(body.reviewed.sources[0]!.license).toEqual(source.license);expect(body.reviewed.sources[0]!.content).toBe(source.content);
  expect(body.reviewed.cases[0]!.synthetic).toBe(true);expect(body.reviewed.cases[0]!.verification).toMatchObject({method:'independent_evidence',reviewedAnswer:candidate.expectedAnswer});
  expect(body.reviewed.cases[0]!.verification).not.toHaveProperty('expertAttestation');expect(body.reviewed.cases[0]!.verification).not.toHaveProperty('contextDigest');expect(corpus).toEqual(before);
 });
 it('blocks missing corpus source decisions and self review',()=>{
  const form=decided();form.sources={};expect(()=>buildExpertReviewSubmission(corpus,form,at)).toThrow('source decision');
  expect(()=>buildExpertReviewSubmission({...corpus,principalId:'generator'},decided(),at)).toThrow('producer');
  expect(()=>buildExpertReviewSubmission({...corpus,principalId:'target'},decided(),at)).toThrow('target');
 });
 it('renders untrusted evidence escaped, with permission and synthetic disclosure',()=>{
  const html=renderToStaticMarkup(createElement(EvidenceSource,{source}));expect(html).not.toContain('<script>');expect(html).toContain('&lt;script&gt;');expect(html).toContain('permission allowed');
  const form=renderToStaticMarkup(createElement(ExpertReviewForm,{detail:corpus,onSubmit:async()=>{}}));expect(form).toContain('synthetic case');expect(form).toContain('cannot expand a license');expect(form).toContain('Choose a decision');
 });
});
export { corpus,contribution };
