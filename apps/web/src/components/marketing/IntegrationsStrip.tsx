import type { CSSProperties } from "react";
import { Container } from "../ui/Container";

const HUES = ["var(--accent-bright)", "var(--violet)", "var(--cyan)"] as const;
const ITEMS = [
  "OpenAI-compatible APIs", "Claude Code", "Cursor", "MCP", "GitHub Actions", "Stripe", "x402", "Neon", "Vercel",
] as const;

function Group({ hidden }: { hidden?: boolean }) {
  return (
    <ul className={`marq-group${hidden ? " marq-dup" : ""}`} aria-hidden={hidden || undefined}>
      {ITEMS.map((n, i) => (
        <li key={n} className="marq-item" style={{ "--c": HUES[i % HUES.length] } as CSSProperties}>{n}</li>
      ))}
    </ul>
  );
}

/** "Works with" band: slow mono-wordmark marquee, edge-faded, pauses on hover; static wrap under reduced motion. */
export function IntegrationsStrip() {
  return (
    <section aria-label="Works with" className="relative border-y border-line-2 bg-bg py-8">
      <Container className="mb-5">
        <p className="t-eyebrow text-subtle">Works with</p>
      </Container>
      <div className="marq-viewport">
        <div className="marq-track">
          <Group />
          <Group hidden />
          <Group hidden />
          <Group hidden />
        </div>
      </div>
    </section>
  );
}
