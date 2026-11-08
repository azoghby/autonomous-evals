import type { Metadata } from "next";
import { inArray, and, eq } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import { verifySignedToken } from "@/server/owner-policy";
import { parseApproveAll, type ApproveAllPayload } from "@/server/outreach-approve";
import { ApproveAllButton } from "./ApproveAllButton";

export const metadata: Metadata = { title: "Approve outreach", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

// Read-only on GET (link scanners prefetch): verifies the signed link and lists drafts; the POST happens from the button.
export default async function ApproveAllPage({ searchParams }: { searchParams: Promise<{ t?: string }> }) {
  const { t } = await searchParams;
  const parsed = t ? parseApproveAll(verifySignedToken<ApproveAllPayload>("approve_all", t)) : null;
  if (!t || !parsed) {
    return <main style={{ maxWidth: 640, margin: "48px auto", padding: "0 16px" }}><h1>Link not valid</h1><p>This approval link is invalid, expired, or no longer authorized. Open the operator console instead.</p></main>;
  }
  const d = schema.outreachDrafts;
  const drafts = parsed.ids.length
    ? await db().select({ id: d.id, kind: d.kind, toEmail: d.toEmail, subject: d.subject }).from(d)
        .where(and(inArray(d.id, parsed.ids), eq(d.status, "pending")))
    : [];
  return (
    <main style={{ maxWidth: 640, margin: "48px auto", padding: "0 16px" }}>
      <h1>Approve outreach</h1>
      {drafts.length === 0 ? <p>Nothing pending: these drafts were already handled.</p> : (
        <>
          <p>{drafts.length} pending draft{drafts.length === 1 ? "" : "s"}. Nothing is sent until you click the button.</p>
          <ul>{drafts.map((x) => <li key={x.id}>[{x.kind}] {x.toEmail}: {x.subject}</li>)}</ul>
          <ApproveAllButton token={t} count={drafts.length} />
        </>
      )}
    </main>
  );
}
