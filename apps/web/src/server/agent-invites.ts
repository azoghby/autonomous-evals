import "server-only";
import { notifyOutreachDraft } from "./notify/hooks";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import { appUrl, companyAddress, isSuppressed } from "./owner-shared";

export const AGENT_INVITE_DEDUPE_MS = 90 * 24 * 60 * 60 * 1000;

export interface AgentInviteInput { toEmail: string; agentName: string; vendor: string; note?: string }
export type AgentInviteResult = { status: "drafted"; id: string } | { status: "suppressed" | "duplicate" };

export function buildAgentInvite(i: AgentInviteInput): { subject: string; body: string } {
  const submit = `${appUrl()}/leaderboard/submit`;
  const note = i.note?.trim();
  const body = [
    `Hello ${i.vendor} team,`,
    "",
    "This email was written by Standard Evals' AI agents and sent after a human on our team approved it.",
    "",
    `We run a public benchmark suite for AI agents. We would like to offer a free benchmark of ${i.agentName} on our public standard suite.`,
    "",
    "To be clear: we have not tested your agent. We will only run anything if you choose to submit it and authorize testing at:",
    submit,
    "",
    ...(note ? [note, ""] : []),
    "If this is not for you, reply 'no thanks' and we'll never email again.",
    "",
    "Standard Evals",
    companyAddress(),
  ].join("\n");
  return { subject: `Free benchmark of ${i.agentName} on a public standard suite`, body };
}

/** Inserts a PENDING agent_invite draft for operator approval. Never sends. */
export async function draftAgentInvite(i: AgentInviteInput): Promise<AgentInviteResult> {
  const toEmail = i.toEmail.trim().toLowerCase();
  if (await isSuppressed(toEmail)) return { status: "suppressed" };
  const d = schema.outreachDrafts;
  const [dup] = await db().select({ id: d.id }).from(d).where(and(
    eq(d.kind, "agent_invite"), inArray(d.status, ["pending", "sent"]),
    sql`lower(${d.toEmail}) = ${toEmail}`, gt(d.createdAt, new Date(Date.now() - AGENT_INVITE_DEDUPE_MS)),
  )).limit(1);
  if (dup) return { status: "duplicate" };
  const { subject, body } = buildAgentInvite(i);
  const [row] = await db().insert(d).values({ toEmail, subject, body, kind: "agent_invite", status: "pending" }).returning({ id: d.id });
  await notifyOutreachDraft({ id: row.id, kind: "agent_invite", toEmail, subject });
  return { status: "drafted", id: row.id };
}
