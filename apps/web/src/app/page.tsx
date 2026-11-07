import { Hero } from "@/components/marketing/Hero";
import { Footer, HowItWorks, Pricing, SampleFinding } from "@/components/marketing/Sections";

export default function Home() {
  return (
    <div className="bg-bg text-fg">
      <Hero />
      <main>
        <HowItWorks />
        <Pricing />
        <SampleFinding />
      </main>
      <Footer />
    </div>
  );
}
