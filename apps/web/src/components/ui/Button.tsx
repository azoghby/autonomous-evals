"use client";
import Link from "next/link";
import { m } from "motion/react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "./cn";
import { springs, motionTokens } from "./motion/tokens";
import { useMotionOk } from "./motion/useMotionOk";

export type ButtonVariant = "primary" | "outline" | "ghost" | "quiet";
export type ButtonSize = "sm" | "md" | "lg";

const base =
  "group inline-flex items-center justify-center gap-2 rounded-md font-medium whitespace-nowrap select-none transition-[background-color,box-shadow,opacity,color,border-color] duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-bright disabled:opacity-50 disabled:pointer-events-none";
const PRIMARY = "bolt-sweep bg-accent text-white hover:bg-accent-bright shadow-[0_0_0_1px_rgb(91_140_255/0.5),0_8px_28px_-10px_var(--accent-glow)]";
const OUTLINE = "border border-line-strong text-fg hover:border-accent-bright hover:text-white bg-transparent";
const variants: Record<ButtonVariant, string> = {
  primary: PRIMARY,
  outline: OUTLINE,
  ghost: "text-muted hover:text-fg hover:bg-white/[0.05]",
  /** Text-only secondary: underline on hover, no fill. */
  quiet: "rounded-none px-0 text-muted hover:text-fg underline-offset-[6px] decoration-accent-bright hover:underline",
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

const MotionLink = m.create(Link);

/** Rectangular button with spring hover-lift / press. Pass `href` to render a Next Link, otherwise a <button>. */
export function Button(props: ButtonProps) {
  const ok = useMotionOk();
  const { variant = "primary", size = "md", className, children } = props;
  const quiet = variant === "quiet";
  const cls = cn(base, variants[variant], quiet ? "h-auto py-1 text-[15px]" : sizes[size], className);
  const gestures = {
    whileHover: ok && !quiet ? { y: -1, scale: motionTokens.scale.hover } : undefined,
    whileTap: ok ? { scale: motionTokens.scale.press } : undefined,
    transition: springs.snappy,
  };
  if (props.href !== undefined) {
    const { href, target, rel } = props;
    return (
      <MotionLink href={href} target={target} rel={rel} aria-label={props["aria-label"]} className={cls} {...gestures}>
        {children}
      </MotionLink>
    );
  }
  const { variant: _v, size: _s, className: _c, children: _ch, href: _h, onDrag: _d, onDragStart: _ds, onDragEnd: _de, onAnimationStart: _as, ...rest } = props as AsButton;
  return (
    <m.button type="button" {...rest} className={cls} {...gestures}>
      {children}
    </m.button>
  );
}
