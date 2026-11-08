"use client";
import { useState } from "react";
import { useFetch } from "@/lib/client/use-fetch";
import { api, errMsg, when } from "@/lib/client/api";
import type { FeedbackRow, InviteRow } from "@/server/feedback";
import { Frame } from "@/components/ui";
import { Banner, Btn, Empty, ErrorBox, Loading, Section, TableWrap, Th, tableCls, tdCls, trCls } from "./ui";

const dash = (s: string | null) => s || "—";
const approvable = (r: FeedbackRow) => !!r.invite && r.quoteConsent && !!r.quote?.trim();

/** Operator-only: /feedback answers plus invite send/reply status (GET /api/operator/feedback). */
export function OperatorFeedback() {
  const { data, error, loading, reload } = useFetch<{ responses: FeedbackRow[]; invites: InviteRow[] }>("/api/operator/feedback");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  async function setApproval(id: string, approved: boolean) {
    setBusyId(id); setNotice(null);
    try {
      await api(`/api/operator/feedback/${id}/approval`, { method: "POST", json: { approved } });
      setNotice({ ok: true, text: approved ? "Quote approved; it now shows on the homepage." : "Quote hidden from the homepage." });
      await reload();
    } catch (e) { setNotice({ ok: false, text: errMsg(e) }); } finally { setBusyId(null); }
  }
  if (loading) return <Section title="Builder feedback"><Loading label="Loading feedback" /></Section>;
  if (error || !data) return <Section title="Builder feedback"><ErrorBox message={error?.message ?? "Unknown error"} onRetry={reload} /></Section>;
  const replies = data.invites.filter((i) => i.replyText);
  return (
    <>
      <Section title="Builder feedback">
        {notice && <div className="mb-4"><Banner tone={notice.ok ? "ok" : "bad"}>{notice.text}</Banner></div>}
        <Frame>
          {data.responses.length === 0 ? <Empty title="No responses yet" body="Answers from /feedback appear here." /> : (
            <TableWrap>
              <table className={tableCls}>
                <thead><tr><Th>When</Th><Th>From</Th><Th>Would use</Th><Th>Must-have</Th><Th>Pay / mo</Th><Th>Quote</Th><Th>Public OK</Th><Th>Homepage</Th></tr></thead>
                <tbody>
                  {data.responses.map((r) => (
                    <tr key={r.id} className={trCls}>
                      <td className={tdCls}>{when(r.createdAt)}</td>
                      <td className={tdCls}>{[r.name, r.company].filter(Boolean).join(", ") || (r.invite ? `${r.invite.org} (invite)` : "anonymous")}</td>
                      <td className={tdCls}>{r.wouldUse}</td>
                      <td className={`${tdCls} max-w-xs whitespace-pre-wrap`}>{dash(r.mustHave)}</td>
                      <td className={tdCls}>{dash(r.pricePerMonth)}</td>
                      <td className={`${tdCls} max-w-xs whitespace-pre-wrap`}>{dash(r.quote)}</td>
                      <td className={tdCls}>{r.quoteConsent ? (r.invite ? "yes" : "yes (anon, hidden)") : "no"}</td>
                      <td className={tdCls}>
                        {r.quoteApprovedAt ? (
                          <span className="flex items-center gap-3">
                            <span>shown as {r.invite?.org}</span>
                            <Btn size="sm" variant="ghost" loading={busyId === r.id} disabled={busyId !== null} onClick={() => setApproval(r.id, false)}>Unapprove</Btn>
                          </span>
                        ) : approvable(r) ? (
                          <Btn size="sm" variant="primary" loading={busyId === r.id} disabled={busyId !== null} onClick={() => setApproval(r.id, true)}>Approve</Btn>
                        ) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Frame>
      </Section>
      <div className="mt-12">
        <Section title={`Feedback invites (${data.invites.filter((i) => i.sentAt).length} sent, ${replies.length} email replies)`}>
          <Frame>
            {data.invites.length === 0 ? <Empty title="No invites yet" body="scripts/feedback-outreach.ts records each send here." /> : (
              <TableWrap>
                <table className={tableCls}>
                  <thead><tr><Th>Org</Th><Th>Contact</Th><Th>Status</Th><Th>Sent</Th><Th>Email reply</Th></tr></thead>
                  <tbody>
                    {data.invites.map((i) => (
                      <tr key={i.id} className={trCls}>
                        <td className={tdCls}><a className="underline-offset-4 hover:underline" href={i.sourceUrl} target="_blank" rel="noopener noreferrer">{i.org}</a></td>
                        <td className={tdCls}><a className="underline-offset-4 hover:underline" href={`mailto:${i.email}`}>{i.name ?? i.email}</a></td>
                        <td className={tdCls}>{i.status}</td>
                        <td className={tdCls}>{i.sentAt ? when(i.sentAt) : "—"}</td>
                        <td className={`${tdCls} max-w-md whitespace-pre-wrap`}>{i.replyText ? `${when(i.repliedAt ?? "")}: ${i.replyText.slice(0, 600)}` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            )}
          </Frame>
        </Section>
      </div>
    </>
  );
}
