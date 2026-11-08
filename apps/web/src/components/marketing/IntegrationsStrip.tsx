import { Container } from "../ui/Container";

const ITEMS = [
  "OpenAI-compatible APIs", "Claude Code", "Cursor", "MCP", "GitHub Actions", "Stripe", "x402", "Neon", "Vercel",
] as const;

function Group({ hidden }: { hidden?: boolean }) {
  return (
    <ul className={`marq-group${hidden ? " marq-dup" : ""}`} aria-hidden={hidden || undefined}>
      {ITEMS.map((n) => <li key={n} className={"marq-item"}>{n}</li>)}
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
      <div className={"marq-viewport"}>
        <div className={"marq-track"}>
          <Group />
          <Group hidden />
          <Group hidden />
          <Group hidden />
        </div>
      </div>
    </section>
  );
}
