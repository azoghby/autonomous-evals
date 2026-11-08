import { OperatorConsole } from "@/components/app/operator-console";
import { requireSignedInPage } from "@/server/page-auth";

export const metadata = { title: "Operator · Standard Evals" };
export const dynamic = "force-dynamic";

export default async function OperatorPage() {
  await requireSignedInPage("/operator");
  return <OperatorConsole />;
}
