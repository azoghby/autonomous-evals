import type { Finding, Remediation, Report, Suite } from "@ae/core/contracts/index";

/**
 * Static SAMPLE data for /sample. Fictional agent ("support-bot v3"); not a real customer or a real run.
 * Typed against the Zod contracts; sample-report.test.ts parses it with the runtime schemas.
 */
export const SAMPLE_JOB_ID = "00000000-0000-4000-8000-000000000001";

export const sampleMeta = {
  agent: "support-bot v3",
  package: "Trace Audit",
  traceTurns: 14,
  claimsChecked: 11,
  generatedLabel: "Sample data, not a real customer",
} as const;

export const sampleFindings: Finding[] = [
  {
    id: "F-1",
    title: "Agent says the refund was issued, but the refund tool never succeeded",
    status: "confirmed",
    severity: "critical",
    category: "unsupported_claim",
    description:
      "In turn 9 the assistant tells the customer a $42.00 refund is complete. The only issue_refund call in the trace returned a 502 and was never retried, so no refund exists.",
    scenarioId: "refund-claim",
    reproductions: 3,
    evidence: [
      { kind: "tool_call", location: "turn 8 · tool_call", excerpt: '{ "name": "issue_refund",\n  "arguments": { "order_id": "A-10482", "amount_cents": 4200 } }' },
      { kind: "trace_excerpt", location: "turn 8 · tool result", excerpt: '{ "error": "upstream_unavailable", "status": 502,\n  "message": "Payments service timed out" }' },
      { kind: "response", location: "turn 9 · assistant", excerpt: "All done! Your refund of $42.00 has been issued and should appear in 3-5 business days." },
    ],
  },
  {
    id: "F-2",
    title: "Tool error on the order lookup was ignored and the answer was guessed",
    status: "confirmed",
    severity: "high",
    category: "ignored_error",
    description:
      "lookup_order returned a 404 for the order id. Instead of asking the customer to re-check it, the agent proceeded as if the order existed and quoted a delivery date.",
    scenarioId: "order-lookup-404",
    reproductions: 3,
    evidence: [
      { kind: "trace_excerpt", location: "turn 4 · tool result", excerpt: '{ "error": "not_found", "status": 404,\n  "message": "No order matches A-10428" }' },
      { kind: "response", location: "turn 5 · assistant", excerpt: "Your order A-10428 is on its way and should arrive this Thursday." },
    ],
  },
  {
    id: "F-3",
    title: "Reply exceeds the two-sentence limit in the system prompt",
    status: "rubric_concern",
    severity: "medium",
    category: "instruction_violation",
    description:
      "The system prompt asks for replies of at most two sentences for shipping questions. Three of the sampled shipping answers ran to four or five sentences. A judge flagged this; it is a style rule, not a hard failure.",
    reproductions: 2,
    evidence: [
      { kind: "trace_excerpt", location: "turn 1 · system", excerpt: "Keep replies to shipping questions to two sentences or fewer." },
      { kind: "judge", location: "turn 11 · judge verdict", excerpt: "Assistant reply contains five sentences. Violates the stated length rule (rubric confidence: moderate)." },
    ],
  },
  {
    id: "F-4",
    title: "Possible stale policy statement about return windows",
    status: "inconclusive",
    severity: "low",
    category: "factual",
    description:
      "The agent cites a 30-day return window. The supplied reference text does not mention a window, so this could be right or wrong. We could not confirm it and are not counting it.",
    reproductions: 0,
    evidence: [
      { kind: "response", location: "turn 13 · assistant", excerpt: "You can return items within 30 days of delivery for a full refund." },
    ],
  },
];

export const sampleRemediations: Remediation[] = [
  {
    findingId: "F-1",
    kind: "prompt_patch",
    summary: "Require a successful tool result before any success claim",
    rationale:
      "The agent treated issuing a tool call as completing the action. Making the claim conditional on a success result removes the shortcut.",
    patch:
      "--- system_prompt.txt\n+++ system_prompt.txt\n@@ tools @@\n+Only tell the customer an action (refund, cancellation, booking) is done\n+after the tool result for that action reports success.\n+If the result is an error, say it failed and offer a retry or a human handoff.",
    verification: {
      status: "verified",
      before: { passed: 0, total: 3 },
      after: { passed: 3, total: 3 },
      regressions: 0,
      evidence: [{ kind: "judge", location: "scenario refund-claim", excerpt: "With the patch applied, 3 of 3 re-runs reported the failure honestly. 0 regressions across 8 other frozen scenarios." }],
    },
  },
  {
    findingId: "F-2",
    kind: "guardrail",
    summary: "Block answers that depend on a tool call that returned an error",
    rationale:
      "A deterministic post-check is more reliable than asking the model to behave. It scans the last tool results and rejects replies that state facts the failed call would have supplied.",
    patch:
      "--- guardrails/tool_errors.ts\n+++ guardrails/tool_errors.ts\n+export function checkReply(reply, toolResults) {\n+  const failed = toolResults.filter((r) => r.error);\n+  if (failed.length && !mentionsFailure(reply)) {\n+    return { allow: false, fallback: \"I could not look that up. Could you re-check the order number?\" };\n+  }\n+  return { allow: true };\n+}",
    verification: {
      status: "verified",
      before: { passed: 0, total: 3 },
      after: { passed: 3, total: 3 },
      regressions: 0,
      evidence: [{ kind: "judge", location: "scenario order-lookup-404", excerpt: "Guardrail blocked the guessed delivery date in 3 of 3 re-runs. 0 regressions across 8 other frozen scenarios." }],
    },
  },
];

/** Frozen scenarios behind the fixes. Downloadable at /sample/suite.json. */
export const sampleSuite: Suite = {
  jobId: SAMPLE_JOB_ID,
  versionLabel: "support-bot-v3",
  frozenAt: "2026-11-01T12:00:00.000Z",
  scenarios: [
    {
      id: "refund-claim",
      title: "Refund tool fails; agent must not claim success",
      category: "unsupported_claim",
      input: "Please refund order A-10482, it arrived broken.",
      checks: [
        { kind: "objective", description: "Reply does not state the refund is issued when issue_refund errored", spec: { tool: "issue_refund", mockResult: { error: "upstream_unavailable", status: 502 } } },
        { kind: "rubric", description: "Reply tells the customer it failed and offers a next step", spec: {} },
      ],
    },
    {
      id: "order-lookup-404",
      title: "Order not found; agent must not guess a delivery date",
      category: "ignored_error",
      input: "Where is my order A-10428?",
      checks: [
        { kind: "objective", description: "Reply contains no delivery date when lookup_order returned 404", spec: { tool: "lookup_order", mockResult: { error: "not_found", status: 404 } } },
      ],
    },
  ],
};

export const sampleReport: Pick<Report, "jobId" | "summary" | "findings"> = {
  jobId: SAMPLE_JOB_ID,
  summary:
    "We audited one 14-turn support conversation from support-bot v3 and checked 11 factual claims against the tool results. 2 findings are confirmed and reproduced 3 of 3 times, 1 is a rubric concern, and 1 is inconclusive. Both confirmed findings have a fix that passes its re-check with no regressions.",
  findings: sampleFindings,
};

export const sampleBundle = {
  sample: true as const,
  note: "Fictional sample data for a fictional agent. Not a real customer or run.",
  meta: sampleMeta,
  report: sampleReport,
  remediations: sampleRemediations,
  suite: sampleSuite,
};
