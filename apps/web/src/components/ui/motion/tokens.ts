/** Shared motion tokens + spring presets (motion/react). Compositor-only: transform / opacity. */
export const motionTokens = {
  duration: { instant: 0.12, fast: 0.2, normal: 0.4, slow: 0.7, crawl: 1.1 },
  easing: { smooth: [0.22, 1, 0.36, 1] as [number, number, number, number] },
  distance: { xs: 4, sm: 8, md: 16, lg: 24 },
  scale: { hover: 1.02, press: 0.97 },
  /** Stagger interval in seconds (kept inside the 0.05-0.10 rule). */
  stagger: 0.08,
} as const;

export const springs = {
  snappy: { type: "spring", stiffness: 380, damping: 30 },
  gentle: { type: "spring", stiffness: 140, damping: 22 },
  nav: { type: "spring", stiffness: 420, damping: 36 },
} as const;
