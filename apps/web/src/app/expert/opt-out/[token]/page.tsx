import { PageShell } from "@/components/ui";
import { OptOut } from "./opt-out";

export const metadata = { title: "Opt out · Autonomous Evals", robots: { index: false } };

export default async function OptOutPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <PageShell nav={[]} narrow>
      <OptOut token={token} />
    </PageShell>
  );
}
