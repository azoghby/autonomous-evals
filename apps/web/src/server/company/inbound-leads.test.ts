import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const returning = vi.fn();
const values = vi.fn(() => ({ onConflictDoNothing: () => ({ returning }) }));
vi.mock("@ae/core/db/client", () => ({
  db: () => ({ insert: () => ({ values }) }),
  schema: { prospectLeads: { id: "id" } },
}));

import { INBOUND_CONTACT_SOURCE, INBOUND_FIT_SCORE, buildInboundProspect, planForVolume, routeSalesLeadToPipeline } from "./inbound-leads";

const lead = {
  id: "11111111-2222-3333-4444-555555555555",
  name: "Ada Lovelace",
  workEmail: "Ada@app.Analytical.co",
  company: "Analytical Co",
  agentDescription: "Support agent with Zendesk and Stripe tools.",
  volume: "10k-100k",
};
const APP = "https://standard-evals.vercel.app";

describe("planForVolume", () => {
  it("maps volume buckets to the plan the SDR pitches", () => {
    expect(planForVolume("<1k trials/mo")).toBe("pro");
    expect(planForVolume("1k-10k")).toBe("scale");
    expect(planForVolume("10k-100k")).toBe("enterprise");
    expect(planForVolume("100k+")).toBe("enterprise");
    expect(planForVolume("not sure")).toBe("enterprise");
  });
});

describe("buildInboundProspect", () => {
  it("derives the registrable domain, keeps the contact and ranks above cold prospects", () => {
    const r = buildInboundProspect(lead, APP);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.row).toMatchObject({
      domain: "analytical.co", contactEmail: "ada@app.analytical.co", contactName: "Ada Lovelace",
      contactSource: INBOUND_CONTACT_SOURCE, fitScore: INBOUND_FIT_SCORE, recommendedPlan: "enterprise", status: "new",
    });
    expect(r.row.evidence[0]?.url).toBe(`${APP}/contact-sales`);
  });

  it("keeps free-mail and no-reply leads out of the pipeline", () => {
    expect(buildInboundProspect({ ...lead, workEmail: "ada@gmail.com" }, APP)).toEqual({ ok: false, reason: "free_mail" });
    expect(buildInboundProspect({ ...lead, workEmail: "noreply@analytical.co" }, APP)).toEqual({ ok: false, reason: "non_contact_role" });
    expect(buildInboundProspect({ ...lead, workEmail: "nope" }, APP).ok).toBe(false);
  });
});

describe("routeSalesLeadToPipeline", () => {
  beforeEach(() => { returning.mockReset(); values.mockClear(); });

  it("inserts a new prospect", async () => {
    returning.mockResolvedValue([{ id: "p1" }]);
    expect(await routeSalesLeadToPipeline(lead, APP)).toEqual({ routed: true, domain: "analytical.co" });
    expect(values).toHaveBeenCalledTimes(1);
  });

  it("never overwrites an existing prospect for the domain", async () => {
    returning.mockResolvedValue([]);
    expect(await routeSalesLeadToPipeline(lead, APP)).toEqual({ routed: false, reason: "domain_already_in_pipeline" });
  });

  it("does not touch the db for free mail", async () => {
    expect(await routeSalesLeadToPipeline({ ...lead, workEmail: "a@outlook.com" }, APP)).toEqual({ routed: false, reason: "free_mail" });
    expect(values).not.toHaveBeenCalled();
  });
});
