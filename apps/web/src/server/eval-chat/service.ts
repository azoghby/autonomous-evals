import "server-only";
/** Wires the eval copilot to the real stores and services. Authorization lives here: every entry point loads the eval as its OWNER. */
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { rateLimit } from "@/server/rate-limit";
import { db, schema } from "@ae/core/db/client";
import type { Viewer } from "@/server/access";
import { getJobForViewer } from "@/server/queries";
import { rerunFindingForJob } from "@/server/job-actions";
import { enableShare } from "@/server/share";
import { shareUrls } from "@/server/share-core";
import { getSandboxService } from "@/server/sandbox-service";
import type { EvalChatHistory, EvalKind, EvalListItem, EvalRef } from "@/lib/eval-chat/types";
import { actionStates, type EvalContext } from "./actions";
import type { ChatDeps } from "./chat";
import { sandboxSuggestions } from "./grounding";
import { jobSuggestions, type JobGroundingInput } from "./job-grounding";
import { createDbEvalChatStore } from "./store";
import { gatewayBudgetSql, reserveGatewayTurn } from "./job-budget";

const RUN_ID = /^(sample|run_[0-9a-f-]{36})$/;
const JOB_ID = /^[0-9a-f-]{36}$/i;

export function parseEvalRef(kind: string, id: string): EvalRef | null {
  if (kind === "sandbox_run" && RUN_ID.test(id)) return { kind, id };
  if (kind === "job" && JOB_ID.test(id)) return { kind, id };
  return null;
}

/** The eval as its owner sees it, or null (callers answer 404 so ids are not probeable). Operators get no special access here. */
export async function loadEvalContext(viewer: Viewer, ref: EvalRef): Promise<EvalContext | null> {
  if (ref.kind === "sandbox_run") {
    const svc = getSandboxService();
    const report = await svc.getRunReport(viewer.id, ref.id);
    if (!report) return null;
    const target = report.sample ? null : await svc.getRunTarget(viewer.id, ref.id);
    return { ownerId: viewer.id, ref: { kind: "sandbox_run", id: ref.id }, report, target };
  }
  const data = await getJobForViewer(ref.id, { ...viewer, isOperator: false });
  if (!data) return null;
  return { ownerId: viewer.id, ref: { kind: "job", id: ref.id }, job: data as unknown as JobGroundingInput };
}

const appUrl = () => (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");

export function copilotDeps(): ChatDeps {
  const store = createDbEvalChatStore();
  return {
    store,
    reserveJobTurn: input => reserveGatewayTurn(gatewayBudgetSql(), input),
    sandbox: getSandboxService(),
    jobs: {
      async rerunFinding(data, findingId) {
        const r = await rerunFindingForJob(data as unknown as Parameters<typeof rerunFindingForJob>[0], findingId);
        return r.ok ? { ok: true } : { ok: false, status: r.status, error: r.error };
      },
      async enableShare(jobId) {
        const { token } = await enableShare(jobId);
        return { url: shareUrls(appUrl(), token).url };
      },
    },
    async spentTodayMicroUsd(ownerId) {
      const C = schema.costs;
      const [r] = await db().select({ total: sql<number>`coalesce(sum(${C.microUsd}), 0)::bigint` }).from(C)
        .where(and(eq(C.agent, "eval_copilot"), gte(C.createdAt, new Date(Date.now() - 86_400_000)), sql`${C.meta}->>'ownerId' = ${ownerId}`));
      return Number(r?.total ?? 0);
    },
    async allowScenarioGeneration(ownerId) {
      return (await rateLimit(`eval-chat-add-scenario:${ownerId}`, 6, 3600)).ok;
    },
    async recordCost({ ownerId, ctx, microUsd, inputTokens, outputTokens, basis }) {
      await db().insert(schema.costs).values({
        jobId: ctx.ref.kind === "job" ? ctx.ref.id : null, source: "ai_gateway", agent: "eval_copilot", microUsd,
        meta: { ownerId, evalKind: ctx.ref.kind, evalId: ctx.ref.id, inputTokens, outputTokens, costBasis: basis },
      });
    },
  };
}

export async function chatHistory(deps: ChatDeps, ctx: EvalContext): Promise<EvalChatHistory> {
  const [messages, actions] = await Promise.all([deps.store.loadMessages(ctx.ownerId, ctx.ref), actionStates(deps.store, ctx.ownerId, ctx.ref)]);
  const isRun = ctx.ref.kind === "sandbox_run" && "report" in ctx;
  return {
    messages, actions,
    title: isRun ? ctx.report.name : `Audit ${ctx.ref.id.slice(0, 8)}`,
    suggestions: isRun ? sandboxSuggestions(ctx.report) : "job" in ctx ? jobSuggestions(ctx.job) : [],
  };
}

const PACKAGE_LABEL: Record<string, string> = { trace_audit: "Trace audit", text_eval: "Text eval", workflow_eval: "Workflow eval", version_comparison: "Version comparison" };

/** Dashboard list: the viewer's own sandbox runs and audits, newest first. */
export async function listEvals(viewer: Viewer, limit = 30): Promise<EvalListItem[]> {
  const [runs, jobs] = await Promise.all([
    getSandboxService().listRuns(viewer.id, limit),
    db().select({ id: schema.jobs.id, state: schema.jobs.state, package: schema.jobs.package, createdAt: schema.jobs.createdAt })
      .from(schema.jobs).where(eq(schema.jobs.customerId, viewer.id)).orderBy(desc(schema.jobs.createdAt)).limit(limit),
  ]);
  const items: EvalListItem[] = [
    ...runs.map((r) => ({
      kind: "sandbox_run" as EvalKind, id: r.runId, name: r.name, status: r.status, createdAt: r.createdAt, href: `/sandbox/runs/${r.runId}`,
      passAt1: r.passAt1, passHatK: r.passHatK, k: r.k, detail: `${r.scenarios} scenario${r.scenarios === 1 ? "" : "s"} · k=${r.k}`,
    })),
    ...jobs.map((j) => ({
      kind: "job" as EvalKind, id: j.id, name: PACKAGE_LABEL[j.package] ?? "Audit", status: j.state, createdAt: new Date(j.createdAt).toISOString(),
      href: `/jobs/${j.id}`, passAt1: null, passHatK: null, k: null, detail: `Audit ${j.id.slice(0, 8)}`,
    })),
  ];
  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}
