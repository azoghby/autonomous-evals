"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutGroup, m } from "motion/react";
import { useEffect, useId, useRef, useState } from "react";
import { cn } from "./cn";
import { springs } from "./motion/tokens";
import { useMotionOk } from "./motion/useMotionOk";
import { NudgeArrow } from "./NudgeArrow";
import { Wordmark } from "./Wordmark";

export type NavItem = { label: string; href: string };

export const DEFAULT_NAV: NavItem[] = [
  { label: "Services", href: "/#services" },
  { label: "How it works", href: "/#how" },
  { label: "Sample report", href: "/sample" },
  { label: "Pricing", href: "/#pricing" },
];

/** Wordmark left, nav centre with a sliding blue underline (follows hover, rests on `active`), quiet links right. */
export function TopBar({ nav = DEFAULT_NAV, active }: { nav?: NavItem[]; active?: string }) {
  const pathname = usePathname();
  const ok = useMotionOk();
  const current = active ?? nav.find((n) => n.href === pathname)?.href ?? (pathname === "/" ? nav[0]?.href : undefined);
  const [hover, setHover] = useState<string | null>(null);
  const lit = hover ?? current;
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const btnRef = useRef<HTMLButtonElement>(null);
  const wrapRef = useRef<HTMLElement>(null);
  useEffect(() => { setOpen(false); }, [pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); btnRef.current?.focus(); } };
    const onDown = (e: MouseEvent) => { if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("mousedown", onDown); };
  }, [open]);
  return (
    <header
      ref={wrapRef}
      onBlur={(e) => { if (open && !e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false); }}
      className="relative z-20 border-b border-line flex items-center justify-between gap-4 px-5 py-5 sm:px-8"
    >
      <Wordmark />
      <nav aria-label="Main navigation" className="hidden md:block">
        <LayoutGroup id="topbar-nav">
          <ul className="flex items-center gap-0.5" onMouseLeave={() => setHover(null)}>
            {nav.map((item) => {
              const isActive = item.href === current;
              return (
                <li key={item.href} className="relative">
                  {item.href === lit && (
                    <m.span
                      layoutId="nav-underline"
                      aria-hidden
                      className="absolute inset-x-3 -bottom-px h-px bg-accent-bright"
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
                      "relative inline-flex h-9 items-center px-3 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-accent-bright",
                      item.href === lit ? "text-fg" : "text-muted",
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
        <Link href="/dashboard" className="hidden text-muted sm:inline transition-colors hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent-bright">
          Dashboard
        </Link>
        <Link
          href={pathname === "/" ? "/start" : "/"}
          className="group inline-flex items-center gap-1 text-fg transition-colors hover:text-accent-bright focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent-bright"
        >
          {pathname === "/" ? "Get an eval" : "Home"} <NudgeArrow size={15} />
        </Link>
        <button
          ref={btnRef}
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={open ? "Close menu" : "Open menu"}
          onClick={() => setOpen((o) => !o)}
          className="inline-flex h-9 w-9 items-center justify-center border border-white/10 text-fg transition-colors hover:border-white/25 focus-visible:outline-2 focus-visible:outline-accent-bright md:hidden"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
            {open ? <path d="M3 3l10 10M13 3L3 13" /> : <path d="M2 4.5h12M2 8h12M2 11.5h12" />}
          </svg>
        </button>
      </div>
      {open && (
        <nav id={panelId} aria-label="Mobile navigation" className="absolute inset-x-0 top-full border-b border-white/10 bg-[#0A0A0B] px-5 py-2 sm:px-8 md:hidden">
          <ul>
            {[...nav, { label: "Dashboard", href: "/dashboard" }].map((item) => (
              <li key={item.href} className="border-b border-white/10 last:border-b-0">
                <Link
                  href={item.href}
                  aria-current={item.href === current ? "page" : undefined}
                  onClick={() => setOpen(false)}
                  className={cn(
                    "flex h-12 items-center text-sm transition-colors hover:text-fg focus-visible:outline-2 focus-visible:outline-accent-bright",
                    item.href === current ? "text-[#5b8cff]" : "text-muted",
                  )}
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </header>
  );
}
