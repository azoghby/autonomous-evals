import { Button, Eyebrow } from "@/components/ui";

export function Hero() {
  return (
    <header className="flex flex-col gap-8 pb-16 pt-16 md:pb-24 md:pt-28">
      <Eyebrow>Sandbox evals</Eyebrow>
      <h1 className="t-h1 max-w-[20ch] text-fg text-balance">
        Test your agent in a world it can&apos;t break.{" "}
        <span className="text-muted">Real tools, real state, graded on what changed.</span>
      </h1>
      <p className="t-lead max-w-[60ch]">
        We build a sandbox that behaves like your product, with working tools and a database. Your agent runs scenarios and attacks against it, and we check the final state against your rules.
      </p>
      <div className="flex flex-col gap-3 sm:flex-row">
        <Button href="/sandbox/new" variant="primary" size="lg">Start a sandbox eval</Button>
        <Button href="/sandbox/runs/sample" variant="outline" size="lg">See a sample report</Button>
      </div>
    </header>
  );
}
