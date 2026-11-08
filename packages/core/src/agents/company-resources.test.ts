import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { COMPANY_OUTCOMES, COMPANY_RESOURCE_REVISION, COMPANY_SKILLS, buildPricingMenuContent } from "./company-resources";
import { COMPANY_ROLE_DEFINITIONS } from "./company-roles";
import { PRICE_TABLE } from "../evals/pricing";

describe("versioned company resource contents", () => {
  it("provides content and integrity hashes for every referenced skill", () => {
    const referenced = new Set(Object.values(COMPANY_ROLE_DEFINITIONS).flatMap(role => role.skillNames));
    expect(new Set(COMPANY_SKILLS.map(skill => skill.slug))).toEqual(referenced);
    for (const skill of COMPANY_SKILLS) {
      expect(skill.sha256).toBe(createHash("sha256").update(skill.content).digest("hex"));
      expect(skill.content).toContain(`Content policy revision: ${COMPANY_RESOURCE_REVISION}`);
    }
  });
  it("derives quick-eval price units from code and defers other product pricing", () => {
    const text = buildPricingMenuContent();
    const data = JSON.parse(text.slice(text.indexOf("\n\n") + 2));
    expect(data.quickEvalOffers).toEqual(Object.values(PRICE_TABLE).map(o => ({ id: o.id, name: o.name, priceMicroUsd: o.priceMicroUsd, billing: o.billing, inputNeeded: o.inputNeeded, deliverables: o.deliverables })));
    expect(data.sandboxPlans).toBeUndefined();
    expect(text).toContain("pricing are deliberately omitted");
    expect(text).toContain("current authorized menu and quote from deterministic code");
  });
  it("provides bounded advisory outcomes for every manifest reference", () => {
    expect(COMPANY_OUTCOMES.map(o => o.name).sort()).toEqual(Object.values(COMPANY_ROLE_DEFINITIONS).flatMap(r => r.outcomeName ? [r.outcomeName] : []).sort());
    for (const outcome of COMPANY_OUTCOMES) {
      expect(outcome.max_iterations).toBe(2);
      expect(outcome.rubric).toContain("Advisory revision only");
      expect(outcome.rubric).toContain("never authorize an action");
    }
  });
});
