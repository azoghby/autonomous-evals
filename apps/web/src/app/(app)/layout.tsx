import type { ReactNode } from "react";
import { PageShell } from "@/components/ui";

const NAV = [
  { label: "New request", href: "/start" },
  { label: "My jobs", href: "/jobs" },
  { label: "Operator", href: "/operator" },
];

export default function AppLayout({ children }: { children: ReactNode }) {
  return <PageShell nav={NAV}>{children}</PageShell>;
}
