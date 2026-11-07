import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "./cn";

export type ButtonVariant = "coral" | "glass" | "ghost";
export type ButtonSize = "sm" | "md" | "lg";

const base =
  "inline-flex items-center justify-center gap-2 rounded-full font-medium whitespace-nowrap select-none transition-[transform,background-color,box-shadow,opacity] duration-200 ease-[var(--ease-out-expo)] active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cream disabled:opacity-50 disabled:pointer-events-none";
const variants: Record<ButtonVariant, string> = {
  coral:
    "bg-coral text-navy-deep hover:bg-[#ff8173] shadow-[0_8px_30px_-8px_rgb(255_107_91/0.6)]",
  glass:
    "bg-glass text-cream border border-glass-border backdrop-blur-md hover:bg-glass-strong",
  ghost: "text-cream/80 hover:text-cream hover:bg-glass",
};
const sizes: Record<ButtonSize, string> = {
  sm: "h-9 px-4 text-sm",
  md: "h-11 px-6 text-[15px]",
  lg: "h-14 px-8 text-base",
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

/** Pill button. Pass `href` to render a Next Link, otherwise a <button>. */
export function Button(props: ButtonProps) {
  const { variant = "coral", size = "md", className, children } = props;
  const cls = cn(base, variants[variant], sizes[size], className);
  if (props.href !== undefined) {
    const { href, target, rel } = props;
    return (
      <Link href={href} target={target} rel={rel} aria-label={props["aria-label"]} className={cls}>
        {children}
      </Link>
    );
  }
  const { variant: _v, size: _s, className: _c, children: _ch, href: _h, ...rest } = props;
  return (
    <button type="button" {...rest} className={cls}>
      {children}
    </button>
  );
}
