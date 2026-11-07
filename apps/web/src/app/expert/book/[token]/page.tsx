import { PageShell } from "@/components/ui";
import { BookCall } from "./book-call";

export const metadata = { title: "Book a call · Autonomous Evals", robots: { index: false } };

export default async function ExpertBookPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <PageShell nav={[]} narrow>
      <BookCall token={token} />
    </PageShell>
  );
}
