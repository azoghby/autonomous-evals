import { describe, it, expect, beforeAll } from "vitest";
import { renderDocument } from "./render.js";
import {
  perturbImage,
  perturbAudio,
  IMAGE_PERTURBATIONS,
  AudioPerturbationUnavailableError,
} from "./perturb.js";
import { loadSharp } from "./render.js";

let input: Uint8Array;
beforeAll(async () => {
  input = (await renderDocument("receipt", { merchant: "Acme Coffee", total: "47.20" }, { scale: 1 })).png;
});

const same = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(b));

describe("perturbImage", () => {
  it.each(IMAGE_PERTURBATIONS)("%s changes bytes and stays decodable", async (p) => {
    const out = await perturbImage(input, [p], { seed: 7 });
    const sharp = await loadSharp();
    const meta = await sharp(out.bytes).metadata();
    expect(meta.width).toBeGreaterThan(0);
    expect(same(out.bytes, input)).toBe(false);
    expect(out.applied).toEqual([p]);
  });

  it("is deterministic for the same seed and varies across seeds", async () => {
    const ops = ["rotate", "crop", "noise", "blur"];
    const a = await perturbImage(input, ops, { seed: 42 });
    const b = await perturbImage(input, ops, { seed: 42 });
    const c = await perturbImage(input, ops, { seed: 43 });
    expect(same(a.bytes, b.bytes)).toBe(true);
    expect(same(a.bytes, c.bytes)).toBe(false);
  });

  it("strong intensity differs from mild", async () => {
    const m = await perturbImage(input, ["blur"], { seed: 1, intensity: "mild" });
    const s = await perturbImage(input, ["blur"], { seed: 1, intensity: "strong" });
    expect(same(m.bytes, s.bytes)).toBe(false);
  });

  it("reports jpeg media type only when jpeg is last", async () => {
    expect((await perturbImage(input, ["jpeg"])).mediaType).toBe("image/jpeg");
    expect((await perturbImage(input, ["blur", "jpeg"])).mediaType).toBe("image/jpeg");
    expect((await perturbImage(input, ["jpeg", "blur"])).mediaType).toBe("image/png");
  });

  it("ignores unknown and audio names", async () => {
    const out = await perturbImage(input, ["speed", "bogus", "blur"]);
    expect(out.applied).toEqual(["blur"]);
  });
});

describe("perturbAudio", () => {
  it("rejects audio perturbations as unavailable", async () => {
    await expect(perturbAudio(new Uint8Array([1, 2, 3]), ["speed"])).rejects.toBeInstanceOf(AudioPerturbationUnavailableError);
  });

  it("returns input unchanged when no audio perturbations requested", async () => {
    const buf = new Uint8Array([1, 2, 3]);
    const out = await perturbAudio(buf, []);
    expect(out.bytes).toBe(buf);
    expect(out.applied).toEqual([]);
  });
});
