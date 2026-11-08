import { containsSecret } from '../agents/redact';
import { PatchSchema, remediationDigest, type AppliedReceipt, type AuthorizedRemediation } from '../evals/remediation';
import { assertRunMatches, canonicalJson, SuiteRunSchema, verifyAdmittedFrozenSuite } from '../evals/text';
import { isPersistableText } from './chat';
import { createTextTarget } from './text';
import { HttpsJsonTransport, TargetError, TargetGate, targetUrl, type JsonTransport } from './transport';

type Trial = NonNullable<AuthorizedRemediation['trial']>;
type Input = Parameters<Trial['send']>[0];
/** Server-authenticated canonical configuration. Never construct this from request lookup strings. */
export interface RemediationTargetScope {
  job: AuthorizedRemediation['job'];
  finding: AuthorizedRemediation['finding'];
  binding: AuthorizedRemediation['binding'];
  original: NonNullable<AuthorizedRemediation['original']>;
  trialId: string;
  endpoint: {
    kind: 'stateless_chat_completions';
    isolation: 'request_messages_only';
    url: string; model: string; apiKey?: string;
  };
}
export interface DispatchEvidence {
  jobId: string; targetId: string; targetVersion: string; environment: 'test' | 'live';
  trialId: string; baselineRunId: string; suiteDigest: string; runId: string; scenarioId: string;
  patchDigest: string; payloadDigest: string; operationId: string; inputDigest: string;
}
export type ObservedUsage = { promptTokens: number; completionTokens: number; totalTokens: number } | null;
export interface RemediationTargetDeps {
  scope: RemediationTargetScope;
  /** Refresh from authenticated server policy immediately before EACH dispatch. */
  currentSecrets(): Promise<readonly string[]>;
  accounting: {
    /** Durable dispatch evidence, linked by run/scenario to the factory reservation. No reservation replacement. */
    beforeDispatch(evidence: Readonly<DispatchEvidence>): Promise<void>;
    /** Durably retain measured usage; null means unknown, including unknown monetary price. No raw bodies/credentials. */
    observed(evidence: Readonly<DispatchEvidence>, usage: Readonly<ObservedUsage>): Promise<void>;
    /** Keep reservation held; reconciliation required. Must be durable, including late usage/outbox handling. */
    ambiguous(evidence: Readonly<DispatchEvidence>): Promise<void>;
  };
  limits: { timeoutMs: number; maxCompletionTokens: number; maxRequestBytes: number; maxResponseBytes: number };
  /** Trusted server injection for offline testing; default is secured HTTPS with its own explicit gate. */
  transport?: JsonTransport;
}
function refused(): never { throw new TargetError('remediation_target_refused'); }
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
function freeze<T>(v: T): T {
  if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); }
  return v;
}
function limit(v: number, min: number, max: number) {
  if (!Number.isInteger(v) || v < min || v > max) refused();
}
async function bounded<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([Promise.resolve().then(fn), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new TargetError('remediation_target_unresolved')), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}
function usage(raw: unknown): ObservedUsage {
  const u = (raw as { usage?: Record<string, unknown> } | null)?.usage;
  if (!u || !['prompt_tokens', 'completion_tokens', 'total_tokens'].every(k => Number.isSafeInteger(u[k]) && Number(u[k]) >= 0)
    || Number(u.total_tokens) !== Number(u.prompt_tokens) + Number(u.completion_tokens)) return null;
  return { promptTokens: Number(u.prompt_tokens), completionTokens: Number(u.completion_tokens), totalTokens: Number(u.total_tokens) };
}

/** Explicit server-only construction; no singleton, ambient credentials, config mutation or retry. */
export function createRemediationTarget(deps: RemediationTargetDeps): Trial {
  try {
    const scope = clone(deps.scope), limits = clone(deps.limits);
    const { endpoint } = scope;
    if (endpoint.kind !== 'stateless_chat_completions' || endpoint.isolation !== 'request_messages_only') refused();
    targetUrl(endpoint.url);
    if (!endpoint.model || endpoint.model.length > 200 || !isPersistableText(endpoint.model)) refused();
    if (endpoint.apiKey !== undefined && (endpoint.apiKey.length < 4 || endpoint.apiKey.length > 8192 || /[^\x21-\x7e]/.test(endpoint.apiKey))) refused();
    limit(limits.timeoutMs, 1, 30_000); limit(limits.maxCompletionTokens, 16, 32_768);
    limit(limits.maxRequestBytes, 1, 256_000); limit(limits.maxResponseBytes, 1, 1_000_000);
    scope.original.suite = verifyAdmittedFrozenSuite(scope.original.suite);
    scope.original.run = SuiteRunSchema.parse(scope.original.run);
    assertRunMatches(scope.original.suite, scope.original.run);
    if (!scope.trialId || !scope.binding.targetId || !scope.binding.targetVersion || !['test', 'live'].includes(scope.binding.environment)
      || scope.job.environment !== scope.binding.environment || scope.job.jobId !== scope.original.suite.jobId
      || canonicalJson(scope.original.binding) !== canonicalJson(scope.binding)
      || scope.original.run.executions.length !== scope.original.suite.scenarios.length) refused();
    freeze(scope); freeze(limits);
    const root = remediationDigest({ finding: scope.finding, binding: scope.binding, original: scope.original, trialId: scope.trialId });
    const runId = `rem-${root.slice(0, 48)}`;
    if (runId === scope.original.run.runId) refused();
    // Bind callback identities at construction too. Their implementation is trusted server infrastructure.
    const secretsNow = deps.currentSecrets, accounting = { ...deps.accounting };
    if (typeof secretsNow !== 'function' || !['beforeDispatch', 'observed', 'ambiguous'].every(k => typeof accounting[k as keyof typeof accounting] === 'function')) refused();
    const transport = deps.transport ?? new HttpsJsonTransport({ ...limits, gate: new TargetGate() });
    const attempted = new Set<string>();
    return Object.freeze({ trialId: scope.trialId, async send(rawInput: Input) {
      let evidence: Readonly<DispatchEvidence> | undefined;
      try {
        const input = clone(rawInput), patch = PatchSchema.parse(input.patch), request = input.request;
        const scenario = scope.original.suite.scenarios.find(s => s.id === request.scenarioId);
        if (!scenario || request.runId !== runId || input.baselineRunId !== scope.original.run.runId
          || input.suiteDigest !== scope.original.suite.digest || input.patchDigest !== remediationDigest(patch)
          || patch.kind !== 'prompt_patch' || patch.patch === scope.original.suite.systemPrompt
          || request.systemPrompt !== patch.patch || request.userMessage !== scenario.userMessage
          || !isPersistableText(patch.patch) || attempted.has(scenario.id)) refused();
        const current = await bounded(secretsNow, limits.timeoutMs);
        if (!Array.isArray(current) || current.some(s => typeof s !== 'string' || s.length < 4)) refused();
        const secrets = [...current, ...(endpoint.apiKey ? [endpoint.apiKey] : [])];
        const safe = (value: unknown) => { if (containsSecret(JSON.stringify(value), secrets)) refused(); };
        safe({ input, binding: scope.binding, trialId: scope.trialId, model: endpoint.model });
        // Lock before any asynchronous accounting/dispatch. Durable cross-instance fencing belongs to the factory.
        if (attempted.has(scenario.id)) refused();
        attempted.add(scenario.id);
        let receipt: AppliedReceipt | undefined, transportFailed = false;
        const observer: JsonTransport = { async post(url, body, bearer) {
          // Capture the actual text/chat serialization, validate its complete shape, and dispatch this same immutable value.
          const payload = freeze(clone(body));
          const expected = { model: endpoint.model, messages: [{ role: 'system', content: patch.patch }, { role: 'user', content: scenario.userMessage }], max_completion_tokens: limits.maxCompletionTokens, store: false };
          if (url !== endpoint.url || bearer !== endpoint.apiKey || canonicalJson(payload) !== canonicalJson(expected)
            || Buffer.byteLength(JSON.stringify(payload)) > limits.maxRequestBytes) refused();
          safe(payload);
          evidence = freeze({ jobId: scope.job.jobId, ...scope.binding, trialId: scope.trialId, baselineRunId: scope.original.run.runId,
            suiteDigest: scope.original.suite.digest, runId, scenarioId: scenario.id, patchDigest: remediationDigest(patch), payloadDigest: remediationDigest(payload),
            operationId: `remediation:${scope.job.jobId}:target:${root}:${scenario.id}`, inputDigest: remediationDigest({ root, input }) });
          try {
            await bounded(() => accounting.beforeDispatch(evidence!), limits.timeoutMs);
            // Recheck policy after the durable hook, immediately before transport dispatch.
            const latest = await bounded(secretsNow, limits.timeoutMs);
            if (!Array.isArray(latest) || latest.some(s => typeof s !== 'string' || s.length < 4)
              || containsSecret(JSON.stringify({ input, payload }), [...latest, ...secrets])) refused();
            const raw = await bounded(async () => {
              const response = await transport.post(url, payload, bearer);
              // Runs even on late completion after timeout. Accounting must durably fence/retain late observations.
              await accounting.observed(evidence!, usage(response));
              return response;
            }, limits.timeoutMs);
            if (Buffer.byteLength(JSON.stringify(raw)) > limits.maxResponseBytes) refused();
            safe(raw);
            if (containsSecret(JSON.stringify(raw), latest)) refused();
            const dispatched = payload as typeof expected;
            receipt = { ...scope.binding, isolated: true, trialId: scope.trialId, baselineRunId: scope.original.run.runId,
              suiteDigest: scope.original.suite.digest, runId, scenarioId: scenario.id, patchDigest: remediationDigest({ ...patch, patch: dispatched.messages[0]!.content }), actualSystemPrompt: dispatched.messages[0]!.content };
            return raw;
          } catch { transportFailed = true; throw new TargetError('remediation_target_unresolved'); }
        } };
        const target = createTextTarget({ url: endpoint.url, model: endpoint.model, apiKey: endpoint.apiKey, maxCompletionTokens: limits.maxCompletionTokens }, observer);
        const response = await target.send(request);
        if (transportFailed || !receipt) refused();
        safe(response);
        // Empty means no Naive-session entries, NOT zero monetary cost. HTTP accounting is mandatory above.
        return { value: { response, receipt }, costs: [] };
      } catch {
        if (evidence) { try { await bounded(() => accounting.ambiguous(evidence!), limits.timeoutMs); } catch { /* Durable factory intent remains unresolved; never retry. */ } }
        throw new TargetError('remediation_target_unresolved');
      }
    } });
  } catch { throw new TargetError('remediation_target_refused'); }
}
