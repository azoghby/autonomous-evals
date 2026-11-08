import { describe, expect, it, vi } from "vitest";
import type { StoredUiPart } from "@/components/chat/nova-types";
import type { LiveSources } from "./onboarding-chat";
import { chunkReply, novaTurnStream, type TurnResult } from "./onboarding-chat-stream";

async function readAll(stream: ReadableStream): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(value as Record<string, unknown>);
  }
}
const types = (chunks: Array<Record<string, unknown>>) => chunks.map((c) => c.type);

const stored = (tool: StoredUiPart["tool"], id: string, input: object, output: unknown): StoredUiPart => ({ tool, id, input, output }) as unknown as StoredUiPart;
const turn = (over: Partial<TurnResult> = {}): TurnResult => ({ reply: "Hello there, how can I help today?", conversationId: "c1", status: "collecting", ui: [], ...over });
const noSrc: LiveSources = { getDraft: async () => null, getRunReport: async () => null };

describe("chunkReply", () => {
  it("groups words three at a time and keeps whitespace so chunks rejoin to the original", () => {
    const text = "one two three four five six seven";
    const chunks = chunkReply(text);
    expect(chunks).toEqual(["one two three ", "four five six ", "seven"]);
    expect(chunks.join("")).toBe(text);
  });
  it("returns no chunks for empty or whitespace-only text", () => {
    expect(chunkReply("")).toEqual([]);
    expect(chunkReply("   ")).toEqual([]);
  });
  it("preserves leading whitespace on the first chunk", () => {
    const chunks = chunkReply("\n\nHi there");
    expect(chunks.join("")).toBe("\n\nHi there");
    expect(chunks[0]!.startsWith("\n\n")).toBe(true);
  });
  it("honours a custom chunk size", () => {
    expect(chunkReply("a b c d", 2)).toEqual(["a b ", "c d"]);
  });
});

describe("novaTurnStream", () => {
  it("emits start, thinking, metadata, text, then finish in order", async () => {
    const chunks = await readAll(novaTurnStream({ run: async () => turn(), src: () => noSrc, thinking: "Reading your message", pacing: 0 }));
    const t = types(chunks);
    expect(t[0]).toBe("start");
    expect(chunks[1]).toMatchObject({ type: "data-thinking", transient: true, data: { label: "Reading your message" } });
    expect(chunks[2]).toMatchObject({ type: "message-metadata", messageMetadata: { conversationId: "c1", status: "collecting" } });
    expect(t.slice(3, 5)).toEqual(["text-start", "text-delta"]);
    expect(t.at(-1)).toBe("finish");
    expect(t.indexOf("text-end")).toBeGreaterThan(t.lastIndexOf("text-delta"));
    const text = chunks.filter((c) => c.type === "text-delta").map((c) => c.delta).join("");
    expect(text).toBe("Hello there, how can I help today?");
  });

  it("streams a stored tool part as input-start, input-available, output-available", async () => {
    const output = { ready: false, items: [], notes: [] };
    const chunks = await readAll(novaTurnStream({
      run: async () => turn({ ui: [stored("intakeChecklist", "m-intake", {}, output)] }), src: () => noSrc, thinking: "t", pacing: 0,
    }));
    const t = types(chunks);
    const i = t.indexOf("tool-input-start");
    expect(t.slice(i, i + 3)).toEqual(["tool-input-start", "tool-input-available", "tool-output-available"]);
    expect(chunks[i]).toMatchObject({ toolCallId: "m-intake", toolName: "intakeChecklist" });
    expect(chunks[i + 2]).toMatchObject({ toolCallId: "m-intake", output });
    expect(t.indexOf("text-end")).toBeLessThan(i);
    expect(t.at(-1)).toBe("finish");
  });

  it("emits tool-output-error for a live part whose source is gone", async () => {
    const getDraft = vi.fn(async () => null);
    const chunks = await readAll(novaTurnStream({
      run: async () => turn({ status: "building", ui: [stored("environmentCard", "m-env", { suiteId: "drf-1" }, null)] }),
      src: () => ({ ...noSrc, getDraft }), thinking: "t", pacing: 0,
    }));
    const t = types(chunks);
    expect(t).toContain("tool-output-error");
    expect(t).not.toContain("tool-output-available");
    expect(chunks.find((c) => c.type === "tool-output-error")).toMatchObject({ toolCallId: "m-env", errorText: expect.stringMatching(/no longer available/) });
    expect(getDraft).toHaveBeenCalledWith("drf-1");
  });

  it("writes each tool part in order", async () => {
    const chunks = await readAll(novaTurnStream({
      run: async () => turn({ ui: [stored("intakeChecklist", "a", {}, { ready: false, items: [], notes: [] }), stored("costEstimate", "b", {}, { blocked: false })] }),
      src: () => noSrc, thinking: "t", pacing: 0,
    }));
    expect(chunks.filter((c) => c.type === "tool-input-start").map((c) => c.toolCallId)).toEqual(["a", "b"]);
  });

  it("passes the turn result to src so sources can be scoped to it", async () => {
    const src = vi.fn(() => noSrc);
    await readAll(novaTurnStream({ run: async () => turn({ conversationId: "c9" }), src, thinking: "t", pacing: 0 }));
    expect(src).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "c9" }));
  });

  it("emits an error chunk with the onError text when run() throws", async () => {
    const chunks = await readAll(novaTurnStream({
      run: async () => { throw new Error("boom"); }, src: () => noSrc, thinking: "t", pacing: 0, onError: () => "Friendly failure",
    }));
    expect(chunks.find((c) => c.type === "error")).toMatchObject({ errorText: "Friendly failure" });
    expect(types(chunks)).not.toContain("text-start");
  });

  it("falls back to a generic error text when onError is not given", async () => {
    const chunks = await readAll(novaTurnStream({ run: async () => { throw new Error("secret detail"); }, src: () => noSrc, thinking: "t", pacing: 0 }));
    const err = chunks.find((c) => c.type === "error");
    expect(err).toMatchObject({ errorText: "Could not process that message." });
    expect(JSON.stringify(err)).not.toContain("secret detail");
  });
});
