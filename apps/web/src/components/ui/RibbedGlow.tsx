import { cn } from "./cn";

/** Decorative blurred coral/indigo glow + fluted-glass ribs + grain. Fills its (relative, overflow-hidden) parent. */
export function RibbedGlow({ dim, className }: { dim?: boolean; className?: string }) {
  return (
    <div aria-hidden className={cn("pointer-events-none absolute inset-0 overflow-hidden", dim && "opacity-45", className)}>
      <div className="glow-field">
        <span className="glow-blob glow-coral" />
        <span className="glow-blob glow-indigo" />
        <span className="glow-blob glow-amber" />
      </div>
      <div className="ribs" />
      <div className="grain" />
    </div>
  );
}
