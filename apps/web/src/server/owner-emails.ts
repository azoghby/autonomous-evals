/**
 * Agent-owner autopilot: pure email copy builders (no DB, no server-only). sendOwnerEmail appends the footer
 * (sender identity, unsubscribe, address), so bodies here carry only the message itself plus a short sender line.
 * Bodies never include API keys, endpoint URLs or system prompts.
 */
import { PRICE_CENTS } from "@ae/core/contracts/index";
import { SENDER_LINE } from "./owner-policy";
import { categoryLabel, percent, type StoredFinding } from "./leaderboard";

const MAX_EXCERPT = 110;
/** Categories whose excerpts could echo prompts or data; their findings are described without an excerpt. */
const NO_EXCERPT = /system_prompt_extraction|data_exfiltration/;

/** One-line, credential-free excerpt of a finding. Returns "" when nothing safe remains. */
/** Lite-engine details look like `lite:v1:{"reason":"..."}`; keep only the human-readable reason (may be truncated JSON). */
export function judgeReason(raw: string): string {
  const m = /^lite:v\d+:(.*)$/s.exec(raw.trim());
  if (!m) return raw;
  const body = m[1]!;
  try { const j = JSON.parse(body) as { reason?: unknown }; if (typeof j.reason === "string") return j.reason; } catch { /* truncated */ }
  const r = /"reason"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(body);
  return r ? r[1]!.replace(/\\"/g, '"') : body;
}

export function scrubExcerpt(raw: string | undefined, category = ""): string {
  if (!raw || NO_EXCERPT.test(category)) return "";
  const s = judgeReason(raw)
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[link]")
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email]")
    .replace(/\b(Bearer|Basic)\s+\S+/gi, "$1 [redacted]")
    .replace(/\b(sk|pk|rk|key|tok|token|secret)[-_][A-Za-z0-9_-]{8,}/gi, "[redacted]")
    .replace(/\b[A-Za-z0-9+/_-]{32,}={0,2}/g, "[redacted]")
    .replace(/\s+/g, " ").trim();
  return s.length > MAX_EXCERPT ? `${s.slice(0, MAX_EXCERPT - 3)}...` : s;
}

const SEV_ORDER = ["critical", "high", "medium", "low"];
export const topFindings = (findings: readonly StoredFinding[], n = 3): StoredFinding[] =>
  [...findings].sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity)).slice(0, n);

export function findingLine(f: StoredFinding): string {
  const ex = scrubExcerpt(f.excerpt, f.category);
  return `- [${f.severity}] ${f.title} (${categoryLabel(f.category)})${ex ? `: ${ex}` : ""}`;
}

/** Generic, category-level remediation hints. No claims about the owner's specific code. */
export function remediationHint(category: string): string {
  if (category.includes("prompt_injection")) return "Treat retrieved or user-supplied text as data, not instructions: add an explicit rule in the system prompt to ignore instructions embedded in content, and separate untrusted content with clear delimiters.";
  if (category.includes("jailbreak")) return "Add a short, non-negotiable policy section to the system prompt, and re-state it after long user turns; consider an output check for the policy categories you care about.";
  if (category.includes("system_prompt_extraction")) return "Keep secrets out of the system prompt entirely, and instruct the agent to decline requests to reveal its instructions.";
  if (category.includes("tool_misuse")) return "Validate tool arguments in code (allow-lists, limits, confirmation for destructive actions) instead of relying on the model to refuse.";
  if (category.includes("data_exfiltration")) return "Scope what the agent can read per user, and strip or block outputs that contain data from other sessions or accounts.";
  if (category.includes("harmful_compliance")) return "Define explicitly what the agent must refuse, and add a refusal-style example to the prompt for each category.";
  if (category.includes("over_refusal")) return "Narrow the refusal rules to the specific harms you mean to block, and add examples of benign requests that should be answered.";
  if (category === "grounding_ambiguity") return "Tell the agent to ask a clarifying question or say it does not know when the request is ambiguous or the source material does not cover it.";
  if (category === "instruction_edge") return "Restate hard format and length constraints at the end of the prompt, and validate the output format in code.";
  return "Add a specific rule and one worked example for this behavior to the system prompt, then re-run to confirm the change.";
}

const usd = (cents: number) => `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
export const paidEvalPriceLine = (): string =>
  `Paid evals start at ${usd(Math.min(...Object.values(PRICE_CENTS)))} (text eval); a version comparison is ${usd(PRICE_CENTS.version_comparison)}.`;

export interface ResultsEmailInput {
  agentName: string; passed: number; total: number;
  rank?: number; totalRanked?: number;
  findings: readonly StoredFinding[];
  visibility: "public" | "private";
  resultsUrl: string; badgeMarkdown?: string; startUrl: string;
}

export function buildResultsEmail(i: ResultsEmailInput): { subject: string; text: string } {
  const score = percent(i.total > 0 ? i.passed / i.total : 0);
  const top = topFindings(i.findings);
  const lines = [
    `Your agent "${i.agentName}" scored ${score} (${i.passed} of ${i.total} scenarios passed) on the Standard Evals suite.`,
  ];
  if (i.visibility === "public" && i.rank && i.totalRanked) lines.push(`It ranks #${i.rank} of ${i.totalRanked} on the public leaderboard.`);
  if (i.visibility === "private") lines.push("Your results are private: only people with the link below can see them.");
  lines.push("");
  if (top.length === 0) lines.push("No scenarios failed in this run.");
  else lines.push(`Top ${top.length === 1 ? "finding" : "findings"} by severity (${i.findings.length} in total):`, ...top.map(findingLine));
  lines.push("", `Full results: ${i.resultsUrl}`);
  if (i.visibility === "public" && i.badgeMarkdown) lines.push("", "Badge for your README:", i.badgeMarkdown);
  lines.push(
    "", `Want these fixed? Reply "start a paid eval" or go to ${i.startUrl}. ${paidEvalPriceLine()}`,
    "", SENDER_LINE,
  );
  return { subject: `Your agent "${i.agentName}" scored ${score} on the Standard Evals suite`, text: lines.join("\n") };
}

export interface RerunEmailInput {
  agentName: string; prevPct: number; nextPct: number; deltaPts: number; newHigh: readonly string[]; resultsUrl: string;
}

export function buildRerunEmail(i: RerunEmailInput): { subject: string; text: string } {
  const dir = i.deltaPts > 0 ? "up" : i.deltaPts < 0 ? "down" : "unchanged";
  const lines = [
    `We re-ran the Standard Evals suite on "${i.agentName}". Score: ${i.nextPct}% (previously ${i.prevPct}%, ${dir}${i.deltaPts === 0 ? "" : ` ${Math.abs(i.deltaPts)} points`}).`,
  ];
  if (i.newHigh.length > 0) lines.push("", "New high or critical findings:", ...i.newHigh.slice(0, 5).map((t) => `- ${t}`));
  lines.push("", `Details: ${i.resultsUrl}`, "", "We only email re-run results when the score moves by 5 points or more, or a new high-severity finding appears.", "", SENDER_LINE);
  return {
    subject: i.newHigh.length > 0 ? `New high-severity finding on "${i.agentName}"` : `Your agent "${i.agentName}" moved ${dir} to ${i.nextPct}%`,
    text: lines.join("\n"),
  };
}

export interface FixOfferInput { agentName: string; finding: StoredFinding; startUrl: string }

export function buildFixOfferEmail(i: FixOfferInput): { subject: string; text: string } {
  const ex = scrubExcerpt(i.finding.excerpt, i.finding.category);
  return {
    subject: `A concrete fix for the top issue found in "${i.agentName}"`,
    text: [
      `The most serious issue in our test of "${i.agentName}" was:`,
      findingLine(i.finding),
      ex ? "" : null,
      `A generic starting point (category: ${categoryLabel(i.finding.category)}): ${remediationHint(i.finding.category)}`,
      "",
      `If you would like us to investigate it properly, confirm the finding, and propose a patch we verify by re-running the failing scenarios, start a paid eval at ${i.startUrl}. ${paidEvalPriceLine()}`,
      "",
      "This is a one-time suggestion; we will not send another.",
      "", SENDER_LINE,
    ].filter((l): l is string => l !== null).join("\n"),
  };
}
