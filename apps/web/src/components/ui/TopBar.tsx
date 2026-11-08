"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "./Button";
import { cn } from "./cn";
import { Wordmark } from "./Wordmark";

export type NavItem = { label: string; href: string };

export const DEFAULT_NAV: NavItem[] = [
  { label: "Services", href: "/#services" },
  { label: "How it works", href: "/#how" },
  { label: "Sandbox", href: "/sandbox" },
  { label: "Sample report", href: "/sample" },
  { label: "Leaderboard", href: "/leaderboard" },
  { label: "Pricing", href: "/#pricing" },
];

export type TopBarProps = {
  nav?: NavItem[];
  active?: string;
  /** Right-side ghost link. Default { label: "Dashboard", href: "/jobs" }. */
  secondary?: NavItem;
  /** Right-side primary CTA. Default { label: "Get an eval", href: "/start" }. */
  cta?: NavItem;
};

/**
 * 64px sticky bar on the shared container: wordmark, left-aligned links, ghost link + primary CTA right.
 * On "/" it is transparent over the hero until scrolled; elsewhere it is always black/80 + blur + hairline.
 */
export function TopBar({
  nav = DEFAULT_NAV,
  active,
  secondary = { label: "Dashboard", href: "/jobs" },
  cta = { label: "Get an eval", href: "/start" },
}: TopBarProps) {
  const pathname = usePathname();
  const current = active ?? nav.find((n) => n.href === pathname)?.href ?? (pathname === "/" ? nav[0]?.href : undefined);
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const panelId = useId();
  const btnRef = useRef<HTMLButtonElement>(null);
  const wrapRef = useRef<HTMLElement>(null);
  useEffect(() => { setOpen(false); }, [pathname]);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); btnRef.current?.focus(); } };
    const onDown = (e: MouseEvent) => { if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("mousedown", onDown); };
  }, [open]);

  const overHero = pathname === "/" && !scrolled && !open;
  const showSecondary = !nav.some((n) => n.href === secondary.href || (secondary.href === "/jobs" && n.href.startsWith("/jobs")));
  const mobileItems = showSecondary ? [...nav, secondary] : nav;
  return (
    <header
      ref={wrapRef}
      onBlur={(e) => { if (open && !e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false); }}
      className={cn(
        "sticky top-0 z-30 border-b backdrop-blur-[12px] transition-colors duration-150",
        overHero ? "border-transparent bg-black/20" : "border-line bg-black/80",
      )}
    >
      <div className="container-x flex h-16 items-center gap-8">
        <Wordmark />
        <nav aria-label="Main navigation" className="hidden lg:block">
          <ul className="flex items-center gap-6 xl:gap-8">
            {nav.map((item) => {
              const isActive = item.href === current;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={isActive ? "page" : undefined}
                    className={cn(
                      "inline-flex h-9 items-center whitespace-nowrap rounded-[4px] text-sm transition-colors duration-150 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                      isActive ? "text-fg" : "text-fg-2",
                    )}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          {showSecondary && <Button href={secondary.href} variant="ghost" size="sm" className="max-md:hidden">{secondary.label}</Button>}
          <Button href={cta.href} size="sm">{cta.label}</Button>
          <button
            ref={btnRef}
            type="button"
            aria-expanded={open}
            aria-controls={panelId}
            aria-label={open ? "Close menu" : "Open menu"}
            onClick={() => setOpen((o) => !o)}
            className="inline-flex size-8 items-center justify-center rounded-[4px] border border-line-3 text-fg transition-colors duration-150 hover:bg-bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent lg:hidden"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
              {open ? <path d="M3 3l10 10M13 3L3 13" /> : <path d="M2 4.5h12M2 8h12M2 11.5h12" />}
            </svg>
          </button>
        </div>
      </div>
      {open && (
        <nav id={panelId} aria-label="Mobile navigation" className="absolute inset-x-0 top-full border-b border-line-2 bg-black lg:hidden">
          <ul className="container-x">
            {mobileItems.map((item) => (
              <li key={item.href} className="border-b border-line last:border-b-0">
                <Link
                  href={item.href}
                  aria-current={item.href === current ? "page" : undefined}
                  onClick={() => setOpen(false)}
                  className={cn(
                    "flex h-12 items-center text-[15px] transition-colors hover:text-fg focus-visible:outline-2 focus-visible:outline-accent",
                    item.href === current ? "text-accent-text" : "text-fg-2",
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
