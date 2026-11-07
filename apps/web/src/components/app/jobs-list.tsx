"use client";
import Link from "next/link";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { motion } from "motion/react";
import { dollars, PACKAGE_LABEL, when } from "@/lib/client/api";
import { PRICE_CENTS } from "@ae/core/contracts/index";
import { useFetch } from "@/lib/client/use-fetch";
import type { JobSummary } from "@/lib/client/types";
import { Chip, Empty, ErrorBox, Loading, LinkBtn, PageTitle, StateChip } from "./ui";
import { Stagger, StaggerItem } from "./motion";

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
          <Stagger as="ul" className="border-t border-white/10">
            {jobs.map((j) => (
              <StaggerItem as="li" key={j.id} className="border-b border-white/10">
                <Link href={`/jobs/${j.id}`} className="group block">
                  <motion.div whileHover={{ x: 4 }} transition={{ type: "spring", stiffness: 400, damping: 30 }}
                    className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 py-5">
                    <div className="min-w-0">
                      <div className="font-medium transition-colors group-hover:text-cream">{PACKAGE_LABEL[j.package] ?? j.package}</div>
                      <div className="mt-0.5 text-xs text-cream/45">{when(j.createdAt)}</div>
                    </div>
                    <div className="flex items-center gap-6">
                      {j.environment === "test" && <Chip tone="warn">Test</Chip>}
                      <span className="text-sm tabular-nums text-cream/60">{dollars(j.priceCents ?? PRICE_CENTS[j.package] ?? 0)}</span>
                      <span className="w-36"><StateChip state={j.state} /></span>
                    </div>
                  </motion.div>
                </Link>
              </StaggerItem>
            ))}
          </Stagger>
        )}
    </>
  );
}
