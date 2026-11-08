import { cn } from "./cn";

export function Spinner({ size = 20, label = "Loading", className }: { size?: number; label?: string; className?: string }) {
  return (
    <span role="status" className={cn("inline-flex", className)}>
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden className="motion-safe:animate-spin">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
        <path d="M21 12a9 9 0 0 0-9-9" stroke="var(--accent-text)" strokeWidth="3" strokeLinecap="round" />
      </svg>
      <span className="sr-only">{label}</span>
    </span>
  );
}
