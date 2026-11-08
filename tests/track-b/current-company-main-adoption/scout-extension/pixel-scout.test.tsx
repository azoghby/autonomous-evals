import React from "react";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { JobPrivateChat } from "./job-private-chat";
import { ScoutMark, SCOUT_PIXEL_PATH } from "./scout-mark";

// Approved artwork, verbatim from the owner request. Any redesign must fail here.
const APPROVED = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" shape-rendering="crispEdges"><path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M4 1H7V7H9V3H10V1H13V2H15V5H13V4H12V7H13V8H14V10H15V13H14V14H12V15H4V14H2V13H1V10H2V8H4V1ZM4 10H6V12H4V10ZM10 10H12V12H10V10ZM7 13H9V14H7V13Z"/></svg>';
const APPROVED_PATH = "M4 1H7V7H9V3H10V1H13V2H15V5H13V4H12V7H13V8H14V10H15V13H14V14H12V15H4V14H2V13H1V10H2V8H4V1ZM4 10H6V12H4V10ZM10 10H12V12H10V10ZM7 13H9V14H7V13Z";
const asset = readFileSync(join(process.cwd(), "scout-pixel.svg"), "utf8");
const componentSource = readFileSync(join(process.cwd(), "scout-mark.tsx"), "utf8");
const chatSource = readFileSync(join(process.cwd(), "job-private-chat.tsx"), "utf8");

const reply = (text = "Recorded checks are running.") => ({ text, asOf: "2026-11-07T12:00:00Z", unknowns: ["Completion time is unknown."] });
const exchange = (sequence: number) => ({ messageId: `message-${sequence}`, sequence, reply: reply(`Saved answer ${sequence}`) });
const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body });
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn((url: string) => url.includes("mode=poll")
    ? ok({ cursor: "a".repeat(64), changed: true, reply: reply() })
    : ok({ exchanges: [exchange(1), exchange(2)], nextAfterSequence: 2, hasMore: false })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("approved Scout pixel artwork", () => {
  it("standalone asset is the approved SVG exactly", () => {
    expect(asset.trimEnd()).toBe(APPROVED);
    expect(asset.endsWith("\n")).toBe(true);
    expect(createHash("sha256").update(APPROVED).digest("hex")).toBe("0c4bb2ff7f4b1ac6f573ae41187a8f251814f930c782a020aac8ad5d507d89fc");
  });
  it("component geometry is identical to the asset and the approved path", () => {
    expect(SCOUT_PIXEL_PATH).toBe(APPROVED_PATH);
    expect(asset).toContain(`d="${APPROVED_PATH}"`);
    const { container } = render(<ScoutMark />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("viewBox")).toBe("0 0 16 16");
    expect(svg.getAttribute("fill")).toBe("none");
    expect(svg.getAttribute("shape-rendering")).toBe("crispEdges");
    const path = svg.querySelector("path")!;
    expect(svg.querySelectorAll("*")).toHaveLength(1);
    expect(path.getAttribute("d")).toBe(APPROVED_PATH);
    expect(path.getAttribute("fill")).toBe("currentColor");
    expect(path.getAttribute("fill-rule")).toBe("evenodd");
    expect(path.getAttribute("clip-rule")).toBe("evenodd");
  });
  it("renders only at integer grid multiples and is decorative", () => {
    for (const size of [16, 32] as const) {
      const { container, unmount } = render(<ScoutMark size={size} />);
      const svg = container.querySelector("svg")!;
      expect(svg.getAttribute("width")).toBe(String(size));
      expect(svg.getAttribute("height")).toBe(String(size));
      expect(size % 16).toBe(0);
      expect(svg.getAttribute("aria-hidden")).toBe("true");
      expect(svg.getAttribute("focusable")).toBe("false");
      expect(svg.querySelector("title,desc")).toBeNull();
      unmount();
    }
    expect(render(<ScoutMark />).container.querySelector("svg")!.getAttribute("width")).toBe("16");
  });
  it("is static: no animation, remote asset, raster, font, script or color literal", () => {
    expect(componentSource).not.toMatch(/animate|keyframes|transition|@font|font-face|https?:\/\/(?!www\.w3\.org\/2000\/svg)|<image|<script|<style|data:image|#[0-9a-fA-F]{3,8}\b|rgb\(|import /);
    expect(asset).not.toMatch(/animate|style=|<image|<script|href=|#[0-9a-fA-F]{3,8}\b/);
  });
});

describe("Scout mark in the private progress chat", () => {
  it("keeps the existing heading, section name and form semantics", async () => {
    render(<JobPrivateChat jobId="job-a" />);
    await screen.findByText("Saved answer 2");
    const heading = screen.getByRole("heading", { level: 2, name: "Private progress chat" });
    expect(heading.textContent).toBe("Private progress chat");
    expect(screen.getByRole("region", { name: "Private progress chat" })).toBeTruthy();
    expect(screen.getByRole("list", { name: "Private chat answers" })).toBeTruthy();
    expect(screen.getByLabelText("Ask about this evaluation")).toBeTruthy();
    expect(screen.getByLabelText("Latest persisted progress")).toBeTruthy();
  });
  it("places a 32px mark beside the header and a 16px mark in every answer label", async () => {
    const { container } = render(<JobPrivateChat jobId="job-a" />);
    await screen.findByText("Saved answer 2");
    const header = container.querySelector("header")!;
    const headerMarks = header.querySelectorAll("svg");
    expect(headerMarks).toHaveLength(1);
    expect(headerMarks[0].getAttribute("width")).toBe("32");
    expect(headerMarks[0].parentElement).toBe(header);
    expect(headerMarks[0].nextElementSibling!.contains(screen.getByRole("heading", { name: "Private progress chat" }))).toBe(true);
    const labels = [screen.getByText("Latest persisted progress"), ...screen.getAllByText(/^Answer \d/)];
    expect(labels.map(l => l.textContent)).toEqual(["Latest persisted progress", "Answer 1", "Answer 2"]);
    for (const label of labels) {
      const marks = label.querySelectorAll("svg");
      expect(marks).toHaveLength(1);
      expect(marks[0].getAttribute("width")).toBe("16");
    }
    // 1 header + 1 snapshot + 2 answers, nothing else (form, buttons, status text carry no mark).
    expect(container.querySelectorAll("svg")).toHaveLength(4);
  });
  it("hides every mark from assistive technology and adds no accessible names or focus stops", async () => {
    const { container } = render(<JobPrivateChat jobId="job-a" />);
    await screen.findByText("Saved answer 2");
    for (const svg of Array.from(container.querySelectorAll("svg"))) {
      expect(svg.getAttribute("aria-hidden")).toBe("true");
      expect(svg.getAttribute("focusable")).toBe("false");
      expect(svg.hasAttribute("aria-label")).toBe(false);
      expect(svg.hasAttribute("tabindex")).toBe(false);
      expect(svg.getAttribute("class")).toMatch(/shrink-0/);
    }
    expect(within(container).queryAllByRole("img")).toHaveLength(0);
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });
  it("uses currentColor via token classes and leaves authority/replay logic untouched", () => {
    expect(chatSource).toContain('<ScoutMark size={32} className="shrink-0 text-accent-text" />');
    expect(chatSource).toContain("Private progress chat");
    expect(chatSource.match(/<ScoutMark /g)).toHaveLength(3);
  });
});
