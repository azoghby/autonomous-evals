import { createHash } from "node:crypto";
import type { DataSource, DataTaskSpec, EvaluationDataCase } from "./types";

/** Canonical JSON for immutable review snapshots; array order remains significant. */
export function reviewDigest(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)])) : item;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
export function casePayload(candidate: EvaluationDataCase): Omit<EvaluationDataCase, "verification"> {
  const { verification: _verification, ...payload } = candidate;
  return payload;
}
/** Integrity only, never authority. Only authenticated reviewers may issue this binding. */
export function answerReviewContextDigest(task: DataTaskSpec, candidate: EvaluationDataCase, sources: readonly DataSource[]): string {
  const { contextDigest: _digest, ...approval } = candidate.verification ?? {};
  const ids = new Set([...candidate.sourceIds, ...(candidate.verification?.evidenceSourceIds ?? [])]);
  return reviewDigest({ version: "answer-review-v1", task, candidate: casePayload(candidate), approval,
    evidence: [...ids].sort().map(id => ({ id, records: sources.filter(source => source.id === id) })) });
}
