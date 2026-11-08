import { JobsList } from "@/components/app/jobs-list";
import { requireSignedInPage } from "@/server/page-auth";

export const metadata = { title: "My jobs · Standard Evals" };
export const dynamic = "force-dynamic";

export default async function JobsPage() {
  await requireSignedInPage("/jobs");
  return <JobsList />;
}
