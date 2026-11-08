import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import { Eyebrow, Frame, PageShell, Stat } from "@/components/ui";
import { SUITE_VERSION, categoryLabel, percent, rate, type StoredFinding } from "@/server/leaderboard";
import { verifySignedToken } from "@/server/owner-policy";
import { scrubExcerpt } from "@/server/owner-emails";
import { LEADERBOARD_NAV, RateBar, SEVERITY_TEXT, SeverityDot, fmtDate } from "../../parts";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Your results · Standard Evals", robots: { index: false, follow: false } };
type Params = { params: Promise<{ token: string }> };

export default async function OwnerResultsPage({ params }: Params) {
  const { token } = await params;
  const p = verifySignedToken<{ a?: unknown }>("owner_results", decodeURIComponent(token));
  if (!p || typeof p.a !== "string") notFound();
  const a = schema.publicAgents, r = schema.publicAgentRuns;
  let agent, run;
  try {
    [agent] = await db().select({ id: a.id, name: a.name, visibility: a.visibility, status: a.status, ownerEmail: a.ownerEmail })
      .from(a).where(eq(a.id, p.a)).limit(1);
    if (agent) [run] = await db().select().from(r).where(and(eq(r.agentId, agent.id), eq(r.suiteVersion, SUITE_VERSION))).orderBy(desc(r.ranAt)).limit(1);
  } catch { notFound(); }
  if (!agent || !agent.ownerEmail) notFound();

  const findings = ((run?.findings as StoredFinding[] | undefined) ?? []);
  const cats = Object.entries(run?.byCategory ?? {});
  return (
    <PageShell nav={LEADERBOARD_NAV} active="/leaderboard">
      <Eyebrow className="mt-8">Private results</Eyebrow>
      <h1 className="t-h1 mt-5 text-fg">{agent.name}</h1>
      <p className="mt-4 text-[14px] text-muted">
        {agent.visibility === "public" ? "Your agent is listed on the public leaderboard." : "Your agent is private: it is not listed publicly."}
        {" "}Status: {agent.status.replace(/_/g, " ")}. Anyone with this link can see this page.
      </p>
      {!run ? (
        <p className="mt-10 text-[14px] text-muted">No completed run yet. Results appear here after the first test finishes.</p>
      ) : (
        <>
          <dl className="mt-10 grid grid-cols-2 gap-px border border-line-2 bg-line-2 md:grid-cols-3">
            {[
              ["Pass rate", percent(rate(run.passed, run.total)), `${run.passed} of ${run.total} scenarios`],
              ["Findings", String(findings.length), "failed scenarios"],
              ["Last run", fmtDate(new Date(run.ranAt)), `suite ${run.suiteVersion}`],
            ].map(([k, v, h]) => <div key={k} className="bg-bg p-5"><dt className="sr-only">{k}</dt><dd><Stat label={k!} value={v!} hint={h} /></dd></div>)}
          </dl>
          <section aria-labelledby="cat-h" className="mt-14">
            <h2 id="cat-h" className="t-h3 text-fg">Results by category</h2>
            <ul className="mt-6 divide-y divide-line">
              {cats.map(([k, v]) => (
                <li key={k} className="grid grid-cols-[1fr_auto] items-center gap-x-6 gap-y-2 py-3 sm:grid-cols-[220px_1fr_auto]">
                  <span className="text-[14px] text-fg-2">{categoryLabel(k)}</span>
                  <RateBar value={rate(v.passed, v.total)} label={categoryLabel(k)} className="col-span-2 row-start-2 sm:col-span-1 sm:row-start-auto" />
                  <span className="t-data text-subtle">{v.passed}/{v.total}</span>
                </li>
              ))}
            </ul>
          </section>
          <section aria-labelledby="find-h" className="mt-14">
            <h2 id="find-h" className="t-h3 text-fg">Findings</h2>
            {findings.length === 0 ? <p className="mt-4 text-[14px] text-muted">No failed scenarios in the latest run.</p> : (
              <Frame className="mt-6 bg-bg-raised">
                <ul className="divide-y divide-line">
                  {findings.map((f, i) => {
                    const ex = scrubExcerpt(f.excerpt, f.category);
                    return (
                      <li key={i} className="px-5 py-4">
                        <p className="flex items-center gap-2 text-[15px] text-fg"><SeverityDot severity={f.severity} />{f.title}</p>
                        <p className="mt-1.5 flex flex-wrap gap-x-3 font-mono text-[11px] uppercase text-subtle">
                          <span className={SEVERITY_TEXT[f.severity]}>{f.severity}</span><span>{categoryLabel(f.category)}</span>
                        </p>
                        {ex && <p className="mt-2 border-l border-line-3 pl-3 font-mono text-[12px] leading-[1.5] text-muted">{ex}</p>}
                      </li>
                    );
                  })}
                </ul>
              </Frame>
            )}
          </section>
        </>
      )}
    </PageShell>
  );
}
