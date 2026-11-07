import type { ReactNode } from "react";
import { cn } from "./cn";

export type EyebrowTone = "default" | "muted" | "accent";
const tones: Record<EyebrowTone, string> = { default: "text-fg-2", muted: "text-subtle", accent: "text-accent-text" };

/** Mono 12px uppercase label with a 6px blue ▶ marker. `index` renders as "01 /" before the text. */
export function Eyebrow({ children, index, tone = "default", className }: { children: ReactNode; index?: string; tone?: EyebrowTone; className?: string }) {
  return (
    <p className={cn("t-eyebrow inline-flex items-center gap-2", tones[tone], className)}>
      <span aria-hidden className="eyebrow-mark" />
      {index && <span className="text-subtle">{index} /</span>}
      <span>{children}</span>
    </p>
  );
}
