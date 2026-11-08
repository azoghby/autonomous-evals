// Standard Evals regression check. No dependencies, no build step. Node 18+ (global fetch).
import { appendFileSync } from "node:fs";

const env = process.env;
const base = (env.SE_API_BASE || "https://standard-evals.vercel.app").replace(/\/$/, "");
const failOn = env.SE_FAIL_ON || "any";
const targetAuth = env.SE_TARGET_AUTH || "";
const POLL_MS = 5000;

// Keep secrets out of the runner logs.
for (const s of [env.SE_API_KEY, targetAuth]) if (s) console.log(`::add-mask::${s}`);

const fail = (msg) => { console.log(`::error::${msg}`); process.exit(1); };
if (!env.SE_API_KEY) fail("api-key is required");
if (!env.SE_JOB_ID) fail("job-id is required");
if (!["any", "regressions"].includes(failOn)) fail("fail-on must be 'any' or 'regressions'");

const redact = (t) => [env.SE_API_KEY, targetAuth].filter(Boolean).reduce((s, k) => s.split(k).join("***"), String(t));
const auth = { Authorization: `Bearer ${env.SE_API_KEY}` };

async function call(path, init) {
  const res = await fetch(`${base}${path}`, init);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").slice(0, 200);

function summary(r) {
  const lines = [`## Standard Evals regression check`, "", `**${r.passed}/${r.total} scenarios passed**`, ""];
  if (r.previouslyFixedRegressed.length) {
    lines.push(`### Previously fixed issues that regressed (${r.previouslyFixedRegressed.length})`, "", "| Scenario | Title | Detail |", "| --- | --- | --- |");
    for (const f of r.previouslyFixedRegressed) lines.push(`| ${cell(f.scenarioId)} | ${cell(f.title)} | ${cell(f.detail)} |`);
    lines.push("");
  }
  if (r.failed.length) {
    lines.push(`### Failing scenarios (${r.failed.length})`, "", "| Scenario | Title | Detail |", "| --- | --- | --- |");
    for (const f of r.failed) lines.push(`| ${cell(f.scenarioId)} | ${cell(f.title)} | ${cell(f.detail)} |`);
  } else lines.push("All scenarios passed.");
  return lines.join("\n") + "\n";
}

const payload = { jobId: env.SE_JOB_ID };
if (env.SE_TARGET_URL) payload.targetUrl = env.SE_TARGET_URL;
if (env.SE_MODEL) payload.model = env.SE_MODEL;
const headers = { ...auth, "Content-Type": "application/json" };
if (targetAuth) headers["X-Target-Authorization"] = targetAuth;

let { status, body } = await call("/api/v1/regression-runs", { method: "POST", headers, body: JSON.stringify(payload) });
if (status === 202 || (status === 200 && body.status === "running")) {
  const deadline = Date.now() + Number(env.SE_TIMEOUT_S || 600) * 1000;
  const runId = body.runId;
  console.log(`Run ${runId} in progress...`);
  for (;;) {
    if (Date.now() > deadline) fail(`Timed out waiting for run ${runId}`);
    await new Promise((r) => setTimeout(r, POLL_MS));
    ({ status, body } = await call(`/api/v1/regression-runs/${runId}`, { headers: auth }));
    if (status !== 200) break;
    if (body.status !== "running") break;
  }
}
if (status !== 200 || body.status !== "completed") fail(redact(`Regression run failed (HTTP ${status}): ${body.error ?? JSON.stringify(body)}`));

const md = summary(body);
console.log(md);
if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, md);
if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `passed=${body.passed}\ntotal=${body.total}\nfailed=${body.failed.length}\n`);

const bad = failOn === "regressions" ? body.previouslyFixedRegressed.length : body.failed.length;
if (bad > 0) fail(`${bad} ${failOn === "regressions" ? "previously fixed scenario(s) regressed" : "scenario(s) failed"}`);
