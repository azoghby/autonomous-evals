"use client";
import { useEffect, useRef, useState } from "react";
import { useInView } from "motion/react";
import { cn } from "./cn";

export type TerminalTone = "default" | "muted" | "ok" | "danger" | "accent";
export type TerminalLine = { text: string; tone?: TerminalTone; prefix?: string };

const toneCls: Record<TerminalTone, string> = {
  default: "text-fg-2", muted: "text-subtle", ok: "text-ok", danger: "text-danger", accent: "text-accent-text",
};

/**
 * Static terminal / trace panel. SSR and reduced motion render every line. With `animate`, lines below the fold
 * reveal one by one (opacity only, no layout shift) once scrolled into view.
 */
export function Terminal({
  title, lines, animate, className,
}: { title?: string; lines: TerminalLine[]; animate?: boolean; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-40px" });
  const [armed, setArmed] = useState(false); // true only after hydration, when animation is wanted and allowed
  const [shown, setShown] = useState(lines.length);
  useEffect(() => {
    if (!animate || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const r = ref.current?.getBoundingClientRect();
    if (r && r.top < window.innerHeight) return; // already in view at mount: no animation
    setArmed(true);
    setShown(0);
  }, [animate]);
  useEffect(() => {
    if (!armed || !inView) return;
    let i = 0;
    const id = setInterval(() => { i += 1; setShown(i); if (i >= lines.length) clearInterval(id); }, 140);
    return () => clearInterval(id);
  }, [armed, inView, lines.length]);

  return (
    <div ref={ref} className={cn("min-w-0 max-w-full overflow-hidden rounded-[4px] border border-line-2 bg-bg-raised", className)}>
      <div className="flex h-10 items-center gap-3 border-b border-line px-3">
        <span aria-hidden className="flex gap-1.5"><i className="size-2 rounded-full bg-line-3" /><i className="size-2 rounded-full bg-line-3" /><i className="size-2 rounded-full bg-line-3" /></span>
        {title && <span className="truncate font-mono text-[11px] uppercase text-subtle">{title}</span>}
      </div>
      <div className="overflow-x-auto p-4 font-mono text-[13px] leading-[1.7]">
        {lines.map((l, i) => (
          <div
            key={i}
            className={cn("whitespace-pre transition-opacity duration-150", toneCls[l.tone ?? "default"])}
            style={{ opacity: i < shown ? 1 : 0 }}
          >
            {l.prefix && <span className="mr-2 select-none text-subtle">{l.prefix}</span>}
            {l.text || " "}
          </div>
        ))}
      </div>
    </div>
  );
}
