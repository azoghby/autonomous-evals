import { Hero } from "@/components/marketing/Hero";
import { IntegrationsStrip } from "@/components/marketing/IntegrationsStrip";
import { HowItWorks } from "@/components/marketing/HowItWorks";
import { SandboxShowcase } from "@/components/marketing/sandbox-showcase/SandboxShowcase";
import { DemoTeaser } from "@/components/marketing/DemoTeaser";
import { LeaderboardTeaser } from "@/components/marketing/LeaderboardTeaser";
import { MeetTheTeam } from "@/components/marketing/team/MeetTheTeam";
import { McpSection } from "@/components/marketing/McpSection";
import { Pricing } from "@/components/marketing/Pricing";
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
        <SandboxShowcase />
        <DemoTeaser />
        <LeaderboardTeaser />
        <MeetTheTeam />
        <McpSection />
        <Pricing />
        <ClosingCta />
      </main>
      <Footer />
    </div>
  );
}
