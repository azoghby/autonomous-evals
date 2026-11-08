"use client";
import { useEffect, useRef, useState } from "react";
import type { JobState } from "@ae/core/contracts/index";
import { api } from "./api";
import { connectLive, type LivePayload } from "./live-connection";
import type { ProgressItem, ProgressResponse } from "./types";

export type LiveMode = "live" | "polling";
const CONNECT_TIMEOUT_MS = 5000;
const POLL_MS = 3000;

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

/**
 * Live job state + progress via Neon Realtime sealed queries; falls back to polling
 * GET /api/jobs/:id/progress every 3s if realtime does not go live within 5s or errors.
 * Only runs while `enabled`. Returns `state`/`progress` as undefined until the first data arrives.
 */
export function useLiveJob(jobId: string, enabled: boolean): { state?: JobState; progress?: ProgressItem[]; mode: LiveMode } {
  const [snap, setSnap] = useState<{ state?: JobState; progress?: ProgressItem[] }>({});
  const [mode, setMode] = useState<LiveMode>("polling");
  const active = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    active.current = true;
    let stopPoll: (() => void) | undefined;
    const h: { stopLive?: () => void; timeout?: ReturnType<typeof setTimeout> } = {};
    let settled = false;

    const startPolling = () => {
      if (stopPoll || !active.current) return;
      setMode("polling");
      let stop = false;
      const tick = async () => {
        try {
          const p = await api<ProgressResponse>(`/api/jobs/${jobId}/progress`);
          if (!stop) setSnap({ state: p.state, progress: p.progress ?? [] });
        } catch { /* transient; next tick retries */ }
      };
      void tick();
      const id = setInterval(() => void tick(), POLL_MS);
      stopPoll = () => { stop = true; clearInterval(id); };
    };

    const fallback = () => { settled = true; clearTimeout(h.timeout); h.stopLive?.(); startPolling(); };

    h.stopLive = connectLive({
      keys: ["progress", "job"] as const,
      fetchSealed: () => api<LivePayload<"progress" | "job">>(`/api/jobs/${jobId}/live`),
      onRows: ({ progress, job }) => {
        if (!active.current) return;
        setSnap((prev) => ({
          state: (job?.[0]?.state as JobState | undefined) ?? prev.state,
          progress: progress
            ? progress.map((r) => ({ milestone: String(r.milestone), message: String(r.message), createdAt: iso(r.created_at) }))
            : prev.progress,
        }));
      },
      onLive: () => { if (settled) return; settled = true; clearTimeout(h.timeout); setMode("live"); },
      onFail: fallback,
    });
    h.timeout = setTimeout(() => { if (!settled) fallback(); }, CONNECT_TIMEOUT_MS);

    return () => {
      active.current = false;
      clearTimeout(h.timeout);
      h.stopLive?.();
      stopPoll?.();
    };
  }, [jobId, enabled]);

  return { ...snap, mode: enabled ? mode : "polling" };
}
