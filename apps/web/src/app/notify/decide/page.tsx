import type { Metadata } from "next";
import { verifySignedToken } from "@/server/owner-policy";
import { parseDecisionToken } from "@/server/notify/approvals-logic";
import { getApprovalById, toMessage } from "@/server/notify/approvals";
import { DecideButton } from "./DecideButton";

export const metadata: Metadata = { title: "Confirm decision", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

const wrap = { maxWidth: 560, margin: "48px auto", padding: "0 16px", fontFamily: "system-ui, sans-serif", lineHeight: 1.5 } as const;

// GET never mutates (email link scanners prefetch). The decision happens only on the button's POST.
export default async function DecidePage({ searchParams }: { searchParams: Promise<{ t?: string }> }) {
  const { t } = await searchParams;
  const payload = t ? parseDecisionToken(verifySignedToken("founder_decision", t)) : null;
  if (!t || !payload) {
    return <main style={wrap}><h1>Link not valid</h1><p>This link is invalid or expired (links last 24 hours). Open the operator console instead.</p></main>;
  }
  const row = await getApprovalById(payload.aid);
  if (!row) return <main style={wrap}><h1>Not found</h1><p>This approval no longer exists.</p></main>;
  const msg = toMessage({ id: row.id, seq: row.seq, kind: row.kind, title: row.title, summary: row.summary, ref: row.ref, payload: {} }, row.status === "fyi");
  const label = payload.d === "approve" ? (msg.actions?.approveLabel ?? "Approve") : (msg.actions?.rejectLabel ?? "Reject");
  return (
    <main style={wrap}>
      <p style={{ color: "#666", margin: 0 }}>#{row.seq} · {row.kind}</p>
      <h1 style={{ marginTop: 4 }}>{row.title}</h1>
      <p>{row.summary}</p>
      {row.status !== "pending" ? (
        <p role="status"><strong>Already {row.status}.</strong> Nothing to do.</p>
      ) : (
        <DecideButton token={t} label={label} danger={payload.d === "reject"} />
      )}
      <p style={{ marginTop: 24 }}><a href={msg.viewUrl}>Open the operator console</a></p>
    </main>
  );
}
