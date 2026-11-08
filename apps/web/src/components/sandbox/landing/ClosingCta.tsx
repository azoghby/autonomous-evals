import { Button } from "@/components/ui";

export function ClosingCta() {
  return (
    <section aria-labelledby="sb-cta" className="border-t border-line-2 py-16 md:py-24">
      <div className="flex flex-col gap-8">
        <h2 id="sb-cta" className="t-h2 max-w-[24ch] text-fg text-balance">
          Ready in about fifteen minutes. <span className="text-muted">See the report first if you prefer.</span>
        </h2>
        <div className="flex flex-col gap-3 sm:flex-row">
          <Button href="/sandbox/new" variant="primary" size="lg">Start a sandbox eval</Button>
          <Button href="/sandbox/runs/sample" variant="outline" size="lg">See a sample report</Button>
        </div>
      </div>
    </section>
  );
}
