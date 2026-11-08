import { Hero } from "@/components/marketing/Hero";
import { HowItWorks } from "@/components/marketing/HowItWorks";
import { DemoTeaser } from "@/components/marketing/DemoTeaser";
import { McpSection } from "@/components/marketing/McpSection";
import { Pricing } from "@/components/marketing/Pricing";
import { ClosingCta, Footer } from "@/components/marketing/Footer";

export default function Home() {
  return (
    <div className="bg-bg text-fg">
      <main id="main" tabIndex={-1} className="outline-none">
        <Hero />
        <HowItWorks />
        <DemoTeaser />
        <McpSection />
        <Pricing />
        <ClosingCta />
      </main>
      <Footer />
    </div>
  );
}
