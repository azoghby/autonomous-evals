/** Short, fixed explainers the copilot cites for "what does X mean" questions (static text: no model spend, no drift). */
import type { ConceptTopic, ExplainerCard } from "@/lib/eval-chat/types";

const CONCEPTS: Record<ConceptTopic, Omit<ExplainerCard, "topic" | "relatedScenarioIds">> = {
  pass_at_1: {
    title: "pass@1",
    body: "The chance a single attempt succeeds. Each scenario runs k trials; pass@1 is the average share of trials that passed across scenarios. It tells you how often a customer gets a good outcome on the first try.",
    example: "A scenario that passed 2 of 3 trials contributes 0.67 to the average.",
  },
  pass_hat_k: {
    title: "pass^k",
    body: "The share of scenarios that passed every one of their k trials. It measures reliability: an agent that succeeds 90% of the time per trial only reaches pass^k of about 73% at k=3. If pass^k is far below pass@1, the agent is flaky rather than incapable.",
    example: "pass@1 0.80 with pass^k 0.40 means most scenarios work sometimes but few work every time.",
  },
  wilson_ci: {
    title: "Wilson 95% interval",
    body: "A range for the true pass rate given how few trials ran. With small samples the interval is wide; run more trials (raise k) to narrow it. Two runs whose intervals overlap heavily are not reliably different.",
  },
  attribution: {
    title: "Failure attribution",
    body: "Every failed trial is attributed to the agent, the simulated customer, the environment, or the grader. Only agent failures count against your agent; the others point at the test itself and are flagged so you can discount them.",
  },
  gates: {
    title: "Scenario gates",
    body: "Before a scenario is trusted, three automatic gates run: an oracle agent with privileged access must be able to solve it (it is satisfiable), do-nothing agents must fail it (it is not trivially passed), and deliberately broken outcomes must be caught by the graders (the checks bite).",
  },
  categories: {
    title: "Scenario categories",
    body: "Happy path, boundary, missing info, policy conflict, adversarial user, tool failure, injection, multi-step and ambiguity. Policy conflicts and injections are traps: the right move is often to refuse or escalate, not to complete the request.",
  },
  state_diff: {
    title: "State diff",
    body: "Each trial runs in its own copy of the database. The diff lists every row the agent inserted, updated or deleted. Expected changes must appear; writes outside the allowed tables count as collateral damage and fail the trial.",
  },
  cost: {
    title: "What a run costs",
    body: "Spend covers the simulated customer, the judge for rubric checks, failure attribution, and hosted target tokens. It scales with scenarios × k. Runs stop at their budget and report partial results honestly.",
  },
  severity: {
    title: "Severity",
    body: "Critical and high checks guard money, data and policy (wrong refunds, leaked data, skipped verification). Medium and low cover tone, completeness and efficiency. One failed critical check fails the trial.",
  },
};

export function explainConcept(topic: ConceptTopic, relatedScenarioIds: string[] = []): ExplainerCard {
  return { topic, ...CONCEPTS[topic], relatedScenarioIds: relatedScenarioIds.slice(0, 8) };
}
