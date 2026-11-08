import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAcmeSupport } from "./acme";
import { buildPrebuiltEnv, isPrebuiltEnvId, listPrebuiltEnvs } from "./prebuilt";
import { PREBUILT_ENV_FILES } from "./prebuilt-files.generated";

const ROOT = resolve(import.meta.dirname, "../../../../..");

describe("prebuilt sandbox environments", () => {
  it("bundled files match data/envs (run scripts/gen-sandbox-prebuilt.ts after editing them)", () => {
    for (const [id, files] of Object.entries(PREBUILT_ENV_FILES)) {
      for (const [name, content] of Object.entries(files)) {
        expect(content, `${id}/${name}`).toBe(readFileSync(resolve(ROOT, "data/envs", id, name), "utf8"));
      }
    }
  });

  it("lists acme-support and builds the same spec as buildAcmeSupport", async () => {
    expect(isPrebuiltEnvId("acme-support")).toBe(true);
    expect(isPrebuiltEnvId("nope")).toBe(false);
    expect(listPrebuiltEnvs().map((e) => e.id)).toContain("acme-support");
    const [a, b] = await Promise.all([buildPrebuiltEnv("acme-support"), buildAcmeSupport()]);
    expect(a.spec).toEqual(b.spec);
  });

  it("applies the given integration", async () => {
    const { spec } = await buildPrebuiltEnv("acme-support", { mode: "tool_loop", endpointUrl: "https://ai-gateway.vercel.sh/v1/chat/completions", model: "openai/gpt-5-mini" });
    expect(spec.integration).toMatchObject({ mode: "tool_loop", model: "openai/gpt-5-mini" });
  });

  it("rejects unknown ids", async () => {
    await expect(buildPrebuiltEnv("nope")).rejects.toThrow(/Unknown prebuilt/);
  });
});
