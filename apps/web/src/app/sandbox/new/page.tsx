import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentCustomer } from "@/server/session";
import { Eyebrow } from "@/components/ui";
import { SandboxShell } from "@/components/sandbox/SandboxShell";
import { getUsageSummary } from "@/server/billing-usage";
import { UsageBanner } from "@/components/billing/UsageBanner";
import { Wizard } from "@/components/sandbox/wizard/Wizard";
import { OnboardingChat } from "@/components/sandbox/onboarding-chat";

export const metadata: Metadata = { title: "New sandbox eval · Standard Evals" };

export default async function NewSandboxEvalPage() {
  const viewer = await getCurrentCustomer();
  if (!viewer) redirect("/signin?next=/sandbox/new");
  const usage = await getUsageSummary(viewer.id).catch(() => null);
  return (
    <SandboxShell active="/sandbox/new">
    <div className="min-w-0 py-10 sm:py-14">
      <header className="mb-10 max-w-3xl">
        <Eyebrow>Sandbox evals</Eyebrow>
        <h1 className="t-h1 mt-3 text-fg">New sandbox eval</h1>
        <p className="t-lead mt-3 text-muted">Connect your agent, describe the world it works in, review the generated scenarios, then run them against a sandbox.</p>
      </header>
      {usage ? <UsageBanner summary={usage} /> : null}
      <Wizard />
      <OnboardingChat />
    </div>
    </SandboxShell>
  );
}
