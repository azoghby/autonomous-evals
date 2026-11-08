import "server-only";
/** Read models for /company (public, PII-free) and the operator Agents tab (full rows). */
import { desc, gte, sql } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import { COMPANY_AGENTS, isCompanyAgentId, orgChart, type CompanyAgentId, type OrgAgent } from "@ae/core/company/registry";
import { dailyBudgetMicroUsd, dayKey, isAgentEnabled, runBudgetMicroUsd } from "@ae/core/company/policy";
import { companySpentTodayMicroUsd, getAgentToggles } from "./store";
import { toPublicActivity, type PublicActivityRow, type PublicLatest } from "./public-activity";

export { toPublicActivity, sanitizePublicText, sanitizeCounts } from "./public-activity";

const DAY_MS = 86_400_000;

export interface AgentActivityStats {
  runs: number; ok: number; failed: number;
  counts: Record<string, number>;
  latest: PublicLatest | null;
}

export interface PublicAgentNode extends OrgAgent {
  /** Managed agents reflect their toggle; unmanaged agents have none and are shown as on. */
  enabled: boolean;
  activity: AgentActivityStats | null;
  /** Cheap, PII-free 7-day count for unmanaged agents. */
  passive: { label: string; count: number } | null;
}

export interface PublicOrgChart {
  agents: PublicAgentNode[];
  /** False when the DB could not be reached; the static chart is still returned. */
  activityAvailable: boolean;
  generatedAt: string;
}

const emptyStats = (): AgentActivityStats => ({ runs: 0, ok: 0, failed: 0, counts: {}, latest: null });

/** Pure: fold activity rows into per-agent 7-day stats using only whitelisted fields. */
export function summarizeActivity(rows: PublicActivityRow[]): Map<string, AgentActivityStats> {
  const out = new Map<string, AgentActivityStats>();
  for (const r of rows) {
    const cur = out.get(r.agentId) ?? emptyStats();
    const p = toPublicActivity(r);
    cur.runs += 1;
    if (r.status === "ok") cur.ok += 1;
    if (r.status === "failed") cur.failed += 1;
    for (const [k, v] of Object.entries(p.counts)) cur.counts[k] = (cur.counts[k] ?? 0) + v;
    if (!cur.latest || new Date(p.at).getTime() > new Date(cur.latest.at).getTime()) {
      cur.latest = { at: p.at, status: p.status, publicSummary: p.publicSummary };
    }
    out.set(r.agentId, cur);
  }
  return out;
}

async function passiveCounts(since: Date): Promise<Record<string, { label: string; count: number }>> {
  const s = schema;
  const d = db();
  const n = sql<number>`count(*)::int`;
  const count = async (q: PromiseLike<Array<{ n: number }>>): Promise<number | null> => {
    try { return Number((await q)[0]?.n ?? 0); } catch { return null; }
  };
  const entries: Array<[string, string, number | null]> = [
    ["owner_responder", "owner emails", await count(d.select({ n }).from(s.ownerEmailLog).where(gte(s.ownerEmailLog.sentAt, since)))],
    ["public_benchmarker", "benchmark runs", await count(d.select({ n }).from(s.publicAgentRuns).where(gte(s.publicAgentRuns.ranAt, since)))],
    ["sandbox_simulator", "sandbox runs", await count(d.select({ n }).from(s.sandboxRuns).where(gte(s.sandboxRuns.createdAt, since)))],
    ["commercial", "jobs handled", await count(d.select({ n }).from(s.jobs).where(gte(s.jobs.createdAt, since)))],
    ["follow_ups", "nudges sent", await count(d.select({ n }).from(s.followUps).where(gte(s.followUps.sentAt, since)))],
  ];
  const out: Record<string, { label: string; count: number }> = {};
  for (const [id, label, c] of entries) if (c !== null) out[id] = { label, count: c };
  return out;
}

/** Static chart nodes with no activity (the DB-down fallback). */
export function staticOrgChart(now: Date, enabledOf: (id: CompanyAgentId) => boolean = (id) => isAgentEnabled(id, null)): PublicOrgChart {
  return {
    agents: orgChart().map((a) => ({ ...a, enabled: isCompanyAgentId(a.id) && a.managed ? enabledOf(a.id) : true, activity: null, passive: null })),
    activityAvailable: false,
    generatedAt: now.toISOString(),
  };
}

export async function getPublicOrgChart(now: Date = new Date()): Promise<PublicOrgChart> {
  const since = new Date(now.getTime() - 7 * DAY_MS);
  const a = schema.companyAgentActivity;
  try {
    const [toggles, rows, passive] = await Promise.all([
      getAgentToggles(),
      // Whitelisted columns only: never summary/detail/error.
      db().select({ agentId: a.agentId, status: a.status, counts: a.counts, publicSummary: a.publicSummary, startedAt: a.startedAt })
        .from(a).where(gte(a.startedAt, since)).orderBy(desc(a.startedAt)).limit(1000),
      passiveCounts(since),
    ]);
    const stats = summarizeActivity(rows);
    return {
      agents: orgChart().map((node) => {
        const managed = node.managed && isCompanyAgentId(node.id);
        return {
          ...node,
          enabled: managed ? isAgentEnabled(node.id as CompanyAgentId, toggles.get(node.id)) : true,
          activity: managed ? (stats.get(node.id) ?? emptyStats()) : null,
          passive: managed ? null : (passive[node.id] ?? null),
        };
      }),
      activityAvailable: true,
      generatedAt: now.toISOString(),
    };
  } catch (err) {
    console.error("getPublicOrgChart failed", err instanceof Error ? err.message : err);
    return staticOrgChart(now);
  }
}

/* ---------------- Operator view (full rows; never expose publicly) ---------------- */

export interface OperatorAgentRow {
  id: CompanyAgentId; name: string; role: string; model: string; schedule: string | null;
  toggle: boolean | null; defaultEnabled: boolean; enabled: boolean;
  runBudgetMicroUsd: number; spentTodayMicroUsd: number;
  lastRun: { at: string; status: string; summary: string | null } | null;
}

export interface OperatorCompanyView {
  agents: OperatorAgentRow[];
  spend: { todayMicroUsd: number; dailyBudgetMicroUsd: number };
  activity: Array<{
    id: string; agentId: string; trigger: string; status: string; summary: string | null; publicSummary: string | null;
    counts: Record<string, number>; detail: Record<string, unknown>; costMicroUsd: number; error: string | null; dryRun: boolean;
    startedAt: string; finishedAt: string | null;
  }>;
  briefs: Array<{ id: string; briefDate: string; brief: unknown; sources: Array<{ url: string; title?: string }>; costMicroUsd: number }>;
  leads: Array<{
    id: string; company: string; domain: string; segment: string; agentDescription: string; fitScore: number; fitReason: string;
    recommendedPlan: string; hasContactEmail: boolean; contactRole: string | null; status: string; evidence: Array<{ url: string; note?: string }>;
  }>;
  tasks: Array<{ id: string; planDate: string; assignee: string; title: string; rationale: string; priority: number; status: string }>;
  plans: Array<{ planDate: string; summary: string; metrics: Record<string, unknown> }>;
  generatedAt: string;
}

export async function getOperatorCompanyView(now: Date = new Date()): Promise<OperatorCompanyView> {
  const a = schema.companyAgentActivity;
  const startOfDay = new Date(`${dayKey(now)}T00:00:00.000Z`);
  const [toggles, spent, activity, briefs, leads, plans] = await Promise.all([
    getAgentToggles(),
    companySpentTodayMicroUsd(now),
    db().select().from(a).orderBy(desc(a.startedAt)).limit(100),
    db().select().from(schema.marketBriefs).orderBy(desc(schema.marketBriefs.briefDate)).limit(7),
    db().select().from(schema.prospectLeads).orderBy(desc(schema.prospectLeads.fitScore)).limit(100),
    db().select().from(schema.companyPlans).orderBy(desc(schema.companyPlans.planDate)).limit(3),
  ]);
  const t = schema.companyTasks;
  const tasks = plans.length
    ? await db().select().from(t).where(sql`${t.planDate} in (${sql.join(plans.map((p) => sql`${p.planDate}`), sql`, `)})`).orderBy(desc(t.planDate), t.priority)
    : [];
  const c = schema.costs;
  const perAgent = await db().select({ agent: c.agent, total: sql<string>`coalesce(sum(${c.microUsd}), 0)` }).from(c)
    .where(sql`${c.agent} like 'company:%' and ${c.createdAt} >= ${startOfDay}`).groupBy(c.agent);
  const spentBy = new Map(perAgent.map((r) => [r.agent, Number(r.total)]));

  const agents = Object.values(COMPANY_AGENTS).map((def): OperatorAgentRow => {
    const last = activity.find((r) => r.agentId === def.id);
    const toggle = toggles.get(def.id) ?? null;
    return {
      id: def.id, name: def.name, role: def.role, model: def.model, schedule: def.schedule ?? null,
      toggle, defaultEnabled: def.defaultEnabledInProduction, enabled: isAgentEnabled(def.id, toggle),
      runBudgetMicroUsd: runBudgetMicroUsd(def.id), spentTodayMicroUsd: spentBy.get(`company:${def.id}`) ?? 0,
      lastRun: last ? { at: last.startedAt.toISOString(), status: last.status, summary: last.summary } : null,
    };
  });

  return {
    agents,
    spend: { todayMicroUsd: spent, dailyBudgetMicroUsd: dailyBudgetMicroUsd() },
    activity: activity.map((r) => ({
      id: r.id, agentId: r.agentId, trigger: r.trigger, status: r.status, summary: r.summary, publicSummary: r.publicSummary,
      counts: r.counts ?? {}, detail: r.detail ?? {}, costMicroUsd: r.costMicroUsd, error: r.error, dryRun: r.dryRun,
      startedAt: r.startedAt.toISOString(), finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
    })),
    briefs: briefs.map((b) => ({ id: b.id, briefDate: b.briefDate, brief: b.brief, sources: b.sources ?? [], costMicroUsd: b.costMicroUsd })),
    leads: leads.map((l) => ({
      id: l.id, company: l.company, domain: l.domain, segment: l.segment, agentDescription: l.agentDescription, fitScore: l.fitScore,
      fitReason: l.fitReason, recommendedPlan: l.recommendedPlan, hasContactEmail: Boolean(l.contactEmail), contactRole: l.contactRole,
      status: l.status, evidence: l.evidence ?? [],
    })),
    tasks: tasks.map((x) => ({ id: x.id, planDate: x.planDate, assignee: x.assignee, title: x.title, rationale: x.rationale, priority: x.priority, status: x.status })),
    plans: plans.map((p) => ({ planDate: p.planDate, summary: p.summary, metrics: p.metrics ?? {} })),
    generatedAt: now.toISOString(),
  };
}
