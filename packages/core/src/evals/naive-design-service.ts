/** Contract design adapter. Owner ports supply authorization, durable admission and accounting. */
import { createHash } from "node:crypto";
import { IntakeInput as IntakeSchema, type IntakeInput } from "../contracts";
import type { EvalServices, ServiceContext } from "../contracts/services";
import { containsSecret } from "../agents/redact";
import type { JobRef } from "./types";
import { TrackBBlockedError, TrackBPendingError } from "./service-adapter";
import type { createTextEvaluationServices } from "./integration/services";
import type { TextDesignOutcome } from "./text/design";
import { canonicalJson, verifyAdmittedFrozenSuite } from "./text/freeze";
import { normalizeReferenceText, type FrozenTextSuite } from "./text/schema";
import { projectFrozenTextSuite, restoreFrozenTextSuite, type RetainedTextSuite, type TextSuiteProjection } from "./naive-contract-mapping";

export interface AuthorizedNaiveTextDesign {
  job: JobRef;
  /** Current canonical stored intake, after caller authorization; keys never enter identity/artifacts. */
  intake: IntakeInput;
  /** Stable owner-assigned design slot, not a new random key per call. */
  designId: string;
  versionLabel: string;
  knownSecrets?: readonly string[];
}
export interface NaiveTextDesignIdentity {
  jobId: string; customerId: string; environment: "live" | "test"; designId: string;
  versionLabel: string; inputDigest: string;
}
export type NaiveTextDesignAdmission = { identity: NaiveTextDesignIdentity } & (
  | { status: "pending" }
  | { status: "rejected" }
  | { status: "approved"; artifact: RetainedTextSuite }
);
export interface NaiveTextDesignAdmissionStore {
  /** Authorize scope; durable key is job/customer/environment/designId. Changed inputDigest
   * must reject, never return null. Return null only when no admission exists. */
  load(identity: NaiveTextDesignIdentity): Promise<NaiveTextDesignAdmission | null>;
  /** Validate review/admission and atomically retain the full frozen body before returning.
   * Return the existing immutable result on replay; reject any conflicting identity/body.
   * Approval ID is assigned by this trusted admission system, never by this adapter/model. */
  admit(identity: NaiveTextDesignIdentity, frozen: FrozenTextSuite): Promise<NaiveTextDesignAdmission>;
}
export interface NaiveDesignServiceDeps {
  authorize(ctx: ServiceContext): Promise<AuthorizedNaiveTextDesign>;
  engine: Pick<ReturnType<typeof createTextEvaluationServices>, "designSuite">;
  admission: NaiveTextDesignAdmissionStore;
}
const reject = (): never => { throw new TrackBBlockedError("rejected_input", "Text design scope, intake or retained admission mismatch."); };
const pending = (): never => { throw new TrackBPendingError(5_000, "Text design admission is pending."); };
function canonicalIntake(input: IntakeInput) {
  const parsed = IntakeSchema.parse(input);
  if (parsed.package !== "text_eval") return reject();
  return { package: parsed.package, authorizedToTest: parsed.authorizedToTest, endpoint: {
    url: parsed.endpoint.url, model: parsed.endpoint.model, systemPrompt: parsed.endpoint.systemPrompt,
    referenceText: normalizeReferenceText(parsed.endpoint.referenceText ?? null),
  }, notes: parsed.notes ?? null };
}
function blocked(outcome: Extract<TextDesignOutcome, { status: "blocked" }>): never {
  const agent = outcome.agentOutcome;
  if (agent?.status === "pending") throw new TrackBPendingError(Number.isSafeInteger(agent.retryAfterMs) && agent.retryAfterMs > 0 ? agent.retryAfterMs : 5_000, "Text design agent is pending.");
  if (agent?.status === "budget_exhausted" || agent?.status === "budget_paused") throw new TrackBBlockedError("paused_budget", "Text design agent budget is paused.");
  if (agent?.status === "needs_operator") throw new TrackBBlockedError("needs_operator", "Text design requires operator reconciliation.");
  throw new TrackBBlockedError("agent_failed", "Text design or independent review did not complete safely.");
}
/** Text-only implementation. Workflow and version-comparison require their own explicit mapping. */
export function createNaiveDesignService(deps: NaiveDesignServiceDeps): Pick<EvalServices, "designSuite"> {
  return { async designSuite(ctx, intake) {
    const contextIdentity = { jobId: ctx.jobId, environment: ctx.environment, budgetMicroUsd: ctx.budgetMicroUsd };
    let requested: ReturnType<typeof canonicalIntake>;
    try { requested = canonicalIntake(intake); } catch { return reject(); }
    const requestSecret = intake.package === "text_eval" ? intake.endpoint.apiKey : undefined;
    async function current() {
      if (ctx.jobId !== contextIdentity.jobId || ctx.environment !== contextIdentity.environment || ctx.budgetMicroUsd !== contextIdentity.budgetMicroUsd) return reject();
      const a = structuredClone(await deps.authorize(ctx));
      let stored: ReturnType<typeof canonicalIntake>;
      try { stored = canonicalIntake(a.intake); } catch { return reject(); }
      if (a.job.jobId !== ctx.jobId || a.job.environment !== ctx.environment || a.job.package !== "text_eval" || !a.job.customerId ||
        !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,95}$/.test(a.designId) || typeof a.designId !== "string" ||
        typeof a.versionLabel !== "string" || !a.versionLabel.trim() || a.versionLabel.length > 64 || canonicalJson(stored) !== canonicalJson(requested)) return reject();
      if (a.knownSecrets !== undefined && (!Array.isArray(a.knownSecrets) || a.knownSecrets.some(secret => typeof secret !== "string" || !secret))) return reject();
      const storedSecret = a.intake.package === "text_eval" ? a.intake.endpoint.apiKey : undefined;
      const secrets = [...(a.knownSecrets ?? []), ...[requestSecret, storedSecret].filter((v): v is string => !!v)];
      if (containsSecret(JSON.stringify(stored), secrets)) return reject();
      const identity: NaiveTextDesignIdentity = { jobId: a.job.jobId, customerId: a.job.customerId, environment: a.job.environment,
        designId: a.designId, versionLabel: a.versionLabel,
        inputDigest: createHash("sha256").update(canonicalJson(stored)).digest("hex") };
      return { identity, secrets, stored };
    }
    const first = await current();
    const reauthorize = async () => { const next = await current(); if (canonicalJson(next.identity) !== canonicalJson(first.identity)) return reject(); return next; };
    function admitted(record: NaiveTextDesignAdmission, secrets: readonly string[], expected?: FrozenTextSuite): TextSuiteProjection {
      if (canonicalJson(record.identity) !== canonicalJson(first.identity)) return reject();
      if (record.status === "pending") return pending();
      if (record.status === "rejected") return reject();
      if (record.status !== "approved") return reject();
      const scope = record.artifact.scope;
      if (scope.jobId !== first.identity.jobId || scope.customerId !== first.identity.customerId || scope.environment !== first.identity.environment) return reject();
      const projection = projectFrozenTextSuite(record.artifact.frozen, scope, secrets);
      const frozen = restoreFrozenTextSuite(projection.suite, record.artifact, scope, secrets);
      if (frozen.versionLabel !== first.identity.versionLabel || frozen.systemPrompt !== first.stored.endpoint.systemPrompt || frozen.referenceText !== first.stored.endpoint.referenceText ||
        expected && canonicalJson(frozen) !== canonicalJson(expected)) return reject();
      return projection;
    }
    const prior = structuredClone(await deps.admission.load(structuredClone(first.identity)));
    let fresh = await reauthorize();
    if (prior) admitted(prior, fresh.secrets);
    if (!Number.isSafeInteger(ctx.budgetMicroUsd) || ctx.budgetMicroUsd < 0) return reject();
    if (ctx.budgetMicroUsd === 0) throw new TrackBBlockedError("paused_budget", "Text design requires a positive authorized budget.");
    // The rich engine owns durable task replay and measured cost redelivery, even for an approved replay.
    const outcome = structuredClone(await deps.engine.designSuite(ctx, { suiteId: first.identity.designId, versionLabel: first.identity.versionLabel,
      systemPrompt: first.stored.endpoint.systemPrompt, referenceText: first.stored.endpoint.referenceText }));
    fresh = await reauthorize();
    if (outcome.status !== "completed") return blocked(outcome);
    let frozen: FrozenTextSuite;
    try { frozen = verifyAdmittedFrozenSuite(outcome.suite); } catch { return reject(); }
    if (frozen.jobId !== first.identity.jobId || frozen.versionLabel !== first.identity.versionLabel || frozen.systemPrompt !== first.stored.endpoint.systemPrompt ||
      frozen.referenceText !== first.stored.endpoint.referenceText || containsSecret(JSON.stringify(frozen), fresh.secrets)) return reject();
    if (prior) {
      const latest = structuredClone(await deps.admission.load(structuredClone(first.identity)));
      fresh = await reauthorize();
      if (!latest) return reject();
      const projection = admitted(latest, fresh.secrets, frozen);
      if (canonicalJson(latest) !== canonicalJson(prior)) return reject();
      return projection.suite;
    }
    const saved = structuredClone(await deps.admission.admit(structuredClone(first.identity), structuredClone(frozen)));
    fresh = await reauthorize();
    return admitted(saved, fresh.secrets, frozen).suite;
  } };
}
