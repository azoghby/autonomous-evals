import { PageShell } from "@/components/ui";
import { Questionnaire } from "./questionnaire";

export const metadata = { title: "Expert questions · Standard Evals", robots: { index: false } };

export default async function ExpertQuestionnairePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <PageShell nav={[]} narrow>
      <Questionnaire token={token} />
    </PageShell>
  );
}
