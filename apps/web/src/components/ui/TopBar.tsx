"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutGroup, motion } from "motion/react";
import { useState } from "react";
import { cn } from "./cn";
import { springs } from "./motion/tokens";
import { useMotionOk } from "./motion/useMotionOk";
import { NudgeArrow } from "./NudgeArrow";
import { Wordmark } from "./Wordmark";

export type NavItem = { label: string; href: string };

export const DEFAULT_NAV: NavItem[] = [
  { label: "Services", href: "/#services" },
  { label: "How it works", href: "/#how" },
  { label: "Sample report", href: "/#sample" },
  { label: "Pricing", href: "/#pricing" },
];

/** Wordmark left, nav centre with a sliding pill (follows hover, rests on `active`), quiet links right. */
export function TopBar({ nav = DEFAULT_NAV, active }: { nav?: NavItem[]; active?: string }) {
  const pathname = usePathname();
  const ok = useMotionOk();
  const current = active ?? nav[0]?.href;
  const [hover, setHover] = useState<string | null>(null);
  const lit = hover ?? current;
  return (
    <header className="relative z-20 flex items-center justify-between gap-4 px-5 py-5 sm:px-8">
      <Wordmark />
      <nav aria-label="Main navigation" className="hidden md:block">
        <LayoutGroup id="topbar-nav">
          <ul className="flex items-center gap-0.5" onMouseLeave={() => setHover(null)}>
            {nav.map((item) => {
              const isActive = item.href === current;
              return (
                <li key={item.href} className="relative">
                  {item.href === lit && (
                    <motion.span
                      layoutId="nav-pill"
                      aria-hidden
                      className="absolute inset-0 rounded-full bg-cream/10"
                      transition={ok ? springs.nav : { duration: 0 }}
                    />
                  )}
                  <Link
                    href={item.href}
                    aria-current={isActive ? "page" : undefined}
                    onMouseEnter={() => setHover(item.href)}
                    onFocus={() => setHover(item.href)}
                    onBlur={() => setHover(null)}
                    className={cn(
                      "relative inline-flex h-9 items-center rounded-full px-4 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-cream",
                      item.href === lit ? "text-cream" : "text-cream/60",
                    )}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </LayoutGroup>
      </nav>
      <div className="flex items-center gap-5 whitespace-nowrap text-sm">
        <Link href="/dashboard" className="hidden text-cream/70 sm:inline transition-colors hover:text-cream focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cream">
          Dashboard
        </Link>
        <Link
          href={pathname === "/" ? "/start" : "/"}
          className="group inline-flex items-center gap-1 text-cream transition-opacity hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cream"
        >
          {pathname === "/" ? "Get an eval" : "Home"} <NudgeArrow size={15} />
        </Link>
      </div>
    </header>
  );
}
