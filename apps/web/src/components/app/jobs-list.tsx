"use client";
import Link from "next/link";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { dollars, PACKAGE_LABEL, when } from "@/lib/client/api";
import { PRICE_CENTS } from "@ae/core/contracts/index";
import { useFetch } from "@/lib/client/use-fetch";
import type { JobSummary } from "@/lib/client/types";
import { Button, Chip, StatusChip } from "@/components/ui";
import { ErrorBox, Loading } from "./ui";
import { PageHead } from "./page-parts";

const TH = "t-eyebrow h-11 border-b border-line-2 px-4 text-left font-normal text-subtle first:pl-5 last:pr-5";

export function JobsList() {
  const router = useRouter();
  const { data, error, loading, reload } = useFetch<{ jobs: JobSummary[] } | JobSummary[]>("/api/jobs");
  useEffect(() => { if (error?.status === 401) router.replace("/signin?next=/jobs"); }, [error, router]);

  const jobs = data ? (Array.isArray(data) ? data : data.jobs ?? []) : [];
  return (
    <>
      <PageHead
        eyebrow="Jobs"
        title="My jobs"
        lead="Every request you have submitted, newest first."
        meta={!loading && !error ? <span className="t-data">{jobs.length} {jobs.length === 1 ? "job" : "jobs"}</span> : undefined}
        actions={<Button href="/start">New request</Button>}
      />
      {loading ? <Loading /> : error && error.status !== 401 ? <ErrorBox message={error.message} onRetry={reload} />
        : jobs.length === 0 ? (
          <div className="rounded-[4px] border border-line-2 bg-bg-raised px-6 py-14 sm:px-10">
            <p className="t-eyebrow text-subtle">No jobs yet</p>
            <h2 className="t-h3 mt-4 text-fg">Start with a Trace Audit.</h2>
            <p className="mt-2 max-w-[52ch] text-[15px] text-muted">Paste an agent transcript and get an evidence-backed report.</p>
            <Button href="/start" className="mt-6">Start a request</Button>
          </div>
        ) : (
          <div className="overflow-hidden rounded-[4px] border border-line-2 bg-bg-raised">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr>
                  <th scope="col" className={TH}>Package</th>
                  <th scope="col" className={`${TH} hidden sm:table-cell`}>Created</th>
                  <th scope="col" className={TH}>Status</th>
                  <th scope="col" className={`${TH} text-right`}>Price</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id} className="group relative h-14 border-b border-line transition-colors duration-150 last:border-b-0 hover:bg-bg-hover sm:h-12">
                    <td className="px-4 py-2 pl-5">
                      <Link href={`/jobs/${j.id}`} className="text-[15px] text-fg after:absolute after:inset-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent">
                        {PACKAGE_LABEL[j.package] ?? j.package}
                      </Link>
                      {j.environment === "test" && <Chip tone="warn" className="ml-3 align-middle">Test</Chip>}
                      <span className="t-data mt-0.5 block text-subtle sm:hidden">{when(j.createdAt)}</span>
                    </td>
                    <td className="t-data hidden px-4 text-muted sm:table-cell">{when(j.createdAt)}</td>
                    <td className="px-4"><StatusChip status={j.state} /></td>
                    <td className="t-data px-4 pr-5 text-right text-fg">{dollars(j.priceCents ?? PRICE_CENTS[j.package] ?? 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </>
  );
}
