"use client";
import Link from "next/link";
import { motion } from "motion/react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "./cn";
import { springs, motionTokens } from "./motion/tokens";
import { useMotionOk } from "./motion/useMotionOk";

export type ButtonVariant = "coral" | "glass" | "ghost" | "quiet" | "navy";
export type ButtonSize = "sm" | "md" | "lg";

const base =
  "group inline-flex items-center justify-center gap-2 rounded-full font-medium whitespace-nowrap select-none transition-[background-color,box-shadow,opacity,color] duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cream disabled:opacity-50 disabled:pointer-events-none";
const variants: Record<ButtonVariant, string> = {
  coral: "bg-coral text-navy-deep hover:bg-[#ff8173] shadow-[0_6px_24px_-10px_rgb(255_107_91/0.55)]",
  glass: "bg-glass text-cream border border-glass-border hover:bg-glass-strong",
  ghost: "text-cream/80 hover:text-cream hover:bg-glass",
  /** Text-only secondary: underline on hover, no fill. */
  quiet: "rounded-none px-0 text-cream/75 hover:text-cream underline-offset-[6px] decoration-cream/40 hover:underline",
  /** Solid navy for cream backgrounds. */
  navy: "bg-navy text-cream hover:bg-navy-soft focus-visible:outline-navy",
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

const MotionLink = motion.create(Link);

/** Pill button with spring hover-lift / press. Pass `href` to render a Next Link, otherwise a <button>. */
export function Button(props: ButtonProps) {
  const ok = useMotionOk();
  const { variant = "coral", size = "md", className, children } = props;
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
    <motion.button type="button" {...rest} className={cls} {...gestures}>
      {children}
    </motion.button>
  );
}
