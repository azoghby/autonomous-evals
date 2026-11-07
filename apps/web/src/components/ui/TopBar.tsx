"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowUpRight, Menu, UserRound } from "lucide-react";
import { cn } from "./cn";
import { Wordmark } from "./Wordmark";

export type NavItem = { label: string; href: string };

export const DEFAULT_NAV: NavItem[] = [
  { label: "Services", href: "/#services" },
  { label: "How it works", href: "/#how" },
  { label: "Sample report", href: "/#sample" },
  { label: "Pricing", href: "/#pricing" },
];

/** Wordmark left, glass pill nav centre, icon + menu buttons right. `active` is a nav href; defaults to the first item. */
export function TopBar({ nav = DEFAULT_NAV, active }: { nav?: NavItem[]; active?: string }) {
  const pathname = usePathname();
  const current = active ?? nav[0]?.href;
  return (
    <header className="relative z-20 flex items-center justify-between gap-4 px-5 py-5 sm:px-8">
      <Wordmark />
      <nav aria-label="Main navigation" className="hidden md:block">
        <ul className="flex items-center gap-1 rounded-full border border-glass-border bg-glass p-1 backdrop-blur-xl">
          {nav.map((item) => {
            const isActive = item.href === current;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={isActive ? "page" : undefined}
                  className={cn(
                    "inline-flex h-9 items-center gap-2 rounded-full px-4 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-cream",
                    isActive ? "bg-glass-strong text-cream" : "text-cream/65 hover:text-cream",
                  )}
                >
                  {isActive && <span aria-hidden className="size-1.5 rounded-full bg-coral" />}
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="flex items-center gap-2">
        <Link
          href={pathname === "/" ? "/start" : "/"}
          aria-label="Start an eval"
          className="grid size-10 place-items-center rounded-full border border-glass-border bg-glass text-cream backdrop-blur-xl transition-colors hover:bg-glass-strong focus-visible:outline-2 focus-visible:outline-cream"
        >
          <ArrowUpRight size={18} aria-hidden />
        </Link>
        <Link
          href="/dashboard"
          className="inline-flex h-10 items-center gap-2 rounded-full border border-glass-border bg-glass px-4 text-sm text-cream backdrop-blur-xl transition-colors hover:bg-glass-strong focus-visible:outline-2 focus-visible:outline-cream"
        >
          <Menu size={16} aria-hidden className="md:hidden" />
          <UserRound size={16} aria-hidden className="hidden md:block" />
          <span className="hidden sm:inline">Menu</span>
          <span className="sr-only sm:hidden">Menu</span>
        </Link>
      </div>
    </header>
  );
}
