import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { LoopbackJsonTransport, isLoopbackEndpoint } from "@ae/core/targets/transport";
import { runPublicAgent } from "./public-agent-runner";
import { buildStandardSuite } from "./leaderboard-suite";

const local = {
  slug: "x--m", name: "x", vendor: "v", kind: "local_reference" as const, endpointUrl: "http://127.0.0.1:8765/v1/chat/completions", model: "openai/gpt-5.5",
  termsUrl: "https://example.com/LICENSE", authorizedNote: "MIT sample agent run by us.", active: true,
};

describe("local_reference runs", () => {
  it("refuses without allowLocal (the web/cron path never sets it), even in dry-run", async () => {
    await expect(runPublicAgent(local, { suite: buildStandardSuite(), dryRun: true })).rejects.toThrow(/--allow-local/);
  });
  it("dry-run plans fine with allowLocal", async () => {
    const lines: string[] = [];
    const out = await runPublicAgent(local, { suite: buildStandardSuite(), dryRun: true, allowLocal: true, log: (l) => lines.push(l) });
    expect(out.dryRun).toBe(true);
    expect(lines[0]).toContain("127.0.0.1:8765");
  });
});

describe("LoopbackJsonTransport", () => {
  it("only accepts exact loopback http endpoints", () => {
    expect(isLoopbackEndpoint("http://127.0.0.1:8765/v1/chat/completions")).toBe(true);
    for (const u of ["http://localhost:8765/x", "http://10.0.0.1:80/x", "https://127.0.0.1:8765/x", "http://127.0.0.1/x", "http://127.0.0.1:1/x?a=1", "nope"]) expect(isLoopbackEndpoint(u)).toBe(false);
  });
  it("refuses non-loopback endpoints and talks to a loopback server", async () => {
    const t = new LoopbackJsonTransport({ timeoutMs: 5_000 });
    await expect(t.post("http://169.254.169.254:80/x", {})).rejects.toMatchObject({ code: "blocked_address" });
    const srv = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end('{"ok":true}'); });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    try {
      const port = (srv.address() as AddressInfo).port;
      await expect(t.post(`http://127.0.0.1:${port}/v1/chat/completions`, { a: 1 })).resolves.toEqual({ ok: true });
    } finally { srv.close(); }
  });
});
