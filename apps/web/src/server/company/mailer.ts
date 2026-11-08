import "server-only";
/**
 * The ONLY path by which a company agent may send an email directly (used by the onboarding agent, to signed-up
 * customers on threads they started). Outreach to prospects never comes here: it goes through outreach_drafts and
 * the operator approve route. Dry-run (ctx.dryRun, COMPANY_EMAIL_DRY_RUN=1, or no transport) records instead of sending.
 */
import { isEmailConfigured, sendEmail, type SentEmail } from "@ae/core/auth/email";
import { isSuppressed } from "../owner-shared";

export interface CompanyEmail { to: string; subject: string; text: string; labels?: string[]; headers?: Record<string, string>; replyTo?: string }
export type CompanyEmailResult =
  | { status: "sent"; sent: SentEmail }
  | { status: "dry_run"; to: string; subject: string }
  | { status: "suppressed" };

export type Transport = (msg: Parameters<typeof sendEmail>[0]) => Promise<SentEmail>;

export function emailDryRun(dryRun: boolean, env: Record<string, string | undefined> = process.env): boolean {
  return dryRun || env.COMPANY_EMAIL_DRY_RUN === "1" || !isEmailConfigured();
}

export async function sendCompanyEmail(
  msg: CompanyEmail,
  opts: { dryRun: boolean; transport?: Transport; suppressed?: (email: string) => Promise<boolean> },
): Promise<CompanyEmailResult> {
  const to = msg.to.trim().toLowerCase();
  if (await (opts.suppressed ?? isSuppressed)(to)) return { status: "suppressed" };
  const dry = opts.dryRun || process.env.COMPANY_EMAIL_DRY_RUN === "1" || (!opts.transport && !isEmailConfigured());
  if (dry) return { status: "dry_run", to, subject: msg.subject };
  const sent = await (opts.transport ?? sendEmail)({ to, subject: msg.subject, text: msg.text, purpose: "commercial", labels: ["company_agent", ...(msg.labels ?? [])],
    ...(msg.headers ? { headers: msg.headers } : {}), ...(msg.replyTo ? { replyTo: msg.replyTo } : {}) });
  return { status: "sent", sent };
}
