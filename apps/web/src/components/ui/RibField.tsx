"use client";
import { useEffect, useRef } from "react";
import { cn } from "./cn";

const STRIPE_GAP = 11; // css px between stripes
const SEG = 28; // vertical segment length for bending
const RADIUS = 300; // cursor influence radius (css px)
const LERP = 0.1;
const BEND = 0.32; // how far stripes are pushed sideways near the cursor

/**
 * Full-bleed fluted-glass stripes on black. Stripes near the pointer bend sideways and brighten to electric blue,
 * with a faint blue light following the cursor (lerped). One canvas, one rAF loop, no React re-renders per frame.
 * Pauses offscreen / hidden tab. Touch: slow ambient drift. prefers-reduced-motion: static render.
 * Place inside a `relative` container; it fills it (absolute inset-0) and ignores pointer events.
 */
export function RibField({ className }: { className?: string }) {
  const wrap = useRef<HTMLDivElement>(null);
  const cvs = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = wrap.current;
    const canvas = cvs.current;
    const ctx = canvas?.getContext("2d");
    if (!el || !canvas || !ctx) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const coarse = window.matchMedia("(pointer: coarse)").matches;

    let w = 0, h = 0, dpr = 1;
    let tx = -9999, ty = -9999; // target pointer
    let px = -9999, py = -9999; // lerped pointer
    let active = false; // pointer present
    let strength = 0; // eased 0..1 influence
    let raf = 0, visible = true, running = false;

    const resize = () => {
      const r = el.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = r.width; h = r.height;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw(performance.now());
    };

    const draw = (t: number) => {
      ctx.clearRect(0, 0, w, h);
      // ambient target (touch / idle): slow Lissajous drift
      if (!active && !reduced) {
        tx = w * (0.5 + 0.32 * Math.sin(t / 5200));
        ty = h * (0.45 + 0.2 * Math.cos(t / 6800));
      }
      const k = reduced ? 0 : LERP;
      if (px < -9000) { px = tx; py = ty; }
      px += (tx - px) * k; py += (ty - py) * k;
      const target = reduced ? 0 : active ? 1 : 0.55; // ambient is gentler
      strength += (target - strength) * 0.06;

      // soft light following the cursor
      if (strength > 0.01) {
        const g = ctx.createRadialGradient(px, py, 0, px, py, RADIUS * 1.3);
        g.addColorStop(0, `rgba(47,107,255,${0.2 * strength})`);
        g.addColorStop(1, "rgba(47,107,255,0)");
        ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      }

      const sig2 = (RADIUS * 0.5) ** 2 * 2;
      ctx.lineCap = "round";
      for (let x = STRIPE_GAP / 2; x < w; x += STRIPE_GAP) {
        let peak = 0;
        ctx.beginPath();
        for (let y = 0; y <= h + SEG; y += SEG) {
          const dx = x - px, dy = y - py;
          const f = strength * Math.exp(-(dx * dx + dy * dy) / sig2);
          if (f > peak) peak = f;
          const xs = x + dx * f * BEND;
          if (y === 0) ctx.moveTo(xs, y); else ctx.lineTo(xs, y);
        }
        const a = 0.055 + peak * 0.5;
        ctx.lineWidth = 1.2 + peak * 1.2;
        ctx.strokeStyle = peak > 0.02
          ? `rgba(${Math.round(255 - 208 * peak)},${Math.round(255 - 148 * peak)},255,${a})`
          : "rgba(255,255,255,0.055)";
        ctx.stroke();
      }
    };

    const loop = (t: number) => {
      draw(t);
      raf = requestAnimationFrame(loop);
    };
    const start = () => {
      if (running || reduced || !visible || document.hidden) return;
      running = true; raf = requestAnimationFrame(loop);
    };
    const stop = () => { running = false; cancelAnimationFrame(raf); };

    const onMove = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const r = el.getBoundingClientRect();
      tx = e.clientX - r.left; ty = e.clientY - r.top; active = true;
    };
    const onLeave = () => { active = false; };
    const onVis = () => (document.hidden ? stop() : start());

    const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; visible ? start() : stop(); });
    const ro = new ResizeObserver(resize);
    io.observe(el); ro.observe(el);
    if (!coarse) {
      window.addEventListener("pointermove", onMove, { passive: true });
      document.addEventListener("pointerleave", onLeave);
    }
    document.addEventListener("visibilitychange", onVis);
    resize(); start();
    return () => {
      stop(); io.disconnect(); ro.disconnect();
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerleave", onLeave);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  return (
    <div
      ref={wrap}
      aria-hidden
      className={cn("pointer-events-none absolute inset-0 overflow-hidden", className)}
      style={{ maskImage: "linear-gradient(to bottom,#000 0%,#000 70%,transparent 100%)", WebkitMaskImage: "linear-gradient(to bottom,#000 0%,#000 70%,transparent 100%)" }}
    >
      <div className="blue-light" />
      <canvas ref={cvs} className="absolute inset-0" />
    </div>
  );
}
