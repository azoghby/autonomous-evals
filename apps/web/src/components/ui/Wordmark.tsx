import Link from "next/link";
import { cn } from "./cn";

export function WaveGlyph({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M2 12c2.5-6 4.5-6 7 0s4.5 6 7 0 3-4 6-2" stroke="var(--coral)" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <Link href="/" className={cn("inline-flex items-center gap-2 rounded-full text-[15px] font-semibold tracking-tight text-cream focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cream", className)}>
      <WaveGlyph />
      <span>Autonomous Evals</span>
    </Link>
  );
}
