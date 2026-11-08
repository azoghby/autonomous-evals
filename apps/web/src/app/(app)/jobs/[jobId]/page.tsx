import { Suspense } from "react";
import { eq } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import { JobView } from "@/components/app/job-view";
import { Loading } from "@/components/app/ui";
import { EvalCopilot, EvalCopilotLayout } from "@/components/eval-chat/EvalCopilot";
import { getCurrentCustomer } from "@/server/queries";
import { requireSignedInPage } from "@/server/page-auth";

export const metadata = { title: "Job · Standard Evals" };

/** The copilot is owner-only (operators can view jobs but do not get a customer's chat). */
async function isOwner(jobId: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) return false;
  const me = await getCurrentCustomer().catch(() => null);
  if (!me) return false;
  const [row] = await db().select({ customerId: schema.jobs.customerId }).from(schema.jobs).where(eq(schema.jobs.id, jobId)).limit(1);
  return row?.customerId === me.id;
}

export default async function JobPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  await requireSignedInPage(`/jobs/${encodeURIComponent(jobId)}`);
  const view = (
    <Suspense fallback={<Loading />}>
      <JobView jobId={jobId} />
    </Suspense>
  );
  if (!(await isOwner(jobId))) return view;
  return (
    <EvalCopilotLayout copilot={<EvalCopilot evalRef={{ kind: "job", id: jobId }} title={`Audit ${jobId.slice(0, 8)}`} />}>
      {view}
    </EvalCopilotLayout>
  );
}
