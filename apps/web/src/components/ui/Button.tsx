"use client";
import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "./cn";

export type ButtonVariant = "primary" | "secondary" | "outline" | "ghost" | "quiet";
export type ButtonSize = "sm" | "md" | "lg";

const base =
  "group inline-flex items-center justify-center gap-2 rounded-[4px] font-medium whitespace-nowrap select-none transition-[background-color,border-color,color,opacity] duration-150 ease-[var(--ease-hover)] active:translate-y-px motion-reduce:active:translate-y-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50 disabled:pointer-events-none";
const variants: Record<ButtonVariant, string> = {
  primary: "bg-accent text-white hover:bg-accent-hover",
  secondary: "bg-white text-black hover:bg-fg-2",
  outline: "border border-line-3 bg-transparent text-fg hover:border-[#5a5e66] hover:bg-bg-hover",
  ghost: "text-fg-2 hover:text-fg hover:bg-bg-hover",
  /** Text-only: underline on hover, no fill. */
  quiet: "rounded-none px-0 text-fg-2 hover:text-fg underline-offset-[6px] decoration-accent hover:underline",
};
const sizes: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-sm",
  md: "h-10 px-4 text-[15px]",
  lg: "h-12 px-5 text-[15px]",
};

type Common = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  children?: ReactNode;
};
type AsButton = Common & { href?: undefined } & ButtonHTMLAttributes<HTMLButtonElement>;
type AsLink = Common & { href: string; target?: string; rel?: string; "aria-label"?: string };
export type ButtonProps = AsButton | AsLink;

/** 4px-radius button (32/40/48). Hover = colour/border only, press = 1px down. Pass `href` for a Next Link, otherwise a <button>. */
export function Button(props: ButtonProps) {
  const { variant = "primary", size = "md", className, children } = props;
  const quiet = variant === "quiet";
  const cls = cn(base, variants[variant], quiet ? "h-auto py-1 text-[15px]" : sizes[size], className);
  if (props.href !== undefined) {
    const { href, target, rel } = props;
    return (
      <Link href={href} target={target} rel={rel} aria-label={props["aria-label"]} className={cls}>
        {children}
      </Link>
    );
  }
  const { variant: _v, size: _s, className: _c, children: _ch, href: _h, ...rest } = props as AsButton;
  return (
    <button type="button" {...rest} className={cls}>
      {children}
    </button>
  );
}
