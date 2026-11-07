/** Shared motion tokens + spring presets (motion/react). Compositor-only: transform / opacity. No overshoot. */
export const motionTokens = {
  /** Seconds. fast = hover, normal/base = entrances, slow = large reveals. */
  duration: { instant: 0.1, fast: 0.15, base: 0.24, normal: 0.24, slow: 0.48, crawl: 0.8 },
  /** out-expo for entrances. */
  easing: { smooth: [0.16, 1, 0.3, 1] as [number, number, number, number], hover: [0.2, 0, 0, 1] as [number, number, number, number] },
  distance: { xs: 4, sm: 8, md: 12, lg: 12 },
  scale: { hover: 1, press: 1 },
  /** Stagger interval in seconds (40-60ms). */
  stagger: 0.05,
} as const;

/** Critically damped (damping = 2*sqrt(stiffness)): settle without overshoot. */
export const springs = {
  snappy: { type: "spring", stiffness: 400, damping: 40 },
  gentle: { type: "spring", stiffness: 150, damping: 24.5 },
  nav: { type: "spring", stiffness: 420, damping: 41 },
} as const;
