import { redirect } from "next/navigation";
import { EvalList } from "@/components/eval-chat/EvalList";
import { getCurrentCustomer } from "@/server/queries";

export const metadata = { title: "My evals · Standard Evals" };
export const dynamic = "force-dynamic";

export default async function EvalsPage() {
  const me = await getCurrentCustomer().catch(() => null);
  if (!me) redirect("/signin?next=/evals");
  return (
    <div className="min-w-0 pb-24 pt-10">
      <h1 className="t-h2">My evals</h1>
      <p className="mt-2 max-w-[60ch] text-muted">Every sandbox run and audit you have started. Open one to read the report, or ask its copilot why something failed, add a scenario or re-run it.</p>
      <div className="mt-8"><EvalList /></div>
    </div>
  );
}
