import { describe, expect, it, vi } from "vitest";
import type { Remediation } from "@ae/core/contracts/index";
import {
  GithubTargetInput, branchNameFor, isValidBranch, isValidFilePath, isValidOwner, isValidRepo, openPullRequest,
  planChange, redact, renderPrBody, PatchError, GithubError,
} from "./github-pr";

const TOKEN = "github_pat_" + "A".repeat(30);
const rem = (over: Partial<Remediation> = {}): Remediation => ({
  findingId: "F-1", kind: "prompt_patch", summary: "Require citations", rationale: "Agent made unsupported claims @bob",
  patch: "@@ -1,2 +1,2 @@\n You are helpful.\n-Answer fast.\n+Answer with citations.\n",
  verification: { status: "verified", before: { passed: 1, total: 5 }, after: { passed: 5, total: 5 }, regressions: 0, evidence: [] }, ...over,
});
const finding = { title: "Unsupported claim", severity: "high", evidence: [{ kind: "response", excerpt: "It is definitely true ```x```" }] };
const target = { owner: "acme", repo: "bot", baseBranch: "main", filePath: "prompts/system.md" };

describe("validation", () => {
  it("accepts good and rejects bad targets", () => {
    expect(isValidOwner("acme-co")).toBe(true);
    for (const o of ["-a", "a--", "a/b", "a b", "", "a".repeat(40)]) expect(isValidOwner(o)).toBe(false);
    expect(isValidRepo("my.repo_1")).toBe(true);
    for (const r of ["..", ".", "a/b", "a b", "x.git", "x?y"]) expect(isValidRepo(r)).toBe(false);
    expect(isValidBranch("release/1.2")).toBe(true);
    for (const b of ["a..b", "/a", "a/", "a//b", "a.lock/x", "x.lock", ".hid", "a b", "a~1", "a:b"]) expect(isValidBranch(b)).toBe(false);
    expect(isValidFilePath("prompts/system.md")).toBe(true);
    for (const p of ["../x", "/etc/passwd", "a/../b", ".github/workflows/ci.yml", "a\\b", ".git/config", "a//b", "a b"]) expect(isValidFilePath(p)).toBe(false);
  });
  it("requires a fine-grained token", () => {
    expect(GithubTargetInput.safeParse({ ...target, token: TOKEN }).success).toBe(true);
    expect(GithubTargetInput.safeParse({ ...target, token: "ghp_" + "a".repeat(36) }).success).toBe(false);
    expect(GithubTargetInput.safeParse({ ...target, owner: "http://evil", token: TOKEN }).success).toBe(false);
  });
});

describe("branch naming", () => {
  it("is deterministic, valid, and collision-safe", () => {
    expect(branchNameFor("f_9")).toMatch(/^standard-evals\/fix-f-9-[0-9a-f]{6}$/);
    expect(branchNameFor("abc-1")).toBe("standard-evals/fix-abc-1");
    expect(branchNameFor("F-1")).not.toBe(branchNameFor("f-1"));
    for (const id of ["x y/../z", "💥", "a".repeat(64)]) expect(isValidBranch(branchNameFor(id))).toBe(true);
  });
});

describe("PR body", () => {
  it("renders the required sections and neutralizes mentions/fences", () => {
    const body = renderPrBody({ finding, remediation: rem(), reportUrl: "https://app.test/jobs/j1" });
    expect(body).toContain("Unsupported claim");
    expect(body).toContain("high");
    expect(body).toContain("| Before | 1/5 |");
    expect(body).toContain("| After | 5/5 |");
    expect(body).toContain("| Regressions | 0 |");
    expect(body).toContain("https://app.test/jobs/j1");
    expect(body).not.toMatch(/@bob/);
    expect(body).toContain("````"); // fence longer than the ``` in the excerpt
  });
});

describe("planChange", () => {
  it("applies diffs, throws PatchError on mismatch", () => {
    expect(planChange(rem(), finding, "p.md", "You are helpful.\nAnswer fast.\n").content).toBe("You are helpful.\nAnswer with citations.\n");
    expect(() => planChange(rem(), finding, "p.md", "different\n")).toThrow(PatchError);
  });
  it("appends replacement text to prompt files idempotently, else writes a fix doc", () => {
    const r = rem({ patch: "Always cite." });
    const once = planChange(r, finding, "p.md", "Base.\n");
    expect(once).toMatchObject({ path: "p.md", kind: "source" });
    expect(once.content).toContain("Always cite.");
    expect(planChange(r, finding, "p.ts", "x").path).toMatch(/^standard-evals\/fixes\/f-1-/);
    expect(planChange(rem({ kind: "guardrail" }), finding, "p.md", "x").kind).toBe("doc");
  });
});

describe("redact", () => {
  it("removes tokens", () => { expect(redact(`bad ${TOKEN} ghp_abcdef`, TOKEN)).not.toMatch(/github_pat_|ghp_/); });
});

/** Minimal GitHub fake. */
function fakeGithub(opts: { existingPr?: boolean; branchExists?: boolean } = {}) {
  const calls: { method: string; url: string; body?: any; headers: Record<string, string> }[] = [];
  const files: Record<string, string> = { "main:prompts/system.md": "You are helpful.\nAnswer fast.\n" };
  const f = vi.fn(async (url: string, init: RequestInit) => {
    const u = new URL(url); const method = init.method!;
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method, url, body, headers: init.headers as Record<string, string> });
    const json = (s: number, d: unknown) => new Response(JSON.stringify(d), { status: s });
    if (u.hostname !== "api.github.com") throw new Error("wrong host");
    if (method === "GET" && u.pathname.endsWith("/pulls")) return json(200, opts.existingPr ? [{ html_url: "https://github.com/acme/bot/pull/3", number: 3 }] : []);
    if (method === "GET" && u.pathname.includes("/git/ref/")) return json(200, { object: { sha: "basesha" } });
    if (method === "POST" && u.pathname.endsWith("/git/refs")) return json(opts.branchExists ? 422 : 201, {});
    if (method === "GET" && u.pathname.includes("/contents/")) {
      const key = `${u.searchParams.get("ref")}:${decodeURIComponent(u.pathname.split("/contents/")[1]!)}`;
      const c = files[key];
      return c === undefined ? json(404, { message: "Not Found" }) : json(200, { type: "file", encoding: "base64", sha: "fsha", content: Buffer.from(c).toString("base64") });
    }
    if (method === "PUT") { files[`${body.branch}:${decodeURIComponent(u.pathname.split("/contents/")[1]!)}`] = Buffer.from(body.content, "base64").toString(); return json(200, {}); }
    if (method === "POST" && u.pathname.endsWith("/pulls")) return json(201, { html_url: "https://github.com/acme/bot/pull/9", number: 9 });
    return json(500, { message: "unexpected" });
  });
  return { f: f as unknown as typeof fetch, calls, files };
}
const run = (g: ReturnType<typeof fakeGithub>, r = rem()) =>
  openPullRequest({ token: TOKEN, target, finding, remediation: r, reportUrl: "https://app.test/jobs/j1", fetchImpl: g.f });

describe("openPullRequest", () => {
  it("creates branch, commits the patched file and opens a PR", async () => {
    const g = fakeGithub();
    const out = await run(g);
    expect(out).toMatchObject({ prUrl: "https://github.com/acme/bot/pull/9", created: true, committed: true, branch: "standard-evals/fix-f-1-" + branchNameFor("F-1").slice(-6) });
    expect(g.files[`${out.branch}:prompts/system.md`]).toBe("You are helpful.\nAnswer with citations.\n");
    expect(g.calls.every((c) => c.url.startsWith("https://api.github.com/repos/acme/bot"))).toBe(true);
    expect(g.calls.every((c) => c.headers.Authorization === `Bearer ${TOKEN}`)).toBe(true);
    const pr = g.calls.find((c) => c.method === "POST" && c.url.endsWith("/pulls"))!;
    expect(pr.body).toMatchObject({ base: "main", head: out.branch });
  });
  it("is idempotent: returns an open PR without writing", async () => {
    const g = fakeGithub({ existingPr: true });
    expect(await run(g)).toMatchObject({ created: false, committed: false, prNumber: 3 });
    expect(g.calls.some((c) => c.method !== "GET")).toBe(false);
  });
  it("reuses an existing branch without recommitting identical content", async () => {
    const g = fakeGithub({ branchExists: true });
    const branch = branchNameFor("F-1");
    g.files[`${branch}:prompts/system.md`] = "You are helpful.\nAnswer with citations.\n";
    const out = await run(g);
    expect(out).toMatchObject({ committed: false, created: true });
  });
  it("fails cleanly when the patch does not apply and writes nothing", async () => {
    const g = fakeGithub(); g.files["main:prompts/system.md"] = "unrelated\n";
    await expect(run(g)).rejects.toBeInstanceOf(PatchError);
    expect(g.calls.some((c) => c.method !== "GET")).toBe(false);
  });
  it("redacts the token from GitHub errors", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ message: `Bad ${TOKEN}` }), { status: 401 })) as unknown as typeof fetch;
    const err = await openPullRequest({ token: TOKEN, target, finding, remediation: rem(), reportUrl: "u", fetchImpl: f }).catch((e) => e);
    expect(err).toBeInstanceOf(GithubError);
    expect(err.message).not.toContain(TOKEN);
  });
  it("rejects invalid targets before any network call", async () => {
    const f = vi.fn() as unknown as typeof fetch;
    await expect(openPullRequest({ token: TOKEN, target: { ...target, filePath: "../x" }, finding, remediation: rem(), reportUrl: "u", fetchImpl: f })).rejects.toThrow();
    expect(f).not.toHaveBeenCalled();
  });
});
