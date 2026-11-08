import type { ReactNode } from "react";
import { cn } from "./cn";
import { DEFAULT_NAV, TopBar, type NavItem } from "./TopBar";

/** App-page frame: black page, sticky TopBar, and <main id="main"> on the shared container (left-aligned; `narrow` caps width at ~760px). */
export function PageShell({
  children,
  active,
  nav = DEFAULT_NAV,
  narrow,
  className,
}: {
  children: ReactNode;
  active?: string;
  nav?: NavItem[];
  /** Cap content at ~760px, still aligned to the container's left edge. */
  narrow?: boolean;
  className?: string;
}) {
  return (
    <div className="relative min-h-screen overflow-x-clip bg-bg text-fg">
      <TopBar nav={nav} active={active} />
      <main id="main" tabIndex={-1} className="container-x relative z-10 pb-32 pt-10 outline-none sm:pt-12">
        <div className={cn("w-full", narrow && "max-w-[760px]", className)}>{children}</div>
      </main>
    </div>
  );
}
