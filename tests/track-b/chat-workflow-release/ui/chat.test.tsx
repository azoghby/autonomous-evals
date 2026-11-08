import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { JobPrivateChat } from "./job-private-chat";
const reply = (text = "Recorded checks are running.") => ({ text, asOf: "2026-11-07T12:00:00Z", unknowns: ["Completion time is unknown."] });
const exchange = (sequence: number, messageId = `message-${sequence}`) => ({ messageId, sequence, reply: reply(`Saved answer ${sequence}`), inputDigest: "never displayed", evidenceRefs: ["opaque"] });
const page = (exchanges: ReturnType<typeof exchange>[], hasMore = false) => ({ exchanges, nextAfterSequence: exchanges.at(-1)?.sequence ?? 0, hasMore });
const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body });
let fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetcher = vi.fn((url: string) => url.includes("mode=poll") ? ok({ cursor: "a".repeat(64), changed: true, reply: reply() }) : ok(page([])));
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("Private progress chat", () => {
  it("loads successfully under React StrictMode effect replay", async () => {
    render(<React.StrictMode><JobPrivateChat jobId="job-a" /></React.StrictMode>);
    await screen.findByText(/No answers yet/);
    expect(screen.queryByText("Loading private history…")).toBeNull();
  });
  it("loads persisted progress and empty history with privacy guidance", async () => {
    render(<JobPrivateChat jobId="job-a" />);
    expect(screen.getByText("Loading private history…")).toBeTruthy();
    await screen.findByText("Recorded checks are running.");
    await screen.findByText(/No answers yet/);
    expect(screen.getByLabelText("Ask about this evaluation")).toBeTruthy();
    expect(screen.getByText(/Do not include API keys/)).toBeTruthy();
    expect(fetcher.mock.calls.every(([, init]) => init.credentials === "same-origin" && init.cache === "no-store")).toBe(true);
  });
  it("paginates ascending history and displays plain text without evidence or digest", async () => {
    fetcher.mockImplementation((url: string) => url.includes("mode=poll") ? ok({ cursor: "a".repeat(64), changed: false }) : url.includes("afterSequence=1") ? ok(page([exchange(2)])) : ok(page([exchange(1)], true)));
    render(<JobPrivateChat jobId="job-a" />);
    await screen.findByText("Saved answer 1");
    fireEvent.click(screen.getByRole("button", { name: "Load next answers" }));
    await screen.findByText("Saved answer 2");
    expect(screen.getAllByText(/^Answer \d/).map(e => e.textContent)).toEqual(["Answer 1", "Answer 2"]);
    expect(screen.queryByText("opaque")).toBeNull();
    expect(screen.queryByText("never displayed")).toBeNull();
  });
  it("retries a failed send with identical identity and text, then deduplicates history", async () => {
    const posts: {messageId: string; text: string}[] = [];
    fetcher.mockImplementation((url: string, init: RequestInit) => {
      if (init.method === "POST") {
        posts.push(JSON.parse(String(init.body)));
        if (posts.length === 1) return Promise.reject(new Error("provider secret leaked"));
        return ok({ exchange: exchange(1, posts[0].messageId) });
      }
      return url.includes("mode=poll") ? ok({ cursor: "a".repeat(64), changed: false }) : ok(page([]));
    });
    render(<JobPrivateChat jobId="job-a" />);
    await screen.findByText(/No answers yet/);
    fireEvent.change(screen.getByLabelText("Ask about this evaluation"), { target: { value: "What is the cost?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send question" }));
    await screen.findByText("Private chat is temporarily unavailable. Try again.");
    expect(screen.queryByText("provider secret leaked")).toBeNull();
    expect((screen.getByLabelText("Ask about this evaluation") as HTMLTextAreaElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Retry same question" }));
    await screen.findByText("Saved answer 1");
    expect(posts[1]).toEqual(posts[0]);
    expect(Object.keys(posts[0]).sort()).toEqual(["messageId", "text"]);
    expect((screen.getByLabelText("Ask about this evaluation") as HTMLTextAreaElement).value).toBe("");
  });
  it("shows safe authorization errors and supports explicit history retry", async () => {
    let authorized = false;
    fetcher.mockImplementation((url: string) => url.includes("mode=poll") ? ok({ cursor: "a".repeat(64), changed: false }) : authorized ? ok(page([exchange(1)])) : Promise.resolve({ ok: false, status: 404, json: async () => ({ error: "raw trace" }) }));
    render(<JobPrivateChat jobId="job-other" />);
    await screen.findByText("This job is unavailable to your account.");
    expect(screen.queryByText("raw trace")).toBeNull();
    authorized = true;
    fireEvent.click(screen.getByRole("button", { name: "Retry history" }));
    await screen.findByText("Saved answer 1");
  });
  it("polls progress and history with separate cursors and stops on unmount", async () => {
    vi.useFakeTimers();
    const view = render(<JobPrivateChat jobId="job-a" />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(fetcher.mock.calls.some(([url]) => String(url).includes(`cursor=${"a".repeat(64)}`))).toBe(true);
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes("afterSequence=0")).length).toBeGreaterThan(1);
    view.unmount();
    const count = fetcher.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fetcher.mock.calls.length).toBe(count);
  });
  it("clears loaded private answers if a later progress poll denies access", async () => {
    vi.useFakeTimers();
    let denied = false;
    fetcher.mockImplementation((url: string) => url.includes("mode=poll") ? denied ? Promise.resolve({ok:false,status:401}) : ok({cursor:"a".repeat(64),changed:true,reply:reply()}) : ok(page([exchange(1)])));
    render(<JobPrivateChat jobId="job-a" />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByText("Saved answer 1")).toBeTruthy();
    denied = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.queryByText("Saved answer 1")).toBeNull();
    expect(screen.queryByText("Recorded checks are running.")).toBeNull();
    expect(screen.getByText("Sign in again to read your private chat.")).toBeTruthy();
  });
  it("clears drafts and prior job answers when navigating across jobs", async () => {
    fetcher.mockImplementation((url: string) => url.includes("mode=poll") ? ok({ cursor: "a".repeat(64), changed: false }) : ok(page(url.includes("job-a") ? [exchange(1)] : [])));
    const view = render(<JobPrivateChat jobId="job-a" />);
    await screen.findByText("Saved answer 1");
    fireEvent.change(screen.getByLabelText("Ask about this evaluation"), { target: { value: "private draft" } });
    view.rerender(<JobPrivateChat jobId="job-b" />);
    await screen.findByText(/No answers yet/);
    expect(screen.queryByText("Saved answer 1")).toBeNull();
    expect((screen.getByLabelText("Ask about this evaluation") as HTMLTextAreaElement).value).toBe("");
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("/jobs/job-b/chat"))).toBe(true);
  });
  it("rejects an over-byte-limit question locally", async () => {
    render(<JobPrivateChat jobId="job-a" />);
    await screen.findByText(/No answers yet/);
    fireEvent.change(screen.getByLabelText("Ask about this evaluation"), { target: { value: "界".repeat(3000) } });
    fireEvent.click(screen.getByRole("button", { name: "Send question" }));
    await screen.findByText("Use a question of at most 4,000 characters and 8,000 bytes.");
    expect(fetcher.mock.calls.some(([,init]) => init.method === "POST")).toBe(false);
  });
});
