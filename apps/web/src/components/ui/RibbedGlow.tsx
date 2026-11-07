import { cn } from "./cn";

/** Subtle atmosphere: a faint electric-blue light at the top edge, plus an optional masked hairline grid. Static, no JS. */
export function BlueLight({ dim, grid, ribs, className }: { dim?: boolean; grid?: boolean; /** Thin vertical fluted-glass stripes over the light. */ ribs?: boolean; className?: string }) {
  return (
    <div aria-hidden className={cn("pointer-events-none absolute inset-0 overflow-hidden", dim && "opacity-50", className)}>
      <div className="blue-light" />
      {ribs && <div className="ribs" />}
      {grid && <div className="grid-lines" />}
    </div>
  );
}
