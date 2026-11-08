import { describe, expect, it, vi } from "vitest";
import { neonPut, neonGet, neonDelete, assertJobKey, neonStorageConfigFromEnv, type NeonStorageConfig } from "./neon-storage";
import type { S3Client } from "@aws-sdk/client-s3";

const cfg: NeonStorageConfig = { endpoint: "https://e", region: "us-east-2", bucket: "artifacts", accessKeyId: "a", secretAccessKey: "s" };
const mk = (impl: (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => unknown) =>
  ({ send: vi.fn(async (c) => impl(c)) }) as unknown as S3Client & { send: ReturnType<typeof vi.fn> };

describe("neon-storage", () => {
  it("puts to the configured bucket", async () => {
    const client = mk(() => ({}));
    await neonPut("jobs/j1/report-ab.md", "hi", "text/markdown", { cfg, client });
    const cmd = client.send.mock.calls[0]![0];
    expect(cmd.constructor.name).toBe("PutObjectCommand");
    expect(cmd.input).toMatchObject({ Bucket: "artifacts", Key: "jobs/j1/report-ab.md", ContentType: "text/markdown" });
  });
  it("get returns null on NoSuchKey and stream otherwise", async () => {
    const miss = mk(() => { throw Object.assign(new Error("x"), { name: "NoSuchKey" }); });
    expect(await neonGet("jobs/j/a.md", { cfg, client: miss })).toBeNull();
    const hit = mk(() => ({ Body: { transformToWebStream: () => new Response("z").body }, ContentType: "text/plain", ContentLength: 1 }));
    const r = await neonGet("jobs/j/a.md", { cfg, client: hit });
    expect(r?.size).toBe(1);
    expect(await new Response(r!.stream).text()).toBe("z");
  });
  it("delete sends DeleteObject", async () => {
    const client = mk(() => ({}));
    await neonDelete("jobs/j/a.md", { cfg, client });
    expect(client.send.mock.calls[0]![0].constructor.name).toBe("DeleteObjectCommand");
  });
  it("rejects keys outside jobs/<id>/<file>", () => {
    for (const k of ["../x", "jobs/../x/a", "other/a/b", "jobs/a/b/c", "jobs//a"]) expect(() => assertJobKey(k)).toThrow();
  });
  it("config requires all vars", () => {
    expect(neonStorageConfigFromEnv({})).toBeNull();
  });
});
