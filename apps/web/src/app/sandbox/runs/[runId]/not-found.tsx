import { SandboxShell } from "@/components/sandbox/SandboxShell";
import { EmptyState, Button } from "@/components/ui";

export default function SandboxRunNotFound() {
  return (
    <SandboxShell>
    <div className="py-24">
      <EmptyState title="Report not found" description="This sandbox report doesn't exist or isn't yours to view." action={<Button href="/sandbox" variant="outline" size="sm">Back to sandbox evals</Button>} />
    </div>
    </SandboxShell>
  );
}
