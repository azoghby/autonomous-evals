/** Lossless retained artifacts with deliberately limited EvalServices projections.
 * Scope and retained artifacts MUST come from a current authorized immutable store,
 * never request fields or model output. This module cannot grant approval or persist it.
 */
import { z } from "zod";
import { Suite as ContractSuiteSchema, type Suite } from "../contracts";
import type { RunResult } from "../contracts/services";
import { containsSecret } from "../agents/redact";
import { TrackBBlockedError } from "./service-adapter";
import { canonicalJson, verifyAdmittedFrozenSuite } from "./text/freeze";
import { SuiteRunSchema, type FrozenTextSuite, type SuiteRun } from "./text/schema";
import { assertRunMatches } from "./text/investigate";
import { assertValidRunId } from "./text/execute";
import { toLegacyRunResult } from "./integration/services";

const Scope = z.object({ jobId: z.uuid(), customerId: z.string().min(1).max(200), environment: z.enum(["live", "test"]),
  suiteDigest: z.string().regex(/^[a-f0-9]{64}$/), approvalArtifactId: z.string().min(1).max(200) }).strict();
/** Current caller-authorized durable approval identity; never inferred from the public Suite. */
export type TextContractScope = z.infer<typeof Scope>;
export interface RetainedTextSuite { schemaVersion: "naive_contract_suite.v1"; scope: TextContractScope; frozen: FrozenTextSuite }
export interface TextSuiteProjection { suite: Suite; retained: RetainedTextSuite }
export interface RetainedTextRun { schemaVersion: "naive_contract_run.v1"; scope: TextContractScope; run: SuiteRun }
export interface TextRunProjection { result: RunResult; retained: RetainedTextRun }
const reject = (): never => { throw new TrackBBlockedError("rejected_input", "Text contract artifact, authority or projection mismatch."); };
const unsupported = (): never => { throw new TrackBBlockedError("needs_operator", "EvalServices RunResult cannot represent this rich text run without losing assessment states."); };
const safe = (input: unknown, secrets: readonly string[]) => { if (containsSecret(JSON.stringify(input), secrets)) reject(); };
function scoped(input: unknown, scope: TextContractScope, knownSecrets: readonly string[]): { frozen: FrozenTextSuite; scope: TextContractScope } {
  try {
    const current = Scope.parse(scope);
    const frozen = verifyAdmittedFrozenSuite(input);
    if (current.jobId !== frozen.jobId || current.suiteDigest !== frozen.digest) return reject();
    safe({ frozen, scope: current }, knownSecrets);
    return { frozen, scope: current };
  } catch { return reject(); }
}
/** Metadata without a Suite field stays in the retained artifact; checks have an explicit dialect. */
function publicSuite(frozen: FrozenTextSuite): Suite {
  return ContractSuiteSchema.parse({ jobId: frozen.jobId, versionLabel: frozen.versionLabel, frozenAt: frozen.frozenAt,
    scenarios: frozen.scenarios.map(s => ({ id: s.id, title: s.title, category: s.category, input: s.userMessage,
      checks: [...s.objectiveChecks, ...s.rubricChecks].map(check => ({ kind: check.kind, description: check.description,
        spec: { dialect: "naive_text_check.v1", check: structuredClone(check) } })) })) });
}
export function projectFrozenTextSuite(input: unknown, scope: TextContractScope, knownSecrets: readonly string[] = []): TextSuiteProjection {
  const verified = scoped(input, scope, knownSecrets);
  try { return { suite: publicSuite(verified.frozen), retained: { schemaVersion: "naive_contract_suite.v1", scope: verified.scope, frozen: verified.frozen } }; }
  catch { return reject(); }
}
/** Restores only the exact trusted approved body, with no design/freeze/default reconstruction. */
export function restoreFrozenTextSuite(projection: unknown, retained: RetainedTextSuite, currentScope: TextContractScope, knownSecrets: readonly string[] = []): FrozenTextSuite {
  try {
    if (!retained || retained.schemaVersion !== "naive_contract_suite.v1" || canonicalJson(Scope.parse(retained.scope)) !== canonicalJson(Scope.parse(currentScope))) return reject();
    const expected = projectFrozenTextSuite(retained.frozen, currentScope, knownSecrets);
    // Compare raw input as well as parsed: reject unknown fields and schema-inserted defaults.
    const parsed = ContractSuiteSchema.parse(projection);
    if (canonicalJson(projection) !== canonicalJson(parsed) || canonicalJson(parsed) !== canonicalJson(expected.suite)) return reject();
    return expected.retained.frozen;
  } catch { return reject(); }
}
function checkedRun(input: unknown, frozen: FrozenTextSuite, secrets: readonly string[]): SuiteRun {
  try {
    const run = SuiteRunSchema.parse(input); assertValidRunId(run.runId); assertRunMatches(frozen, run);
    // Contract runSuite means the whole suite. Partial reruns need a separate explicit contract.
    if (run.executions.length !== frozen.scenarios.length) return reject();
    if (run.executions.some(e => e.attempt !== "initial" && e.attempt !== "rerun")) return reject();
    safe(run, secrets);
    return run;
  } catch { return reject(); }
}
/** A boolean projection is permitted only for complete, purely objective runs. */
export function projectTextSuiteRun(input: unknown, suite: TextSuiteProjection, scope: TextContractScope, knownSecrets: readonly string[] = []): TextRunProjection {
  const frozen = restoreFrozenTextSuite(suite.suite, suite.retained, scope, knownSecrets);
  const run = checkedRun(input, frozen, knownSecrets);
  if (run.executions.some(e => !e.target.ok || e.target.errorCode !== null || e.outcome !== "completed" || e.responseText === null || e.checks.some(c => c.reason !== null))) return unsupported();
  let result: RunResult;
  try { result = toLegacyRunResult(run); } catch { return unsupported(); }
  return { result, retained: { schemaVersion: "naive_contract_run.v1", scope: Scope.parse(scope), run } };
}
export function restoreTextSuiteRun(projection: unknown, retained: RetainedTextRun, suite: TextSuiteProjection, scope: TextContractScope, knownSecrets: readonly string[] = []): SuiteRun {
  try {
    if (!retained || retained.schemaVersion !== "naive_contract_run.v1" || canonicalJson(Scope.parse(retained.scope)) !== canonicalJson(Scope.parse(scope))) return reject();
    const expected = projectTextSuiteRun(retained.run, suite, scope, knownSecrets);
    if (canonicalJson(projection) !== canonicalJson(expected.result)) return reject();
    return expected.retained.run;
  } catch { return reject(); }
}
