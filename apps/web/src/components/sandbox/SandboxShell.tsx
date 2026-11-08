import type { ReactNode } from "react";
import { PageShell, type NavItem } from "@/components/ui";

const SANDBOX_NAV: NavItem[] = [
  { label: "Sandbox evals", href: "/sandbox" },
  { label: "New sandbox eval", href: "/sandbox/new" },
  { label: "Chat with Nova", href: "/chat" },
  { label: "Sample report", href: "/sandbox/runs/sample" },
  { label: "Leaderboard", href: "/leaderboard" },
  { label: "My jobs", href: "/jobs" },
];

/** Page frame for every /sandbox route (a page-level wrapper rather than a nested layout). */
export function SandboxShell({ children, active }: { children: ReactNode; active?: string }) {
  return <PageShell nav={SANDBOX_NAV} active={active}>{children}</PageShell>;
}
