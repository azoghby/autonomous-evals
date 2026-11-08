import type { RunResult } from "@ae/core/contracts/services";

/** Pure regression-check logic (no I/O): turns a suite run into the CI-facing verdict. */

type ScenarioResult = RunResult["results"][number];

export interface RegressionFailure { scenarioId: string; title: string; detail: string }
export interface FixedRegression extends RegressionFailure { findingId: string; remediationId?: string }
export interface RegressionVerdict {
  passed: number;
  total: number;
  failed: RegressionFailure[];
  /** Failing scenarios that were tied to a verified remediation: a previously fixed issue came back. */
  previouslyFixedRegressed: FixedRegression[];
}

export interface RegressionInputs {
  scenarios: ReadonlyArray<{ id: string; title: string }>;
  results: ReadonlyArray<ScenarioResult>;
  /** Finding rows: data.id is the finding key, data.scenarioId the frozen scenario it was found on. */
  findings: ReadonlyArray<{ data: { id: string; scenarioId?: string } }>;
  remediations: ReadonlyArray<{ id?: string; findingId: string; verification: { status: string } }>;
}

export const DETAIL_MAX = 300;
const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Scenario ids whose finding has a *verified* remediation, mapped to that finding/remediation. */
export function fixedScenarioIndex(
  findings: RegressionInputs["findings"], remediations: RegressionInputs["remediations"],
): Map<string, { findingId: string; remediationId?: string }> {
  const scenarioOf = new Map(findings.filter((f) => f.data.scenarioId).map((f) => [f.data.id, f.data.scenarioId as string]));
  const out = new Map<string, { findingId: string; remediationId?: string }>();
  for (const r of remediations) {
    if (r.verification.status !== "verified") continue;
    const scenarioId = scenarioOf.get(r.findingId);
    if (scenarioId && !out.has(scenarioId)) out.set(scenarioId, { findingId: r.findingId, remediationId: r.id });
  }
  return out;
}

export function evaluateRegression(input: RegressionInputs): RegressionVerdict {
  const titles = new Map(input.scenarios.map((s) => [s.id, s.title]));
  const fixed = fixedScenarioIndex(input.findings, input.remediations);
  const failed: RegressionFailure[] = [];
  const previouslyFixedRegressed: FixedRegression[] = [];
  for (const r of input.results) {
    if (r.passed) continue;
    const entry = { scenarioId: r.scenarioId, title: titles.get(r.scenarioId) ?? r.scenarioId, detail: truncate(r.detail ?? "", DETAIL_MAX) };
    failed.push(entry);
    const link = fixed.get(r.scenarioId);
    if (link) previouslyFixedRegressed.push({ ...entry, ...link });
  }
  return { passed: input.results.length - failed.length, total: input.results.length, failed, previouslyFixedRegressed };
}

/** Removes the caller's target secret (and its bearer-less form) from any text we might return or log. */
export function redactSecret(text: string, secret: string | undefined): string {
  if (!secret) return text;
  const bare = secret.replace(/^Bearer\s+/i, "");
  let out = text.split(secret).join("[redacted]");
  if (bare.length >= 4) out = out.split(bare).join("[redacted]");
  return out;
}

/** `X-Target-Authorization` may be a raw key or a full "Bearer <key>"; the services want the bare key. */
export function targetKeyFromHeader(value: string | null): string | undefined {
  const v = value?.trim().replace(/^Bearer\s+/i, "").trim();
  return v ? v : undefined;
}
