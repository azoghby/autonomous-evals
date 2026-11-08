/**
 * Image/audio perturbations for robustness testing of media-reading agents.
 * Image ops use sharp (lazy-loaded) and are deterministic for a given seed.
 */
import { loadSharp } from "./render.js";

export type ImagePerturbation = "blur" | "rotate" | "low_light" | "crop" | "jpeg" | "noise";
export type AudioPerturbation = "accent" | "speed" | "packet_loss" | "background_noise";
export const IMAGE_PERTURBATIONS: readonly ImagePerturbation[] = ["blur", "rotate", "low_light", "crop", "jpeg", "noise"];
export const AUDIO_PERTURBATIONS: readonly AudioPerturbation[] = ["accent", "speed", "packet_loss", "background_noise"];

export interface PerturbedImage {
  bytes: Uint8Array;
  mediaType: "image/png" | "image/jpeg";
  applied: string[];
}

type Intensity = "mild" | "strong";
type Rng = () => number;

/** mulberry32: tiny deterministic PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pickLevel = <T>(i: Intensity, mild: T, strong: T): T => (i === "mild" ? mild : strong);

type Sharp = Awaited<ReturnType<typeof loadSharp>>;
interface Ctx {
  sharp: Sharp;
  rng: Rng;
  intensity: Intensity;
}
interface State {
  buf: Buffer;
  jpeg: boolean;
}
type Op = (c: Ctx, buf: Buffer) => Promise<Buffer>;

const png = (buf: Buffer, c: Ctx, f: (s: ReturnType<Sharp>) => ReturnType<Sharp>): Promise<Buffer> =>
  f(c.sharp(buf)).png().toBuffer();

const OPS: Record<ImagePerturbation, Op> = {
  blur: (c, buf) => png(buf, c, (s) => s.blur(pickLevel(c.intensity, 1.2, 2.5))),

  rotate: (c, buf) => {
    const sign = c.rng() < 0.5 ? -1 : 1;
    const angle = sign * pickLevel(c.intensity, 4, 12) * (0.6 + 0.4 * c.rng());
    return png(buf, c, (s) => s.rotate(angle, { background: "#ffffff" }));
  },

  low_light: (c, buf) =>
    png(buf, c, (s) => s.modulate({ brightness: pickLevel(c.intensity, 0.45, 0.3) }).gamma(pickLevel(c.intensity, 1.2, 1.5))),

  /**
   * Trims 4% (mild) / 10% (strong) from the width/height on seed-chosen edges (at
   * least one). Rendered documents keep >= 4% padding, so mild never removes content;
   * strong may clip text near the edges.
   */
  crop: async (c, buf) => {
    const meta = await c.sharp(buf).metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    const frac = pickLevel(c.intensity, 0.04, 0.1);
    const edges = [c.rng() < 0.5, c.rng() < 0.5, c.rng() < 0.5, c.rng() < 0.5]; // l, t, r, b
    if (!edges.some(Boolean)) edges[Math.floor(c.rng() * 4)] = true;
    const [l, t, r, b] = edges.map((e, i) => (e ? Math.round((i % 2 === 0 ? w : h) * frac) : 0)) as [number, number, number, number];
    return png(buf, c, (s) => s.extract({ left: l, top: t, width: w - l - r, height: h - t - b }));
  },

  jpeg: (c, buf) =>
    c
      .sharp(buf)
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: pickLevel(c.intensity, 35, 12) })
      .toBuffer(),

  noise: async (c, buf) => {
    const amp = pickLevel(c.intensity, 12, 30);
    const { data, info } = await c.sharp(buf).flatten({ background: "#ffffff" }).raw().toBuffer({ resolveWithObject: true });
    const out = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i++) {
      const n = (c.rng() + c.rng() + c.rng() - 1.5) * amp; // gaussian-ish, std ~ amp/2
      out[i] = Math.max(0, Math.min(255, Math.round((data[i] as number) + n)));
    }
    return c.sharp(out, { raw: { width: info.width, height: info.height, channels: info.channels } }).png().toBuffer();
  },
};

const isImagePerturbation = (n: string): n is ImagePerturbation => (IMAGE_PERTURBATIONS as readonly string[]).includes(n);
const isJpegMagic = (b: Uint8Array): boolean => b.length > 2 && b[0] === 0xff && b[1] === 0xd8;

export async function perturbImage(
  input: Uint8Array,
  perturbations: readonly string[],
  opts: { seed?: number; intensity?: Intensity } = {},
): Promise<PerturbedImage> {
  const ctx: Ctx = { sharp: await loadSharp(), rng: mulberry32(opts.seed ?? 1), intensity: opts.intensity ?? "mild" };
  const applied: string[] = [];
  let state: State = { buf: Buffer.from(input), jpeg: isJpegMagic(input) };
  for (const name of perturbations) {
    if (!isImagePerturbation(name)) continue;
    state = { buf: await OPS[name](ctx, state.buf), jpeg: name === "jpeg" };
    applied.push(name);
  }
  return { bytes: new Uint8Array(state.buf), mediaType: state.jpeg ? "image/jpeg" : "image/png", applied };
}

export class AudioPerturbationUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AudioPerturbationUnavailableError";
  }
}

// TODO(week-1): implement audio perturbations with ffmpeg inside the Vercel Sandbox worker.
// Intended filter graphs:
//   speed            -> -filter:a "atempo=1.25"
//   packet_loss      -> drop 20ms frames at a seeded 5% rate via `aselect`
//                       (e.g. aselect='gte(mod(floor(t/0.02),N),1)'-style mask built from the seed)
//   background_noise -> amix of the input with `anoisesrc=color=pink:amplitude=0.05`
//   accent           -> not a signal perturbation: a TTS persona dial handled by
//                       tts.ts voice/instructions at generation time.
export async function perturbAudio(
  input: Uint8Array,
  perturbations: readonly string[],
): Promise<{ bytes: Uint8Array; applied: string[] }> {
  const requested = perturbations.filter((p) => (AUDIO_PERTURBATIONS as readonly string[]).includes(p));
  if (requested.length === 0) return { bytes: input, applied: [] };
  throw new AudioPerturbationUnavailableError(
    `Audio perturbations (${requested.join(", ")}) require ffmpeg and must run inside the Vercel Sandbox worker; they are not available in this process.`,
  );
}
