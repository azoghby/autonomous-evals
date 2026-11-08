import "server-only";
/**
 * Inbound enterprise leads (/contact-sales) -> company-agent pipeline.
 * The person gave us their work email and asked to be contacted, so the lead goes into prospect_leads with a high fit
 * score; the Outreach/SDR agent then drafts a reply that waits for founder approval like every other draft.
 * Nothing here sends email.
 */
import { db, schema } from "@ae/core/db/client";
import { acceptPublicWorkEmail, normalizeDomain } from "@ae/core/company/research";
import type { PlanId } from "@ae/core/pricing/plans";

/** Above every cold prospect score the prospecting agent assigns in practice: they asked us. */
export const INBOUND_FIT_SCORE = 95;
export const INBOUND_SEGMENT = "inbound (requested contact via /contact-sales)";
export const INBOUND_CONTACT_SOURCE = "inbound:contact_sales";

export interface InboundLead {
  id: string;
  name: string;
  workEmail: string;
  company: string;
  agentDescription: string;
  volume: string;
}

export type RouteResult = { routed: true; domain: string } | { routed: false; reason: string };

/** Volume bucket (sales-leads VOLUMES) -> plan the SDR should pitch. */
export function planForVolume(volume: string): PlanId {
  if (volume === "<1k trials/mo") return "pro";
  if (volume === "1k-10k") return "scale";
  return "enterprise";
}

export interface InboundProspectRow {
  domain: string;
  company: string;
  segment: string;
  agentDescription: string;
  evidence: Array<{ url: string; note?: string }>;
  fitScore: number;
  fitReason: string;
  recommendedPlan: PlanId;
  contactEmail: string;
  contactName: string;
  contactRole: string | null;
  contactSource: string;
  status: "new";
}

/** Pure: builds the prospect row, or explains why the lead stays sales-lead only (free mail, malformed, no-reply...). */
export function buildInboundProspect(lead: InboundLead, appUrl: string): { ok: true; row: InboundProspectRow } | { ok: false; reason: string } {
  const email = lead.workEmail.trim().toLowerCase();
  const host = email.split("@")[1] ?? "";
  const domain = host ? normalizeDomain(host) : null;
  if (!domain) return { ok: false, reason: "malformed" };
  const sourceUrl = `${appUrl.replace(/\/$/, "")}/contact-sales`;
  const accepted = acceptPublicWorkEmail(email, domain, sourceUrl);
  if (!accepted.ok) return { ok: false, reason: accepted.reason };
  return {
    ok: true,
    row: {
      domain,
      company: lead.company,
      segment: INBOUND_SEGMENT,
      agentDescription: lead.agentDescription,
      evidence: [{ url: sourceUrl, note: `They contacted us (expected volume ${lead.volume}); reply to their request` }],
      fitScore: INBOUND_FIT_SCORE,
      fitReason: `Inbound request via /contact-sales (volume ${lead.volume}, sales lead ${lead.id.slice(0, 8)})`,
      recommendedPlan: planForVolume(lead.volume),
      contactEmail: accepted.email,
      contactName: lead.name,
      contactRole: null,
      contactSource: INBOUND_CONTACT_SOURCE,
      status: "new",
    },
  };
}

/** Inserts the inbound prospect. An existing prospect for the domain is left untouched (dedupe by domain). */
export async function routeSalesLeadToPipeline(
  lead: InboundLead,
  appUrl: string = process.env.APP_URL ?? "https://standard-evals.vercel.app",
): Promise<RouteResult> {
  const built = buildInboundProspect(lead, appUrl);
  if (!built.ok) return { routed: false, reason: built.reason };
  const rows = await db().insert(schema.prospectLeads).values(built.row).onConflictDoNothing().returning({ id: schema.prospectLeads.id });
  if (rows.length === 0) return { routed: false, reason: "domain_already_in_pipeline" };
  return { routed: true, domain: built.row.domain };
}
