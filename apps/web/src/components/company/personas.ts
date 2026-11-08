/** Joins org-chart nodes (packages/core/src/company/registry.ts) to the landing "Meet the team" roster for names and bios. */
import { ROSTER, type TeamAgent } from "@/components/marketing/team/roster";

/** org-chart id -> roster id */
export const ORG_TO_ROSTER: Readonly<Record<string, string>> = Object.freeze({
  planner: "cass",
  market_research: "mara",
  prospecting: "pax",
  outreach: "otto",
  onboarding: "nova",
  commercial: "cora",
  evaluation_engineer: "ezra",
  sandbox_simulator: "remy",
  quality_investigator: "ines",
  company_operator: "wren",
  owner_responder: "olive",
  public_benchmarker: "lev",
});

const BY_ID = new Map(ROSTER.map((a) => [a.id, a]));

export function personaFor(orgId: string): TeamAgent | null {
  const rosterId = ORG_TO_ROSTER[orgId];
  return rosterId ? (BY_ID.get(rosterId) ?? null) : null;
}
