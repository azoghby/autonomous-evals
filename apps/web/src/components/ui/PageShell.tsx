import type { ReactNode } from "react";
import { cn } from "./cn";
import { BlueLight } from "./RibbedGlow";
import { TopBar, type NavItem } from "./TopBar";

const APP_NAV: NavItem[] = [
  { label: "Start", href: "/start" },
  { label: "Dashboard", href: "/dashboard" },
  { label: "Sample report", href: "/sample" },
  { label: "Pricing", href: "/#pricing" },
];

/** App-page frame: black background, faint blue light, top bar, and a centred <main>. */
export function PageShell({
  children,
  active,
  nav = APP_NAV,
  narrow,
  className,
}: {
  children: ReactNode;
  active?: string;
  nav?: NavItem[];
  /** Constrain content to a reading-width column. */
  narrow?: boolean;
  className?: string;
}) {
  return (
    <div className="relative isolate min-h-screen overflow-x-clip bg-bg text-fg">
      <BlueLight dim className="fixed" />
      <TopBar nav={nav} active={active} />
      <main className={cn("relative z-10 mx-auto w-full px-5 pb-24 pt-6 sm:px-8", narrow ? "max-w-2xl" : "max-w-5xl", className)}>
        {children}
      </main>
    </div>
  );
}
