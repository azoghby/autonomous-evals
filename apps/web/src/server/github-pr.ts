import { createHash } from "node:crypto";
import { z } from "zod";
import type { Remediation } from "@ae/core/contracts/index";
import { applyUnifiedDiff, looksLikeUnifiedDiff } from "./diff-apply";

/** Fixed API host: user input never reaches the URL host (no SSRF). */
export const GITHUB_API = "https://api.github.com";

/* ---------- strict input validation ---------- */
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const BRANCH_RE = /^[A-Za-z0-9._\-/]{1,200}$/;
const PATH_RE = /^[A-Za-z0-9._@+\-/]{1,300}$/;
const TOKEN_RE = /^github_pat_[A-Za-z0-9_]{20,255}$/;

export const isValidOwner = (s: string) => OWNER_RE.test(s);
export const isValidRepo = (s: string) => REPO_RE.test(s) && s !== "." && s !== ".." && !s.endsWith(".git");
export function isValidBranch(s: string): boolean {
  if (!BRANCH_RE.test(s) || s.includes("..") || s.includes("//") || s.startsWith("/") || s.endsWith("/") || s.endsWith(".")) return false;
  return s.split("/").every((seg) => !seg.startsWith(".") && !seg.endsWith(".lock"));
}
const ALLOWED_DOC_EXT = /\.(md|mdx|txt|prompt|json|yaml|yml|toml)$/i;
const ALLOWED_CODE_EXT = /\.(py|ts|js)$/i;
const DENIED_DIRS = new Set([".github", ".circleci", ".husky", ".git", ".gitlab", ".vscode", ".devcontainer"]);
const DENIED_NAMES = /^(package(-lock)?\.json|makefile|dockerfile|\.gitlab-ci\.yml|\.travis\.yml|azure-pipelines\.yml|jenkinsfile|\.env.*|\.npmrc|\.pre-commit-config\.yaml|pnpm-lock\.yaml|yarn\.lock|pyproject\.toml|setup\.py|conftest\.py|tox\.ini)$/i;
const DENIED_CODE_DIRS = /^(scripts?|bin|hooks?|ci|\.?workflows?)$/i;
/** Fix target must be a prompt/doc/config file; never CI, hooks, lockfiles, env or build scripts. */
export function isValidFilePath(s: string): boolean {
  if (!PATH_RE.test(s) || s.startsWith("/") || s.endsWith("/") || s.includes("//")) return false;
  const segs = s.split("/");
  if (segs.some((x) => x === "." || x === ".." || DENIED_DIRS.has(x.toLowerCase()))) return false;
  const name = segs.at(-1)!;
  if (DENIED_NAMES.test(name)) return false;
  if (ALLOWED_DOC_EXT.test(name)) return true;
  // Source files only outside CI/automation directories.
  return ALLOWED_CODE_EXT.test(name) && !segs.slice(0, -1).some((d) => DENIED_CODE_DIRS.test(d));
}
export const isValidToken = (s: string) => TOKEN_RE.test(s);

export const GithubTargetInput = z.object({
  owner: z.string().refine(isValidOwner, "Invalid GitHub owner"),
  repo: z.string().refine(isValidRepo, "Invalid repository name"),
  baseBranch: z.string().refine(isValidBranch, "Invalid branch name"),
  filePath: z.string().refine(isValidFilePath, "Invalid file path"),
  token: z.string().refine(isValidToken, "Use a fine-grained personal access token (github_pat_...)"),
});
export type GithubTargetInput = z.infer<typeof GithubTargetInput>;
export interface GithubTarget { owner: string; repo: string; baseBranch: string; filePath: string }

/* ---------- naming ---------- */
export function fixSlug(findingId: string): string {
  const slug = findingId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  const suffix = slug === findingId ? "" : `-${createHash("sha1").update(findingId).digest("hex").slice(0, 6)}`;
  return `${slug || "finding"}${suffix}`;
}
export const branchNameFor = (findingId: string) => `standard-evals/fix-${fixSlug(findingId)}`;
export const fixDocPathFor = (findingId: string) => `standard-evals/fixes/${fixSlug(findingId)}.md`;

/* ---------- errors, redaction ---------- */
export class GithubError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export class PatchError extends Error {}

export function redact(text: string, token?: string): string {
  let out = text.replace(/(github_pat_|gh[pousr]_)[A-Za-z0-9_]+/g, "[redacted]");
  if (token) out = out.split(token).join("[redacted]");
  return out;
}

/* ---------- PR content ---------- */
const NOTIFY_SAFE = (s: string) => s.replace(/@(?=\w)/g, "@​");
const oneLine = (s: string, max: number) => NOTIFY_SAFE(s.replace(/\s+/g, " ").trim()).slice(0, max);
function fence(text: string, lang = ""): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const f = "`".repeat(longest + 1);
  return `${f}${lang}\n${text}\n${f}`;
}

export interface PrFinding { title: string; severity: string; evidence: { kind: string; excerpt: string }[] }
export interface PrBodyInput { finding: PrFinding; remediation: Remediation; reportUrl: string; fixDocPath?: string }

export function renderPrTitle(finding: PrFinding, remediation: Remediation): string {
  return `Fix: ${oneLine(finding.title || remediation.summary, 120)}`;
}

export function renderPrBody({ finding, remediation: r, reportUrl, fixDocPath }: PrBodyInput): string {
  const v = r.verification;
  const ev = finding.evidence[0];
  const lines = [
    `## ${oneLine(finding.title, 200)}`,
    `**Severity:** ${finding.severity} | **Fix type:** ${r.kind.replace(/_/g, " ")} | **Verification:** ${v.status.replace(/_/g, " ")}`,
    "",
    "### Evidence",
    ev ? `${ev.kind.replace(/_/g, " ")}:\n\n${fence(NOTIFY_SAFE(ev.excerpt.slice(0, 1500)))}` : "_No excerpt attached._",
    "",
    "### Fix",
    NOTIFY_SAFE(r.summary),
    "",
    "### Rationale",
    NOTIFY_SAFE(r.rationale),
    "",
    "### Verification",
    `| | Passed |`, `|---|---|`,
    `| Before | ${v.before.passed}/${v.before.total} |`,
    `| After | ${v.after.passed}/${v.after.total} |`,
    `| Regressions | ${v.regressions} |`,
    "",
    ...(fixDocPath ? [`The change is documented in \`${fixDocPath}\` (it could not be applied to the source file automatically).`, ""] : []),
    `[Full report](${reportUrl})`,
    "",
    "_Opened by Standard Evals. Review before merging._",
  ];
  return lines.join("\n");
}

export function renderFixDoc(r: Remediation, finding: PrFinding): string {
  return [
    `# ${oneLine(finding.title, 200)}`, "",
    `Finding \`${r.findingId.replace(/`/g, "")}\` | severity ${finding.severity} | ${r.kind.replace(/_/g, " ")}`, "",
    "## Summary", NOTIFY_SAFE(r.summary), "",
    "## Rationale", NOTIFY_SAFE(r.rationale), "",
    "## Proposed change", fence(r.patch), "",
  ].join("\n");
}

/* ---------- patch planning ---------- */
const APPENDABLE = /\.(md|mdx|txt|prompt)$/i;

export interface FileChange { path: string; content: string; kind: "source" | "doc" }

/** Pure: decide what file content the PR will carry. Throws PatchError on mismatch. */
export function planChange(
  r: Remediation, finding: PrFinding, filePath: string, baseContent: string | null,
): FileChange {
  const doc = (): FileChange => ({ path: fixDocPathFor(r.findingId), content: renderFixDoc(r, finding), kind: "doc" });
  const patchable = r.kind === "prompt_patch" || r.kind === "tool_schema";
  if (!patchable) return doc();
  if (looksLikeUnifiedDiff(r.patch)) {
    if (baseContent === null) throw new PatchError(`${filePath} does not exist on the base branch`);
    const res = applyUnifiedDiff(baseContent, r.patch);
    if (!res.ok) throw new PatchError(res.error);
    return { path: filePath, content: res.content, kind: "source" };
  }
  if (r.kind === "prompt_patch" && baseContent !== null && APPENDABLE.test(filePath)) {
    const id = fixSlug(r.findingId);
    const begin = `<!-- standard-evals:fix ${id} begin -->`;
    const end = `<!-- standard-evals:fix ${id} end -->`;
    const block = `${begin}\n${r.patch.trim()}\n${end}\n`;
    const base = baseContent.endsWith("\n") || baseContent === "" ? baseContent : `${baseContent}\n`;
    return { path: filePath, content: `${base}${base ? "\n" : ""}${block}`, kind: "source" };
  }
  return doc(); // replacement text with no safe in-place format
}

/* ---------- GitHub client ---------- */
type FetchLike = typeof fetch;
export interface GhOpts { token: string; fetchImpl?: FetchLike }

const seg = (s: string) => s.split("/").map(encodeURIComponent).join("/");

async function gh<T>(o: GhOpts, method: string, path: string, body?: unknown, okStatuses: number[] = []): Promise<{ status: number; data: T }> {
  if (!path.startsWith("/repos/")) throw new Error("invalid GitHub path");
  let res: Response;
  try {
    res = await (o.fetchImpl ?? fetch)(`${GITHUB_API}${path}`, {
      method, redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${o.token}`, Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "standard-evals",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new GithubError(502, "Could not reach GitHub");
  }
  const text = await res.text();
  let data: unknown = undefined;
  try { data = text ? JSON.parse(text) : undefined; } catch { /* non-JSON */ }
  if (!res.ok && !okStatuses.includes(res.status)) {
    const msg = redact(String((data as { message?: unknown } | undefined)?.message ?? `HTTP ${res.status}`), o.token).slice(0, 200);
    throw new GithubError(res.status, msg);
  }
  return { status: res.status, data: data as T };
}

const repoPath = (t: GithubTarget) => `/repos/${encodeURIComponent(t.owner)}/${encodeURIComponent(t.repo)}`;

/** Checks the token can reach the repo with push access and the base branch exists. */
export async function verifyAccess(o: GhOpts, t: GithubTarget): Promise<void> {
  const repo = await gh<{ permissions?: { push?: boolean } }>(o, "GET", repoPath(t));
  if (repo.data.permissions && repo.data.permissions.push === false) throw new GithubError(403, "Token lacks write access to this repository");
  await gh(o, "GET", `${repoPath(t)}/git/ref/heads/${seg(t.baseBranch)}`);
}

interface FileInfo { sha: string; content: string }
async function getFile(o: GhOpts, t: GithubTarget, path: string, ref: string): Promise<FileInfo | null> {
  const r = await gh<{ sha: string; content?: string; encoding?: string; type?: string }>(
    o, "GET", `${repoPath(t)}/contents/${seg(path)}?ref=${encodeURIComponent(ref)}`, undefined, [404]);
  if (r.status === 404) return null;
  if (r.data.type !== "file" || r.data.encoding !== "base64" || typeof r.data.content !== "string") {
    throw new PatchError(`${path} is not a regular file under 1 MB`);
  }
  return { sha: r.data.sha, content: Buffer.from(r.data.content, "base64").toString("utf8") };
}

interface PullInfo { html_url: string; number: number }
async function findOpenPr(o: GhOpts, t: GithubTarget, branch: string): Promise<PullInfo | null> {
  const r = await gh<PullInfo[]>(o, "GET", `${repoPath(t)}/pulls?state=open&head=${encodeURIComponent(`${t.owner}:${branch}`)}&per_page=1`);
  return r.data[0] ?? null;
}

export interface OpenPrInput {
  token: string; target: GithubTarget; finding: PrFinding; remediation: Remediation; reportUrl: string; fetchImpl?: FetchLike;
}
export interface OpenPrResult { prUrl: string; prNumber: number; branch: string; created: boolean; committed: boolean }

/** Idempotent: reuses the branch, skips an unchanged commit, and returns an already-open PR. */
export async function openPullRequest(input: OpenPrInput): Promise<OpenPrResult> {
  const { target: t, remediation: r, finding } = input;
  if (!isValidOwner(t.owner) || !isValidRepo(t.repo) || !isValidBranch(t.baseBranch) || !isValidFilePath(t.filePath)) {
    throw new GithubError(400, "Invalid repository target");
  }
  const o: GhOpts = { token: input.token, fetchImpl: input.fetchImpl };
  const branch = branchNameFor(r.findingId);

  const existing = await findOpenPr(o, t, branch);
  if (existing) return { prUrl: existing.html_url, prNumber: existing.number, branch, created: false, committed: false };

  const base = await gh<{ object: { sha: string } }>(o, "GET", `${repoPath(t)}/git/ref/heads/${seg(t.baseBranch)}`);
  const baseFile = await getFile(o, t, t.filePath, t.baseBranch);
  const change = planChange(r, finding, t.filePath, baseFile?.content ?? null);
  const baseOfChange = change.path === t.filePath ? baseFile : await getFile(o, t, change.path, t.baseBranch);
  if (baseOfChange && baseOfChange.content === change.content) throw new PatchError("The fix is already present on the base branch");

  await gh(o, "POST", `${repoPath(t)}/git/refs`, { ref: `refs/heads/${branch}`, sha: base.data.object.sha }, [422]);

  const onBranch = await getFile(o, t, change.path, branch);
  let committed = false;
  if (!onBranch || onBranch.content !== change.content) {
    await gh(o, "PUT", `${repoPath(t)}/contents/${seg(change.path)}`, {
      message: `fix: ${oneLine(r.summary, 100)}\n\nFinding: ${r.findingId.replace(/\s+/g, " ").slice(0, 64)}`,
      content: Buffer.from(change.content, "utf8").toString("base64"), branch,
      ...(onBranch ? { sha: onBranch.sha } : {}),
    });
    committed = true;
  }

  const pr = await gh<PullInfo & { message?: string }>(o, "POST", `${repoPath(t)}/pulls`, {
    title: renderPrTitle(finding, r), head: branch, base: t.baseBranch,
    body: renderPrBody({ finding, remediation: r, reportUrl: input.reportUrl, fixDocPath: change.kind === "doc" ? change.path : undefined }),
  }, [422]);
  if (pr.status === 422) {
    const again = await findOpenPr(o, t, branch);
    if (!again) throw new GithubError(422, "GitHub could not open the pull request");
    return { prUrl: again.html_url, prNumber: again.number, branch, created: false, committed };
  }
  return { prUrl: pr.data.html_url, prNumber: pr.data.number, branch, created: true, committed };
}
