import type { ReactNode } from "react";
import { PageShell } from "@/components/ui";
import { SessionHint } from "@/components/ui/SessionHint";
import { getCurrentCustomer } from "@/server/queries";

const BASE_NAV = [
  { label: "New request", href: "/start" },
  { label: "My jobs", href: "/jobs" },
  { label: "My evals", href: "/evals" },
  { label: "Billing", href: "/settings/billing" },
];
const OPERATOR_NAV = { label: "Operator", href: "/operator" };

export default async function AppLayout({ children }: { children: ReactNode }) {
  // Operator link is a convenience only; /api/operator/* enforces access server-side.
  const me = await getCurrentCustomer().catch(() => null);
  const nav = me?.isOperator ? [...BASE_NAV, OPERATOR_NAV] : BASE_NAV;
  return (
    <>
      <SessionHint signedIn={me !== null} />
      <PageShell nav={nav}>{children}</PageShell>
    </>
  );
}
