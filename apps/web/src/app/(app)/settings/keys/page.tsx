import { ApiKeys } from "@/components/app/api-keys";
import { requireSignedInPage } from "@/server/page-auth";

export const metadata = { title: "API keys · Standard Evals" };
export const dynamic = "force-dynamic";

export default async function ApiKeysPage() {
  await requireSignedInPage("/settings/keys");
  return <ApiKeys />;
}
