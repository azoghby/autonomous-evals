"use client";
import { useEffect, useRef, useState } from "react";
import { cn } from "./cn";

/** Mono 13px code panel with optional label and Copy button (aria-live "Copied"). Scrolls horizontally inside itself. */
export function CodeBlock({
  code, label, copy = true, language, className,
}: { code: string; label?: string; copy?: boolean; language?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard unavailable: leave button as is */ }
  };
  return (
    <div className={cn("min-w-0 max-w-full overflow-hidden rounded-[4px] border border-line-2 bg-bg-raised", className)}>
      {(label || copy) && (
        <div className="flex h-10 items-center justify-between gap-3 border-b border-line px-3">
          <span className="truncate font-mono text-[11px] uppercase text-subtle">{label ?? language ?? ""}</span>
          {copy && (
            <button
              type="button"
              onClick={onCopy}
              className="inline-flex h-7 items-center rounded-[4px] px-2 font-mono text-[11px] uppercase text-fg-2 transition-colors duration-150 hover:bg-bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
            >
              <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
            </button>
          )}
        </div>
      )}
      <pre className="overflow-x-auto p-4 font-mono text-[13px] leading-[1.6] text-fg-2"><code data-language={language}>{code}</code></pre>
    </div>
  );
}
