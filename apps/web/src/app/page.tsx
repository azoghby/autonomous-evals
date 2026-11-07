import { RevenueTicker } from "@/components/marketing/RevenueTicker";
import { Hero } from "@/components/marketing/Hero";
import { HowItWorks } from "@/components/marketing/HowItWorks";
import { ReportPreview } from "@/components/marketing/ReportPreview";
import { Fixes } from "@/components/marketing/Fixes";
import { Pricing } from "@/components/marketing/Pricing";
import { McpSection } from "@/components/marketing/McpSection";
import { Experts } from "@/components/marketing/Experts";
import { ClosingCta, Footer } from "@/components/marketing/Footer";

export default function Home() {
  return (
    <div className="bg-bg text-fg">
      <main id="main" tabIndex={-1} className="outline-none">
        <Hero />
        <HowItWorks />
        <ReportPreview />
        <Fixes />
        <Pricing />
        <McpSection />
        <Experts />
        <section aria-label="Revenue" className="border-t border-line">
          <div className="mx-auto flex max-w-[1440px] flex-wrap items-baseline justify-between gap-3 px-8 py-6 font-mono text-xs uppercase tracking-wide text-fg-muted">
            <span>▶ Earned by our agents this weekend · live payments only</span>
            <RevenueTicker className="font-mono text-sm text-fg" />
          </div>
        </section>
        <ClosingCta />
      </main>
      <Footer />
    </div>
  );
}
