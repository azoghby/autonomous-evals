/** Evaluation data is untrusted input; review records must come from authenticated adapters. */
export type DataUse = "evaluation" | "generation" | "redistribution";
export type ReviewStatus = "pending" | "approved" | "rejected";
export interface DataReview {
  status: ReviewStatus;
  reviewerId: string;
  reviewedAt: string;
  notes: string;
}
export interface CoverageRequirement {
  id: string;
  description: string;
  minimumCases: number;
}
export interface DataTaskSpec {
  taskId: string;
  jobId: string;
  description: string;
  requirements: CoverageRequirement[];
  factualAnswersRequired: boolean;
  targetId: string;
  requiredUses?: DataUse[];
}
export interface DataSource {
  id: string;
  url: string;
  content: string;
  license: {
    name: string;
    url: string;
    permission: "allowed" | "denied" | "unknown" | "mixed";
    allowedUses: DataUse[];
  };
  provenance: {
    origin: "public" | "customer" | "expert" | "synthetic" | "evaluation_target";
    producerId: string;
    retrievedAt: string;
    contentHash: string;
  };
  /** Review confirms retrieval, content integrity, and permission for the stated uses. */
  review: DataReview;
}
export interface AnswerVerification {
  status: ReviewStatus;
  method: "independent_evidence" | "expert";
  verifierId: string;
  independentOfTarget: boolean;
  independentOfGenerator: boolean;
  evidenceSourceIds: string[];
  /** Exact answer the reviewer approved: edits invalidate approval. */
  reviewedAnswer: string;
  reviewedAt: string;
  rationale: string;
  /** Authenticated expert adapter attests qualifications and consent. */
  expertAttestation?: { qualified: boolean; consentToEvaluation: boolean; contributionId: string };
}
export interface EvaluationDataCase {
  id: string;
  input: string;
  requirementIds: string[];
  synthetic: boolean;
  generatorId?: string;
  sourceIds: string[];
  expectedAnswer?: string;
  verification?: AnswerVerification;
}
export interface DataQualityIssue {
  code: string;
  caseId?: string;
  sourceId?: string;
}
export interface DataQualityAssessment {
  status: "sufficient" | "insufficient" | "unassessed";
  factualCorrectness: "assessed" | "unassessed";
  acceptedCaseIds: string[];
  approvedAnswerCaseIds: string[];
  coverage: Array<{ requirementId: string; minimumCases: number; acceptedCases: number; covered: boolean }>;
  issues: DataQualityIssue[];
}
