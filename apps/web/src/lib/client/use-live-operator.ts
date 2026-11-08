"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { connectLive, type LivePayload } from "./live-connection";
import type { LiveMode } from "./use-live-job";

const CONNECT_TIMEOUT_MS = 5000;
const POLL_MS = 5000;
type Keys = "jobs" | "payments" | "interventions";

export interface LiveOperator {
  mode: LiveMode;
  /** Changes whenever the live job/payment/intervention rows change (not on the first snapshot). */
  version: number;
  jobs?: Array<Record<string, unknown>>;
  payments?: Array<Record<string, unknown>>;
  interventions?: Array<Record<string, unknown>>;
}

/**
 * Live operator essentials (operator-only sealed queries). `refetch` is the existing overview loader:
 * the console calls it when `version` bumps, and it is also the polling fallback (5s) when realtime
 * does not connect within 5s or errors.
 */
export function useLiveOperator(refetch: () => unknown): LiveOperator {
  const [rows, setRows] = useState<Omit<LiveOperator, "mode" | "version">>({});
  const [mode, setMode] = useState<LiveMode>("polling");
  const [version, setVersion] = useState(0);
  const refetchRef = useRef(refetch);
  useEffect(() => { refetchRef.current = refetch; });

  useEffect(() => {
    let alive = true;
    let settled = false;
    let stopPoll: (() => void) | undefined;
    const h: { stopLive?: () => void; timeout?: ReturnType<typeof setTimeout> } = {};
    let sig = "";

    const fallback = () => {
      settled = true; clearTimeout(h.timeout); h.stopLive?.();
      if (!alive || stopPoll) return;
      setMode("polling");
      const id = setInterval(() => void refetchRef.current(), POLL_MS);
      stopPoll = () => clearInterval(id);
    };

    h.stopLive = connectLive({
      keys: ["jobs", "payments", "interventions"] as const satisfies readonly Keys[],
      fetchSealed: () => api<LivePayload<Keys>>("/api/operator/live"),
      onRows: (r) => {
        if (!alive) return;
        setRows(r);
        const next = JSON.stringify([r.jobs?.map((j) => [j.id, j.state, String(j.updated_at)]), r.payments?.map((p) => p.id), r.interventions?.map((i) => i.id)]);
        if (sig && next !== sig) setVersion((v) => v + 1);
        sig = next;
      },
      onLive: () => { if (settled) return; settled = true; clearTimeout(h.timeout); setMode("live"); },
      onFail: fallback,
    });
    h.timeout = setTimeout(() => { if (!settled) fallback(); }, CONNECT_TIMEOUT_MS);
    return () => { alive = false; clearTimeout(h.timeout); h.stopLive?.(); stopPoll?.(); };
  }, []);

  return { ...rows, mode, version };
}
