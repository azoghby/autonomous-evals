import "server-only";
import { createHash } from "node:crypto";
import { desc } from "drizzle-orm";
import { z } from "zod";
import { db } from "@ae/core/db/client";
import { salesLeads } from "@ae/core/db/schema";
import { alertOperators, redactAlertText } from "./operator-alerts";
import { rateLimit } from "./rate-limit";
import { notifySalesLead } from "./notify/hooks";

export const VOLUMES = ["<1k trials/mo", "1k-10k", "10k-100k", "100k+", "not sure"] as const;
export const LEAD_RATE_LIMIT = 5;
export const LEAD_RATE_WINDOW_SECONDS = 3600;
export const LEADS_PAGE_SIZE = 25;

const trimmed = (min: number, max: number) => z.string().trim().min(min).max(max);

export const salesLeadInput = z.object({
  name: trimmed(1, 200),
  workEmail: z.string().trim().toLowerCase().max(320).pipe(z.email()),
  company: trimmed(1, 200),
  agentDescription: trimmed(10, 4000),
  volume: z.enum(VOLUMES),
  /** Honeypot: real users never see or fill this. */
  website: z.string().max(500).optional(),
});
export type SalesLeadInput = z.infer<typeof salesLeadInput>;

export type ParsedLead =
  | { kind: "invalid"; fieldErrors: Record<string, string[]> }
  | { kind: "honeypot" }
  | { kind: "lead"; lead: Omit<SalesLeadInput, "website"> };

/** Pure validation + honeypot check. A filled honeypot short-circuits before field validation so bots learn nothing. */
export function parseSalesLead(raw: unknown): ParsedLead {
  const website = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).website : undefined;
  if (typeof website === "string" && website.trim() !== "") return { kind: "honeypot" };
  const parsed = salesLeadInput.safeParse(raw);
  if (!parsed.success) {
    return { kind: "invalid", fieldErrors: z.flattenError(parsed.error).fieldErrors as Record<string, string[]> };
  }
  const { website: _w, ...lead } = parsed.data;
  return { kind: "lead", lead };
}

export const hashIp = (ip: string) => createHash("sha256").update(ip).digest("hex");

export type SubmitResult =
  | { ok: true }
  | { ok: false; status: 400; fieldErrors: Record<string, string[]> }
  | { ok: false; status: 429; retryAfter: number };

/** Validates, rate-limits, stores and announces a lead. Operator notification failure never fails the request. */
export async function submitSalesLead(raw: unknown, ip: string): Promise<SubmitResult> {
  const parsed = parseSalesLead(raw);
  if (parsed.kind === "honeypot") return { ok: true };
  if (parsed.kind === "invalid") return { ok: false, status: 400, fieldErrors: parsed.fieldErrors };

  const ipHash = hashIp(ip);
  const rl = await rateLimit(`contact-sales:${ipHash}`, LEAD_RATE_LIMIT, LEAD_RATE_WINDOW_SECONDS);
  if (!rl.ok) return { ok: false, status: 429, retryAfter: rl.retryAfter };

  const { lead } = parsed;
  const [row] = await db().insert(salesLeads).values({ ...lead, ipHash }).returning({ id: salesLeads.id });

  try {
    await alertOperators({
      // kind is part of the dedupe key; include the lead id so every lead alerts.
      kind: `sales_lead:${row?.id.slice(0, 8) ?? "new"}`,
      title: `New enterprise lead: ${lead.company}`,
      detail: redactAlertText(`${lead.name} <${lead.workEmail}>, volume ${lead.volume}. ${lead.agentDescription}`),
      severity: "info",
    });
  } catch (err) {
    console.error("sales lead alert failed", err instanceof Error ? err.message : String(err));
  }
  if (row) await notifySalesLead({ id: row.id, company: lead.company, name: lead.name, volume: lead.volume, agentDescription: lead.agentDescription });
  if (row) {
    // Hand the lead to the SDR agent (draft only, founder approves before anything is sent). Never fails the request.
    try {
      const { routeSalesLeadToPipeline } = await import("./company/inbound-leads");
      await routeSalesLeadToPipeline({ id: row.id, ...lead });
    } catch (err) {
      console.error("sales lead pipeline routing failed", err instanceof Error ? err.message : String(err));
    }
  }
  return { ok: true };
}

export interface SalesLeadRow {
  id: string;
  createdAt: string;
  name: string;
  company: string;
  workEmail: string;
  volume: string;
  status: string;
  agentDescription: string;
}

/** Latest leads for the operator console (caller enforces operator auth). */
export async function listRecentSalesLeads(limit = LEADS_PAGE_SIZE): Promise<SalesLeadRow[]> {
  const rows = await db().select().from(salesLeads).orderBy(desc(salesLeads.createdAt)).limit(limit);
  return rows.map((r) => ({
    id: r.id,
    createdAt: new Date(r.createdAt).toISOString(),
    name: r.name,
    company: r.company,
    workEmail: r.workEmail,
    volume: r.volume,
    status: r.status,
    agentDescription: r.agentDescription,
  }));
}
