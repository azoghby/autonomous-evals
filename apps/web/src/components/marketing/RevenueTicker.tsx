"use client";

import { useEffect, useState } from "react";
import { animate, m, useMotionValue, useReducedMotion, useTransform } from "motion/react";

interface Stats { revenueCents: number; paidJobs: number }
const fmt = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

/** Live revenue counter. Fetches /api/stats/revenue, counts up unless reduced motion; honest "$0 so far" at zero. Mount inside the app's LazyMotion/MotionProvider. */
export function RevenueTicker({ className, active = true, big = false }: { className?: string; /** Hold the count at $0 until true (e.g. scrolled into view). */ active?: boolean; /** Large display: amount on its own line, detail as a small caption. */ big?: boolean }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const reduce = useReducedMotion();
  const value = useMotionValue(0);
  const text = useTransform(value, (v) => fmt(Math.round(v)));

  useEffect(() => {
    let live = true;
    fetch("/api/stats/revenue").then((r) => (r.ok ? r.json() : null)).then((s) => { if (live && s) setStats(s); }).catch(() => {});
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (!stats || !active) return;
    if (reduce || stats.revenueCents === 0) { value.set(stats.revenueCents); return; }
    const c = animate(value, stats.revenueCents, { duration: 1.4, ease: "easeOut" });
    return () => c.stop();
  }, [stats, active, reduce, value]);

  if (!stats) return <span className={className} aria-busy="true">&nbsp;</span>;
  const detail = stats.paidJobs ? `across ${stats.paidJobs} paid ${stats.paidJobs === 1 ? "job" : "jobs"}` : "";
  if (big) {
    return (
      <span className={className}>
        {stats.revenueCents === 0 ? "$0 so far" : <><m.span className="block tabular-nums">{text}</m.span><span className="mt-2 block font-mono text-xs uppercase tracking-normal text-subtle">earned {detail}</span></>}
      </span>
    );
  }
  return (
    <span className={className}>
      {stats.revenueCents === 0 ? "$0 so far" : <><m.span className="tabular-nums">{text}</m.span> earned{stats.paidJobs ? ` across ${stats.paidJobs} paid ${stats.paidJobs === 1 ? "job" : "jobs"}` : ""}</>}
    </span>
  );
}
