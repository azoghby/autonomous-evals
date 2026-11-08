"use client";
import { useEffect, useRef, useState } from "react";

export const POLL_INTERVAL_MS = 3000;

type PollState<T> = { data: T | null; error: string | null };

/**
 * Poll a JSON endpoint every 3s until `isDone(data)`. Pauses while the document is hidden (and refetches on return),
 * aborts in-flight requests and clears timers on unmount or when `url` changes. Pass `url = null` to disable.
 */
export function usePoll<T>(url: string | null, parse: (json: unknown) => T | null, isDone: (data: T) => boolean, intervalMs = POLL_INTERVAL_MS): PollState<T> {
  const [state, setState] = useState<PollState<T>>({ data: null, error: null });
  const fns = useRef({ parse, isDone });
  useEffect(() => {
    fns.current = { parse, isDone };
  });

  useEffect(() => {
    if (!url) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ctl = new AbortController();

    const schedule = () => {
      if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
    };
    const tick = async () => {
      if (stopped) return;
      if (document.hidden) return schedule();
      try {
        const res = await fetch(url, { signal: ctl.signal, cache: "no-store" });
        if (!res.ok) throw new Error(`Status check failed (${res.status})`);
        const data = fns.current.parse(await res.json());
        if (stopped) return;
        if (data === null) throw new Error("Unexpected response");
        setState({ data, error: null });
        if (fns.current.isDone(data)) {
          stopped = true;
          return;
        }
      } catch (e) {
        if (stopped || ctl.signal.aborted) return;
        setState((s) => ({ data: s.data, error: e instanceof Error ? e.message : "Status check failed" }));
      }
      schedule();
    };
    const onVisible = () => {
      if (document.hidden || stopped) return;
      clearTimeout(timer);
      void tick();
    };

    document.addEventListener("visibilitychange", onVisible);
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
      ctl.abort();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [url, intervalMs]);

  return state;
}
