import { Suspense } from "react";
import { JobView } from "@/components/app/job-view";
import { Loading } from "@/components/app/ui";

export const metadata = { title: "Job · Standard Evals" };

export default async function JobPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  return (
    <Suspense fallback={<Loading />}>
      <JobView jobId={jobId} />
    </Suspense>
  );
}
