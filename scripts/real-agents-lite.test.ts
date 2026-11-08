import { describe, expect, it, vi } from "vitest";
import { fakeHostFor, localhostTransport, mapEndpoint, parseCli } from "./real-agents-lite";

describe("mapEndpoint", () => {
  const host = fakeHostFor("cs-agents-demo");
  it("maps the fake https host onto 127.0.0.1:<port>", () => {
    expect(mapEndpoint(`https://${host}/v1/chat/completions`, host, 8765)).toBe("http://127.0.0.1:8765/v1/chat/completions");
  });
  it.each(["https://example.com/v1/chat/completions", "http://cs-agents-demo.real-agent.test/v1", "https://ai-gateway.vercel.sh/v1", "https://user:p@cs-agents-demo.real-agent.test/x", "https://cs-agents-demo.real-agent.test:8443/x", "not a url"])(
    "refuses %s", (u) => { expect(() => mapEndpoint(u, host, 8765)).toThrow(/transport/); },
  );
});

describe("localhostTransport", () => {
  it("never performs I/O for a foreign host", async () => {
    const f = vi.fn();
    await expect(localhostTransport("a.real-agent.test", 1, 1000, f as unknown as typeof fetch).post("https://evil.test/x", {})).rejects.toThrow(/refused/);
    expect(f).not.toHaveBeenCalled();
  });
  it("posts the body to the mapped URL without forwarding the bearer", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ ok: 1 })));
    const out = await localhostTransport("a.real-agent.test", 9, 1000, f as unknown as typeof fetch).post("https://a.real-agent.test/v1/chat/completions", { m: 1 }, "secret");
    expect(out).toEqual({ ok: 1 });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:9/v1/chat/completions");
    expect(JSON.stringify(init.headers)).not.toContain("secret");
  });
});

describe("parseCli", () => {
  it("parses flags and converts budget", () => {
    expect(parseCli(["--slug", "x-agent", "--port", "9000", "--budget-usd", "0.5", "--limit", "3"])).toMatchObject({ slug: "x-agent", port: 9000, budgetMicroUsd: 500_000, limit: 3 });
  });
  it("defaults to the cs demo with $1.50", () => {
    expect(parseCli([])).toMatchObject({ slug: "cs-agents-demo", port: 8765, budgetMicroUsd: 1_500_000 });
  });
});
