"use client";
import Link from "next/link";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { dollars, PACKAGE_LABEL, when } from "@/lib/client/api";
import { PRICE_CENTS } from "@ae/core/contracts/index";
import { useFetch } from "@/lib/client/use-fetch";
import type { JobSummary } from "@/lib/client/types";
import { Chip, Empty, ErrorBox, Glass, Loading, LinkBtn, PageTitle, StateChip } from "./ui";

export function JobsList() {
  const router = useRouter();
  const { data, error, loading, reload } = useFetch<{ jobs: JobSummary[] } | JobSummary[]>("/api/jobs");
  useEffect(() => { if (error?.status === 401) router.replace("/signin?next=/jobs"); }, [error, router]);

  const jobs = data ? (Array.isArray(data) ? data : data.jobs ?? []) : [];
  return (
    <>
      <PageTitle title="My jobs" right={<LinkBtn href="/start">New request</LinkBtn>} />
      {loading ? <Loading /> : error && error.status !== 401 ? <ErrorBox message={error.message} onRetry={reload} />
        : jobs.length === 0 ? <Empty title="No jobs yet" body="Start with a Trace Audit: paste an agent transcript and get an evidence-backed report." action={<LinkBtn href="/start">Start a request</LinkBtn>} />
        : (
          <ul className="space-y-3">
            {jobs.map((j) => (
              <li key={j.id}>
                <Link href={`/jobs/${j.id}`} className="block">
                  <Glass className="flex flex-wrap items-center justify-between gap-3 transition hover:bg-glass-strong">
                    <div>
                      <div className="font-semibold">{PACKAGE_LABEL[j.package] ?? j.package}</div>
                      <div className="text-xs text-cream/60">{when(j.createdAt)}</div>
                    </div>
                    <div className="flex items-center gap-3">
                      {j.environment === "test" && <Chip tone="warn">TEST MODE</Chip>}
                      <span className="text-sm tabular-nums">{dollars(j.priceCents ?? PRICE_CENTS[j.package] ?? 0)}</span>
                      <StateChip state={j.state} />
                    </div>
                  </Glass>
                </Link>
              </li>
            ))}
          </ul>
        )}
    </>
  );
}
