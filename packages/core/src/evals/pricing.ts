/**
 * Quick eval offers use the shared checkout price constants. Agents never set prices:
 * the Commercial agent picks a package; code produces the quote from this table.
 */
import { PRICE_CENTS, MONITORING_PRICE_CENTS_MONTHLY } from "../contracts";
import { type MicroUsd, type PackageId, usd } from "./types";

export interface PackageOffer {
  id: PackageId;
  name: string;
  priceMicroUsd: MicroUsd;
  billing: "one_time" | "monthly";
  inputNeeded: string;
  deliverables: string[];
  /** Per-job Naïve budget cap reserved before dispatch (PLAN.md §7). */
  jobBudgetMicroUsd: MicroUsd;
}

export const PRICE_TABLE: Readonly<Record<PackageId, PackageOffer>> = Object.freeze({
  trace_audit: {
    id: "trace_audit",
    name: "Trace Audit",
    priceMicroUsd: usd(PRICE_CENTS.trace_audit / 100),
    billing: "one_time",
    inputNeeded: "Agent transcript or tool log (JSON or text, up to 200 KB)",
    deliverables: [
      "Every success claim matched to evidence in your log",
      "Unsupported claims, ignored tool errors, instruction concerns, unsafe actions",
      "Investigator re-check with confirmed / rubric concern / inconclusive labels",
      "Markdown and JSON report",
    ],
    jobBudgetMicroUsd: usd(3),
  },
  text_eval: {
    id: "text_eval",
    name: "Text Eval",
    priceMicroUsd: usd(PRICE_CENTS.text_eval / 100),
    billing: "one_time",
    inputNeeded: "OpenAI-compatible endpoint, system prompt, optional reference text",
    deliverables: [
      "12 reviewed scenarios frozen as an exportable suite",
      "Objective checks plus labeled rubric judgments",
      "Up to 3 candidate failures re-run to confirm",
      "Markdown and JSON report",
    ],
    jobBudgetMicroUsd: usd(3),
  },
  workflow_eval: {
    id: "workflow_eval",
    name: "Workflow Eval",
    priceMicroUsd: usd(PRICE_CENTS.workflow_eval / 100),
    billing: "one_time",
    inputNeeded: "Endpoint that supports tool calls (runs in our calendar simulator)",
    deliverables: ["Calendar scenarios graded on resulting state", "Markdown and JSON report"],
    jobBudgetMicroUsd: usd(3),
  },
  version_comparison: {
    id: "version_comparison",
    name: "Version Comparison",
    priceMicroUsd: usd(PRICE_CENTS.version_comparison / 100),
    billing: "one_time",
    inputNeeded: "Two configs of either Text or Workflow Eval",
    deliverables: ["Same frozen suite on both versions", "Observed differences only (no significance claims)"],
    jobBudgetMicroUsd: usd(5),
  },
  monitoring_pilot: {
    id: "monitoring_pilot",
    name: "Monitoring pilot",
    priceMicroUsd: usd(MONITORING_PRICE_CENTS_MONTHLY / 100),
    billing: "monthly",
    inputNeeded: "A delivered Text or Workflow Eval with a frozen suite",
    deliverables: ["Nightly re-run of the frozen suite", "Regression alert by email"],
    jobBudgetMicroUsd: usd(3),
  },
});

export const priceLabel = (offer: PackageOffer): string =>
  `$${(offer.priceMicroUsd / 1_000_000).toFixed(0)}${offer.billing === "monthly" ? "/month" : ""}`;

/** Every dollar amount that may legitimately appear in agent-written customer text. */
export const ALLOWED_PRICE_STRINGS: readonly string[] = Object.values(PRICE_TABLE).flatMap((o) => {
  const whole = (o.priceMicroUsd / 1_000_000).toFixed(0);
  return [`$${whole}`, `$${whole}.00`];
});

/**
 * Returns dollar amounts in `text` that are not in the fixed price table.
 * Used to reject agent output that invents prices, discounts or fees.
 */
export function findInventedPrices(text: string): string[] {
  const matches = text.match(/(?:US)?\$\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?(?:USD|dollars?)\b/gi) ?? [];
  return matches
    .map((m) => m.replace(/\s+/g, ""))
    .filter((m) => {
      const n = m.replace(/^(?:US)?\$/i, "$").replace(/(USD|dollars?)$/i, "");
      const normalized = n.startsWith("$") ? n : `$${n}`;
      return !ALLOWED_PRICE_STRINGS.includes(normalized.replace(/,/g, ""));
    });
}
