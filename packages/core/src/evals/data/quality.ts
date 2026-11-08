import { answerReviewContextDigest } from "./binding";
import { createHash } from "node:crypto";
import { redactSecrets } from "../../agents/redact";
import type { DataSource, DataTaskSpec, DataQualityAssessment, EvaluationDataCase } from "./types";

/** Reject rather than persist a partially scrubbed record. Diagnostics contain no input text. */
export function inspectDataSafety(value: unknown, knownSecrets: readonly string[] = []): { safe: boolean; reasons: string[] } {
  let text: string;
  try { text = JSON.stringify(value) ?? ""; } catch { return { safe: false, reasons: ["unserializable_data"] }; }
  const reasons: string[] = [];
  if (text.length > 500_000) reasons.push("data_too_large");
  if (redactSecrets(text, knownSecrets).redactions > 0) reasons.push("secret_detected");
  // Conservative PII screen, supplementary to explicit known-secret/PII lists supplied by A.
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text)
    || /\b\d{3}-\d{2}-\d{4}\b/.test(text)
    || /(?:\+\d{1,3}[ .-]?)?(?:\(\d{3}\)|\b\d{3})[ .-]\d{3}[ .-]\d{4}\b/.test(text)
    || /\b(?:\d[ -]*?){13,19}\b/.test(text)) reasons.push("pii_detected");
  return { safe: reasons.length === 0, reasons };
}

function publicUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !!url.hostname
      && !/^(?:localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[|172\.(?:1[6-9]|2\d|3[01])\.)/i.test(url.hostname)
      && !url.hostname.endsWith(".local");
  } catch { return false; }
}
const nonblank = (value: string | undefined): boolean => typeof value === "string" && value.trim().length > 0;
const timestamp = (value: string): boolean => nonblank(value) && Number.isFinite(Date.parse(value));
const safeId = (value: string): boolean => /^[A-Za-z0-9_-]{1,96}$/.test(value) && inspectDataSafety(value).safe;

/** Pure, deterministic admission gate. Source content and instructions never execute. */
export function assessDataQuality(
  spec: DataTaskSpec,
  cases: readonly EvaluationDataCase[],
  sources: readonly DataSource[],
  options: { knownSecrets?: readonly string[] } = {},
): DataQualityAssessment {
  const taskSafety = inspectDataSafety(spec, options.knownSecrets);
  if (!taskSafety.safe) return { status: "unassessed", factualCorrectness: "unassessed", acceptedCaseIds: [],
    approvedAnswerCaseIds: [], coverage: [], issues: taskSafety.reasons.map(code => ({ code })) };
  const issues: DataQualityAssessment["issues"] = [];
  const acceptedCaseIds: string[] = [];
  const approvedAnswerCaseIds: string[] = [];
  const approvedSources = new Map<string, DataSource>();
  const sourceCounts = new Map<string, number>();
  for (const source of sources) sourceCounts.set(source.id, (sourceCounts.get(source.id) ?? 0) + 1);
  for (const source of sources) {
    const reasons = [...inspectDataSafety(source, options.knownSecrets).reasons];
    if (!safeId(source.id) || sourceCounts.get(source.id) !== 1) reasons.push("duplicate_or_missing_source_id");
    if (!publicUrl(source.url) || !publicUrl(source.license.url)) reasons.push("unverifiable_source_url");
    if (source.license.permission !== "allowed" || !nonblank(source.license.name)
      || !(spec.requiredUses ?? ["evaluation"]).every(use => source.license.allowedUses.includes(use))) reasons.push("permission_not_allowed");
    if (source.review.status !== "approved" || !nonblank(source.review.reviewerId)
      || source.review.reviewerId === spec.targetId || !timestamp(source.review.reviewedAt)) reasons.push("source_not_reviewed");
    if (!nonblank(source.content) || !timestamp(source.provenance.retrievedAt)
      || !nonblank(source.provenance.producerId)
      || source.provenance.contentHash !== createHash("sha256").update(source.content).digest("hex")) reasons.push("unverifiable_provenance");
    if (source.provenance.origin === "evaluation_target" || source.provenance.producerId === spec.targetId) reasons.push("target_is_not_ground_truth");
    for (const code of reasons) issues.push({ ...(safeId(source.id) && inspectDataSafety(source.id, options.knownSecrets).safe ? { sourceId: source.id } : {}), code });
    if (!reasons.length) approvedSources.set(source.id, source);
  }
  const requirementIds = new Set(spec.requirements.map(item => item.id));
  const seen = new Set<string>();
  for (const candidate of cases) {
    const reasons = [...inspectDataSafety(candidate, options.knownSecrets).reasons];
    if (!safeId(candidate.id) || seen.has(candidate.id) || cases.filter(item => item.id === candidate.id).length !== 1) reasons.push("duplicate_or_missing_case_id");
    seen.add(candidate.id);
    if (!nonblank(candidate.input) || !candidate.requirementIds.length
      || candidate.requirementIds.some(id => !requirementIds.has(id))) reasons.push("invalid_task_coverage");
    if (!candidate.synthetic && !candidate.sourceIds.length) reasons.push("missing_source");
    if (candidate.sourceIds.some(id => !approvedSources.has(id))) reasons.push("unapproved_source");
    if (!candidate.synthetic && candidate.sourceIds.some(id => approvedSources.get(id)?.provenance.origin === "synthetic")) reasons.push("synthetic_label_required");
    if (candidate.synthetic && !nonblank(candidate.generatorId)) reasons.push("missing_generator_provenance");
    const answerPresent = nonblank(candidate.expectedAnswer);
    const verification = candidate.verification;
    let answerApproved = false;
    if (answerPresent && verification?.status === "approved") {
      const independentSources = verification.evidenceSourceIds.map(id => approvedSources.get(id));
      const evidenceValid = independentSources.length > 0 && independentSources.every(source => source
        && source.provenance.origin !== "synthetic" && source.provenance.origin !== "evaluation_target"
        && source.provenance.producerId !== spec.targetId && source.provenance.producerId !== candidate.generatorId
        && source.provenance.producerId !== verification.verifierId
        && source.review.reviewerId !== candidate.generatorId);
      const expertValid = verification.method === "expert" && verification.expertAttestation?.qualified === true
        && verification.expertAttestation.consentToEvaluation === true && nonblank(verification.expertAttestation.contributionId)
        && /^[a-f0-9]{64}$/.test(verification.expertAttestation.contributionContextDigest ?? "");
      answerApproved = verification.independentOfTarget && verification.independentOfGenerator
        && nonblank(verification.verifierId) && verification.verifierId !== spec.targetId
        && verification.verifierId !== candidate.generatorId && timestamp(verification.reviewedAt)
        && nonblank(verification.rationale) && verification.reviewedAnswer === candidate.expectedAnswer
        && verification.contextDigest === answerReviewContextDigest(spec, candidate, sources)
        && (verification.method === "independent_evidence" ? evidenceValid : expertValid);
    }
    if (answerPresent && !answerApproved) reasons.push("answer_unverified");
    if (spec.factualAnswersRequired && !answerApproved) reasons.push("factual_evidence_missing");
    for (const code of reasons) issues.push({ ...(safeId(candidate.id) && inspectDataSafety(candidate.id, options.knownSecrets).safe ? { caseId: candidate.id } : {}), code });
    if (!reasons.length) {
      acceptedCaseIds.push(candidate.id);
      if (answerApproved) approvedAnswerCaseIds.push(candidate.id);
    }
  }
  const accepted = new Set(acceptedCaseIds);
  const coverage = spec.requirements.map(requirement => {
    const acceptedCases = cases.filter(candidate => accepted.has(candidate.id) && candidate.requirementIds.includes(requirement.id)).length;
    return { requirementId: requirement.id, minimumCases: requirement.minimumCases, acceptedCases,
      covered: Number.isInteger(requirement.minimumCases) && requirement.minimumCases > 0 && acceptedCases >= requirement.minimumCases };
  });
  const validTask = safeId(spec.taskId) && safeId(spec.jobId) && nonblank(spec.targetId) && nonblank(spec.description)
    && requirementIds.size === spec.requirements.length && spec.requirements.length > 0
    && spec.requirements.every(requirement => safeId(requirement.id) && nonblank(requirement.description));
  if (!validTask) issues.push({ code: "invalid_task_spec" });
  const status = !validTask || !cases.length ? "unassessed" : coverage.every(item => item.covered) ? "sufficient" : "insufficient";
  return { status,
    factualCorrectness: status === "sufficient" && approvedAnswerCaseIds.length > 0 && acceptedCaseIds.length === approvedAnswerCaseIds.length ? "assessed" : "unassessed",
    acceptedCaseIds, approvedAnswerCaseIds, coverage, issues };
}
