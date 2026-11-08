import "server-only";
import { and, asc, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import { MIN_FIT_SCORE, SDR_KINDS } from "@ae/core/company/outreach";
import { appUrl, companyAddress, isSuppressed, suppressEmail, unsubscribeUrl } from "../owner-shared";

export interface OutreachLead {
  id: string; domain: string; company: string; segment: string; agentDescription: string;
  evidence: Array<{ url: string; note?: string }>; fitScore: number; recommendedPlan: string;
  contactEmail: string; contactName: string | null; contactRole: string | null;
}
export interface FollowUpLead extends OutreachLead { lastDraftAt: Date | null; hasPendingDraft: boolean }

/** All DB access for the outreach agent. Injected in tests. None of these sends email. */
export interface OutreachStore {
  countSdrDraftsSince(since: Date): Promise<number>;
  newLeads(limit: number): Promise<OutreachLead[]>;
  followUpLeads(): Promise<FollowUpLead[]>;
  isSuppressed(email: string): Promise<boolean>;
  recentDraftExists(email: string, domain: string, since: Date): Promise<boolean>;
  insertDraft(row: { toEmail: string; subject: string; body: string; kind: string }): Promise<string>;
  setLead(id: string, patch: { status: string; outreachDraftId?: string }): Promise<void>;
  matchLeadByEmail(email: string): Promise<{ id: string } | null>;
  suppress(email: string): Promise<void>;
  rejectPendingDrafts(email: string): Promise<void>;
  appUrl(): string;
  companyAddress(): string;
  unsubscribeUrl(email: string): string;
}

const L = schema.prospectLeads;
const D = schema.outreachDrafts;
const leadCols = {
  id: L.id, domain: L.domain, company: L.company, segment: L.segment, agentDescription: L.agentDescription,
  evidence: L.evidence, fitScore: L.fitScore, recommendedPlan: L.recommendedPlan,
  contactEmail: L.contactEmail, contactName: L.contactName, contactRole: L.contactRole,
};
const lowerEmail = (e: string) => e.trim().toLowerCase();

export function drizzleOutreachStore(): OutreachStore {
  return {
    async countSdrDraftsSince(since) {
      const [r] = await db().select({ n: sql<number>`count(*)` }).from(D)
        .where(and(inArray(D.kind, [...SDR_KINDS]), gte(D.createdAt, since)));
      return Number(r?.n ?? 0);
    },
    async newLeads(limit) {
      const rows = await db().select(leadCols).from(L)
        .where(and(eq(L.status, "new"), isNotNull(L.contactEmail), gte(L.fitScore, MIN_FIT_SCORE)))
        .orderBy(desc(L.fitScore), asc(L.createdAt)).limit(limit);
      return rows.filter((r): r is typeof r & { contactEmail: string } => !!r.contactEmail);
    },
    async followUpLeads() {
      const rows = await db().select(leadCols).from(L)
        .where(and(inArray(L.status, ["replied", "opted_in"]), isNotNull(L.contactEmail))).limit(50);
      const out: FollowUpLead[] = [];
      for (const r of rows) {
        if (!r.contactEmail) continue;
        const drafts = await db().select({ status: D.status, createdAt: D.createdAt }).from(D)
          .where(sql`lower(${D.toEmail}) = ${lowerEmail(r.contactEmail)}`).orderBy(desc(D.createdAt));
        out.push({ ...r, contactEmail: r.contactEmail, lastDraftAt: drafts[0]?.createdAt ?? null, hasPendingDraft: drafts.some((d) => d.status === "pending") });
      }
      return out;
    },
    isSuppressed,
    async recentDraftExists(email, domain, since) {
      const [r] = await db().select({ id: D.id }).from(D)
        .where(and(gte(D.createdAt, since), sql`(lower(${D.toEmail}) = ${lowerEmail(email)} or lower(${D.toEmail}) like ${`%@${domain.toLowerCase()}`})`)).limit(1);
      return !!r;
    },
    async insertDraft(row) {
      const [r] = await db().insert(D).values({ ...row, toEmail: lowerEmail(row.toEmail), status: "pending" }).returning({ id: D.id });
      return r.id;
    },
    async setLead(id, patch) {
      await db().update(L).set({ ...patch, updatedAt: new Date() }).where(eq(L.id, id));
    },
    async matchLeadByEmail(email) {
      const [r] = await db().select({ id: L.id }).from(L).where(sql`lower(${L.contactEmail}) = ${lowerEmail(email)}`).limit(1);
      return r ?? null;
    },
    suppress: (email) => suppressEmail(email, "prospect_opt_out"),
    async rejectPendingDrafts(email) {
      await db().update(D).set({ status: "rejected" })
        .where(and(eq(D.status, "pending"), sql`lower(${D.toEmail}) = ${lowerEmail(email)}`));
    },
    appUrl, companyAddress, unsubscribeUrl,
  };
}
