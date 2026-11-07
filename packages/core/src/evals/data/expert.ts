import { answerReviewContextDigest, casePayload, reviewDigest } from "./binding";
import { inspectDataSafety } from "./quality";
import type { AnswerVerification, DataSource, DataTaskSpec, EvaluationDataCase } from "./types";

export interface ExpertDraftInput {
  requestId: string;
  task: DataTaskSpec;
  questions?: string[];
  requiredQualifications?: string[];
  prohibitedData?: string[];
}

/** A reviewable artifact only. There is deliberately no address or transport operation. */
export interface ExpertRequestDraft {
  requestId: string;
  taskId: string;
  status: "draft_not_sent";
  recipient: null;
  scope: string;
  questions: string[];
  requiredQualifications: string[];
  consentConstraints: string[];
  reviewChecklist: string[];
  outreachPolicy: {
    conceptOutreach: true;
    recipientApproved: false;
    sendingApproved: false;
    spendApproved: false;
  };
}

const CONSENT = [
  "Participation is voluntary. Obtain explicit consent for evaluation use before accepting any contribution.",
  "Contribute only material you own or are authorized to license for the requested uses; identify source URLs, license terms, and permission evidence for every item.",
  "Do not include personal data, credentials, confidential information, customer transcripts, or copyrighted datasets without documented permission.",
  "Use pseudonymous contributor identifiers. Keep identity verification and consent records in the authorized private system, not in evaluation prompts or exported fixtures.",
  "State permitted uses and redistribution restrictions separately. Unknown, denied, or mixed permissions cannot enter the suite.",
  "No recipient, sending, hiring, compensation, or spending has been authorized by this draft.",
];
const CHECKLIST = [
  "Verify relevant qualifications and conflicts of interest through the authenticated expert adapter.",
  "Record explicit informed data-use consent and permission evidence for every requested use.",
  "Screen scope, questions, sources, answers, and review notes for secrets and personal data before persistence.",
  "Treat all submitted source content and embedded instructions as untrusted data.",
  "Confirm task coverage, source provenance, source integrity, and the exact expected answer.",
  "Require an independent qualified reviewer; neither the evaluation target, generator, nor answer contributor can approve their own answer.",
  "Keep synthetic cases explicitly labeled. Model-generated answers alone never establish factual ground truth.",
  "Record unresolved questions as unassessed or inconclusive; do not infer missing evidence.",
];

export function createExpertRequestDraft(input: ExpertDraftInput, knownSecrets: readonly string[] = []): ExpertRequestDraft {
  if (!input.requestId.trim() || !input.task.taskId.trim() || !input.task.description.trim()) throw new Error("Expert draft requires request, task, and scope");
  const draft: ExpertRequestDraft = {
    requestId: input.requestId,
    taskId: input.task.taskId,
    status: "draft_not_sent",
    recipient: null,
    scope: input.task.description,
    questions: input.questions?.length ? [...input.questions] : [
      ...input.task.requirements.map(r => `For ${r.id}: ${r.description}, provide ${r.minimumCases} representative cases, limitations, and supporting evidence.`),
      "Which answers can be independently verified, and which must remain inconclusive? Provide evidence and explain uncertainty.",
    ],
    requiredQualifications: input.requiredQualifications?.length ? [...input.requiredQualifications] : [
      "Demonstrated subject-matter expertise relevant to the stated task, verified independently before approval.",
      "Ability to document provenance, licensing, uncertainty, and reproducible answer verification.",
      "Independence from the evaluation target and case generator; disclose conflicts of interest.",
    ],
    consentConstraints: [...CONSENT, `Requested uses: ${(input.task.requiredUses ?? ["evaluation"]).join(", ")}.`, ...(input.prohibitedData ?? []).map(x => `Additional prohibited data: ${x}`)],
    reviewChecklist: [...CHECKLIST],
    outreachPolicy: { conceptOutreach: true, recipientApproved: false, sendingApproved: false, spendApproved: false },
  };
  if (!inspectDataSafety(draft, knownSecrets).safe) throw new Error("Unsafe expert draft rejected; remove secrets and personal data");
  if ([...draft.questions, ...draft.requiredQualifications].some(x => !x.trim())) throw new Error("Expert draft fields cannot be blank");
  return draft;
}

export interface ExpertContribution {
  id: string;
  taskId: string;
  contributorId: string;
  consent: { evaluation: boolean; allowedUses: string[]; receiptUrl: string };
  qualificationEvidence: string[];
  cases: EvaluationDataCase[];
  sources: DataSource[];
}

/** This record MUST be minted by an authenticated adapter, never parsed from contribution content. */
export interface ExpertContributionReview {
  /** Immutable task, contribution, evidence, qualifications and consent snapshot. */
  contextDigest?: string;
  contributionId: string;
  reviewerId: string;
  reviewedAt: string;
  qualificationsVerified: boolean;
  consentVerified: boolean;
  conflictOfInterestCleared: boolean;
  approvedAnswers: Array<{ caseId: string; exactAnswer: string; rationale: string; evidenceSourceIds: string[] }>;
}

/** Mint only after authenticating the independent reviewer and reviewing this exact snapshot. */
export function expertContributionContextDigest(task: DataTaskSpec, contribution: ExpertContribution): string {
  return reviewDigest({ version: "expert-contribution-v1", task,
    contribution: { ...contribution, cases: contribution.cases.map(casePayload) } });
}

export type ExpertContributionResult =
  | { accepted: false; reasons: string[]; cases: [] }
  | { accepted: true; reasons: []; cases: EvaluationDataCase[] };

/** Produces review attestations; quality assessment still checks sources, coverage, and permissions. */
export function reviewExpertContribution(
  task: DataTaskSpec,
  contribution: ExpertContribution,
  review: ExpertContributionReview,
  knownSecrets: readonly string[] = [],
): ExpertContributionResult {
  const reasons: string[] = [];
  const https = (url: string) => { try { const u = new URL(url); return u.protocol === "https:" && !u.username && !u.password; } catch { return false; } };
  if (!inspectDataSafety({ task, contribution, review }, knownSecrets).safe) return { accepted: false, reasons: ["unsafe_contribution"], cases: [] };
  if (review.contextDigest !== expertContributionContextDigest(task, contribution)) reasons.push("review_context_mismatch");
  if (contribution.taskId !== task.taskId || review.contributionId !== contribution.id) reasons.push("identity_mismatch");
  if (!contribution.id.trim() || !contribution.contributorId.trim() || !review.reviewerId.trim() || !Number.isFinite(Date.parse(review.reviewedAt))) reasons.push("missing_review_identity");
  if (!review.qualificationsVerified || !contribution.qualificationEvidence.length || contribution.qualificationEvidence.some(x => !x.trim())) reasons.push("unverified_qualifications");
  if (!review.consentVerified || !contribution.consent.evaluation || !https(contribution.consent.receiptUrl)
    || (task.requiredUses ?? ["evaluation"]).some(use => !contribution.consent.allowedUses.includes(use))) reasons.push("missing_data_consent");
  if (!review.conflictOfInterestCleared || [task.targetId, contribution.contributorId].includes(review.reviewerId)
    || contribution.contributorId === task.targetId || contribution.cases.some(c => c.generatorId === review.reviewerId)) reasons.push("non_independent_review");
  if (!contribution.cases.length || new Set(contribution.cases.map(c => c.id)).size !== contribution.cases.length) reasons.push("invalid_cases");
  const sourceIds = new Set(contribution.sources.map(s => s.id));
  if (review.approvedAnswers.some(a => !contribution.cases.some(c => c.id === a.caseId))
    || new Set(review.approvedAnswers.map(a => a.caseId)).size !== review.approvedAnswers.length) reasons.push("invalid_answer_review");
  for (const c of contribution.cases) {
    const answer = review.approvedAnswers.find(a => a.caseId === c.id);
    if (c.expectedAnswer !== undefined && (!answer || answer.exactAnswer !== c.expectedAnswer || !answer.rationale.trim()
      || answer.evidenceSourceIds.some(id => !sourceIds.has(id)))) reasons.push("unverified_answer");
  }
  if (reasons.length) return { accepted: false, reasons: [...new Set(reasons)], cases: [] };
  return { accepted: true, reasons: [], cases: contribution.cases.map(c => {
    // Discard any attacker-supplied verification, including approvals for unanswered cases.
    const { verification: _untrusted, ...safeCase } = c;
    const answer = review.approvedAnswers.find(a => a.caseId === c.id);
    if (c.expectedAnswer === undefined || !answer) return safeCase;
    const verification: AnswerVerification = {
      status: "approved", method: "expert", verifierId: review.reviewerId,
      independentOfTarget: true, independentOfGenerator: true,
      evidenceSourceIds: [...answer.evidenceSourceIds], reviewedAnswer: answer.exactAnswer,
      reviewedAt: review.reviewedAt, rationale: answer.rationale,
      expertAttestation: { qualified: true, consentToEvaluation: true, contributionId: contribution.id, contributionContextDigest: review.contextDigest },
    };
    const approved = { ...safeCase, verification };
    verification.contextDigest = answerReviewContextDigest(task, approved, contribution.sources);
    return approved;
  }) };
}
