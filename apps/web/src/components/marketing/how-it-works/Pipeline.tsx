"use client";
import { useEffect, useRef, useState, type CSSProperties } from "react";

export type PipelineStep = { title: string; body: string; detail: string };

/** Animated pipeline: nodes on a hairline track, a blue pulse hops node to node once in view. */
export function Pipeline({ steps }: { steps: readonly PipelineStep[] }) {
  const ref = useRef<HTMLOListElement>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      ([e]) => setLive(e.isIntersecting),
      { threshold: 0.25 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div className={`hiw-stage ${live ? "hiw-live" : ""}`}>
      <ol ref={ref} className="grid grid-cols-1 lg:grid-cols-5">
        {steps.map((st, i) => (
          <li key={st.title} className="hiw-item" style={{ "--i": i } as CSSProperties}>
            <span className="hiw-node" aria-hidden="true"><span className="hiw-lit" /></span>
            {i < steps.length - 1 && (
              <span className="hiw-seg" aria-hidden="true"><span className="hiw-pulse" /></span>
            )}
            <span className="font-mono text-[11px] text-accent-text">0{i + 1}</span>
            <h3 className="t-h3 mt-2 text-fg">{st.title}</h3>
            <p className="t-small mt-2 text-muted">{st.body}</p>
            <span className="hiw-detail"><span className="hiw-tick" aria-hidden="true" />{st.detail}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
