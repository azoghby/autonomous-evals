import { ClosingCta } from "@/components/sandbox/landing/ClosingCta";
import { ConnectModes } from "@/components/sandbox/landing/ConnectModes";
import { Hero } from "@/components/sandbox/landing/Hero";
import { ReportPreview } from "@/components/sandbox/landing/ReportPreview";
import { Steps } from "@/components/sandbox/landing/Steps";
import { SandboxShell } from "@/components/sandbox/SandboxShell";

export const metadata = { title: "Sandbox evals · Standard Evals" };

export default function SandboxLandingPage() {
  return (
    <SandboxShell active="/sandbox">
      <Hero />
      <Steps />
      <ConnectModes />
      <ReportPreview />
      <ClosingCta />
    </SandboxShell>
  );
}
