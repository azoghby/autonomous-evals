import { LeaderboardTeaser } from "@/components/marketing/LeaderboardTeaser";
import { RevenueBand } from "@/components/marketing/RevenueBand";
import { Hero } from "@/components/marketing/Hero";
import { IntegrationsStrip } from "@/components/marketing/IntegrationsStrip";
import { HowItWorks } from "@/components/marketing/HowItWorks";
import { ReportPreview } from "@/components/marketing/ReportPreview";
import { Fixes } from "@/components/marketing/Fixes";
import { Pricing } from "@/components/marketing/Pricing";
import { McpSection } from "@/components/marketing/McpSection";
import { Experts } from "@/components/marketing/Experts";
import { ClosingCta, Footer } from "@/components/marketing/Footer";

/** ISR so the leaderboard teaser picks up new public-agent runs. */
export const revalidate = 300;

export default function Home() {
  return (
    <div className="bg-bg text-fg">
      <main id="main" tabIndex={-1} className="outline-none">
        <Hero />
        <IntegrationsStrip />
        <HowItWorks />
        <ReportPreview />
        <Fixes />
        <Pricing />
        <McpSection />
        <Experts />
        <LeaderboardTeaser />
        <RevenueBand />
        <ClosingCta />
      </main>
      <Footer />
    </div>
  );
}
